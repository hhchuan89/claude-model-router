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
}

declare module 'claude-code' {
  interface PluginState {
    'model-router': {
      route: Route | null
      enabled: boolean
    }
  }
}
