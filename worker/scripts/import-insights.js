import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localDate, validateRange } from '../src/stats.js';

export function importStatements(document, before) {
  validateRange(before, before);
  if (before > localDate()) throw new Error('Cutoff must not include today or future dates');
  const data = document?.data;
  if (data?.timezone !== 'Asia/Shanghai' || data.is_up_to_date !== true || data.percent_calculated !== 100 || !Array.isArray(data.days) || !data.days.length) {
    throw new Error('Expected complete, current Asia/Shanghai Insights days');
  }
  const { days, user_id, ...metadata } = data;
  const seen = new Set(), statements = [];
  const quote = value => "'" + JSON.stringify(value).replaceAll("'", "''") + "'";
  const validSeconds = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  for (const day of days) {
    validateRange(day.date, day.date);
    if (seen.has(day.date) || day.date > localDate() || !validSeconds(day.total) || !Array.isArray(day.categories)) throw new Error('Invalid or duplicate history date');
    seen.add(day.date);
    const categories = Object.create(null);
    for (const category of day.categories) {
      if (typeof category.name !== 'string' || !category.name.trim() || category.name.length > 256 || Object.hasOwn(categories, category.name) || !validSeconds(category.total)) throw new Error('Invalid history category');
      categories[category.name] = category.total;
    }
    if (Math.abs(Object.values(categories).reduce((a, b) => a + b, 0) - day.total) > 0.01) throw new Error('Category totals do not match daily total');
    if (day.date >= before) continue;
    const unknown = day.total ? { 'History (no details)': day.total } : {};
    const summary = { total_seconds: day.total, categories, languages: unknown, editors: unknown, projects: unknown, operating_systems: unknown };
    const source = { provider: 'wakatime-insights', ...metadata, day };
    statements.push(`INSERT INTO historical_summaries(day,summary,source) VALUES ('${day.date}',${quote(summary)},${quote(source)}) ON CONFLICT(day) DO UPDATE SET summary=excluded.summary,source=excluded.source;`);
  }
  if (!statements.length) throw new Error('No completed history dates before cutoff');
  return statements;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error('Usage: node scripts/import-insights.js input.json YYYY-MM-DD > private-import.sql');
  const statements = importStatements(JSON.parse(readFileSync(process.argv[2], 'utf8')), process.argv[3]);
  process.stdout.write(statements.join('\n') + '\n');
}
