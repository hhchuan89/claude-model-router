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

export function familyOf(model: string | undefined): Family | undefined {
  const m = model?.toLowerCase() ?? ''
  return (['fable', 'opus', 'sonnet', 'haiku'] as const).find(f => m.includes(f))
}

// The highest tier a subagent may run on: the parent's, and never Fable.
function ceilingOf(parentModel: string | undefined): ModelKey {
  const parent = familyOf(parentModel) ?? 'opus'
  return parent === 'fable' ? 'opus' : parent
}

function clamp(target: Family, ceiling: ModelKey): ModelKey {
  return RANK[target] > RANK[ceiling] ? ceiling : (target as ModelKey)
}

// model undefined: the spawn goes on as the caller made it (inherit); the reason is still logged.
export type Decision = { model: ModelKey | undefined; reason: string; fable?: boolean }

type SpawnFacts = Pick<AgentSpawnInput, 'subagentType' | 'model' | 'parentModel' | 'fork' | 'workflow'>

// Only a general-purpose agent the call gave no model needs the classifier.
export function needsClassifier(e: SpawnFacts): boolean {
  return !e.fork && e.workflow === undefined && e.model === undefined && e.subagentType === 'general-purpose'
}

// undefined: leave the spawn exactly as the caller made it. tier: the classifier's verdict on a
// general-purpose task, null when it failed (or was not asked).
// sure: the classifier's confidence. An unsure lookup never goes to Haiku: the verdict was a guess, and
// a wrong guess on the cheapest model costs a failed run, a wrong guess one tier up costs a few cents.
export function decideSpawn(e: SpawnFacts, tier: Tier | null, sure = true): Decision | undefined {
  if (e.fork || e.workflow !== undefined) return undefined
  const ceiling = ceilingOf(e.parentModel)
  const parentIsFable = familyOf(e.parentModel) === 'fable'
  // Inheriting a Fable parent would run Fable: pin Opus instead.
  const inherit = (reason: string): Decision =>
    parentIsFable ? { model: 'opus', reason: 'no Fable tier', fable: true } : { model: undefined, reason }

  if (e.model !== undefined) {
    const asked = familyOf(e.model)
    // An id or `inherit` we cannot rank is left alone, unless it would run Fable.
    if (asked === undefined) return parentIsFable ? inherit('') : undefined
    const model = clamp(asked, ceiling)
    return model === asked ? undefined : { model, reason: `asked ${asked}, capped at ${model}`, fable: asked === 'fable' }
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
  model: string | undefined
  effort: Effort | undefined
  ceiling: ModelKey
  parentModel: string
  errorsInARow: number
  // Whether the automatic ladder has already spent its same-model retry (more effort) at this tier.
  retriedAtTier: boolean
}

// The tier a started agent is on: what the engine resolved it to, and whether this router pinned it.
export function startOf(resolved: string | undefined, parentModel: string, isPinned: boolean, ids: Record<ModelKey, string>): AgentTier {
  const ceiling = ceilingOf(parentModel)
  const tier = clamp(familyOf(resolved) ?? ceiling, ceiling)
  return {
    tier,
    model: isPinned ? ids[tier] : undefined,
    effort: isPinned ? START_EFFORT[tier] : undefined,
    ceiling,
    parentModel,
    errorsInARow: 0,
    retriedAtTier: false,
  }
}

export type SubEscalateRequest = { model?: string; effort?: string }

// Only up, never past the ceiling. undefined: nothing would change.
export function escalateAgent(s: AgentTier, req: SubEscalateRequest, ids: Record<ModelKey, string>): AgentTier | undefined {
  const askedModel = familyOf(req.model)
  const tier = askedModel === undefined ? s.tier : clamp(RANK[askedModel] > RANK[s.tier] ? askedModel : s.tier, s.ceiling)
  // A new tier starts no lower than its own starting effort: haiku raised to sonnet runs at least medium.
  const asked = EFFORTS.indexOf(req.effort as Effort)
  // A tier change starts the new model at its starting effort (or the asked one, if higher), not at the
  // old model's effort; on the same model effort only goes up.
  const effort =
    tier !== s.tier
      ? EFFORTS[Math.max(asked, EFFORTS.indexOf(START_EFFORT[tier]))]
      : asked > (s.effort === undefined ? -1 : EFFORTS.indexOf(s.effort))
        ? EFFORTS[asked]
        : s.effort
  if (tier === s.tier && effort === s.effort) return undefined
  // A tier change is a fresh start for the automatic ladder; an effort-only change is not.
  return { ...s, tier, model: tier === s.tier ? s.model : ids[tier], effort, retriedAtTier: tier === s.tier ? s.retriedAtTier : false }
}

// The automatic ladder, one step per call. First more effort on the same model (cheaper than a model
// switch, and often enough), then the next tier at its starting effort; at the ceiling effort only,
// until max. undefined: nothing left to raise.
export function stepUp(s: AgentTier, ids: Record<ModelKey, string>): AgentTier | undefined {
  const nextEffort = EFFORTS[(s.effort === undefined ? EFFORTS.indexOf('high') : EFFORTS.indexOf(s.effort)) + 1]
  if (!s.retriedAtTier && nextEffort !== undefined) {
    const up = escalateAgent(s, { effort: nextEffort }, ids)
    return up && { ...up, retriedAtTier: true }
  }
  const next = (['haiku', 'sonnet', 'opus'] as const)[RANK[s.tier] + 1]
  if (next !== undefined && RANK[next] <= RANK[s.ceiling]) return escalateAgent(s, { model: next }, ids)
  return nextEffort === undefined ? undefined : escalateAgent(s, { effort: nextEffort }, ids)
}

export function describeTier(s: AgentTier): string {
  return `${s.tier}${s.effort ? `/${s.effort}` : ''}`
}

// The events log for the weekly report (tiering_report.py): one file per session in ~/.claude/model-tiering.
export type UsageStats = { steps: number; input: number; output: number; cacheRead: number; cacheWrite: number }
export type AgentStats = { byModel: Record<string, UsageStats>; byEffort: Record<string, number> }
export type EventLog = {
  sessionId: string
  events: { at: string; agentId: string; event: string; to: string; reason: string }[]
  stats: Record<string, AgentStats>
}

// ~/.claude/model-tiering, found from where the plugin lives under ~/.claude.
export function logDir(pluginRoot: string): string {
  const root = pluginRoot.split('\\').join('/')
  const at = root.toLowerCase().lastIndexOf('/.claude/')
  return `${at < 0 ? root : root.slice(0, at + '/.claude'.length)}/model-tiering`
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
