// Pure helpers for /model-router history: no engine calls, so they are unit tested directly.
export const SPARK = '▁▂▃▄▅▆▇█'

export type DayCost = { day: string; cost: number; baseline: number }

export function hhmm(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// YYYYMMDD of the last n local days ending at now, oldest first.
export function lastDays(now: number, n: number, dayKey: (ms: number) => string): string[] {
  const days: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    days.push(dayKey(d.getTime()))
  }
  return days
}

// A day's amount on the chart: whole dollars from $10, cents below, and a dash for a day with nothing.
export function chartAmount(n: number): string {
  if (!(n > 0)) return '—'
  return `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`
}

const usd = (n: number) => `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`

// Terminal cells a string takes: wide (CJK) characters are two.
export function cellWidth(text: string): number {
  let n = 0
  for (const ch of text) n += (ch.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1
  return n
}

function center(text: string, width: number): string {
  const room = Math.max(0, width - cellWidth(text))
  const left = Math.floor(room / 2)
  return ' '.repeat(left) + text + ' '.repeat(room - left)
}

// The weekday of a YYYYMMDD day: Mon, Tue ...; in Chinese a single character.
export function weekdayOf(day: string, lang: 'en' | 'zh'): string {
  const d = new Date(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8)))
  return lang === 'zh' ? '日一二三四五六'[d.getDay()]! : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]!
}

export type TextChart = { days: DayCost[]; colWidth: number; amounts: string[]; bars: string[]; labels: string[]; today: number }

// The terminal's week chart: dollar amounts, bars and weekdays in fixed-width columns that line up. Seven columns of
// six characters if they fit `columns`, else of four, else only the last four days. The last day is today.
export function textChart(series: readonly DayCost[], columns: number, lang: 'en' | 'zh'): TextChart {
  const fits = (n: number, w: number) => n * w + 2 <= columns
  const [count, colWidth] =
    fits(series.length, 6) ? [series.length, 6]
      : fits(series.length, 4) ? [series.length, 4]
        : fits(4, 6) ? [4, 6] : [4, 4]
  const days = series.slice(-count)
  const max = Math.max(0, ...days.map(d => d.cost))
  const barWidth = colWidth >= 6 ? 3 : 2
  // Whole dollars from $10 and cents below; a column too narrow for that takes tenths, then whole dollars, then thousands.
  const amount = (n: number) => {
    const options = n < 10 ? [chartAmount(n), `$${n.toFixed(1)}`, `$${Math.round(n)}`] : [chartAmount(n), `$${(n / 1000).toFixed(1)}k`, `${(n / 1000).toFixed(1)}k`]
    return options.find(o => cellWidth(o) <= colWidth) ?? options.at(-1)!
  }
  return {
    days,
    colWidth,
    amounts: days.map(d => center(amount(d.cost), colWidth)),
    bars: days.map(d => d.cost > 0 && max > 0
      ? center(SPARK[Math.min(SPARK.length - 1, Math.round((d.cost / max) * (SPARK.length - 1)))]!.repeat(barWidth), colWidth)
      : ' '.repeat(colWidth)),
    labels: days.map(d => center(weekdayOf(d.day, lang), colWidth)),
    today: days.length - 1,
  }
}

// What the chart says for a reader that cannot see it.
export function chartAlt(days: readonly DayCost[]): string {
  const cost = days.reduce((s, d) => s + d.cost, 0)
  const base = days.reduce((s, d) => s + d.baseline, 0)
  return `Spend over the last ${days.length} days: ${usd(cost)}, against ${usd(base)} for the same work tokens at Opus prices.`
}

// Bars are the cost, each with its dollar amount above it where the amount fits (a dash for a day with nothing); a thin
// marker across each is the Opus-priced baseline; the weekday is below, today's in the accent colour. Fixed mid-tone
// colours that read on a light and a dark surface alike, since an image cannot follow the theme. About 80px tall, text at
// 11px.
export function barChartSvg(days: readonly DayCost[], width = 320, height = 80, labels?: readonly string[], today = days.length - 1): string {
  const font = 11
  const top = 16
  const bottom = 14
  const plot = height - top - bottom
  const max = Math.max(0.0001, ...days.flatMap(d => [d.cost, d.baseline]))
  const slot = width / Math.max(1, days.length)
  const barW = Math.max(4, Math.floor(slot * 0.5))
  const y = (v: number) => top + plot - (v / max) * plot
  const parts = days.map((d, i) => {
    const x = Math.round(i * slot + (slot - barW) / 2)
    const h = Math.max(d.cost > 0 ? 1 : 0, (d.cost / max) * plot)
    const barTop = top + plot - h
    const label = chartAmount(d.cost)
    // About 0.6em a character: a label that does not fit its slot is left off, the bar and the day stay.
    const fits = label.length * font * 0.6 <= slot - 2
    const at = x + barW / 2
    return `<rect x="${x}" y="${barTop.toFixed(1)}" width="${barW}" height="${h.toFixed(1)}" rx="2" fill="#4f8cff"/>` +
      (d.baseline > 0 ? `<rect x="${x - 2}" y="${(y(d.baseline) - 1).toFixed(1)}" width="${barW + 4}" height="2" fill="#e0a030"/>` : '') +
      (fits ? `<text x="${at}" y="${Math.max(font, Math.min(barTop, d.baseline > 0 ? y(d.baseline) : barTop) - 3).toFixed(1)}" font-size="${font}" text-anchor="middle" fill="#8a8f98">${label}</text>` : '') +
      `<text x="${at}" y="${height - 2}" font-size="${font}" text-anchor="middle" ${i === today ? 'font-weight="bold" fill="#4f8cff"' : 'fill="#8a8f98"'}>${labels?.[i] ?? d.day.slice(6)}</text>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${parts.join('')}</svg>`
}
