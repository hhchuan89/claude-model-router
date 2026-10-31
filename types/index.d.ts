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
  // The classifier failed on a first turn and there was no earlier route to keep: this turn is unrouted and runs
  // on the session's own model and effort. tier/model/effort are placeholders and are never applied.
  sessionModel?: boolean
  // How the route was reached; the pane shows it and only 'classified' turns can be corrected.
  how?: TurnHow
  // A pacing steer moved this turn from decide to execute (counted once, unless the warm cache kept it on Opus).
  steered?: boolean
}

export type TurnHow = 'classified' | 'forced' | 'pinned' | 'inherited' | 'kept-tier' | 'warm-skip' | 'session-model'

// One main turn as the pane lists it. The prompt snippet is never in here: it stays in memory for corrections.
export type TurnRecord = {
  turnId: string
  at: number
  tier: Tier
  model: ModelKey | 'session'
  effort?: Effort
  keptFrom?: ModelKey
  reason: string
  trail: string[]
  tokens: number
  cost: number
  // The turn's first request rewrote a cold cache (the same detection as the cacheExpiryRewrites counter).
  cold: boolean
  how: TurnHow
  corrected?: Tier
}

export type Tally = {
  tokens: number
  cost: number
  baseline: number
  byModel: Record<string, { tokens: number; cost: number }>
  // Absent on records written before 1.0; those costs cannot be attributed after the fact.
  byRole?: Partial<Record<SpendRole, { tokens: number; cost: number }>>
  byUsage?: Partial<Record<SpendUsage, { tokens: number; cost: number }>>
  peakMainContext?: number
  compactions?: { at: number; before?: number; after?: number }[]
}

export type SpendRole = 'main' | 'subagents' | 'classifier' | 'reviewer' | 'compaction'
export type SpendUsage = 'read' | 'write' | 'input' | 'output'

declare module 'claude-code' {
  interface PluginState {
    'model-router': {
      route: Route | null
      enabled: boolean
      meter: { turn: Tally; today: Tally }
      turns: Shaped<TurnRecord[]>
    }
  }
}
