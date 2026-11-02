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
Return ONLY one JSON object:
{"p":{"lookup":<0-1>,"execute":<0-1>,"decide":<0-1>},"risk":<0-1>,"reason":string}
- p: your probability that each tier is the cheapest one that does the work well. The three add up to 1.
  Be calibrated: 0.9 means you expect to be wrong about one time in ten.
- risk: your probability that the message asks for, or approves, an irreversible or outward-facing action (deploy,
  push, merge, delete, production or shared data, money, a message or comment to people).
- reason: ${lang === 'zh' ? 'Simplified Chinese, at most 15 字' : 'English, at most 10 words'}, says what kind of work it is.

lookup (fast model): pure retrieval or mechanical work with nothing to judge — find/grep/list files, read and report a value
  or status, run a command the user named and report the output, rename, fix a typo, format, translate a short text,
  look up a fact or a doc.
execute (mid model): doing work whose "what" is already settled in the message or the context you can see — a plan, a
  spec or an exact instruction: implement a clearly specified change, fix a bug whose cause is known, write tests,
  refactor to a stated target, write docs or a report from known material, extract or transform data, explain how
  existing code works, carry out a plan that was already agreed.
decide (top model): anything that needs judgment before acting — design or architecture, choosing between approaches,
  trade-offs, planning multi-step or multi-file work, finding the root cause of an unexplained failure, security or
  correctness review, research synthesis or recommendations, evaluating quality, ambiguous requests that need
  interpreting, working out how a change to business rules, production data or stored procedures should behave,
  porting a change to a branch whose version of the code differs, and anything irreversible or outward-facing
  (deploy, push, delete, money, production, messages to people).

Rules:
- A short reply that continues the previous turn ("做吧", "yes", "继续", "go on") keeps the previous tier,
  except: approving a plan that was just made ("照这个做", "开始吧") is execute, because the plan settles what to do.
- "Implement it", "add it to the PR", "commit the fixes" or "cherry-pick it" is execute when the context shows what to
  change (an approved plan, a spec, an exact instruction). When what to change still has to be worked out, it is decide.
- If a message mixes tiers, use the highest one it contains.`
}

// The user prompt of one classification: the same text the router and the replay command both send.
export function classifierPrompt(previous: Tier | null, context: string, message: string): string {
  return [
    `<previous_tier>${previous ?? 'none'}</previous_tier>`,
    `<context>\n${context || '(none)'}\n</context>`,
    `\n<message>\n${message}\n</message>`,
  ].join('\n')
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

const TIERS: Tier[] = ['lookup', 'execute', 'decide']
const TIER_RANK: Record<Tier, number> = { lookup: 0, execute: 1, decide: 2 }

function isTier(x: unknown): x is Tier {
  return x === 'lookup' || x === 'execute' || x === 'decide'
}

export type Probs = Record<Tier, number>
// What one classifier reply says, plus the pick made from it. p and risk are absent for a reply in the 1.1 format
// ({"tier","sure","reason"}), which already is a pick. guard says why the risk guard decided.
export type Decision = { tier: Tier; reason: string; sure: boolean; p?: Probs; risk?: number; guard?: 'risk' }

// Provisional: refit from a replay over labelled messages (/model-router replay). A tier is accepted outright when it is
// the most likely one and its probability reaches its own bar; lookup is the dearest mistake to make, so its bar is highest.
export const TIER_BARS: Probs = { lookup: 0.85, execute: 0.6, decide: 0.3 }
// An irreversible or outward-facing request goes to decide when the classifier's risk reaches this.
export const RISK_BAR = 0.7

// The tier a calibrated reply asks for. The risk guard can only raise the tier. Otherwise the most likely tier (a tie goes
// to the more capable one) is taken when it clears its bar; if not, the more capable of the top two is taken and the
// pick is unsure, which settleTier never lets move work to a cheaper model.
export function pickTier(p: Probs, risk: number, bars: Probs = TIER_BARS, riskBar: number = RISK_BAR): { tier: Tier; sure: boolean; guard?: 'risk' } {
  if (risk >= riskBar) return { tier: 'decide', sure: true, guard: 'risk' }
  const ranked = TIERS.slice().sort((a, b) => p[b] - p[a] || TIER_RANK[b] - TIER_RANK[a])
  const top = ranked[0]!
  if (p[top] >= bars[top]) return { tier: top, sure: true }
  const second = ranked[1]!
  return { tier: TIER_RANK[top] > TIER_RANK[second] ? top : second, sure: false }
}

const unit = (x: number) => Math.min(1, Math.max(0, x))

// The reply's p, clamped to [0,1] and scaled to add up to 1. An absent tier counts as 0; a present one that is not a
// number, or all zeros, makes the whole reply unreadable. A sum already 1 (within rounding) is left exactly as given,
// so a boundary value such as 0.85 is not nudged by the division.
function normaliseP(raw: unknown): Probs | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const p = { lookup: 0, execute: 0, decide: 0 }
  for (const t of TIERS) {
    const v = o[t]
    if (v === undefined) continue
    if (typeof v !== 'number' || !Number.isFinite(v)) return null
    p[t] = unit(v)
  }
  const sum = p.lookup + p.execute + p.decide
  if (!(sum > 0)) return null
  if (Math.abs(sum - 1) < 1e-9) return p
  return { lookup: p.lookup / sum, execute: p.execute / sum, decide: p.decide / sum }
}

const riskOf = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? unit(x) : 0)

function calibrated(p: Probs, risk: number, reason: string, bars: Probs, riskBar: number): Decision {
  return { ...pickTier(p, risk, bars, riskBar), reason, p, risk }
}

// Anything unreadable becomes null, and the caller falls back to execute.
// A reply in the 1.1 format ({"tier","sure","reason"}) still parses: sure defaults to true, so an older reply routes.
// A reply cut off before its closing brace still carries its tier (or its p) when that came first: it parses as unsure
// with no reason, so it can never move work to a cheaper model.
export function parseDecision(text: string, bars: Probs = TIER_BARS, riskBar: number = RISK_BAR): Decision | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  const end = text.lastIndexOf('}')
  const truncated = (): Decision | null => {
    const tail = text.slice(start)
    const pm = /"p"\s*:\s*(\{[^{}]*\})/.exec(tail)
    if (pm) {
      try {
        const p = normaliseP(JSON.parse(pm[1]!))
        if (p) {
          const rm = /"risk"\s*:\s*([0-9.]+)\s*[,}]/.exec(tail)
          const d = calibrated(p, rm ? riskOf(Number(rm[1])) : 0, '', bars, riskBar)
          return d.guard ? d : { ...d, sure: false }
        }
      } catch { /* Fall through to the tier. */ }
    }
    const m = /"tier"\s*:\s*"(lookup|execute|decide)"/.exec(tail)
    return m ? { tier: m[1] as Tier, reason: '', sure: false } : null
  }
  if (end <= start) return truncated()
  try {
    const o = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
    const reason = typeof o.reason === 'string' ? shorten(o.reason, 60) : ''
    if (o.p !== undefined) {
      const p = normaliseP(o.p)
      return p ? calibrated(p, riskOf(o.risk), reason, bars, riskBar) : null
    }
    if (!isTier(o.tier)) return null
    return { tier: o.tier, reason, sure: o.sure !== false }
  } catch {
    return truncated()
  }
}


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
      ? `You are on opus at ${r.effort} effort. Decide the effort this task needs: medium for most work; high for multi-step design, plans or reviews; xhigh for hard debugging or architecture; max only for an irreversible, production-affecting decision or after an attempt at xhigh has failed. If it is not ${r.effort}, call mcp__model-router__escalate with that effort first. Then do the work. Once the plan is settled, if carrying it out spans several files or many steps, delegate it to a general-purpose subagent without a model (the router puts settled work on sonnet) with the plan, the paths and the checks to run, then verify the result yourself; make small changes directly.`
      : `Before doing any work, judge whether this task fits ${r.model}. Decisions (design, choosing between approaches, trade-offs, plans, unexplained root causes, reviews, anything irreversible) must be made on opus. If the task is beyond ${r.model} or needs more effort, call mcp__model-router__escalate FIRST, before any other tool; the change applies from your next step. If it fits, just start.`
  return `${head}\n${opus}\nEscalation only goes up within a turn; never call it to go down.`
}

export function reviewSystem(lang: Lang): string {
  return `You review a decision Claude Opus just made for a developer: its recommendation, design or plan.
Point out what is wrong, risky or missing (an alternative not weighed, an unstated assumption, an irreversible step).
If the decision is sound, say so in one line. ${lang === 'zh' ? 'Write in Simplified Chinese' : 'Write in English'}, at most 150 words, no preamble.`
}
