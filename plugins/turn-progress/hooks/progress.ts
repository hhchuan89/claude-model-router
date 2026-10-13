import type { Run } from '../types'

export const CLAY = '#D97757'
export const CLAY_LIGHT = '#F0A98E'
const TRACK = 'rgba(128,128,128,0.28)'

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
const H = 8

function svg(body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${body}</svg>`
}

// Estimate mode: one rounded track, a striped fill so it never reads as measured progress.
export function estimateSvg(p: number): string {
  const w = Math.max(H, Math.round(W * p))
  return svg(
    `<defs><pattern id="s" width="16" height="${H}" patternUnits="userSpaceOnUse" patternTransform="skewX(-30)">` +
      `<rect width="16" height="${H}" fill="${CLAY}"/><rect width="7" height="${H}" fill="${CLAY_LIGHT}"/></pattern></defs>` +
      `<rect width="${W}" height="${H}" rx="${H / 2}" fill="${TRACK}"/>` +
      `<rect width="${w}" height="${H}" rx="${H / 2}" fill="url(#s)"/>`,
  )
}

// Task mode: one segment per task; done solid, in progress light, pending track.
export function taskSvg(states: readonly string[]): string {
  const n = Math.max(states.length, 1)
  const gap = 6
  const seg = (W - gap * (n - 1)) / n
  return svg(
    states
      .map((s, i) => {
        const fill = s === 'completed' ? CLAY : s === 'in_progress' ? CLAY_LIGHT : TRACK
        return `<rect x="${(i * (seg + gap)).toFixed(1)}" width="${seg.toFixed(1)}" height="${H}" rx="${H / 2}" fill="${fill}"/>`
      })
      .join(''),
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
