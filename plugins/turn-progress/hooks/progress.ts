import type { Run } from '../types'

export const CLAY = '#D97757'

// Without a task list the bar is an estimate: it eases toward 90% and never claims done.
export function timeFraction(elapsedMs: number, tauMs: number): number {
  return 0.9 * (1 - Math.exp(-elapsedMs / Math.max(tauMs, 1000)))
}

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

export type TaskStats = { total: number; done: number; active: number }

export function taskStats(run: Run): TaskStats {
  const states = run.order.map(id => run.tasks[id]).filter(s => s !== undefined)
  return {
    total: states.length,
    done: states.filter(s => s === 'completed').length,
    active: states.filter(s => s === 'in_progress').length,
  }
}

// Finish time projected from the pace of the tasks done so far; none before the first one.
export function etaMs(stats: TaskStats, startedAt: number, now: number): number | null {
  if (stats.done === 0 || stats.done >= stats.total) return null
  const perTask = (now - startedAt) / stats.done
  return now + perTask * (stats.total - stats.done)
}

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

export function fmtClock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const W = 1000
// The drawing is 14 tall so the glow has room; the bar itself is 8, centred.
export const SVG_H = 14
const Y = 3
const H = 8
// Mid gray at low opacity reads as an empty track on both a light and a dark band.
const TRACK = 'fill="#888888" fill-opacity="0.25"'

function svg(body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${SVG_H}" viewBox="0 0 ${W} ${SVG_H}" preserveAspectRatio="none">${body}</svg>`
}

// Shared paint: the clay-to-coral gradient across the whole width, the light that sweeps over it, and a soft glow.
const DEFS =
  `<linearGradient id="g" x1="0" x2="${W}" gradientUnits="userSpaceOnUse">` +
  `<stop offset="0" stop-color="${CLAY}"/><stop offset=".6" stop-color="#E8906F"/><stop offset="1" stop-color="#F2B8A0"/></linearGradient>` +
  `<linearGradient id="sw" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/>` +
  `<stop offset=".5" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>` +
  `<filter id="glow" x="-20%" y="-200%" width="140%" height="500%"><feGaussianBlur stdDeviation="4"/></filter>`

function sweep(to: number): string {
  return `<rect x="-200" y="${Y}" width="200" height="${H}" fill="url(#sw)"><animate attributeName="x" from="-200" to="${to}" dur="2.4s" repeatCount="indefinite"/></rect>`
}

// Steps of 2%, so the drawing stays the same between most once-a-second redraws and its animation runs on.
export function quantize(p: number): number {
  return Math.round(Math.max(0, Math.min(1, p)) * 50) / 50
}

// Estimate mode: gradient fill with a light sweep, plus drifting stripes so it never reads as measured progress.
export function estimateSvg(p: number): string {
  const w = Math.max(H, Math.round(W * quantize(p)))
  return svg(
    `<defs>${DEFS}` +
      `<pattern id="st" width="18" height="${SVG_H}" patternUnits="userSpaceOnUse" patternTransform="skewX(-30)">` +
      `<rect width="7" height="${SVG_H}" fill="#fff" fill-opacity=".14"/>` +
      `<animateTransform attributeName="patternTransform" type="translate" from="0 0" to="18 0" dur="1.2s" repeatCount="indefinite" additive="sum"/></pattern>` +
      `<clipPath id="c"><rect x="0" y="${Y}" width="${w}" height="${H}" rx="${H / 2}"/></clipPath></defs>` +
      `<rect x="0" y="${Y}" width="${W}" height="${H}" rx="${H / 2}" ${TRACK}/>` +
      `<rect x="${Math.max(0, w - 40)}" y="${Y}" width="40" height="${H}" rx="${H / 2}" fill="#E8906F" filter="url(#glow)" opacity=".8"/>` +
      `<g clip-path="url(#c)"><rect x="0" y="${Y}" width="${w}" height="${H}" fill="url(#g)"/>` +
      `<rect x="0" y="${Y}" width="${w}" height="${H}" fill="url(#st)"/>${sweep(w + 200)}</g>`,
  )
}

// Task mode: one segment per task; done in the gradient with the sweep over it, the running one pulsing, pending dim.
export function taskSvg(states: readonly string[]): string {
  const n = Math.max(states.length, 1)
  const gap = 6
  const seg = (W - gap * (n - 1)) / n
  const x = (i: number) => (i * (seg + gap)).toFixed(1)
  const rect = (i: number, paint: string) =>
    `<rect x="${x(i)}" y="${Y}" width="${seg.toFixed(1)}" height="${H}" rx="${H / 2}" ${paint}`
  const done = states.map((s, i) => (s === 'completed' ? i : -1)).filter(i => i >= 0)
  const doneEnd = done.length > 0 ? Number(x(done[done.length - 1]!)) + seg : 0
  return svg(
    `<defs>${DEFS}<clipPath id="d">${done.map(i => `${rect(i, 'fill="#000"')}/>`).join('')}</clipPath></defs>` +
      states
        .map((s, i) =>
          s === 'completed'
            ? `${rect(i, 'fill="url(#g)"')}/>`
            : s === 'in_progress'
              ? `${rect(i, 'fill="#E8906F" fill-opacity=".45"')}><animate attributeName="fill-opacity" values=".3;.7;.3" dur="1.6s" repeatCount="indefinite"/></rect>`
              : `${rect(i, TRACK)}/>`,
        )
        .join('') +
      (done.length > 0 ? `<g clip-path="url(#d)">${sweep(doneEnd + 200)}</g>` : ''),
  )
}

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

// Terminal: eighth blocks give the bar sub-cell steps; returns the filled part and the rest.
export function blocks(p: number, width: number): { filled: string; rest: string } {
  const cells = Math.max(0, Math.min(1, p)) * width
  const full = Math.floor(cells)
  const part = EIGHTHS[Math.floor((cells - full) * 8)] ?? ''
  const used = full + (part === '' ? 0 : 1)
  return { filled: '█'.repeat(full) + part, rest: '─'.repeat(Math.max(0, width - used)) }
}
