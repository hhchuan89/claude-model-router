import type { ModelKey, Tally } from '../types'

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

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

// Tally.baseline: what the same tokens would have cost on Opus, the "everything on Opus" baseline.
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

export function add(t: Tally, modelId: string, u: Usage): Tally {
  const key = priceKey(modelId)
  const cost = costOf(u, key)
  const tokens = tokensOf(u)
  const prev = t.byModel[key] ?? { tokens: 0, cost: 0 }
  return {
    tokens: t.tokens + tokens,
    cost: t.cost + cost,
    baseline: t.baseline + costOf(u, 'opus'),
    byModel: { ...t.byModel, [key]: { tokens: prev.tokens + tokens, cost: prev.cost + cost } },
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

// A downgrade costs a cold read of the whole context on the new model. Keep the warm model when
// that costs more than the cheaper model saves over the turn's expected steps and output.
export function keepWarm(target: ModelKey, last: LastRequest | null, now: number, shape: Shape): ModelKey {
  if (!last || RANK[target] >= RANK[last.model] || now - last.at > CACHE_TTL_MS) return target
  const steps = Math.max(1, shape.steps)
  const out = Math.max(0, shape.output)
  const ctx = last.context
  const stay = steps * (ctx * PRICES[last.model].read + out * PRICES[last.model].output)
  const move =
    ctx * PRICES[target].write + (steps - 1) * ctx * PRICES[target].read + steps * out * PRICES[target].output
  return stay < move ? last.model : target
}

// Which model a subagent gets when the call names none: by its type first, else by its task's tier.
export function subagentModel(type: string | undefined, tier: 'lookup' | 'execute' | 'decide' | null): ModelKey {
  if (type === 'Explore') return 'haiku'
  if (type === 'Plan') return 'opus'
  if (tier === 'lookup') return 'haiku'
  if (tier === 'decide') return 'opus'
  return 'sonnet'
}
