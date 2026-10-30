import type { ModelKey, SpendRole, SpendUsage, Tally } from '../types'

// USD per million tokens, Anthropic first-party API rates (claude-api skill table, cached 2026-10-06).
// Cache writes are priced at 2x input: Claude Code caches with a 1-hour TTL. Haiku 5.5's cache
// read is not listed; 10% of input, as for the other models, is assumed.
type Price = { input: number; output: number; read: number; write: number }
export const PRICES: Record<ModelKey | 'fable', Price> = {
  haiku: { input: 0.1, output: 0.5, read: 0.01, write: 0.2 },
  sonnet: { input: 2, output: 10, read: 0.2, write: 4 },
  opus: { input: 4, output: 20, read: 0.2, write: 8 },
  fable: { input: 10, output: 50, read: 0.25, write: 20 },
}
export const CACHE_TTL_MS = 60 * 60 * 1000
// A warm main-thread context this big is never moved to a lower model: leaving Opus and coming back within the
// cache TTL rewrote the whole Opus cache (200k-800k tokens), which cost far more than the cheaper model saved.
export const WARM_CONTEXT_KEEP = 50_000

// Checkpoint hints assume one cached read to summarise, 8k output, then a 40k summary written back.
// Fifteen future steps must save more in cached reads than that whole cost; this is a hint, never an auto-compact.
const CHECKPOINT_OUTPUT = 8000
const CHECKPOINT_SUMMARY = 40_000
const CHECKPOINT_STEPS = 15
export const CHECKPOINT_COOLDOWN_MS = 30 * 60_000
export const CHECKPOINT_GROWTH = 1.5

export function checkpointPays(context: number, model: keyof typeof PRICES): boolean {
  const p = PRICES[model]
  const cost = context * p.read + CHECKPOINT_OUTPUT * p.output + CHECKPOINT_SUMMARY * p.write
  const saving = (context - CHECKPOINT_SUMMARY) * p.read * CHECKPOINT_STEPS
  return saving > cost
}

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

// Tally.baseline: the same work tokens at Opus prices; classification and probes are pure overhead.
export const EMPTY: Tally = { tokens: 0, cost: 0, baseline: 0, byModel: {} }

export function priceKey(modelId: string): keyof typeof PRICES {
  const m = /(haiku|sonnet|opus|fable)/i.exec(modelId)
  return (m ? m[1]!.toLowerCase() : 'opus') as keyof typeof PRICES
}

export function costOf(u: Usage, key: keyof typeof PRICES): number {
  const p = PRICES[key]
  return (
    (u.input_tokens * p.input +
      u.output_tokens * p.output +
      u.cache_read_input_tokens * p.read +
      u.cache_creation_input_tokens * p.write) /
    1e6
  )
}

export function tokensOf(u: Usage): number {
  return u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
}

// What the same tokens would have cost had the thread stayed on Opus. A main-thread step that switched model
// family within the cache TTL wrote its context (cache_creation_input_tokens) because of the switch; staying on
// Opus would have read that context from a warm cache, so those tokens are priced at Opus's cache-read rate,
// not its write rate. This applies to a step going down and to the step coming back up to Opus.
export function baselineOf(u: Usage, switched: boolean): number {
  if (!switched) return costOf(u, 'opus')
  return costOf(
    { ...u, cache_read_input_tokens: u.cache_read_input_tokens + u.cache_creation_input_tokens, cache_creation_input_tokens: 0 },
    'opus',
  )
}

// Whether a main-thread step that ran on `key` is a family switch from the previous main step, within the TTL.
export function isSwitchStep(prev: LastRequest | null, key: keyof typeof PRICES, now: number): boolean {
  return prev !== null && prev.model !== key && now - prev.at <= CACHE_TTL_MS
}

export function add(t: Tally, modelId: string, u: Usage, switched = false, overhead = false, role: SpendRole = 'main'): Tally {
  const key = priceKey(modelId)
  const cost = costOf(u, key)
  const tokens = tokensOf(u)
  const prev = t.byModel[key] ?? { tokens: 0, cost: 0 }
  const prevRole = t.byRole?.[role] ?? { tokens: 0, cost: 0 }
  const byUsage = { ...t.byUsage }
  const amounts: Record<SpendUsage, number> = { read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, input: u.input_tokens, output: u.output_tokens }
  for (const kind of Object.keys(amounts) as SpendUsage[]) {
    const prev = byUsage[kind] ?? { tokens: 0, cost: 0 }
    byUsage[kind] = { tokens: prev.tokens + amounts[kind], cost: prev.cost + amounts[kind] * PRICES[key][kind] / 1e6 }
  }
  return {
    ...t,
    tokens: t.tokens + tokens,
    cost: t.cost + cost,
    baseline: t.baseline + (overhead ? 0 : baselineOf(u, switched)),
    byModel: { ...t.byModel, [key]: { tokens: prev.tokens + tokens, cost: prev.cost + cost } },
    byRole: { ...t.byRole, [role]: { tokens: prevRole.tokens + tokens, cost: prevRole.cost + cost } },
    byUsage,
    peakMainContext: Math.max(t.peakMainContext ?? 0, role === 'main' ? tokens - u.output_tokens : 0),
  }
}

export function merge(a: Tally, b: Tally): Tally {
  const byModel = { ...a.byModel }
  for (const [key, v] of Object.entries(b.byModel)) {
    const prev = byModel[key] ?? { tokens: 0, cost: 0 }
    byModel[key] = { tokens: prev.tokens + v.tokens, cost: prev.cost + v.cost }
  }
  const byRole = { ...a.byRole }
  for (const [key, v] of Object.entries(b.byRole ?? {}) as [SpendRole, { tokens: number; cost: number }][]) {
    const prev = byRole[key] ?? { tokens: 0, cost: 0 }
    byRole[key] = { tokens: prev.tokens + v.tokens, cost: prev.cost + v.cost }
  }
  const byUsage = { ...a.byUsage }
  for (const [key, v] of Object.entries(b.byUsage ?? {}) as [SpendUsage, { tokens: number; cost: number }][]) {
    const prev = byUsage[key] ?? { tokens: 0, cost: 0 }
    byUsage[key] = { tokens: prev.tokens + v.tokens, cost: prev.cost + v.cost }
  }
  return {
    tokens: a.tokens + b.tokens, cost: a.cost + b.cost, baseline: a.baseline + b.baseline, byModel, byRole, byUsage,
    peakMainContext: a.peakMainContext === undefined && b.peakMainContext === undefined ? undefined : Math.max(a.peakMainContext ?? 0, b.peakMainContext ?? 0),
    compactions: [...(a.compactions ?? []), ...(b.compactions ?? [])],
  }
}

export function saved(t: Tally): { usd: number; pct: number } {
  const usd = t.baseline - t.cost
  return { usd, pct: t.baseline > 0 ? Math.round((usd / t.baseline) * 100) : 0 }
}

export function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(Math.round(n))
}

export function fmtUsd(n: number): string {
  if (n > 0 && n < 0.01) return '<$0.01'
  return `$${n.toFixed(2)}`
}

const RANK: Record<ModelKey, number> = { haiku: 0, sonnet: 1, opus: 2 }

export type LastRequest = { model: ModelKey; at: number; context: number }
export type Shape = { steps: number; output: number }

// A downgrade costs a cold read of the whole context on the new model, and usually a second rewrite when the
// thread comes back up. Within the cache TTL, a context of WARM_CONTEXT_KEEP tokens or more never moves to a lower
// model; a smaller one keeps the warm model only when the cold read costs more than the cheaper model saves over
// the turn's expected steps and output. Upgrades are never blocked.
export function keepWarm(target: ModelKey, last: LastRequest | null, now: number, shape: Shape): ModelKey {
  if (!last || RANK[target] >= RANK[last.model] || now - last.at > CACHE_TTL_MS) return target
  if (last.context >= WARM_CONTEXT_KEEP) return last.model
  const steps = Math.max(1, shape.steps)
  const out = Math.max(0, shape.output)
  const ctx = last.context
  const stay = steps * (ctx * PRICES[last.model].read + out * PRICES[last.model].output)
  const move =
    ctx * PRICES[target].write + (steps - 1) * ctx * PRICES[target].read + steps * out * PRICES[target].output
  return stay < move ? last.model : target
}

// A main turn that stays on Opus whatever the classifier says: the last main request was Opus, inside the cache TTL,
// with a context of WARM_CONTEXT_KEEP tokens or more, so keepWarm would never move the turn below Opus.
export function isWarmOpus(last: LastRequest | null, now: number): boolean {
  return last !== null && last.model === 'opus' && now - last.at <= CACHE_TTL_MS && last.context >= WARM_CONTEXT_KEEP
}
