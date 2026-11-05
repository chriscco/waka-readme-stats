import { HttpError } from './collector.js';

export const DAY = 86400;
export const TIMEZONE = 'Asia/Shanghai';
const dimensions = { languages: 'language', editors: 'editor', projects: 'project', operating_systems: 'operating_system', categories: 'category' };
export function localDate(time = Date.now() / 1000) { return new Date((time + 8 * 3600) * 1000).toISOString().slice(0, 10); }
export function midnight(day) { return Date.parse(day + 'T00:00:00+08:00') / 1000; }
export function shiftDate(day, offset) { return localDate(midnight(day) + offset * DAY); }
export function dates(start, end) {
  const result = [];
  for (let day = start; day <= end; day = shiftDate(day, 1)) result.push(day);
  return result;
}
export function validateRange(start, end) {
  for (const day of [start, end]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(midnight(day)) || localDate(midnight(day)) !== day) throw new HttpError(400, 'Invalid date');
  }
  if (start > end || midnight(end) - midnight(start) >= 366 * DAY) throw new HttpError(400, 'Date range must contain 1–366 dates');
}
function empty() { return { total_seconds: 0, ...Object.fromEntries(Object.keys(dimensions).map(k => [k, Object.create(null)])) }; }

export function aggregate(events, day) {
  const start = midnight(day), end = start + DAY;
  const previous = new Map(), points = [];
  for (const event of events) {
    if (event.type === 'app' && event.category === 'ai coding') continue;
    const prev = previous.get(event.machine);
    if (prev && event.time > prev.time && event.time - prev.time <= 900) {
      const a = Math.max(start, prev.time), b = Math.min(end, event.time);
      if (a < b) { points.push({ time: a, add: prev }); points.push({ time: b, remove: prev }); }
    }
    previous.set(event.machine, event);
  }
  points.sort((a, b) => a.time - b.time);
  const active = new Map(), result = empty();
  for (let i = 0; i < points.length;) {
    const at = points[i].time;
    while (i < points.length && points[i].time === at) {
      const point = points[i++];
      if (point.remove) active.delete(point.remove.id);
      if (point.add) active.set(point.add.id, point.add);
    }
    if (i === points.length || !active.size) continue;
    let chosen;
    for (const event of active.values()) {
      if (!chosen || event.time > chosen.time || (event.time === chosen.time && event.id > chosen.id)) chosen = event;
    }
    const seconds = points[i].time - at;
    result.total_seconds += seconds;
    for (const [dimension, field] of Object.entries(dimensions)) {
      let name = chosen[field];
      if (dimension === 'categories') name = name === 'ai coding' ? 'AI Coding' : name.replace(/\b\w/g, char => char.toUpperCase());
      result[dimension][name] = (Object.hasOwn(result[dimension], name) ? result[dimension][name] : 0) + seconds;
    }
  }
  return result;
}

export async function summaries(db, start, end) {
  const dirty = await db.prepare('SELECT day, version FROM daily_summaries WHERE day BETWEEN ? AND ? AND computed_version != version AND day NOT IN (SELECT day FROM historical_summaries) ORDER BY day LIMIT 16').bind(start, end).all();
  for (const row of dirty.results) {
    const beginning = midnight(row.day);
    const events = await db.prepare('SELECT id,time,machine,type,category,language,editor,project,operating_system FROM heartbeats WHERE time BETWEEN ? AND ? ORDER BY time,id')
      .bind(beginning - 900, beginning + DAY + 900).all();
    const summary = aggregate(events.results, row.day);
    await db.prepare('UPDATE daily_summaries SET summary = ?, computed_version = ? WHERE day = ? AND version = ?')
      .bind(JSON.stringify(summary), row.version, row.day, row.version).run();
  }
  // One snapshot checks readiness and reads caches, so late writes cannot hide behind stale totals.
  // Imported dates replace local estimates; late client retries must not count a day twice.
  const rows = await db.prepare(`SELECT day,version,computed_version,summary FROM daily_summaries
    WHERE day BETWEEN ?1 AND ?2 AND day NOT IN (SELECT day FROM historical_summaries)
    UNION ALL SELECT day,0 AS version,0 AS computed_version,summary FROM historical_summaries
    WHERE day BETWEEN ?1 AND ?2 ORDER BY day`).bind(start, end).all();
  if (rows.results.some(row => row.version !== row.computed_version || !row.summary)) throw new HttpError(503, 'Daily summaries are updating; retry this request');
  return new Map(rows.results.map(row => [row.day, JSON.parse(row.summary)]));
}

export function duration(seconds) {
  const whole = Math.floor(seconds), hours = Math.floor(whole / 3600), minutes = Math.floor(whole / 60) % 60;
  const text = hours ? `${hours} hrs ${minutes} mins` : minutes ? `${minutes} mins` : `${whole} secs`;
  return { total_seconds: seconds, text, hours, minutes, seconds: whole % 60,
    decimal: (seconds / 3600).toFixed(2), digital: `${hours}:${String(minutes).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}` };
}
export function format(summary = empty()) {
  const result = { ...duration(summary.total_seconds), timezone: TIMEZONE, human_readable_total: duration(summary.total_seconds).text };
  for (const dimension of Object.keys(dimensions)) {
    result[dimension] = Object.entries(summary[dimension]).map(([name, seconds]) => ({ name, ...duration(seconds), percent: summary.total_seconds ? Math.round(seconds / summary.total_seconds * 10000) / 100 : 0 }))
      .sort((a, b) => b.total_seconds - a.total_seconds || a.name.localeCompare(b.name));
  }
  return result;
}
export function combine(summaries) {
  const total = empty();
  for (const summary of summaries) {
    total.total_seconds += summary.total_seconds;
    for (const dimension of Object.keys(dimensions)) {
      for (const [name, seconds] of Object.entries(summary[dimension])) total[dimension][name] = (Object.hasOwn(total[dimension], name) ? total[dimension][name] : 0) + seconds;
    }
  }
  return format(total);
}
