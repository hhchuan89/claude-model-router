export type Tier = 'lookup' | 'execute' | 'decide'
export type ModelKey = 'haiku' | 'sonnet' | 'opus'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type Route = {
  // the turn this route governs; null until the turn starts
  turnId: string | null
  tier: Tier
  model: ModelKey
  effort: Effort
  reason: string
  // escalations made during the turn, oldest first
  trail: string[]
  // the tier's own model, when a warm cache made it cheaper to stay on a bigger one
  keptFrom?: ModelKey
}

export type Tally = {
  tokens: number
  cost: number
  baseline: number
  byModel: Record<string, { tokens: number; cost: number }>
}

declare module 'claude-code' {
  interface PluginState {
    'model-router': {
      route: Route | null
      enabled: boolean
      meter: { turn: Tally; today: Tally }
    }
  }
}
