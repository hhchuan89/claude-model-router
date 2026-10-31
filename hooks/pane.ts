// Pure helpers for the router pane: no engine calls, so they are unit tested directly.
export const SPARK = '▁▂▃▄▅▆▇█'

export type DayCost = { day: string; cost: number; baseline: number }

// One block per value, scaled to the largest; zero is the lowest block.
export function sparkline(values: readonly number[]): string {
  const max = Math.max(0, ...values)
  return values.map(v => SPARK[max > 0 ? Math.min(SPARK.length - 1, Math.round((v / max) * (SPARK.length - 1))) : 0]).join('')
}

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

const usd = (n: number) => `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`

// What the chart says for a reader that cannot see it.
export function chartAlt(days: readonly DayCost[]): string {
  const cost = days.reduce((s, d) => s + d.cost, 0)
  const base = days.reduce((s, d) => s + d.baseline, 0)
  return `Spend over the last ${days.length} days: ${usd(cost)}, against ${usd(base)} for the same work tokens at Opus prices.`
}

// Bars are the cost; a thin marker across each is the Opus-priced baseline. Fixed mid-tone colours that read on a
// light and a dark surface alike, since an image cannot follow the theme.
export function barChartSvg(days: readonly DayCost[], width = 320, height = 96): string {
  const top = 6
  const bottom = 16
  const plot = height - top - bottom
  const max = Math.max(0.0001, ...days.flatMap(d => [d.cost, d.baseline]))
  const slot = width / Math.max(1, days.length)
  const barW = Math.max(4, Math.floor(slot * 0.55))
  const y = (v: number) => top + plot - (v / max) * plot
  const parts = days.map((d, i) => {
    const x = Math.round(i * slot + (slot - barW) / 2)
    const h = Math.max(d.cost > 0 ? 1 : 0, (d.cost / max) * plot)
    return `<rect x="${x}" y="${(top + plot - h).toFixed(1)}" width="${barW}" height="${h.toFixed(1)}" rx="2" fill="#4f8cff"/>` +
      (d.baseline > 0 ? `<rect x="${x - 2}" y="${(y(d.baseline) - 1).toFixed(1)}" width="${barW + 4}" height="2" fill="#e0a030"/>` : '') +
      `<text x="${x + barW / 2}" y="${height - 4}" font-size="9" text-anchor="middle" fill="#8a8f98">${d.day.slice(6)}</text>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${parts.join('')}</svg>`
}

// "opus · high (why)" as the trail stores it becomes "opus/high".
export function trailStep(step: string): string {
  return step.replace(/\s*\(.*\)$/, '').replace(/\s·\s/, '/')
}
