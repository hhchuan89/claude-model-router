import type { Effort, ModelKey, Route, Tier } from '../types'

export const TIER_ROUTE: Record<Tier, { model: ModelKey; effort: Effort }> = {
  lookup: { model: 'haiku', effort: 'medium' },
  execute: { model: 'sonnet', effort: 'medium' },
  decide: { model: 'opus', effort: 'medium' },
}

const MODEL_RANK: Record<ModelKey, number> = { haiku: 0, sonnet: 1, opus: 2 }
const EFFORT_RANK: Record<Effort, number> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 }
export const EFFORTS = Object.keys(EFFORT_RANK) as Effort[]
export const MODELS = Object.keys(MODEL_RANK) as ModelKey[]

export type Lang = 'zh' | 'en'

export function classifierSystem(lang: Lang): string {
  return `You route a developer's message to Claude Code (an AI coding agent) to the cheapest model that can do it well.
Return ONLY one JSON object: {"tier":"lookup"|"execute"|"decide","sure":true|false,"reason":string}

lookup (fast model): pure retrieval or mechanical work with nothing to judge — find/grep/list files, read and report a value
  or status, run a command the user named and report the output, rename, fix a typo, format, translate a short text,
  look up a fact or a doc.
execute (mid model): doing work whose "what" is already settled — implement a clearly specified change, fix a bug whose
  cause is known, write tests, refactor to a stated target, write docs or a report from known material, extract or
  transform data, explain how existing code works, carry out a plan that was already agreed.
decide (top model): anything that needs judgment before acting — design or architecture, choosing between approaches,
  trade-offs, planning multi-step or multi-file work, finding the root cause of an unexplained failure, security or
  correctness review, research synthesis or recommendations, evaluating quality, ambiguous requests that need
  interpreting, and anything irreversible or outward-facing (deploy, push, delete, money, production, messages to people).

Rules:
- A short reply that continues the previous turn ("做吧", "yes", "继续", "go on") keeps the previous tier,
  except: approving a plan that was just made ("照这个做", "开始吧") is execute.
- If a message mixes tiers, use the highest one it contains.
- When unsure between two tiers, pick the higher one.
- sure: set false when the message is ambiguous, could reasonably be read at two tiers, or depends on context you cannot
  see; otherwise true. An unsure verdict is never used to move work to a cheaper model.
- reason: ${lang === 'zh' ? 'Simplified Chinese, at most 15 字' : 'English, at most 10 words'}, says what kind of work it is.`
}

// A reason longer than max is cut at a word boundary and marked with an ellipsis, so the band never shows a word
// sliced in half. A single word longer than max is cut where it stands.
export function shorten(text: string, max: number): string {
  const t = text.trim()
  if (t.length <= max) return t
  const room = t.slice(0, max - 1)
  const space = room.lastIndexOf(' ')
  const cut = space >= max / 2 ? room.slice(0, space) : room
  return `${cut.replace(/[\s,;:.\-—]+$/, '')}…`
}

function isTier(x: unknown): x is Tier {
  return x === 'lookup' || x === 'execute' || x === 'decide'
}

// Anything unreadable becomes null, and the caller falls back to execute.
// sure defaults to true, so a reply in the old format (no "sure") still parses.
// A reply cut off before its closing brace still carries the tier when that came first: it parses as unsure with
// no reason, so it can never move work to a cheaper model.
export function parseDecision(text: string): { tier: Tier; reason: string; sure: boolean } | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  const end = text.lastIndexOf('}')
  const truncated = (): { tier: Tier; reason: string; sure: boolean } | null => {
    const m = /"tier"\s*:\s*"(lookup|execute|decide)"/.exec(text.slice(start))
    return m ? { tier: m[1] as Tier, reason: '', sure: false } : null
  }
  if (end <= start) return truncated()
  try {
    const o = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
    if (!isTier(o.tier)) return null
    return { tier: o.tier, reason: typeof o.reason === 'string' ? shorten(o.reason, 60) : '', sure: o.sure !== false }
  } catch {
    return truncated()
  }
}

const TIER_RANK: Record<Tier, number> = { lookup: 0, execute: 1, decide: 2 }

// Low confidence never downgrades: after a higher-tier turn the previous tier stays, and a first turn
// never starts on lookup. A wrong guess upward costs cents; a wrong guess downward costs a failed turn.
export function settleTier(d: { tier: Tier; reason: string; sure: boolean }, previous: Tier | null): { tier: Tier; reason: string } {
  if (d.sure) return { tier: d.tier, reason: d.reason }
  if (previous !== null) {
    return TIER_RANK[previous] > TIER_RANK[d.tier]
      ? { tier: previous, reason: `${d.reason} (unsure: not downgrading)` }
      : { tier: d.tier, reason: d.reason }
  }
  return d.tier === 'lookup' ? { tier: 'execute', reason: `${d.reason} (unsure: not starting on lookup)` } : { tier: d.tier, reason: d.reason }
}

// "#opus", "#sonnet" or "#haiku" in a message pins that turn's model.
export function forcedModel(text: string): ModelKey | null {
  const m = /(?:^|\s)#(haiku|sonnet|opus)\b/i.exec(text)
  return m ? (m[1]!.toLowerCase() as ModelKey) : null
}

export function routeFor(tier: Tier, reason: string): Route {
  return { turnId: null, tier, ...TIER_ROUTE[tier], reason, trail: [] }
}

export type EscalateRequest = { model?: string; effort?: string; reason?: string }

// Up only: a higher model, or more effort on the same one; Opus alone may also lower its effort.
export function applyEscalation(cur: Route, req: EscalateRequest): { ok: true; route: Route } | { ok: false; why: string } {
  const model = req.model === undefined ? cur.model : (req.model as ModelKey)
  if (!MODELS.includes(model)) return { ok: false, why: `unknown model "${req.model}"; use haiku, sonnet or opus` }
  if (req.effort !== undefined && !EFFORTS.includes(req.effort as Effort)) {
    return { ok: false, why: `unknown effort "${req.effort}"; use ${EFFORTS.join(', ')}` }
  }
  if (MODEL_RANK[model] < MODEL_RANK[cur.model]) {
    return { ok: false, why: `escalation only goes up: this turn is on ${cur.model}, it cannot move down to ${model}` }
  }
  const isUpgrade = MODEL_RANK[model] > MODEL_RANK[cur.model]
  const effort = (req.effort as Effort | undefined) ?? (isUpgrade ? TIER_ROUTE[tierOf(model)].effort : cur.effort)
  if (!isUpgrade && model !== 'opus' && EFFORT_RANK[effort] < EFFORT_RANK[cur.effort]) {
    return { ok: false, why: `only opus may lower its effort; ${model} stays at ${cur.effort} or above` }
  }
  if (model === cur.model && effort === cur.effort) return { ok: false, why: `already on ${model} at ${effort}` }
  const step = `${model} · ${effort}${req.reason ? ` (${shorten(req.reason, 60)})` : ''}`
  return { ok: true, route: { ...cur, model, effort, trail: [...cur.trail, step] } }
}

function tierOf(model: ModelKey): Tier {
  return model === 'haiku' ? 'lookup' : model === 'sonnet' ? 'execute' : 'decide'
}

export function isFable(id: string): boolean {
  return /fable/i.test(id)
}

// Keeps a context-window suffix such as "[1m]" so a long session still fits after the switch.
export function withSuffixOf(id: string, current: string): string {
  const suffix = /\[[^\]]+\]$/.exec(current)?.[0] ?? ''
  return id.endsWith(suffix) ? id : `${id}${suffix}`
}

export function assignmentContext(r: Route): string {
  const head = `[model-router] This turn is assigned to ${r.model} at ${r.effort} effort (tier: ${r.tier}${r.reason ? ` — ${r.reason}` : ''}).`
  const opus =
    r.model === 'opus'
      ? `You are on opus at ${r.effort} effort. Decide the effort this task needs: medium for most work; high for multi-step design, plans or reviews; xhigh for hard debugging or architecture; max only for an irreversible, production-affecting decision or after an attempt at xhigh has failed. If it is not ${r.effort}, call mcp__model-router__escalate with that effort first. Then do the work.`
      : `Before doing any work, judge whether this task fits ${r.model}. Decisions (design, choosing between approaches, trade-offs, plans, unexplained root causes, reviews, anything irreversible) must be made on opus. If the task is beyond ${r.model} or needs more effort, call mcp__model-router__escalate FIRST, before any other tool; the change applies from your next step. If it fits, just start.`
  return `${head}\n${opus}\nEscalation only goes up within a turn; never call it to go down.`
}

export function reviewSystem(lang: Lang): string {
  return `You review a decision Claude Opus just made for a developer: its recommendation, design or plan.
Point out what is wrong, risky or missing (an alternative not weighed, an unstated assumption, an irreversible step).
If the decision is sound, say so in one line. ${lang === 'zh' ? 'Write in Simplified Chinese' : 'Write in English'}, at most 150 words, no preamble.`
}
