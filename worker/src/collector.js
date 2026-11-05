export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2, '0')).join('');
}

export async function authorized(request, key, url) {
  if (!key) throw new HttpError(503, 'Service is not configured');
  const header = request.headers.get('Authorization') || '';
  let candidate = '';
  if (/^Bearer /i.test(header)) candidate = header.slice(7);
  else if (/^Basic /i.test(header)) {
    try { candidate = atob(header.slice(6)).replace(/:$/, ''); } catch { return false; }
  } else if (!header && request.method === 'GET') candidate = url.searchParams.get('api_key') || '';
  if (!candidate || candidate.length > 256) return false;
  const [a, b] = await Promise.all([digest(candidate), digest(key)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

export async function bodyJSON(request, limit = 262144) {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'JSON body required');
  const parts = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new HttpError(413, 'Body exceeds size limit'); }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new HttpError(400, 'Invalid JSON'); }
}

function canonical(value, depth = 0) {
  if (depth > 8) throw new HttpError(400, 'Metadata nesting exceeds 8 levels');
  if (typeof value === 'string' && value.length > 4096) throw new HttpError(400, 'String exceeds 4096 characters');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new HttpError(400, 'Invalid number');
  if (Array.isArray(value)) return value.map(v => canonical(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(k => {
      if (k.length > 128) throw new HttpError(400, 'Metadata key exceeds 128 characters');
      return [k, canonical(value[k], depth + 1)];
    }));
  }
  return value;
}

function field(event, name, fallback = 'Unknown') {
  if (event[name] == null || event[name] === '') return fallback;
  if (typeof event[name] !== 'string' || event[name].length > 4096) throw new HttpError(400, `Invalid ${name}`);
  return event[name];
}

function agentInfo(agent) {
  const platform = agent.match(/\(([^)]+)\)/)?.[1]?.toLowerCase() || '';
  const os = /darwin|macos|mac os/.test(platform) ? 'Mac' : /windows/.test(platform) ? 'Windows' : /linux/.test(platform) ? 'Linux' : 'Unknown';
  const tokens = agent.replace(/\([^)]*\)/g, '').split(/\s+/);
  const editor = tokens.find(token => token.includes('/') && !/^(wakatime|go\d|python|[^/]*wakatime)\//i.test(token))?.split('/')[0] || 'Unknown';
  const names = { vscode: 'VS Code', cursor: 'Cursor', pycharm: 'PyCharm', intellij: 'IntelliJ IDEA', vim: 'Vim', neovim: 'Neovim', claude: 'Claude', codex: 'Codex' };
  return { editor: names[editor.toLowerCase()] || editor, os };
}

async function normalize(event, request) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new HttpError(400, 'Heartbeat must be an object');
  const payload = JSON.stringify(canonical(event));
  if (new TextEncoder().encode(payload).length > 16384) throw new HttpError(400, 'Heartbeat exceeds 16 KiB');
  if (typeof event.time !== 'number' || !Number.isFinite(event.time) || event.time < 0 || event.time > Date.now() / 1000 + 300) {
    throw new HttpError(400, 'Invalid time (Unix seconds, at most 5 minutes ahead)');
  }
  if (typeof event.entity !== 'string' || !event.entity.trim()) throw new HttpError(400, 'Entity is required');
  if (!['file', 'app', 'url', 'domain'].includes(event.type)) throw new HttpError(400, 'Invalid entity type');
  const agent = field(event, 'user_agent', request.headers.get('User-Agent') || '');
  let machineHeader = request.headers.get('X-Machine-Name') || '';
  try { machineHeader = decodeURIComponent(machineHeader.replace(/\+/g, ' ')); }
  catch { throw new HttpError(400, 'Invalid machine header'); }
  const machine = field(event, 'machine_name', machineHeader || 'Unknown');
  if (machine.length > 4096 || agent.length > 4096) throw new HttpError(400, 'Header exceeds 4096 characters');
  const info = agentInfo(agent);
  const values = {
    time: event.time, machine, entity: event.entity, type: event.type,
    category: field(event, 'category', 'coding').toLowerCase(), language: field(event, 'language'),
    editor: field(event, 'editor', info.editor), project: field(event, 'project'),
    operating_system: field(event, 'operating_system', info.os), user_agent: agent, payload,
  };
  const id = await digest(JSON.stringify([canonical(event), machine, agent]));
  return { id, ...values };
}

export async function collect(request, db, bulk) {
  const input = await bodyJSON(request);
  if (bulk && (!Array.isArray(input) || input.length < 1 || input.length > 25)) throw new HttpError(400, 'Bulk requires 1–25 heartbeats');
  const responses = [];
  const statements = [];
  for (const event of bulk ? input : [input]) {
    try {
      const row = await normalize(event, request);
      statements.push(db.prepare('INSERT OR IGNORE INTO heartbeats (id,time,machine,entity,type,category,language,editor,project,operating_system,user_agent,payload) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .bind(...Object.values(row)));
      responses.push([{ data: { id: row.id } }, 201]);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      responses.push([{ error: error.message }, error.status]);
    }
  }
  // D1 batch is transactional; the insert trigger invalidates caches in the same commit.
  if (statements.length) await db.batch(statements);
  return bulk ? { body: { responses }, status: 201 } : { body: responses[0][0], status: responses[0][1] };
}
