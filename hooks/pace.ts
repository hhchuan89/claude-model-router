// Weekly pacing: how fast the seven-day usage window is being used against an even spend over the week.
export const WEEK_MS = 7 * 24 * 3600 * 1000
// Too early in the window to judge: a burst on day one says nothing about the week.
export const MIN_ELAPSED = 0.1
// Below this much used, being "ahead" is noise.
export const MIN_USED = 25
export const AHEAD_PACE = 1.2

export type PaceState = 'ahead' | 'ok' | 'unknown'
export type Pace = { used: number; elapsed: number; pace: number; state: PaceState }
export type PaceMode = 'off' | 'warn' | 'steer'
export const PACE_MODES: readonly PaceMode[] = ['off', 'warn', 'steer']

export function isPaceMode(x: unknown): x is PaceMode {
  return typeof x === 'string' && (PACE_MODES as readonly string[]).includes(x)
}

type Limit = { kind?: string; percentUsed: number; resetsAt?: string }

// The window is the 7 days ending at resetsAt; elapsed is the fraction of it gone, pace is used over elapsed
// (1 = an even spend). Unknown without a seven_day window or a reset time, or before a tenth of the window has gone.
export function paceOf(limit: Limit | undefined, now: number): Pace {
  const unknown: Pace = { used: limit?.percentUsed ?? 0, elapsed: 0, pace: 0, state: 'unknown' }
  if (!limit || (limit.kind !== undefined && limit.kind !== 'seven_day') || !limit.resetsAt) return unknown
  const end = new Date(limit.resetsAt).getTime()
  if (!Number.isFinite(end) || !Number.isFinite(limit.percentUsed)) return unknown
  const elapsed = Math.min(1, Math.max(0, 1 - (end - now) / WEEK_MS))
  if (elapsed < MIN_ELAPSED) return { ...unknown, elapsed }
  const used = limit.percentUsed
  const pace = used / 100 / elapsed
  return { used, elapsed, pace, state: used >= MIN_USED && pace >= AHEAD_PACE ? 'ahead' : 'ok' }
}

export function fmtPace(p: Pace): string {
  return `${p.pace.toFixed(1)}×`
}

// Two readings of the same weekly window may differ by seconds; windows are a week apart.
export function sameWindow(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false
  const x = new Date(a).getTime()
  const y = new Date(b).getTime()
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) < WEEK_MS / 2
}
