import { dates, duration, midnight } from './stats.js';

export function heatmap(summaries, start, end) {
  const days = dates(start, end);
  const offset = new Date(midnight(start) * 1000 + 8 * 3600000).getUTCDay();
  const colors = ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'];
  const elements = [];
  let previousMonth;
  for (let i = 0; i < days.length; i++) {
    const day = days[i], seconds = summaries.get(day)?.total_seconds || 0;
    const column = Math.floor((i + offset) / 7), row = (i + offset) % 7;
    const x = 44 + column * 13, y = 40 + row * 13;
    const level = seconds === 0 ? 0 : seconds < 1800 ? 1 : seconds < 7200 ? 2 : seconds < 14400 ? 3 : 4;
    elements.push(`<rect class="level-${level}" data-date="${day}" x="${x}" y="${y}" width="10" height="10" rx="2" fill="${colors[level]}"><title>${day}: ${duration(seconds).text}</title></rect>`);
    const month = day.slice(0, 7);
    if (month !== previousMonth && (i === 0 || column > 0)) {
      const label = new Date(day + 'T00:00:00Z').toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
      elements.push(`<text x="${x}" y="30">${label}</text>`);
      previousMonth = month;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 174" role="img" aria-labelledby="title description">
<title id="title">Coding activity: ${start} to ${end}</title>
<desc id="description">Daily coding time in Asia/Shanghai for 365 dates. Green levels: zero, under 30 minutes, under 2 hours, under 4 hours, and 4 or more hours. Each date has a time label.</desc>
<style>
@media (prefers-color-scheme: dark) {
  text { fill: #c9d1d9; }
  .level-0 { fill: #161b22; }
  .level-1 { fill: #0e4429; }
  .level-2 { fill: #006d32; }
  .level-3 { fill: #26a641; }
  .level-4 { fill: #39d353; }
}
</style>
<g font-family="system-ui,sans-serif" font-size="10" fill="#24292f">
<text x="12" y="62">Mon</text><text x="12" y="88">Wed</text><text x="12" y="114">Fri</text>
${elements.join('\n')}
<text x="565" y="157">Less</text>${colors.map((color, i) => `<rect class="level-${i}" x="${595 + i * 13}" y="148" width="10" height="10" rx="2" fill="${color}"/>`).join('')}<text x="665" y="157">More</text>
</g></svg>`;
}
