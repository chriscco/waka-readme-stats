import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { summaries } from '../src/stats.js';
import { importStatements } from '../scripts/import-insights.js';

const key = '00000000-0000-4000-8000-000000000001';
const base = 'https://stats.test/api/v1/users/current/';
let mf, db;
before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: ['index', 'collector', 'stats', 'heatmap'].map(name => ({ type: 'ESModule', path: `src/${name}.js` })), compatibilityDate: '2026-07-01',
    d1Databases: ['DB'], bindings: { INGEST_KEY: key } }));
  db = await mf.getD1Database('DB');
  await db.exec((await readFile('migrations/0001.sql', 'utf8')).replaceAll('\n', ' '));
  await db.exec((await readFile('migrations/0002.sql', 'utf8')).replaceAll('\n', ' '));
  await db.exec((await readFile('migrations/0003.sql', 'utf8')).replaceAll('\n', ' '));
});
after(async () => { await mf?.dispose(); });
beforeEach(async () => { await db.batch([db.prepare('DELETE FROM heartbeats'), db.prepare('DELETE FROM daily_summaries'), db.prepare('DELETE FROM historical_summaries'), db.prepare('DELETE FROM gitea_snapshot')]); });
function request(path, { auth = `Bearer ${key}`, ...options } = {}) {
  return mf.dispatchFetch(base + path, { ...options, headers: { Authorization: auth, ...options.headers } });
}
function heartbeat(at, fields = {}) {
  return { entity: '/work/main.py', type: 'file', time: Date.parse(`2026-01-${at}+08:00`) / 1000,
    language: 'Python', project: 'demo', ...fields };
}
function upload(events, options = {}) {
  return request('heartbeats.bulk', { method: 'POST', body: JSON.stringify(events), ...options });
}
function insights() {
  return { data: { timezone: 'Asia/Shanghai', is_up_to_date: true, percent_calculated: 100, timeout: 30,
    days: [1, 2].map(n => ({ date: `2026-01-0${n}`, total: 900, categories: [{ name: 'Coding', total: 300 }, { name: 'AI Coding', total: 600 }] })) } };
}
test('historical totals retain AI, exclude cutoff day, survive late heartbeats, and import idempotently', async () => {
  const statements = importStatements(insights(), '2026-01-02');
  for (let i = 0; i < 2; i++) await db.batch(statements.map(sql => db.prepare(sql)));
  await upload([heartbeat('01T10:00:00'), heartbeat('01T10:05:00'), heartbeat('02T10:00:00'), heartbeat('02T10:05:00')]);
  const result = await daily('2026-01-01', '2026-01-02');
  assert.deepEqual(result.map(x => x.total_seconds), [900, 300]);
  assert.equal(result[0].categories.find(x => x.name === 'AI Coding').total_seconds, 600);
  assert.equal(result[0].languages[0].name, 'History (no details)');
  assert.equal((await (await request('stats/all_time')).json()).data.total_seconds, 1200);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM historical_summaries').first()).n, 1);
  const history = JSON.parse((await db.prepare('SELECT source FROM historical_summaries').first()).source);
  assert.equal(history.timeout, 30);
});
test('history import rejects stale, incomplete, invalid, duplicate or mismatched records before emitting SQL', () => {
  for (const modify of [
    d => { d.data.timezone = 'UTC'; }, d => { d.data.is_up_to_date = false; },
    d => { d.data.percent_calculated = 50; }, d => { d.data.days[0].total = -1; },
    d => { d.data.days[0].date = '2026-02-30'; }, d => { d.data.days.push(d.data.days[0]); },
    d => { d.data.days[0].categories[0].total = 999; }, d => { d.data.days[0].total = Infinity; },
    d => { d.data.days[0].categories[0].total = '300'; },
  ]) { const data = insights(); modify(data); assert.throws(() => importStatements(data, '2026-01-02')); }
  assert.throws(() => importStatements(insights(), '2999-01-01'));
});
async function daily(start = '2026-01-01', end = start) {
  const response = await request(`daily?start=${start}&end=${end}`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).data;
}

test('private routes reject missing/wrong auth; both Basic forms and legacy GET key work', async () => {
  for (const path of ['daily', 'heatmap.svg', 'stats/all_time', 'status_bar/today', 'heartbeats']) {
    assert.equal((await request(path, { auth: '' })).status, 401);
    assert.equal((await request(path, { auth: 'Basic %%%' })).status, 401);
  }
  for (const credentials of [key, key + ':']) {
    assert.equal((await request('stats/all_time', { auth: 'Basic ' + btoa(credentials) })).status, 200);
  }
  assert.equal((await request(`stats/all_time?api_key=${key}`, { auth: '' })).status, 200);
  assert.equal((await request(`heartbeats?api_key=${key}`, { auth: '', method: 'POST', body: '{}' })).status, 401);
});

test('durable bulk and single writes deduplicate retries with stable canonical IDs', async () => {
  const event = heartbeat('01T10:00:00');
  const response = await upload([event]);
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.responses[0][1], 201);
  assert.match(body.responses[0][0].data.id, /^[a-f0-9]{64}$/);
  const reverse = Object.fromEntries(Object.entries(event).reverse());
  await request('heartbeats', { method: 'POST', body: JSON.stringify(reverse) });
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM heartbeats').first()).n, 1);
  assert.equal((await db.prepare('SELECT version FROM daily_summaries').first()).version, 1);
});

test('a D1 failure rolls back the batch and never acknowledges undurable events', async () => {
  await db.exec("CREATE TRIGGER reject_test BEFORE INSERT ON heartbeats WHEN NEW.entity = 'reject' BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END;");
  try {
    const response = await upload([heartbeat('01T10:00:00'), heartbeat('01T10:05:00', { entity: 'reject' })]);
    assert.equal(response.status, 503);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM heartbeats').first()).n, 0);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM daily_summaries').first()).n, 0);
    assert.doesNotMatch(await response.text(), /simulated|reject|00000000/);
  } finally { await db.exec('DROP TRIGGER reject_test'); }
});

test('bulk validation gives individual failures and bounds batch, body, strings, timestamps', async () => {
  const response = await upload([heartbeat('01T10:00:00'), { time: 'bad' }, heartbeat('01T10:01:00', { entity: 'x'.repeat(4097) }), heartbeat('01T10:02:00', { time: Date.now() / 1000 + 86400 })]);
  assert.deepEqual((await response.json()).responses.map(item => item[1]), [201, 400, 400, 400]);
  assert.equal((await upload(Array(26).fill(heartbeat('01T10:00:00')))).status, 400);
  assert.equal((await upload([])).status, 400);
  assert.equal((await upload({})).status, 400);
  assert.equal((await request('heartbeats', { method: 'POST', body: '{' })).status, 400);
  assert.equal((await request('heartbeats', { method: 'POST', body: ' '.repeat(262145) })).status, 413);
  assert.equal((await request('daily?start=2026-02-30&end=2026-03-01')).status, 400);
});

test('idle gaps and isolated events add nothing; events can arrive out of order', async () => {
  await upload([heartbeat('01T11:00:00'), heartbeat('01T10:05:00'), heartbeat('01T10:00:00')]);
  assert.equal((await daily())[0].total_seconds, 300);
});

test('midnight splitting and late events invalidate both sides while unrelated dates stay cached', async () => {
  await upload([heartbeat('01T23:58:00'), heartbeat('03T10:00:00')]);
  assert.deepEqual((await daily('2026-01-01', '2026-01-03')).map(d => d.total_seconds), [0, 0, 0]);
  await upload([heartbeat('02T00:02:00')]);
  const cached = await db.prepare('SELECT day, version, computed_version FROM daily_summaries ORDER BY day').all();
  assert.ok(cached.results.find(d => d.day === '2026-01-01').version > cached.results.find(d => d.day === '2026-01-01').computed_version);
  assert.equal(cached.results.find(d => d.day === '2026-01-03').version, cached.results.find(d => d.day === '2026-01-03').computed_version);
  assert.deepEqual((await daily('2026-01-01', '2026-01-03')).map(d => d.total_seconds), [120, 120, 0]);
});

test('overlapping machines count once and newest interval wins attribution', async () => {
  await upload([heartbeat('01T10:00:00'), heartbeat('01T10:10:00')], { headers: { 'X-Machine-Name': 'laptop' } });
  await upload([heartbeat('01T10:05:00', { language: 'Rust' }), heartbeat('01T10:15:00', { language: 'Rust' })], { headers: { 'X-Machine-Name': 'desktop' } });
  const result = (await daily())[0];
  assert.equal(result.total_seconds, 900);
  assert.equal(result.languages.find(x => x.name === 'Python').total_seconds, 300);
  assert.equal(result.languages.find(x => x.name === 'Rust').total_seconds, 600);
});

test('per-event user agent overrides headers; preserve AI metadata and exclude app thinking', async () => {
  const agent = 'wakatime/v2.0.0 (darwin-24.0.0-arm64) go1.25.0 vscode/1.99.0 vscode-wakatime/25.0.0';
  await upload([heartbeat('01T10:00:00', { user_agent: agent }), heartbeat('01T10:05:00', { user_agent: agent }),
    heartbeat('01T11:00:00', { type: 'app', category: 'ai coding', ai_input_tokens: 123, ai_model: 'model-x', ai_session: 'abc', user_agent: 'wakatime/v2 (linux-unknown) go1.25 Claude/2.0 claude-opus-4-6/high' }),
    heartbeat('01T11:10:00', { type: 'app', category: 'ai coding' })],
  { headers: { 'User-Agent': 'wrong/1.0', 'X-Machine-Name': 'my%2Blaptop' } });
  const result = (await daily())[0];
  assert.equal(result.total_seconds, 300);
  assert.equal(result.editors[0].name, 'VS Code');
  assert.equal(result.operating_systems[0].name, 'Mac');
  const raw = await db.prepare("SELECT machine, payload FROM heartbeats WHERE category='ai coding' AND payload LIKE '%123%'").first();
  assert.equal(raw.machine, 'my+laptop');
  assert.equal(JSON.parse(raw.payload).ai_input_tokens, 123);
  assert.equal(JSON.parse(raw.payload).ai_model, 'model-x');
  assert.equal(JSON.parse(raw.payload).ai_session, 'abc');
});

test('late insertion can remove a gap and changes cached attribution', async () => {
  await upload([heartbeat('01T10:00:00'), heartbeat('01T10:20:00')]);
  assert.equal((await daily())[0].total_seconds, 0);
  await upload([heartbeat('01T10:10:00', { language: 'Rust' })]);
  const result = (await daily())[0];
  assert.equal(result.total_seconds, 1200);
  assert.deepEqual(result.languages.map(x => x.total_seconds), [600, 600]);
});

test('stats match README fields, seven completed dates; today status matches CLI shape', async () => {
  const now = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const stamp = Date.parse(now + 'T00:00:00+08:00') / 1000;
  await upload([heartbeat('01T10:00:00'), heartbeat('01T10:05:00'), heartbeat('01T10:00:00', { time: stamp - 600 }), heartbeat('01T10:00:00', { time: stamp - 300 })]);
  const all = (await (await request('stats/all_time')).json()).data;
  assert.equal(all.total_seconds, 600);
  assert.equal(all.timezone, 'Asia/Shanghai');
  assert.equal(typeof all.human_readable_total, 'string');
  for (const field of ['languages', 'editors', 'projects', 'operating_systems', 'categories']) {
    assert.equal(all[field][0].percent, 100);
    assert.equal(typeof all[field][0].text, 'string');
  }
  const week = (await (await request('stats/last_7_days')).json()).data;
  assert.equal(week.total_seconds, 300);
  assert.ok(week.end < now);
  for (const path of ['status_bar/today', 'statusbar/today']) {
    const today = (await (await request(path)).json()).data;
    assert.equal(today.grand_total.total_seconds, 0);
    assert.equal(today.range.date, now);
  }
});

test('annual private SVG has 365 date cells, title, weekday/month labels and legend', async () => {
  const response = await request('heatmap.svg');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /image\/svg\+xml/);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const svg = await response.text();
  assert.equal((svg.match(/data-date=/g) || []).length, 365);
  for (const text of ['<title', '<desc', 'Mon', 'Wed', 'Fri', 'Less', 'More', '#216e39']) assert.ok(svg.includes(text), text);
});

test('a write during production summary rebuilding refuses stale cache publication', async () => {
  await upload([heartbeat('01T10:00:00')]);
  let injected = false;
  const interleavedDB = { prepare(sql) {
    const statement = db.prepare(sql);
    if (!sql.startsWith('UPDATE daily_summaries')) return statement;
    return { bind(...args) { return { async run() {
      if (!injected) { injected = true; await upload([heartbeat('01T10:05:00')]); }
      return statement.bind(...args).run();
    } }; } };
  } };
  await assert.rejects(summaries(interleavedDB, '2026-01-01', '2026-01-01'), error => error.status === 503);
  assert.equal((await daily())[0].total_seconds, 300);
});

test('header-only model user agent is retained, unusual dimension names remain ordinary data', async () => {
  const agent = 'wakatime/v2 (linux-6-x86) go1.25 Codex/1.0 gpt-5/high';
  await upload([heartbeat('01T10:00:00', { project: '__proto__' }), heartbeat('01T10:05:00', { project: '__proto__' })], { headers: { 'User-Agent': agent } });
  const row = await db.prepare('SELECT user_agent FROM heartbeats LIMIT 1').first();
  assert.equal(row.user_agent, agent);
  const result = (await daily())[0];
  assert.equal(result.projects[0].name, '__proto__');
  assert.equal(result.projects[0].total_seconds, 300);
});

test('same-start overlap attribution is deterministic under reversed arrival order', async () => {
  const a = [heartbeat('01T10:00:00'), heartbeat('01T10:10:00')];
  const b = [heartbeat('01T10:00:00', { language: 'Rust' }), heartbeat('01T10:10:00', { language: 'Rust' })];
  await upload(a, { headers: { 'X-Machine-Name': 'a' } });
  await upload(b, { headers: { 'X-Machine-Name': 'b' } });
  const first = await daily();
  await db.batch([db.prepare('DELETE FROM heartbeats'), db.prepare('DELETE FROM daily_summaries')]);
  await upload(b, { headers: { 'X-Machine-Name': 'b' } });
  await upload(a, { headers: { 'X-Machine-Name': 'a' } });
  assert.deepEqual(await daily(), first);
  assert.equal(first[0].total_seconds, 600);
});

test('a large dirty backlog returns retryable failure instead of incomplete totals, then converges', async () => {
  for (let day = 1; day <= 20; day++) {
    const d = String(day).padStart(2, '0');
    await upload([heartbeat(`${d}T10:00:00`), heartbeat(`${d}T10:05:00`)]);
  }
  const first = await request('stats/all_time');
  assert.equal(first.status, 503);
  assert.equal(first.headers.get('Retry-After'), '1');
  const second = await request('stats/all_time');
  assert.equal(second.status, 200);
  assert.equal((await second.json()).data.total_seconds, 6000);
});


test('Gitea snapshot requires auth, replaces atomically, and cannot alter coding totals', async () => {
  assert.equal((await request('gitea/commits', { auth: '' })).status, 401);
  assert.equal((await request('gitea/commits')).status, 404);
  const data = { ['a'.repeat(40)]: '2026-11-01T17:30:00Z' };
  const put = value => request('gitea/commits', { method: 'PUT', body: JSON.stringify(value) });
  assert.equal((await put(data)).status, 200);
  assert.deepEqual((await (await request('gitea/commits')).json()).data, data);
  for (const bad of [{ secret: 'private text' }, { ['b'.repeat(40)]: '2026-02-30T00:00:00Z' }, {}, [], null]) {
    assert.equal((await put(bad)).status, 400);
    assert.deepEqual((await (await request('gitea/commits')).json()).data, data);
  }
  assert.equal((await request('gitea/commits', { method: 'PUT', body: ' '.repeat(1048577) })).status, 413);
  assert.equal((await request('gitea/commits', { method: 'DELETE' })).status, 405);
  assert.equal((await (await request('stats/all_time')).json()).data.total_seconds, 0);
  const replacement = { ['b'.repeat(40)]: '2026-11-02T01:00:00Z' };
  assert.equal((await put(replacement)).status, 200);
  assert.deepEqual((await (await request('gitea/commits')).json()).data, replacement);
  await db.exec("CREATE TRIGGER reject_snapshot BEFORE UPDATE ON gitea_snapshot BEGIN SELECT RAISE(ABORT, 'private storage detail'); END;");
  try {
    const failure = await put(data);
    assert.equal(failure.status, 503);
    assert.doesNotMatch(await failure.text(), /private storage detail/);
    assert.deepEqual((await (await request('gitea/commits')).json()).data, replacement);
  } finally { await db.exec('DROP TRIGGER reject_snapshot'); }

});
