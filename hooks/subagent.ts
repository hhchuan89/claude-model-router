import type { AgentSpawnInput } from 'claude-code'

import type { Effort, ModelKey, Tier } from '../types'
import { EFFORTS } from './route'

// Subagent tiering: tier by what the subagent does with its context, default down, the top tier
// is "inherit" (never a pinned Opus), never above the parent, never Fable. Pure rules: the hooks in
// register.tsx do the engine calls.

export type Family = ModelKey | 'fable'

const RANK: Record<Family, number> = { haiku: 0, sonnet: 1, opus: 2, fable: 3 }
// Starting effort per pinned tier: medium everywhere, since effort can be raised later (by the agent or
// the automatic ladder). A subagent raised to a new tier starts that tier at medium, whatever effort it
// had before: a bigger model at medium beats a smaller one at max. An inheriting agent keeps the session's.
const START_EFFORT: Record<ModelKey, Effort> = { haiku: 'medium', sonnet: 'medium', opus: 'medium' }
export const AUTO_ESCALATE_AFTER = 3

// Who may raise a subagent how far. xhigh and max belong to the main conversation's own thread: a subagent
// never reaches them, so a failing one hands the problem back instead of thinking longer (the main thread
// verifies what subagents return).
// 1. By itself (the automatic ladder and its own `escalate`): never above Opus at medium; lower models
//    keep their effort steps (haiku and sonnet up to high).
export const SUBAGENT_SELF_CAP: { model: ModelKey; effort: Effort } = { model: 'opus', effort: 'medium' }
export const SELF_EFFORT_CAP: Record<ModelKey, Effort> = { haiku: 'high', sonnet: 'high', opus: SUBAGENT_SELF_CAP.effort }
// 2. Raised by the main conversation (`escalate` with `agent`): never above Opus at high.
export const MAIN_RAISE_CAP: { model: ModelKey; effort: Effort } = { model: 'opus', effort: 'high' }
// 3. Whatever a tracked subagent is sent, including one that inherits the session's effort: never above this.
export const HARD_EFFORT_CAP: Effort = 'high'

// The engine's effort type also allows a number, which has no named rank here and passes through.
export function capSent<T extends Effort | number | undefined>(effort: T): T | Effort {
  return typeof effort === 'string' && EFFORTS.indexOf(effort) > EFFORTS.indexOf(HARD_EFFORT_CAP) ? HARD_EFFORT_CAP : effort
}

export function familyOf(model: string | undefined): Family | undefined {
  const m = model?.toLowerCase() ?? ''
  return (['fable', 'opus', 'sonnet', 'haiku'] as const).find(f => m.includes(f))
}

// The highest tier a subagent may run on: the parent's, and never Fable.
function ceilingOf(parentModel: string | undefined): ModelKey {
  const parent = familyOf(parentModel) ?? 'opus'
  return parent === 'fable' ? 'opus' : parent
}

// The effort a tracked subagent counts as running at when it inherits the session's.
const INHERITED_EFFORT: Effort = 'high'

function clamp(target: Family, ceiling: ModelKey): ModelKey {
  return RANK[target] > RANK[ceiling] ? ceiling : (target as ModelKey)
}

// model undefined: the spawn goes on as the caller made it (inherit); the reason is still logged.
export type Decision = { model: ModelKey | undefined; reason: string; fable?: boolean }

type SpawnFacts = Pick<AgentSpawnInput, 'subagentType' | 'model' | 'parentModel' | 'fork' | 'workflow'>

// A model the caller named that the router can rank, below Fable: such an agent starts at medium (see startOf).
// `inherit`, an unknown id and Fable are not pins of a tier.
export function isCallerPin(model: string | undefined): boolean {
  const f = familyOf(model)
  return f !== undefined && f !== 'fable'
}

// Only a general-purpose agent the call gave no model needs the classifier.
export function needsClassifier(e: SpawnFacts): boolean {
  return !e.fork && e.workflow === undefined && e.model === undefined && e.subagentType === 'general-purpose'
}

// undefined: leave the spawn exactly as the caller made it. tier: the classifier's verdict on a
// general-purpose task, null when it failed (or was not asked).
// sure: the classifier's confidence. An unsure lookup never goes to Haiku: the verdict was a guess, and
// a wrong guess on the cheapest model costs a failed run, a wrong guess one tier up costs a few cents.
// blockFable false: Fable is left alone (a Fable parent's agents inherit it, an agent asking for Fable under a Fable
// parent keeps it); the parent's tier is still the ceiling, so a lower parent still caps a Fable ask.
export function decideSpawn(e: SpawnFacts, tier: Tier | null, sure = true, blockFable = true): Decision | undefined {
  if (e.fork || e.workflow !== undefined) return undefined
  const ceiling = ceilingOf(e.parentModel)
  const parentIsFable = blockFable && familyOf(e.parentModel) === 'fable'
  // Inheriting a Fable parent would run Fable: pin Opus instead.
  const inherit = (reason: string): Decision =>
    parentIsFable ? { model: 'opus', reason: 'no Fable tier', fable: true } : { model: undefined, reason }

  if (e.model !== undefined) {
    const asked = familyOf(e.model)
    // An id or `inherit` we cannot rank is left alone, unless it would run Fable.
    if (asked === undefined) return parentIsFable ? inherit('') : undefined
    // Under a Fable parent that is allowed to run Fable, an agent asking for Fable is within its ceiling.
    if (asked === 'fable' && !blockFable && familyOf(e.parentModel) === 'fable') return undefined
    const model = clamp(asked, ceiling)
    return model === asked ? undefined : { model, reason: `asked ${asked}, capped at ${model}`, fable: asked === 'fable' && blockFable }
  }

  if (e.subagentType === 'Explore') return { model: clamp('haiku', ceiling), reason: 'Explore: lookup' }
  // Plan and named/custom agents declare their own model or inherit.
  if (e.subagentType !== 'general-purpose') return inherit('agent keeps its own model')
  if (tier === 'decide') return inherit('decision work, inherits')
  if (tier === 'lookup' && !sure) return { model: clamp('sonnet', ceiling), reason: 'unsure lookup: sonnet' }
  const target: ModelKey = tier === 'lookup' ? 'haiku' : 'sonnet'
  return { model: clamp(target, ceiling), reason: tier === null ? 'classifier failed, sonnet' : `${tier} work` }
}

// What a running subagent is on now. `model` undefined: as spawned (inherit); `effort` undefined:
// the session's.
export type AgentTier = {
  tier: ModelKey
  // Resolved at spawn, then observed on requests: accounting must not use the clamped policy tier for Fable.
  family: Family
  model: string | undefined
  effort: Effort | undefined
  ceiling: ModelKey
  parentModel: string
  errorsInARow: number
  // Whether the automatic ladder has already spent its same-model retry (more effort) at this tier.
  retriedAtTier: boolean
}

// Whether a tier starting at its starting effort can still raise its effort by itself.
function roomToRise(tier: ModelKey): boolean {
  return EFFORTS.indexOf(START_EFFORT[tier]) < EFFORTS.indexOf(SELF_EFFORT_CAP[tier])
}

// The tier a started agent is on: what the engine resolved it to, and whether this router pinned it.
// callerPinned: the caller named a model the router left as it was. Its model is the caller's but it starts at medium like
// a router pin: otherwise it ran at the session's effort (high, once capped), against "every tier starts at medium".
// Except where medium is already the tier's own effort cap (Opus): there it would sit at the self cap with no way up of
// its own, so an Opus pin keeps the session's effort, as before.
export function startOf(
  resolved: string | undefined,
  parentModel: string,
  isPinned: boolean,
  ids: Record<ModelKey, string>,
  callerPinned = false,
): AgentTier {
  const ceiling = ceilingOf(parentModel)
  const tier = clamp(familyOf(resolved) ?? ceiling, ceiling)
  return {
    tier,
    family: familyOf(resolved) ?? tier,
    model: isPinned ? ids[tier] : undefined,
    effort: isPinned || (callerPinned && roomToRise(tier)) ? START_EFFORT[tier] : undefined,
    ceiling,
    parentModel,
    errorsInARow: 0,
    retriedAtTier: false,
  }
}

export type SubEscalateRequest = { model?: string; effort?: string }
// self: the subagent itself (or the automatic ladder). main: the main conversation raising it.
export type RaisedBy = 'self' | 'main'

// The most a subagent on `tier` may be raised to, by `by`. The model never passes the parent's tier (s.ceiling)
// and never the cap's model; effort is capped per who raises it.
export function modelCap(s: AgentTier, by: RaisedBy): ModelKey {
  const cap = by === 'main' ? MAIN_RAISE_CAP.model : SUBAGENT_SELF_CAP.model
  return RANK[cap] < RANK[s.ceiling] ? cap : s.ceiling
}

export function effortCap(tier: ModelKey, by: RaisedBy): Effort {
  return by === 'main' ? MAIN_RAISE_CAP.effort : SELF_EFFORT_CAP[tier]
}

// Only up, never past the caps. undefined: nothing would change.
export function escalateAgent(
  s: AgentTier,
  req: SubEscalateRequest,
  ids: Record<ModelKey, string>,
  by: RaisedBy = 'self',
): AgentTier | undefined {
  const askedModel = familyOf(req.model)
  const tier = askedModel === undefined ? s.tier : clamp(RANK[askedModel] > RANK[s.tier] ? askedModel : s.tier, modelCap(s, by))
  // A request for more than the cap is the cap; a request below what the agent already has changes nothing.
  const cap = EFFORTS.indexOf(effortCap(tier, by))
  const wanted = EFFORTS.indexOf(req.effort as Effort)
  const asked = wanted > cap ? cap : wanted
  // A tier change starts the new model at its starting effort (or the asked one, if higher), not at the
  // old model's effort; on the same model effort only goes up. An inheriting agent counts as high.
  const effort =
    tier !== s.tier
      ? EFFORTS[Math.max(asked, EFFORTS.indexOf(START_EFFORT[tier]))]
      : asked > EFFORTS.indexOf(s.effort ?? INHERITED_EFFORT)
        ? EFFORTS[asked]
        : s.effort
  if (tier === s.tier && effort === s.effort) return undefined
  // A tier change is a fresh start for the automatic ladder; an effort-only change is not.
  return { ...s, tier, model: tier === s.tier ? s.model : ids[tier], effort, retriedAtTier: tier === s.tier ? s.retriedAtTier : false }
}

// The automatic ladder, one step per call, always by the subagent's own authority: first more effort on the same
// model (cheaper than a model switch, and often enough), then the next tier at its starting effort; it stops at
// the self cap (opus/medium, or the parent's tier if lower, with that tier's own effort step).
// undefined: nothing left to raise.
export function stepUp(s: AgentTier, ids: Record<ModelKey, string>): AgentTier | undefined {
  const raised = EFFORTS[EFFORTS.indexOf(s.effort ?? INHERITED_EFFORT) + 1]
  const nextEffort = raised !== undefined && EFFORTS.indexOf(raised) <= EFFORTS.indexOf(effortCap(s.tier, 'self')) ? raised : undefined
  if (!s.retriedAtTier && nextEffort !== undefined) {
    const up = escalateAgent(s, { effort: nextEffort }, ids)
    return up && { ...up, retriedAtTier: true }
  }
  const next = (['haiku', 'sonnet', 'opus'] as const)[RANK[s.tier] + 1]
  if (next !== undefined && RANK[next] <= RANK[modelCap(s, 'self')]) return escalateAgent(s, { model: next }, ids)
  return nextEffort === undefined ? undefined : escalateAgent(s, { effort: nextEffort }, ids)
}

export function describeTier(s: AgentTier): string {
  return `${s.tier}${s.effort ? `/${s.effort}` : ''}`
}

// The events log, for your own analysis: batches per session in ~/.claude/model-router.
export type UsageStats = { steps: number; input: number; output: number; cacheRead: number; cacheWrite: number }
export type AgentStats = { byModel: Record<string, UsageStats>; byEffort: Record<string, number> }
export type EventLog = {
  sessionId: string
  events: { id?: string; at: string; agentId: string; event: string; to: string; reason: string }[]
  stats: Record<string, AgentStats>
}

// ~/.claude/model-router, found from where the plugin lives under ~/.claude.
export function logDir(pluginRoot: string): string {
  const root = pluginRoot.split('\\').join('/')
  const at = root.toLowerCase().lastIndexOf('/.claude/')
  return `${at < 0 ? root : root.slice(0, at + '/.claude'.length)}/model-router`
}

export function addUsage(
  stats: AgentStats | undefined,
  model: string,
  effort: string | undefined,
  u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number },
): AgentStats {
  const s: AgentStats = stats ?? { byModel: {}, byEffort: {} }
  const m = s.byModel[model] ?? { steps: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const key = effort ?? 'default'
  return {
    byModel: {
      ...s.byModel,
      [model]: {
        steps: m.steps + 1,
        input: m.input + u.input_tokens,
        output: m.output + u.output_tokens,
        cacheRead: m.cacheRead + u.cache_read_input_tokens,
        cacheWrite: m.cacheWrite + u.cache_creation_input_tokens,
      },
    },
    byEffort: { ...s.byEffort, [key]: (s.byEffort[key] ?? 0) + 1 },
  }
}
