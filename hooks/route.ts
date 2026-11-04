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

A tier is how much judgement the work needs, not how dangerous it is.

- **lookup (Haiku):** retrieval or mechanical work with nothing to judge. Find, grep or list files; read and report a value or status; run a command the user named and report the output; rename; fix a typo; format; translate or re-explain a short text; look up a fact or a doc; acknowledge; answer a quick factual follow-up.
  Not for: anything that needs a judgement call, explaining why something fails, or a change whose content still has to be worked out.
- **execute (Sonnet):** work whose "what" is already settled in the message or the visible context, by a plan, a spec or an exact instruction. Examples:
  - implement a clearly specified change, or fix a bug whose cause is known;
  - write tests, or refactor to a stated target;
  - write docs or a report from known material;
  - extract or transform data;
  - explain how existing code works;
  - carry out a plan that was already agreed, including an instructed push, merge, PR, deploy, or a message whose content is settled;
  - cherry-pick or port a change when the code is the same on both branches.
  Not for: choosing between approaches, finding a cause nobody has identified yet, judging whether something is right, or a request whose "what" is still open.
- **decide (Opus):** judgement is needed before acting. Examples:
  - design or architecture, choosing between approaches, trade-offs;
  - planning multi-step or multi-file work;
  - finding the root cause of an unexplained failure;
  - a security or correctness review;
  - research synthesis or recommendations, evaluating quality;
  - an ambiguous request that needs interpreting;
  - working out how a change to business rules, production data or stored procedures should behave;
  - porting a change to a branch whose version of the code differs.
  Not for: carrying out a plan, spec or instruction that is already settled, or retrieval and mechanical work, however long or important it looks.

Rules:
- Judge how much judgement the work needs, not how long the reply will be or how important the topic sounds.
- A reply that only continues work already in progress ("yes", "go on", "继续") keeps the previous tier.
- Approving a plan that was just made ("照这个做", "开始吧", "go ahead with that") is execute, because the plan settles what to do.
- A short message that asks for something new ("explain it in Chinese", "how long will it take?") is judged on its own.
- A message that asks for your opinion, or whether something is right, safe or should be done ('你覺得呢？', 'is this right?', 'should it be 60s?', '这样对吗？'), is decide, even when it is short or also gives an instruction; a question about a fact ('is the build green?', '这个文件在哪？') stays lookup.
- A message that is only an image or an attachment, with no words, keeps the previous tier.
- If a message mixes tiers, use the highest one it contains.
- When unsure between two tiers, pick the higher one.
- sure: set false when the message is ambiguous, could reasonably be read at two tiers, or depends on context you cannot
  see; otherwise true. An unsure verdict is never used to move work to a cheaper model.
- reason: ${lang === 'zh' ? 'Simplified Chinese, at most 15 字' : 'English, at most 10 words'}, says what kind of work it is.`
}

// A local slash command (/model-router stats, /clear and the like) is stored as a user row starting with one of these
// tags. It is the person talking to Claude Code, not to Claude, so it says nothing about the work.
const LOCAL_COMMAND = /^\s*<(?:command-name|local-command-caveat|local-command-stdout|local-command-stderr)>/

// Which messages the classifier sees as context. session.messages() has one row per message, and every intermediate
// assistant narration in a turn ("Next I will read X…") is its own row, so "the last two" after a multi-step turn was
// usually two narration lines and never the person's previous request. Instead: the person's last request and the last
// assistant row after it (that turn's final answer). Empty rows and local-command rows are dropped first, and a last
// user row equal to the current message too, since prompt.submit may or may not already list it. With no user row,
// the last two rows; with no answer after the request, the request alone.
export function pickContext<T extends { role: string; text: string }>(messages: readonly T[], current?: string): T[] {
  const rows = messages.filter(m => m.text.trim() !== '' && !LOCAL_COMMAND.test(m.text))
  const last = rows.at(-1)
  if (current !== undefined && last?.role === 'user' && last.text.trim() === current.trim()) rows.pop()
  let user = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]!.role === 'user') {
      user = i
      break
    }
  }
  if (user === -1) return rows.slice(-2)
  let answer = -1
  for (let i = rows.length - 1; i > user; i--) {
    if (rows[i]!.role === 'assistant') {
      answer = i
      break
    }
  }
  return answer === -1 ? [rows[user]!] : [rows[user]!, rows[answer]!]
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

// Low confidence never downgrades: after a higher-tier turn the previous tier stays, and an unsure lookup never runs on
// Haiku, whatever came before (subagents follow the same rule). A wrong guess upward costs cents; a wrong guess
// downward costs a failed turn.
export function settleTier(d: { tier: Tier; reason: string; sure: boolean }, previous: Tier | null): { tier: Tier; reason: string } {
  if (d.sure) return { tier: d.tier, reason: d.reason }
  if (previous !== null && TIER_RANK[previous] > TIER_RANK[d.tier]) {
    return { tier: previous, reason: `${d.reason} (unsure: not downgrading)` }
  }
  return d.tier === 'lookup' ? { tier: 'execute', reason: `${d.reason} (unsure: not on lookup)` } : { tier: d.tier, reason: d.reason }
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

const SONNET_RISK = `An irreversible or outward-facing action the user asked for and already settled (a push, merge, PR, deploy or a message whose content is given) does not need opus, but care: confirm what it will affect, follow the project's confirmation rules, and escalate only if what to do is not settled.`
// The backstop for what the code risk floor cannot see, such as a "yes" to "push it?": Haiku never carries one out.
// Main thread only: this text goes beside a person's prompt, and subagents never get it.
const HAIKU_RISK = `Any irreversible or outward-facing action (a push, merge, PR, deploy, delete, a message to people, or a change to production data) needs at least sonnet, even when the user asked for it or has just approved it: call mcp__model-router__escalate with model sonnet FIRST, before any tool. Once on sonnet it does not need opus if what to do is settled; confirm what it will affect and follow the project's confirmation rules.`

export function assignmentContext(r: Route): string {
  const head = `[model-router] This turn is assigned to ${r.model} at ${r.effort} effort (tier: ${r.tier}${r.reason ? ` — ${r.reason}` : ''}).`
  const opus =
    r.model === 'opus'
      ? `You are on opus at ${r.effort} effort. Decide the effort this task needs: medium for most work; high for multi-step design, plans or reviews; xhigh for hard debugging or architecture; max only for an irreversible, production-affecting decision or after an attempt at xhigh has failed. If it is not ${r.effort}, call mcp__model-router__escalate with that effort first. Then do the work. Once the plan is settled, if carrying it out spans several files or many steps, delegate it to a general-purpose subagent without a model (the router puts settled work on sonnet) with the plan, the paths and the checks to run, then verify the result yourself; make small changes directly.`
      : `Before doing any work, judge whether this task fits ${r.model}. Decisions (design, choosing between approaches, trade-offs, plans, unexplained root causes, reviews) must be made on opus. If the task needs one, is beyond ${r.model} or needs more effort, call mcp__model-router__escalate FIRST, before any other tool; the change applies from your next step. ${r.model === 'haiku' ? HAIKU_RISK : SONNET_RISK} If it fits, just start.`
  return `${head}\n${opus}\nEscalation only goes up within a turn; never call it to go down.`
}

export function reviewSystem(lang: Lang): string {
  return `You review a decision Claude Opus just made for a developer: its recommendation, design or plan.
Point out what is wrong, risky or missing (an alternative not weighed, an unstated assumption, an irreversible step).
If the decision is sound, say so in one line. ${lang === 'zh' ? 'Write in Simplified Chinese' : 'Write in English'}, at most 150 words, no preamble.`
}
