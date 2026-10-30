import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { ModelKey, Route, Tally, Tier } from '../types'
import type { LastRequest, Shape, Usage } from './meter'
import { add, CACHE_TTL_MS, EMPTY, fmtTokens, fmtUsd, isSwitchStep, isWarmOpus, keepWarm, merge, PRICES, priceKey, saved, tokensOf } from './meter'
import { isPersonOrigin } from './origin'
import { redact } from './redact'
import type { Lang } from './route'
import {
  applyEscalation,
  assignmentContext,
  classifierSystem,
  EFFORTS,
  forcedModel,
  isFable,
  MODELS,
  parseDecision,
  settleTier,
  reviewSystem,
  routeFor,
  TIER_ROUTE,
  withSuffixOf,
} from './route'
import type { AgentTier, EventLog } from './subagent'
import {
  addUsage,
  AUTO_ESCALATE_AFTER,
  capSent,
  decideSpawn,
  describeTier,
  effortCap,
  escalateAgent,
  familyOf,
  logDir,
  modelCap,
  needsClassifier,
  startOf,
  stepUp,
} from './subagent'

const TOOL = 'escalate'
const TOOL_CALL = `mcp__model-router__${TOOL}`
const CLASSIFY_MS = 8000
const PROBE_EVERY_MS = 24 * 3600 * 1000
// The verdict is a JSON object with a tier, a confidence and a reason; 120 tokens cut it off mid-reply.
const CLASSIFY_MAX_TOKENS = 300
const SNIPPET_CHARS = 120

const route = atom({ plugin: 'model-router', key: 'route' } as const, null)
const enabled = atom({ plugin: 'model-router', key: 'enabled' } as const, true)
const meter = atom({ plugin: 'model-router', key: 'meter' } as const, { turn: EMPTY, today: EMPTY })

// The route chosen for a submitted prompt, waiting for its turn to start.
let pending: Route | null = null
// The person's prompt for the running turn, kept for the decision review.
let pendingPrompt = ''
// Fable blocks already counted: a main turn once per turnId, a subagent once per agent. Without this every step of a
// turn would add one.
const fableCounted = new Set<string>()
// The main thread's last model request, for keeping a warm cache; and the running turn's step count.
let last: LastRequest | null = null
let turnSteps = 0
let turnOutput = 0
// The main thread's last request of ANY model family, Fable included (`last` skips Fable, which keepWarm never
// routes). The compaction guards and the cache-expiry counter read this one. Null after a compaction: the context is
// small now, so the old figure must not trigger again, and the next request is not a cache rewrite.
let lastMain: { at: number; context: number; model: keyof typeof PRICES } | null = null
// Moves only when a main request is recorded: a completed compaction must not clear a newer request's context.
let mainRequestSequence = 0
// True from a compaction this process saw until the next main request: that request reads a fresh summary, so its
// big cache write is not an expiry rewrite even though lastMain is null.
let justCompacted = false
// The pending idle-compact (or deferred cap-compact) timer; at most one at a time. timerEpoch moves on every cancel:
// a callback that is already awaiting when the person comes back compares it and stands down.
let compactTimer: Timer | null = null
let timerEpoch = 0
// Off takes effect before its state/store writes finish.
let compactEnabled = true
// A cache write this big after a gap past the TTL is the "resumed after an hour" rewrite the guard exists to shrink.
const REWRITE_MIN_TOKENS = 100_000
// A cache read below this on a request with no earlier one in this process means the cache was cold.
const COLD_READ_TOKENS = 1000
// Idle compaction only makes sense inside the cache TTL, and with a margin: the summary request itself takes a while and
// a clock a few minutes off must not let it land on an expired cache. 55 minutes is the longest setting; the margin is
// 3 minutes, not 5. A long response brings the timer forward inside the deadline, with at least a minute at the prompt.
const SAFE_MARGIN_MS = 3 * 60_000
// Arm timers before the validation cutoff so timer delays and the agent lookup have time to finish.
const IDLE_HEADROOM_MS = 30_000
const IDLE_MIN_MINUTES = 1
const IDLE_MAX_MINUTES = 55
// The engine's own autoCompactWindow range starts here; a smaller cap would compact every turn.
const CAP_MIN_CONTEXT = 100_000
// A cap compaction that is refused (a turn is still marked running as the hook fires) is retried a few times.
const CAP_RETRIES = 3
const CAP_RETRY_MS = 2000
// Background agents hold work the summary could cut from under them: one re-check this much later, then give up.
const AGENT_RECHECK_MS = 5 * 60_000
// Agent statuses that mean the agent is still working or about to (idle, completed, failed and killed are not).
const BUSY_STATUSES: readonly string[] = ['pending', 'running', 'waiting']
const COMPACT_INSTRUCTIONS =
  'Keep the current task and its goal, the decisions made and why, open items and next steps, and the file paths and identifiers in play. Drop finished exploration and tool output.'
// What each tiered subagent is on now, by agent id.
const agents = new Map<string, AgentTier>()
// Resumes after a reload resolve their effort on the first step, not in the spawn result.
const resumed = new Set<string>()
// Per session: what changed and what each tiered subagent cost per model and effort. Written to
// ~/.claude/model-router/, one file per session, for your own analysis.
const log: EventLog = { sessionId: '', events: [], stats: {} }

const STR = {
  zh: {
    keptTier: (why: string) => `分类失败（${why}）：沿用上一档位`,
    sessionModel: (why: string) => `分类失败（${why}）：用会话模型`,
    inherited: '沿用上一轮路由',
    forced: '你在消息里指定了模型',
    abandoned: (cost: string) => `放弃 Opus 热缓存，预计往返重写 ${cost}`,
    warmSkip: '大上下文缓存仍热：跳过分类',
    off: 'Model router 已关闭',
    review: '决策审查',
    kept: '保缓存',
    turn: '本轮',
    today: '今日',
    save: '差额',
    vs: '对比工作 token 按 Opus 计价（含切换调整）',
    idleCompacted: (size: string) => `空闲压缩：已压缩 ${size} 上下文（缓存仍热）`,
    capCompacted: (size: string) => `上下文达到上限：已压缩 ${size}`,
  },
  en: {
    keptTier: (why: string) => `classifier failed (${why}): kept previous tier`,
    sessionModel: (why: string) => `classifier failed (${why}): session model`,
    inherited: 'continues previous route',
    forced: 'model pinned in your message',
    abandoned: (cost: string) => `warm Opus cache abandoned, estimated round-trip rewrite ${cost}`,
    warmSkip: 'warm large context: classifier skipped',
    off: 'Model router is off',
    review: 'Decision review',
    kept: 'cache kept',
    turn: 'turn',
    today: 'today',
    save: 'difference',
    vs: 'vs work tokens at Opus prices (switch-adjusted)',
    idleCompacted: (size: string) => `Idle compact: compacted ${size} of context while the cache was warm`,
    capCompacted: (size: string) => `Context cap reached: compacted ${size}`,
  },
} as const

const LABEL: Record<ModelKey, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' }
const TIER_OF: Record<ModelKey, Tier> = { haiku: 'lookup', sonnet: 'execute', opus: 'decide' }

type Counts = {
  turns: Record<Tier, number>
  escalations: number
  cacheKeeps: number
  // Main prompts that went to Opus without a classifier call: a warm large Opus context stays on Opus whatever the tier.
  classifierSkipped: number
  subagents: Record<ModelKey, number>
  fableBlocked: number
  // Steps whose answering model was not the family the router asked for.
  modelMismatch: number
  // Classifier calls that gave no usable verdict, by reason (main turns and subagents alike).
  classifierFailures: Record<string, number>
  // Escalations to max effort, main thread and subagents: max is meant to be rare.
  maxEffort: number
  // Compactions this plugin started: after an idle spell (cache still warm) and at the context cap.
  idleCompactions: number
  capCompactions: number
  // Main-thread requests that rewrote 100k+ tokens of cache after a gap past the TTL, and what those writes cost.
  cacheExpiryRewrites: number
  cacheExpiryRewriteCost: number
}
const NO_COUNTS: Counts = {
  turns: { lookup: 0, execute: 0, decide: 0 },
  escalations: 0,
  cacheKeeps: 0,
  classifierSkipped: 0,
  subagents: { haiku: 0, sonnet: 0, opus: 0 },
  fableBlocked: 0,
  modelMismatch: 0,
  classifierFailures: {},
  maxEffort: 0,
  idleCompactions: 0,
  capCompactions: 0,
  cacheExpiryRewrites: 0,
  cacheExpiryRewriteCost: 0,
}

function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

// A person coming back, or any new turn, must never be compacted under.
function cancelCompact() {
  timerEpoch += 1
  compactTimer?.cancel()
  compactTimer = null
}

// The context is a summary now (whoever compacted): the old figures must not steer routing or trigger a guard.
function forgetContext() {
  last = null
  lastMain = null
  justCompacted = true
}

async function setEnabled($: EngineInterface, isOn: boolean) {
  // Off must also stop a compaction already scheduled.
  compactEnabled = isOn
  if (!isOn) cancelCompact()
  await update($, enabled, () => isOn)
  await $.store.set('enabled', isOn)
}

// Each session owns its daily keys. The chain also keeps parallel subagent increments in this process in order.
let writes: Promise<void> = Promise.resolve()
const RETAIN_DAYS = 30
let prunedDay = ''

function oldestDay(now: number): string {
  const d = new Date(now)
  d.setDate(d.getDate() - RETAIN_DAYS + 1)
  return dayKey(d.getTime())
}

async function prune($: EngineInterface, now: number) {
  const day = dayKey(now)
  if (prunedDay === day) return
  const oldest = oldestDay(now)
  for (const key of await $.store.keys()) {
    const day = /^(?:meter|counts):(\d{8}):/.exec(key)?.[1]
    if (day !== undefined && day < oldest) await $.store.delete(key)
  }
  prunedDay = day
}

async function totals($: EngineInterface, now: number, todayOnly = false): Promise<{ today: Tally; all: Tally; counts: Counts }> {
  const day = dayKey(now)
  const oldest = oldestDay(now)
  let today = ((await $.store.get(`meter:${day}`)) as Tally | undefined) ?? EMPTY
  let all = todayOnly ? EMPTY : ((await $.store.get('meter:all')) as Tally | undefined) ?? EMPTY
  let counts = todayOnly ? NO_COUNTS : { ...NO_COUNTS, ...((await $.store.get('counts')) as Counts | undefined) }
  for (const key of await $.store.keys()) {
    const m = /^(meter|counts):(\d{8}):/.exec(key)
    if (!m || m[2]! < oldest || m[2]! > day || (todayOnly && (m[1] !== 'meter' || m[2] !== day))) continue
    if (m[1] === 'meter') {
      const t = (await $.store.get(key)) as Tally | undefined
      if (!t) continue
      all = merge(all, t)
      if (m[2] === day) today = merge(today, t)
    } else {
      const c = (await $.store.get(key)) as Counts | undefined
      if (!c) continue
      counts = mergeCounts(counts, c)
    }
  }
  return { today, all, counts }
}

function mergeCounts(a: Counts, b: Counts): Counts {
  const out = { ...a }
  for (const key of Object.keys(NO_COUNTS) as (keyof Counts)[]) {
    if (typeof NO_COUNTS[key] === 'number') {
      Object.assign(out, { [key]: ((a[key] as number) ?? 0) + ((b[key] as number) ?? 0) })
    } else {
      const left = a[key] as Record<string, number> | undefined
      const right = b[key] as Record<string, number> | undefined
      const sum = { ...left }
      for (const [k, v] of Object.entries(right ?? {})) sum[k] = (sum[k] ?? 0) + v
      Object.assign(out, { [key]: sum })
    }
  }
  return out
}

function serial($: EngineInterface, job: () => Promise<void>): Promise<void> {
  writes = writes.then(job).catch(err => $.ui.log(`model-router: store write failed: ${String(err)}`))
  return writes
}

function count($: EngineInterface, change: (c: Counts) => Counts): Promise<void> {
  return serial($, async () => {
    const now = await $.clock.now()
    await prune($, now)
    const key = `counts:${dayKey(now)}:${await $.session.id()}`
    const c = ((await $.store.get(key)) as Counts | undefined) ?? NO_COUNTS
    await $.store.set(key, change(c))
  })
}

// Every model call this session pays for, the router's own included, goes on the turn, the day and the total.
// switched: a main-thread step that changed model family within the cache TTL (see baselineOf).
function record($: EngineInterface, modelId: string, u: Usage, switched = false, overhead = false): Promise<void> {
  return serial($, async () => {
    const now = await $.clock.now()
    await prune($, now)
    const key = `meter:${dayKey(now)}:${await $.session.id()}`
    await $.store.set(key, add(((await $.store.get(key)) as Tally | undefined) ?? EMPTY, modelId, u, switched, overhead))
    const { today } = await totals($, now, true)
    await update($, meter, m => ({ turn: add((m ?? { turn: EMPTY }).turn, modelId, u, switched, overhead), today }))
  })
}

// The log is for review only: a failed write never fails a turn or an agent. Writes go through the
// serial chain so a slow older snapshot cannot land over a newer one.
function persist($: EngineInterface): Promise<void> {
  return serial($, async () => {
    try {
      if (log.sessionId === '') log.sessionId = await $.session.id()
      await $.fs.write(`${logDir($.plugin.root)}/events-${log.sessionId}.json`, JSON.stringify(log, null, 1))
    } catch {
      // Nothing to do: the next event writes the whole log again.
    }
  })
}

// A reload runs session.start again: keep what this session already logged.
async function restore($: EngineInterface) {
  try {
    log.sessionId = await $.session.id()
    const saved = JSON.parse(await $.fs.read(`${logDir($.plugin.root)}/events-${log.sessionId}.json`)) as EventLog
    log.events = saved.events ?? []
    log.stats = saved.stats ?? {}
  } catch {
    // First load of this session: nothing to restore.
  }
}

// agentId "main" is the main thread's own route; a subagent event also goes to the status line.
async function logEvent($: EngineInterface, agentId: string, event: string, to: string, reason: string) {
  log.events.push({ at: new Date(await $.clock.now()).toISOString(), agentId, event, to, reason })
  if (agentId !== 'main') {
    try {
      $.ui.status(`subagent ${event}: ${to} (${reason})`)
    } catch {
      // A missing status line is not worth failing the agent.
    }
  }
  await persist($)
}

async function recentContext($: EngineInterface): Promise<string> {
  const rows = (await $.session.messages()).filter(m => m.text.trim() !== '').slice(-2)
  // Masked before trimming, so a secret cut by the trim is still caught whole.
  return rows
    .map(m => redact(m.text))
    .map((text, i) => `[${rows[i]!.role}] ${text.length > 1200 ? `${text.slice(0, 200)}\n…\n${text.slice(-1000)}` : text}`)
    .join('\n\n')
}

type Verdict = { tier: Tier; reason: string; sure: boolean }
// A verdict, or why there is none: 'timeout', 'api-error <status>', 'empty-reply', 'unparseable' or 'exception'.
// why is the counted reason; detail (the start of an unparseable reply) is only for the person reading the log.
type Classified = { ok: true; verdict: Verdict } | { ok: false; why: string; detail?: string }

function failText(c: { why: string; detail?: string }): string {
  return c.detail ? `${c.why}: ${c.detail}` : c.why
}

// Haiku sorts a text into a tier. withContext adds the last two messages.
async function classifyTier($: EngineInterface, lang: Lang, text: string, previous: Tier | null, withContext: boolean): Promise<Classified> {
  try {
    const context = withContext ? await recentContext($) : ''
    const r = await $.model.complete({
      model: 'haiku',
      system: classifierSystem(lang),
      prompt:
        `<previous_tier>${previous ?? 'none'}</previous_tier>\n` +
        `<context>\n${context || '(none)'}\n</context>\n\n<message>\n${redact(text).slice(0, 6000)}\n</message>`,
      maxTokens: CLASSIFY_MAX_TOKENS,
      effort: 'low',
      timeoutMs: CLASSIFY_MS,
    })
    await record($, 'claude-haiku-5-5', r.usage, false, true)
    if (!r.isAnswered) {
      if (r.reason === 'aborted') return { ok: false, why: 'timeout' }
      if (r.reason === 'api-error') return { ok: false, why: `api-error ${r.status ?? 'none'}` }
      return { ok: false, why: 'empty-reply' }
    }
    const verdict = parseDecision(r.text)
    if (verdict) return { ok: true, verdict }
    // Masked whole before cutting, so a secret split by the cut is still caught.
    return { ok: false, why: 'unparseable', detail: redact(r.text).replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS) }
  } catch {
    return { ok: false, why: 'exception' }
  }
}

function countFailure($: EngineInterface, why: string): Promise<void> {
  return count($, c => {
    const failures = c.classifierFailures ?? {}
    return { ...c, classifierFailures: { ...failures, [why]: (failures[why] ?? 0) + 1 } }
  })
}

// A failed classification never downgrades: it keeps the previous route's tier, and with no previous route the
// turn is left unrouted, on the session's own model (sessionModel). Switching to Sonnet on failure cost money:
// 24% of those turns later escalated to Opus, against 6% of classified ones.
async function classify($: EngineInterface, lang: Lang, text: string, previous: Route | null): Promise<Route> {
  const forced = forcedModel(text)
  if (forced) return routeFor(TIER_OF[forced], STR[lang].forced)
  // The verdict could not change anything: keepWarm keeps a warm large Opus context on Opus whatever the tier.
  if (isWarmOpus(last, await $.clock.now())) {
    await count($, c => ({ ...c, classifierSkipped: (c.classifierSkipped ?? 0) + 1 }))
    return routeFor('decide', STR[lang].warmSkip)
  }
  const c = await classifyTier($, lang, text, previous?.tier ?? null, true)
  if (!c.ok) {
    await countFailure($, c.why)
    if (previous) return routeFor(previous.tier, STR[lang].keptTier(failText(c)))
    return { ...routeFor('execute', STR[lang].sessionModel(failText(c))), sessionModel: true }
  }
  const s = settleTier(c.verdict, previous?.tier ?? null)
  return routeFor(s.tier, s.reason)
}

// The last route that actually routed a turn: an unrouted (session model) turn is not one.
function routed(r: Route | null): Route | null {
  return r && !r.sessionModel ? r : null
}

// Whether the reviewer model exists on this account; asked at most once a day.
async function reviewerAvailable($: EngineInterface, reviewModel: string): Promise<boolean> {
  if (reviewModel === '') return false
  if (/fable-5-1\b/i.test(reviewModel)) return false
  const now = await $.clock.now()
  const seen = (await $.store.get('reviewer')) as { model: string; ok: boolean; at: number } | undefined
  if (seen && seen.model === reviewModel && now - seen.at < PROBE_EVERY_MS) return seen.ok
  let ok = false
  try {
    const r = await $.model.complete({ model: reviewModel, prompt: 'Reply with OK.', maxTokens: 5, timeoutMs: 15000 })
    await record($, reviewModel, r.usage, false, true)
    ok = r.isAnswered
  } catch {
    ok = false
  }
  await $.store.set('reviewer', { model: reviewModel, ok, at: now })
  return ok
}

async function reviewDecision($: EngineInterface, lang: Lang, reviewModel: string, prompt: string, answer: string) {
  const r = await $.model.complete({
    model: reviewModel,
    system: reviewSystem(lang),
    prompt: `<request>\n${prompt.slice(0, 6000)}\n</request>\n\n<opus_decision>\n${answer.slice(-12000)}\n</opus_decision>`,
    maxTokens: 600,
    timeoutMs: 120000,
  })
  await record($, reviewModel, r.usage)
  if (!r.isAnswered) return
  await $.session.append({ message: { type: 'system', content: [{ type: 'text', text: `${STR[lang].review} (${reviewModel})：\n${r.text.trim()}` }] } })
}

// Runs after the turn, unawaited: an Opus decision goes to the reviewer only when one is set and exists.
async function maybeReview($: EngineInterface, lang: Lang, reviewModel: string, prompt: string, answer: string) {
  if (reviewModel === '') return
  try {
    if (await reviewerAvailable($, reviewModel)) await reviewDecision($, lang, reviewModel, prompt, answer)
  } catch (err) {
    $.ui.log(`model-router: review failed: ${String(err)}`)
  }
}

function tallyLines(name: string, t: Tally): string {
  const s = saved(t)
  const rows = Object.entries(t.byModel)
    .sort((a, b) => b[1].cost - a[1].cost)
    .map(([m, v]) => `| ${m} | ${fmtTokens(v.tokens)} | ${fmtUsd(v.cost)} |`)
  return [
    `**${name}**: ${fmtTokens(t.tokens)} tokens, ${fmtUsd(t.cost)} API-equivalent; same work tokens at Opus prices (switch-adjusted): ${fmtUsd(t.baseline)}, difference ≈ ${fmtUsd(s.usd)} (${s.pct}%).`,
    '',
    '| model | tokens | cost |',
    '|---|---|---|',
    ...rows,
  ].join('\n')
}

async function statsText($: EngineInterface): Promise<string> {
  const now = await $.clock.now()
  const { today, all, counts: c } = await totals($, now)
  const failures = Object.entries(c.classifierFailures ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([why, n]) => `${why} ×${n}`)
  return [
    tallyLines('Today', today),
    '',
    tallyLines('Retained total (30 days + legacy)', all),
    '',
    `Turns routed: lookup ${c.turns.lookup} · execute ${c.turns.execute} · decide ${c.turns.decide}. ` +
      `Escalations: ${c.escalations}. Kept on a warm cache: ${c.cacheKeeps}. ` +
      `Classifier skipped (warm large Opus context): ${c.classifierSkipped ?? 0}. ` +
      `Subagents routed: haiku ${c.subagents.haiku} · sonnet ${c.subagents.sonnet} · opus ${c.subagents.opus}. ` +
      `Fable requests moved to Opus: ${c.fableBlocked}. ` +
      `Routed model not the one that answered: ${c.modelMismatch ?? 0}. ` +
      `Classifier failures: ${failures.length > 0 ? failures.join(' · ') : 'none'}. ` +
      `Escalations to max effort: ${c.maxEffort ?? 0}. ` +
      `Compactions at idle (cache warm): ${c.idleCompactions ?? 0}. ` +
      `Compactions at the context cap: ${c.capCompactions ?? 0}. ` +
      `Cache rewrites after the TTL (100k+ tokens): ${c.cacheExpiryRewrites ?? 0}, costing ${fmtUsd(c.cacheExpiryRewriteCost ?? 0)}.`,
    '',
    '_API-equivalent prices; work tokens are priced on Opus with switch writes priced as warm reads. Classification and availability probes add cost only. Another model would not use exactly the same tokens. Session records are retained for 30 days; legacy totals are included unchanged._',
  ].join('\n')
}

// Timer paths keep the entry epoch across every await; only a current, enabled path may arm or start compacting,
// with no await after its last check.
// A completed compaction forgets context even while off, unless a newer main request was recorded.
// Its timer cleanup still requires the current, enabled epoch.
type CompactOutcome = 'done' | 'skipped' | 'rejected'

// Compacts the main conversation between turns while the cache is warm. $.session.compact rejects while a turn
// runs ('rejected') and resolves { skip } when a hook vetoed it ('skipped'): neither is a compaction, so neither is
// counted. Never throws.
async function compactMain($: EngineInterface, lang: Lang, kind: 'idle' | 'cap'): Promise<CompactOutcome> {
  const epoch = timerEpoch
  const request = mainRequestSequence
  const before = lastMain?.context ?? 0
  // Compact usage has no model id: estimate it at the last main request's rates, including Fable.
  const model = lastMain?.model ?? 'opus'
  let tokensBefore: number | undefined
  let tokensAfter: number | undefined
  try {
    const r = await $.session.compact({ instructions: COMPACT_INSTRUCTIONS })
    if (r.skip !== undefined) return 'skipped'
    // The compact has already happened. Do not clear a newer turn's context while accounting for it.
    if (request === mainRequestSequence) {
      forgetContext()
      if (!stale(epoch)) cancelCompact()
    }
    tokensBefore = r.tokensBefore
    tokensAfter = r.tokensAfter
    if (r.usage) await record($, model, r.usage)
  } catch {
    return 'rejected'
  }
  await count($, c =>
    kind === 'idle' ? { ...c, idleCompactions: (c.idleCompactions ?? 0) + 1 } : { ...c, capCompactions: (c.capCompactions ?? 0) + 1 },
  )
  // The engine's own figures when it recorded them, else the last request's context.
  const size = tokensAfter === undefined ? fmtTokens(tokensBefore ?? before) : `${fmtTokens(tokensBefore ?? before)} → ${fmtTokens(tokensAfter)}`
  const str = STR[lang]
  try {
    $.ui.toast((kind === 'idle' ? str.idleCompacted : str.capCompacted)(size))
  } catch {
    // A missing toast surface is not worth failing a compaction that happened.
  }
  return 'done'
}

// Whether the idle guard should compact now: a big enough context, last used safely inside the cache TTL.
function idleDue(now: number, minContext: number): boolean {
  return lastMain !== null && lastMain.context >= minContext && now - lastMain.at <= CACHE_TTL_MS - SAFE_MARGIN_MS
}

// Whether any subagent or teammate is still working. A failed lookup counts as busy: not compacting is the safe side.
async function agentsBusy($: EngineInterface): Promise<boolean> {
  try {
    return (await $.agent.list()).some(a => BUSY_STATUSES.includes(a.status))
  } catch {
    return true
  }
}

// What the timer callbacks need from the options.
type Guard = { lang: Lang; idleMs: number; minContext: number; completedAt?: number }

// Synchronous so a prompt or off cannot slip between the last check and arming or compacting.
function stale(epoch: number): boolean {
  return epoch !== timerEpoch || !compactEnabled
}

// The idle compaction, a single re-check later while background agents run, never past the safe window.
async function runIdle($: EngineInterface, g: Guard, epoch: number, rechecked: boolean): Promise<void> {
  if (stale(epoch)) return
  compactTimer = null
  const isOn = await read($, enabled)
  if (stale(epoch) || !isOn) return
  const now = await $.clock.now()
  if (stale(epoch)) return
  if (!idleDue(now, g.minContext)) return
  const busy = await agentsBusy($)
  if (stale(epoch)) return
  if (busy) {
    const checkedAt = await $.clock.now()
    if (stale(epoch)) return
    const deadline = lastMain === null ? 0 : lastMain.at + CACHE_TTL_MS - SAFE_MARGIN_MS - IDLE_HEADROOM_MS
    if (!rechecked && checkedAt < deadline) {
      compactTimer = $.clock.after(Math.min(AGENT_RECHECK_MS, deadline - checkedAt), () => void runIdle($, g, epoch, true).catch(() => {}))
    }
    return
  }
  const checkedAt = await $.clock.now()
  if (stale(epoch)) return
  if (!idleDue(checkedAt, g.minContext)) return
  await compactMain($, g.lang, 'idle')
}

async function armIdle($: EngineInterface, g: Guard, epoch: number) {
  if (g.idleMs <= 0 || lastMain === null) return
  const isOn = await read($, enabled)
  if (stale(epoch) || !isOn) return
  const now = await $.clock.now()
  if (stale(epoch) || lastMain === null) return
  const completedAt = g.completedAt ?? now
  const deadline = lastMain.at + CACHE_TTL_MS - SAFE_MARGIN_MS - IDLE_HEADROOM_MS
  const earliest = Math.max(now, completedAt + IDLE_MIN_MINUTES * 60_000)
  if (earliest > deadline) return
  const at = Math.max(earliest, Math.min(completedAt + g.idleMs, deadline))
  compactTimer = $.clock.after(at - now, () => void runIdle($, g, epoch, false).catch(() => {}))
}

// The cap compaction, retried when refused; if it never lands, the idle guard takes over for this turn.
async function runCap($: EngineInterface, g: Guard, epoch: number, attempt: number): Promise<void> {
  if (stale(epoch)) return
  compactTimer = null
  const isOn = await read($, enabled)
  if (stale(epoch) || !isOn) return
  const busy = await agentsBusy($)
  if (stale(epoch)) return
  if (busy) {
    await armIdle($, g, epoch)
    return
  }
  const outcome = await compactMain($, g.lang, 'cap')
  if (stale(epoch) || outcome === 'done') return
  if (outcome === 'rejected' && attempt < CAP_RETRIES) {
    compactTimer = $.clock.after(CAP_RETRY_MS, () => void runCap($, g, epoch, attempt + 1).catch(() => {}))
    return
  }
  await armIdle($, g, epoch)
}

export const register: Register = (on, options) => {
  const lang: Lang = options.language === 'zh' ? 'zh' : 'en'
  const ids: Record<ModelKey, string> = {
    haiku: String(options.haikuModel ?? 'claude-haiku-5-5'),
    sonnet: String(options.sonnetModel ?? 'claude-sonnet-5-5'),
    opus: String(options.opusModel ?? 'claude-opus-5-5'),
  }
  // false: subagent-only mode. The main thread is neither classified nor rewritten; subagent routing, escalation,
  // Fable blocking (of subagents) and the meter keep working.
  const mainRouting = options.mainRouting !== false
  // true (the default): Fable never runs on a subagent, and on the main thread when main routing is on. false: Fable is
  // left alone everywhere (a subagent still never runs above its parent).
  const blockFable = options.blockFable !== false
  // Empty (the default) leaves the reviewer off.
  const reviewModel = String(options.reviewModel ?? '').trim()
  // Minutes of idle after which the main context is compacted while the cache is still warm; 0 (the default) is off.
  // Outside 1 to 55 counts as off, not clamped: 56 or more cannot fire safely inside the TTL, and silently turning 90
  // into 55 would compact sessions the person meant to leave alone.
  const idleMinutes = Number(options.idleCompactMinutes ?? 0)
  const idleMs = Number.isFinite(idleMinutes) && idleMinutes >= IDLE_MIN_MINUTES && idleMinutes <= IDLE_MAX_MINUTES ? idleMinutes * 60_000 : 0
  // A smaller context is not worth a summarizer call: the rewrite it would save is cheap anyway.
  const compactMinContext = Number(options.compactMinContext ?? 100_000)
  // Token count at which the main context is compacted between turns; 0 (the default) is off. Below 100,000 counts as
  // off, like the engine's own autoCompactWindow range (100,000 to 1,000,000): a smaller cap would compact every turn.
  const compactAtContext = Number(options.compactAtContext ?? 0)
  const capOn = Number.isFinite(compactAtContext) && compactAtContext >= CAP_MIN_CONTEXT
  const str = STR[lang]
  const guard: Guard = { lang, idleMs, minContext: compactMinContext }

  on('session.start', async ($, e, next) => {
    await restore($)
    await $.command.register({
      name: 'model-router',
      description: 'Model router: "stats" for tokens and price comparison, "on" / "off" to toggle',
      argumentHint: '[stats|on|off]',
    })
    await $.tool.register({
      name: TOOL,
      isDeferred: false,
      description:
        'Raise the model or effort for the rest of the current turn, before you start the work. ' +
        'Call it first when the task is beyond the model you were assigned (decisions must be made on opus) or needs more effort. ' +
        'Only goes up; opus may set any effort. The change applies from your next step. ' +
        'Works for subagents too: a subagent calls it when its task proves harder than its tier handles well ' +
        '(guessing, a result contradicts it, the same step failed twice); on its own it stops at opus/medium. ' +
        'Main conversation only: pass `agent` (a subagent id) to raise that subagent, up to opus/high.',
      inputSchema: {
        type: 'object',
        properties: {
          model: { type: 'string', enum: MODELS, description: 'Model to move up to; omit to change only the effort' },
          effort: { type: 'string', enum: EFFORTS, description: 'Effort for the rest of the turn' },
          agent: { type: 'string', description: 'Main conversation only: id of the subagent to raise, as the Agent tool returned it' },
          reason: { type: 'string', description: 'One short line: why the assignment does not fit' },
        },
        required: ['reason'],
      },
    })
    const stored = await $.store.get('enabled')
    compactEnabled = stored !== false
    await update($, enabled, () => compactEnabled)
    const now = await $.clock.now()
    await prune($, now)
    const { today } = await totals($, now, true)
    await update($, meter, () => ({ turn: EMPTY, today }))
    return next(e)
  })

  on('command.run', { command: 'model-router' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'stats' || arg === '') return { text: await statsText($) }
    if (arg !== 'on' && arg !== 'off') return { text: 'Usage: /model-router stats | on | off' }
    // setEnabled cancels a pending compaction when switching off.
    await setEnabled($, arg === 'on')
    return { text: `Model router ${arg === 'on' ? 'enabled' : 'disabled'}.` }
  })

  // Every compaction of the main conversation: the plugin's own, a manual /compact and the engine's auto-compact. The
  // old context figures are stale after any of them, and a pending timer would compact a summary.
  on('session.compact', async ($, e, next) => {
    const epoch = timerEpoch
    const request = mainRequestSequence
    const result = await next(e)
    if (request !== mainRequestSequence) return result
    if (e.agentId === undefined && e.trigger !== 'precompute' && result.skip === undefined) {
      forgetContext()
      if (!stale(epoch)) cancelCompact()
    }
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    cancelCompact()
    const origin = e.origin as typeof e.origin | undefined
    // A prompt typed into a running turn joins that turn's route.
    if (!(await read($, enabled)) || !isPersonOrigin(origin) || e.turnId !== undefined || e.text.trim() === '') {
      return next(e)
    }
    // The turn's tally starts here, so it includes the classifier's own call.
    await update($, meter, m => ({ turn: EMPTY, today: (m ?? { today: EMPTY }).today }))
    if (!mainRouting) return next(e)
    let r = await classify($, lang, e.text, routed(await read($, route)))
    if (r.sessionModel) {
      // Unrouted: nothing to rewrite and nothing to tell the model; turn.start still binds the reason for the band.
      pending = r
      pendingPrompt = e.text
      const entered = await next(e)
      if (entered.drop !== undefined) {
        pending = null
        pendingPrompt = ''
      }
      return entered
    }
    const shape = ((await $.store.get('shape')) as Shape | undefined) ?? { steps: 3, output: 800 }
    const now = await $.clock.now()
    const pinned = forcedModel(e.text) !== null
    if (pinned && r.model !== 'opus' && isWarmOpus(last, now)) {
      const cost = fmtUsd((last!.context * (PRICES[r.model].write + PRICES.opus.write)) / 1e6)
      r = { ...r, reason: `${r.reason}; ${str.abandoned(cost)}` }
    }
    const model = pinned ? r.model : keepWarm(r.model, last, now, shape)
    if (model !== r.model) {
      r = { ...r, keptFrom: r.model, model, effort: TIER_ROUTE[r.tier].effort }
      await count($, c => ({ ...c, cacheKeeps: c.cacheKeeps + 1 }))
    }
    // Set before next: next resolves only after the turn has started, and turn.start binds this route.
    pending = r
    pendingPrompt = e.text
    const entered = await next({ ...e, context: [...(e.context ?? []), assignmentContext(r)] })
    if (entered.drop !== undefined) {
      // Held back by another plugin: no turn starts, so the route must not bind to the next one.
      pending = null
      pendingPrompt = ''
    }
    return entered
  })

  on('turn.start', async ($, e, next) => {
    // A subagent's or teammate's run is not a main turn: it neither takes the pending route nor inherits one.
    if (e.agentId !== undefined) return next(e)
    cancelCompact()
    if (pending) {
      const r = { ...pending, turnId: e.turnId }
      pending = null
      turnSteps = 0
      turnOutput = 0
      await update($, route, () => r)
      if (r.sessionModel) {
        await logEvent($, 'main', 'turn route', 'session model', r.reason)
      } else {
        await count($, c => ({ ...c, turns: { ...c.turns, [r.tier]: c.turns[r.tier] + 1 } }))
        await logEvent($, 'main', 'turn route', `${r.model}/${r.effort}`, r.reason)
      }
    } else if (mainRouting && (await read($, enabled))) {
      // A turn without a person prompt (a task notification, an agent message, a scheduled prompt) is never
      // classified. While the previous route's cache is warm it continues that route: left on the session model it
      // would switch away from, and back to, the model the cache is on. Without a previous route it stays unrouted.
      const prev = routed(await read($, route))
      if (prev && last && (await $.clock.now()) - last.at <= CACHE_TTL_MS) {
        const r: Route = { ...prev, turnId: e.turnId, reason: str.inherited }
        turnSteps = 0
        turnOutput = 0
        await update($, route, () => r)
        await logEvent($, 'main', 'turn inherit', `${r.model}/${r.effort}`, r.reason)
      }
    }
    return next(e)
  })

  // Every model request: the turn's route on the main thread, no Fable where blockFable says so, and its usage on the meter.
  on('turn.step', async function* ($, e, next) {
    if (!(await read($, enabled))) return yield* next(e)
    let model = e.model
    let effort = e.effort
    const r = await read($, route)
    const isMain = e.agentId === undefined
    let sub = e.agentId === undefined ? undefined : agents.get(e.agentId)
    if (sub && e.agentId !== undefined && resumed.delete(e.agentId) && sub.effort === undefined) {
      sub = { ...sub, effort: typeof effort === 'string' ? capSent(effort) : undefined }
      agents.set(e.agentId, sub)
    }
    if (isMain && mainRouting && r && r.turnId === e.turnId && !r.sessionModel) {
      model = withSuffixOf(ids[r.model], e.model)
      effort = r.effort
    }
    // A tiered subagent's own model and effort; an inheriting one keeps what the engine resolved.
    if (sub) {
      if (sub.model !== undefined) model = withSuffixOf(sub.model, e.model)
      if (sub.effort !== undefined) effort = sub.effort
      // Hard ceiling for every tracked subagent, inheriting ones too: xhigh and max are main-thread only.
      effort = capSent(effort)
    }
    // With main routing off the main model is the person's own choice: only subagents are kept off Fable.
    if (blockFable && isFable(model) && (!isMain || mainRouting)) {
      model = withSuffixOf(ids.opus, e.model)
      const key = isMain ? `turn:${e.turnId}` : `agent:${e.agentId}`
      if (!fableCounted.has(key)) {
        fableCounted.add(key)
        await count($, c => ({ ...c, fableBlocked: c.fableBlocked + 1 }))
      }
    }
    // When the request was sent: the cache is touched then, and a long streamed response must not stretch the TTL.
    const sentAt = isMain ? await $.clock.now() : 0
    const result =
      model === e.model && effort === e.effort ? yield* next(e) : yield* next({ ...e, model, effort })
    const u = result?.usage
    if (u) {
      const key = priceKey(u.model || model)
      const now = await $.clock.now()
      // Read before `last` moves on: a main step that switched family within the TTL is priced for what it cost.
      // Send time, like lastMain: the cache is touched when the request goes out, not when a long reply ends.
      const switched = isMain && isSwitchStep(last, key, sentAt)
      await record($, u.model || model, u, switched)
      if (isMain) {
        // A cache rewrite after the TTL: the person was away over an hour and the whole context was written again.
        // Also the first request of this process (a --resume): nothing was read from the cache and a big context was
        // written. Not right after a compaction, whose summary is written fresh. After a gap, the write must also
        // outweigh the read: a big read means a warm prefix survived (say a background fork kept it), and the
        // write is new input, not expiry.
        const afterGap =
          lastMain !== null && sentAt - lastMain.at > CACHE_TTL_MS && u.cache_read_input_tokens < u.cache_creation_input_tokens
        const coldStart = lastMain === null && !justCompacted && u.cache_read_input_tokens < COLD_READ_TOKENS
        if ((afterGap || coldStart) && u.cache_creation_input_tokens >= REWRITE_MIN_TOKENS) {
          const cost = (u.cache_creation_input_tokens * PRICES[key].write) / 1e6
          await count($, c => ({
            ...c,
            cacheExpiryRewrites: (c.cacheExpiryRewrites ?? 0) + 1,
            cacheExpiryRewriteCost: (c.cacheExpiryRewriteCost ?? 0) + cost,
          }))
        }
        justCompacted = false
        mainRequestSequence += 1
        lastMain = { at: sentAt, context: tokensOf(u) - u.output_tokens, model: key }
        if (key !== 'fable') last = { model: key, at: sentAt, context: tokensOf(u) - u.output_tokens }
        turnSteps += 1
        turnOutput += u.output_tokens
      }
      // Proof the rewrite took effect: the family that answered is the family asked for.
      if (model !== e.model || effort !== e.effort) {
        const asked = familyOf(model)
        const got = familyOf(u.model)
        if (asked !== undefined && got !== undefined && asked !== got) {
          await count($, c => ({ ...c, modelMismatch: (c.modelMismatch ?? 0) + 1 }))
        }
      }
      if (e.agentId !== undefined && sub) {
        log.stats[e.agentId] = addUsage(log.stats[e.agentId], u.model || model, effort === undefined ? undefined : String(effort), u)
        await persist($)
      }
    }
    return result
  })

  on('tool.call', { tool: TOOL_CALL }, async ($, e) => {
    const input = e as unknown as { agentId?: string; agent?: string; model?: string; effort?: string; reason?: string }
    // A subagent cannot raise another agent: only the main conversation passes `agent`.
    if (input.agentId !== undefined && input.agent !== undefined) {
      return { result: 'Not changed: only the main conversation can raise a subagent. Use escalate without `agent` to raise yourself.' }
    }
    // The main conversation raises a tracked subagent: up only, never above the parent's tier nor opus/high.
    if (input.agentId === undefined && input.agent !== undefined) {
      const s = agents.get(input.agent)
      if (s === undefined) return { result: `No tracked subagent ${input.agent}.` }
      const up = escalateAgent(s, input, ids, 'main')
      if (up === undefined) {
        return { result: `No change: subagent ${input.agent} already runs ${describeTier(s)}; main can raise it to ${modelCap(s, 'main')}/${effortCap(modelCap(s, 'main'), 'main')} at most.` }
      }
      agents.set(input.agent, { ...up, errorsInARow: 0 })
      await logEvent($, input.agent, 'raised by main', describeTier(up), input.reason ?? 'no reason given')
      return { result: `Subagent ${input.agent} now runs ${describeTier(up)} from its next step.` }
    }
    // A subagent the router tiered raises itself, capped at its own ceiling.
    if (input.agentId !== undefined) {
      const s = agents.get(input.agentId)
      if (s === undefined) {
        return { result: 'No routed agent here: escalate applies to the main conversation of a routed turn and to subagents the router tiered. Carry on.' }
      }
      const up = escalateAgent(s, input, ids)
      if (up === undefined) {
        return { result: `No change: already on ${describeTier(s)}, the ceiling is ${modelCap(s, 'self')}/${effortCap(modelCap(s, 'self'), 'self')} for a subagent on its own.` }
      }
      agents.set(input.agentId, { ...up, errorsInARow: 0 })
      if (up.effort === 'max' && s.effort !== 'max') await count($, c => ({ ...c, maxEffort: (c.maxEffort ?? 0) + 1 }))
      await logEvent($, input.agentId, 'escalated', describeTier(up), input.reason ?? 'no reason given')
      return { result: `Escalated to ${describeTier(up)} from your next step.` }
    }
    const r = await read($, route)
    if (!mainRouting || !r || r.turnId === null || r.sessionModel) {
      return { result: 'No routed turn here: escalate only applies to the main conversation of a routed turn. Carry on.' }
    }
    const out = applyEscalation(r, input)
    if (!out.ok) return { result: `Not changed: ${out.why}. Carry on with the current route.` }
    await update($, route, () => out.route)
    await count($, c => ({
      ...c,
      escalations: c.escalations + 1,
      maxEffort: (c.maxEffort ?? 0) + (out.route.effort === 'max' && r.effort !== 'max' ? 1 : 0),
    }))
    return {
      result: `Route updated: from your next step this turn runs on ${out.route.model} at ${out.route.effort} effort. Now do the work.`,
    }
  })

  // Automatic fallback: a subagent that keeps failing is raised one step: effort first, then the next model.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const s = e.agentId === undefined ? undefined : agents.get(e.agentId)
    if (e.agentId === undefined || s === undefined || e.tool === TOOL_CALL || !(await read($, enabled))) return ran
    const failed = ran.deny === undefined && ran.isError === true
    const errorsInARow = failed ? s.errorsInARow + 1 : 0
    const up = errorsInARow >= AUTO_ESCALATE_AFTER ? stepUp(s, ids) : undefined
    if (up === undefined) {
      const atCeiling = errorsInARow >= AUTO_ESCALATE_AFTER
      // At the top already: start counting again rather than retrying each call.
      agents.set(e.agentId, { ...s, errorsInARow: atCeiling ? 0 : errorsInARow })
      if (!atCeiling || ran.isError !== true) return ran
      // Nothing left to raise: only the main conversation can go further, so tell the agent to hand back.
      const at = `${s.tier}/${s.effort ?? 'session effort'}`
      await logEvent($, e.agentId, 'ceiling reached', at, `${AUTO_ESCALATE_AFTER} tool errors in a row at the subagent ceiling`)
      return {
        ...ran,
        context: [
          ...(ran.context ?? []),
          `[model-router] You are at the subagent ceiling (${at}). Stop retrying: report what you found and what is blocking to the main conversation.`,
        ],
      }
    }
    agents.set(e.agentId, { ...up, errorsInARow: 0 })
    const why = up.tier === s.tier ? 'more effort on the same model' : 'next model'
    const again = up.tier === s.tier ? '' : ' again'
    await logEvent($, e.agentId, 'auto-escalated', describeTier(up), `${AUTO_ESCALATE_AFTER} tool errors in a row${again}: ${why}`)
    return ran
  })

  // A subagent the call gives no model gets one by its job: search on Haiku, work on Sonnet, judgment
  // inherits the parent. Never above the parent, never Fable; forks and workflow agents are left alone.
  on('agent.spawn', async ($, e, next) => {
    if (!(await read($, enabled)) || e.fork || e.workflow !== undefined) return next(e)
    if (e.resume !== undefined) {
      const ran = await next(e)
      // A reload loses tracking, but a resume must keep the engine's model and effort and any entry still here.
      if (ran.deny === undefined && ran.agentId !== undefined && !agents.has(ran.agentId)) {
        agents.set(ran.agentId, { ...startOf(ran.model, e.parentModel, false, ids), model: ran.model })
        resumed.add(ran.agentId)
      }
      return ran
    }
    const verdict = needsClassifier(e) ? await classifyTier($, lang, e.prompt, null, false) : null
    const failure = verdict && !verdict.ok ? verdict.why : undefined
    if (failure !== undefined) await countFailure($, failure)
    const failureText = verdict && !verdict.ok ? failText(verdict) : undefined
    const ok = verdict?.ok ? verdict.verdict : null
    const d = decideSpawn(e, ok?.tier ?? null, ok?.sure ?? true, blockFable)
    const ran = await next(d?.model === undefined ? e : { ...e, model: d.model })
    try {
      if (ran.deny === undefined && ran.agentId !== undefined) {
        const model = d?.model
        if (model !== undefined) {
          // The spawn counts its own Fable block; the agent's steps then run on Opus, and fableCounted keeps any later one from counting again.
          if (d?.fable) fableCounted.add(`agent:${ran.agentId}`)
          await count($, c => ({
            ...c,
            subagents: { ...c.subagents, [model]: c.subagents[model] + 1 },
            fableBlocked: c.fableBlocked + (d?.fable ? 1 : 0),
          }))
        }
        const s = startOf(ran.model, e.parentModel, model !== undefined, ids)
        agents.set(ran.agentId, s)
        // A failed classification keeps today's fallback (sonnet) and says why.
        const why = failureText !== undefined && d?.reason ? d.reason.replace('classifier failed', `classifier failed (${failureText})`) : d?.reason
        await logEvent($, ran.agentId, `${e.subagentType} start`, describeTier(s), why ?? 'as asked')
      }
    } catch {
      // Tracking is best effort: the agent has started either way.
    }
    return ran
  })
    // Fail open: a broken policy must never block a spawn.
    .catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const epoch = timerEpoch
    // Completion still reaches the engine when the compaction path has been cancelled.
    const done = await next(e)
    if (stale(epoch)) return done
    const r = await read($, route)
    if (stale(epoch)) return done
    if (e.agentId === undefined && r && r.turnId === e.turnId && turnSteps > 0) {
      // A slow average of the turn's shape feeds the warm-cache decision.
      const prev = ((await $.store.get('shape')) as Shape | undefined) ?? { steps: 3, output: 800 }
      if (stale(epoch)) return done
      const output = turnOutput / turnSteps
      await $.store.set('shape', { steps: prev.steps * 0.8 + turnSteps * 0.2, output: prev.output * 0.8 + output * 0.2 })
      if (stale(epoch)) return done
    }
    const isOn = await read($, enabled)
    if (stale(epoch) || !isOn) return done
    if (e.agentId === undefined && !e.isAborted && r && r.turnId === e.turnId && r.model === 'opus') {
      void maybeReview($, lang, reviewModel, pendingPrompt, e.answer)
    }
    if (e.agentId === undefined && (capOn || idleMs > 0)) {
      const completedAt = await $.clock.now()
      if (stale(epoch)) return done
      const g = { ...guard, completedAt }
      // Replace an earlier timer without moving past a cancel that landed during this completion.
      compactTimer?.cancel()
      compactTimer = null
      if (!e.isAborted && capOn && lastMain !== null && lastMain.context >= compactAtContext) {
        // The hook runs as the turn ends and compact rejects while a turn runs, so it goes on the next tick of the clock.
        compactTimer = $.clock.after(0, () => void runCap($, g, epoch, 0).catch(() => {}))
      } else {
        await armIdle($, g, epoch)
      }
    }
    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const { Box, Text, Button } = $.ui.resolve(e)

    if (!(await read($, enabled))) {
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1} alignItems="center">
            <Text dimColor>⚙ {str.off}</Text>
            <Button key="router-enable" label="Enable" onPress={() => setEnabled($, true)} />
          </Box>
          {below}
        </Box>
      )
    }

    const r = await read($, route)
    const m = (await read($, meter)) ?? { turn: EMPTY, today: EMPTY }
    const routeText = !r
      ? ''
      : r.sessionModel
        ? r.reason
        : `${LABEL[r.keptFrom ?? TIER_ROUTE[r.tier].model]} · ${TIER_ROUTE[r.tier].effort}` +
          (r.keptFrom ? ` → ${LABEL[r.model]} (${str.kept})` : '') +
          (r.trail.length > 0 ? ` → ${r.trail.join(' → ')}` : '') +
          (r.reason ? ` — ${r.reason}` : '')
    const s = saved(m.today)
    const meterText =
      `${str.turn} ${fmtTokens(m.turn.tokens)} token · ${fmtUsd(m.turn.cost)}   ` +
      `${str.today} ${fmtTokens(m.today.tokens)} token · ${fmtUsd(m.today.cost)}, ${str.save} ≈${fmtUsd(s.usd)} (${s.pct}%) ${str.vs}`

    // No route yet (a new session, or main routing off): the meter takes the gear's row, so there is no empty route row.
    if (!r) {
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1} alignItems="center">
            <Box flexShrink={0}>
              <Text dimColor>⚙</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1} width={0}>
              <Text dimColor wrap="truncate-end">
                {meterText}
              </Text>
            </Box>
            <Button key="router-disable" label="Disable router" onPress={() => setEnabled($, false)} />
          </Box>
          {below}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} alignItems="center">
          <Box flexShrink={0}>
            <Text dimColor>⚙</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1} width={0}>
            <Text dimColor wrap="truncate-end">
              {routeText}
            </Text>
          </Box>
          <Button key="router-disable" label="Disable router" onPress={() => setEnabled($, false)} />
        </Box>
        <Box paddingLeft={2}>
          <Text dimColor wrap="truncate-end">
            {meterText}
          </Text>
        </Box>
        {below}
      </Box>
    )
  })
}
