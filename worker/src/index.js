import { authorized, collect, HttpError } from './collector.js';
import { combine, dates, duration, format, localDate, shiftDate, summaries, TIMEZONE, validateRange } from './stats.js';
import { heatmap } from './heatmap.js';

function json(body, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...(status === 503 ? { 'Retry-After': '1' } : {}) } });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (!await authorized(request, env.INGEST_KEY, url)) return json({ error: 'Unauthorized' }, 401);
      const prefix = '/api/v1/users/current/';
      if (!url.pathname.startsWith(prefix)) return json({ error: 'Not found' }, 404);
      const route = url.pathname.slice(prefix.length);
      const db = env.DB.withSession('first-primary');
      if (route === 'heartbeats' || route === 'heartbeats.bulk') {
        if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
        const result = await collect(request, db, route.endsWith('.bulk'));
        return json(result.body, result.status);
      }
      if (!['stats/last_7_days', 'stats/all_time', 'status_bar/today', 'statusbar/today', 'daily', 'heatmap.svg'].includes(route)) return json({ error: 'Not found' }, 404);
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      const today = localDate();
      let start = today, end = today;
      if (route === 'stats/all_time') start = '1970-01-01';
      else if (route === 'stats/last_7_days') { start = shiftDate(today, -7); end = shiftDate(today, -1); }
      else if (route === 'daily' || route === 'heatmap.svg') start = shiftDate(today, -364);
      if (route === 'daily') {
        start = url.searchParams.get('start') || start;
        end = url.searchParams.get('end') || end;
        validateRange(start, end);
      }
      const cached = await summaries(db, start, end);
      if (route === 'heatmap.svg') return new Response(heatmap(cached, start, end), { headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" } });
      if (route === 'daily') return json({ timezone: TIMEZONE, data: dates(start, end).map(day => ({ date: day, ...format(cached.get(day)) })) });
      const data = { ...combine(cached.values()), start, end };
      if (route.endsWith('/today')) {
        data.grand_total = duration(data.total_seconds);
        data.range = { date: today, timezone: TIMEZONE, start: today + 'T00:00:00+08:00', end: shiftDate(today, 1) + 'T00:00:00+08:00' };
      }
      return json({ data });
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      return json({ error: 'Storage is unavailable; retry this request' }, 503);
    }
  }
};
