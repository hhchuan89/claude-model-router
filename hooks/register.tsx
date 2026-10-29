import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ModelKey, Route, Tally, Tier } from '../types'
import type { LastRequest, Shape, Usage } from './meter'
import { add, CACHE_TTL_MS, EMPTY, fmtTokens, fmtUsd, isSwitchStep, keepWarm, priceKey, saved, tokensOf } from './meter'
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

const route = atom({ plugin: 'model-router', key: 'route' } as const, null)
const enabled = atom({ plugin: 'model-router', key: 'enabled' } as const, true)
const meter = atom({ plugin: 'model-router', key: 'meter' } as const, { turn: EMPTY, today: EMPTY })

// The route chosen for a submitted prompt, waiting for its turn to start.
let pending: Route | null = null
// The person's prompt for the running turn, kept for the decision review.
let pendingPrompt = ''
// The main thread's last model request, for keeping a warm cache; and the running turn's step count.
let last: LastRequest | null = null
let turnSteps = 0
let turnOutput = 0
// What each tiered subagent is on now, by agent id.
const agents = new Map<string, AgentTier>()
// Per session: what changed and what each tiered subagent cost per model and effort. Written to
// ~/.claude/model-router/, one file per session, for your own analysis.
const log: EventLog = { sessionId: '', events: [], stats: {} }

const STR = {
  zh: {
    keptTier: (why: string) => `分类失败（${why}）：沿用上一档位`,
    sessionModel: (why: string) => `分类失败（${why}）：用会话模型`,
    inherited: '沿用上一轮路由',
    forced: '你在消息里指定了模型',
    off: 'Model router 已关闭',
    review: '决策审查',
    kept: '保缓存',
    turn: '本轮',
    today: '今日',
    save: '省',
    vs: '对比全用 Opus',
  },
  en: {
    keptTier: (why: string) => `classifier failed (${why}): kept previous tier`,
    sessionModel: (why: string) => `classifier failed (${why}): session model`,
    inherited: 'continues previous route',
    forced: 'model pinned in your message',
    off: 'Model router is off',
    review: 'Decision review',
    kept: 'cache kept',
    turn: 'turn',
    today: 'today',
    save: 'saved',
    vs: 'vs all on Opus',
  },
} as const

const LABEL: Record<ModelKey, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' }
const TIER_OF: Record<ModelKey, Tier> = { haiku: 'lookup', sonnet: 'execute', opus: 'decide' }

type Counts = {
  turns: Record<Tier, number>
  escalations: number
  cacheKeeps: number
  subagents: Record<ModelKey, number>
  fableBlocked: number
  // Steps whose answering model was not the family the router asked for.
  modelMismatch: number
  // Classifier calls that gave no usable verdict, by reason (main turns and subagents alike).
  classifierFailures: Record<string, number>
  // Escalations to max effort, main thread and subagents: max is meant to be rare.
  maxEffort: number
}
const NO_COUNTS: Counts = {
  turns: { lookup: 0, execute: 0, decide: 0 },
  escalations: 0,
  cacheKeeps: 0,
  subagents: { haiku: 0, sonnet: 0, opus: 0 },
  fableBlocked: 0,
  modelMismatch: 0,
  classifierFailures: {},
  maxEffort: 0,
}

function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

async function setEnabled($: EngineInterface, isOn: boolean) {
  await update($, enabled, () => isOn)
  await $.store.set('enabled', isOn)
}

// $.store has no compare-and-set, and steps of parallel subagents land at once: every read-modify-write
// goes through one chain so no increment is lost.
let writes: Promise<void> = Promise.resolve()

function serial($: EngineInterface, job: () => Promise<void>): Promise<void> {
  writes = writes.then(job).catch(err => $.ui.log(`model-router: store write failed: ${String(err)}`))
  return writes
}

function count($: EngineInterface, change: (c: Counts) => Counts): Promise<void> {
  return serial($, async () => {
    const c = ((await $.store.get('counts')) as Counts | undefined) ?? NO_COUNTS
    await $.store.set('counts', change(c))
  })
}

// Every model call this session pays for, the router's own included, goes on the turn, the day and the total.
// switched: a main-thread step that changed model family within the cache TTL (see baselineOf).
function record($: EngineInterface, modelId: string, u: Usage, switched = false): Promise<void> {
  return serial($, async () => {
    const day = `meter:${dayKey(await $.clock.now())}`
    const today = add(((await $.store.get(day)) as Tally | undefined) ?? EMPTY, modelId, u, switched)
    await $.store.set(day, today)
    await $.store.set('meter:all', add(((await $.store.get('meter:all')) as Tally | undefined) ?? EMPTY, modelId, u, switched))
    await update($, meter, m => ({ turn: add((m ?? { turn: EMPTY }).turn, modelId, u, switched), today }))
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
type Classified = { ok: true; verdict: Verdict } | { ok: false; why: string }

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
      maxTokens: 120,
      effort: 'low',
      timeoutMs: CLASSIFY_MS,
    })
    await record($, 'claude-haiku-5-5', r.usage)
    if (!r.isAnswered) {
      if (r.reason === 'aborted') return { ok: false, why: 'timeout' }
      if (r.reason === 'api-error') return { ok: false, why: `api-error ${r.status ?? 'none'}` }
      return { ok: false, why: 'empty-reply' }
    }
    const verdict = parseDecision(r.text)
    return verdict ? { ok: true, verdict } : { ok: false, why: 'unparseable' }
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
  const c = await classifyTier($, lang, text, previous?.tier ?? null, true)
  if (!c.ok) {
    await countFailure($, c.why)
    if (previous) return routeFor(previous.tier, STR[lang].keptTier(c.why))
    return { ...routeFor('execute', STR[lang].sessionModel(c.why)), sessionModel: true }
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
    `**${name}**: ${fmtTokens(t.tokens)} tokens, ${fmtUsd(t.cost)} API-equivalent; all on Opus would be ${fmtUsd(t.baseline)}, so ≈ ${fmtUsd(s.usd)} (${s.pct}%) saved.`,
    '',
    '| model | tokens | cost |',
    '|---|---|---|',
    ...rows,
  ].join('\n')
}

async function statsText($: EngineInterface): Promise<string> {
  const now = await $.clock.now()
  const today = ((await $.store.get(`meter:${dayKey(now)}`)) as Tally | undefined) ?? EMPTY
  const all = ((await $.store.get('meter:all')) as Tally | undefined) ?? EMPTY
  const c = ((await $.store.get('counts')) as Counts | undefined) ?? NO_COUNTS
  const failures = Object.entries(c.classifierFailures ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([why, n]) => `${why} ×${n}`)
  return [
    tallyLines('Today', today),
    '',
    tallyLines('All time', all),
    '',
    `Turns routed: lookup ${c.turns.lookup} · execute ${c.turns.execute} · decide ${c.turns.decide}. ` +
      `Escalations: ${c.escalations}. Kept on a warm cache: ${c.cacheKeeps}. ` +
      `Subagents routed: haiku ${c.subagents.haiku} · sonnet ${c.subagents.sonnet} · opus ${c.subagents.opus}. ` +
      `Fable requests moved to Opus: ${c.fableBlocked}. ` +
      `Routed model not the one that answered: ${c.modelMismatch ?? 0}. ` +
      `Classifier failures: ${failures.length > 0 ? failures.join(' · ') : 'none'}. ` +
      `Escalations to max effort: ${c.maxEffort ?? 0}.`,
    '',
    '_API-equivalent prices; the baseline prices the same tokens on Opus, so it is an estimate: another model would not use exactly the same tokens._',
  ].join('\n')
}

export const register: Register = (on, options) => {
  const lang: Lang = options.language === 'zh' ? 'zh' : 'en'
  const ids: Record<ModelKey, string> = {
    haiku: String(options.haikuModel ?? 'claude-haiku-5-5'),
    sonnet: String(options.sonnetModel ?? 'claude-sonnet-5-5'),
    opus: String(options.opusModel ?? 'claude-opus-5-5'),
  }
  // false: subagent-only mode. The main thread is neither classified nor rewritten; subagent routing, escalation,
  // Fable blocking and the meter keep working.
  const mainRouting = options.mainRouting !== false
  // Empty (the default) leaves the reviewer off.
  const reviewModel = String(options.reviewModel ?? '').trim()
  const str = STR[lang]

  on('session.start', async ($, e, next) => {
    await restore($)
    await $.command.register({
      name: 'model-router',
      description: 'Model router: "stats" for tokens and savings, "on" / "off" to toggle',
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
    await update($, enabled, () => stored !== false)
    const today = ((await $.store.get(`meter:${dayKey(await $.clock.now())}`)) as Tally | undefined) ?? EMPTY
    await update($, meter, () => ({ turn: EMPTY, today }))
    return next(e)
  })

  on('command.run', { command: 'model-router' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'stats' || arg === '') return { text: await statsText($) }
    if (arg !== 'on' && arg !== 'off') return { text: 'Usage: /model-router stats | on | off' }
    await setEnabled($, arg === 'on')
    return { text: `Model router ${arg === 'on' ? 'enabled' : 'disabled'}.` }
  })

  on('prompt.submit', async ($, e, next) => {
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
    const model = keepWarm(r.model, last, await $.clock.now(), shape)
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

  // Every model request: the turn's route on the main thread, never Fable 5.1 anywhere, and its usage on the meter.
  on('turn.step', async function* ($, e, next) {
    if (!(await read($, enabled))) return yield* next(e)
    let model = e.model
    let effort = e.effort
    const r = await read($, route)
    const isMain = e.agentId === undefined
    const sub = e.agentId === undefined ? undefined : agents.get(e.agentId)
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
    if (isFable(model)) {
      model = withSuffixOf(ids.opus, e.model)
      await count($, c => ({ ...c, fableBlocked: c.fableBlocked + 1 }))
    }
    const result =
      model === e.model && effort === e.effort ? yield* next(e) : yield* next({ ...e, model, effort })
    const u = result?.usage
    if (u) {
      const key = priceKey(u.model || model)
      const now = await $.clock.now()
      // Read before `last` moves on: a main step that switched family within the TTL is priced for what it cost.
      const switched = isMain && isSwitchStep(last, key, now)
      await record($, u.model || model, u, switched)
      if (isMain) {
        if (key !== 'fable') last = { model: key, at: now, context: tokensOf(u) - u.output_tokens }
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
    const verdict = needsClassifier(e) ? await classifyTier($, lang, e.prompt, null, false) : null
    const failure = verdict && !verdict.ok ? verdict.why : undefined
    if (failure !== undefined) await countFailure($, failure)
    const ok = verdict?.ok ? verdict.verdict : null
    const d = decideSpawn(e, ok?.tier ?? null, ok?.sure ?? true)
    const ran = await next(d?.model === undefined ? e : { ...e, model: d.model })
    try {
      if (ran.deny === undefined && ran.agentId !== undefined) {
        const model = d?.model
        if (model !== undefined) {
          await count($, c => ({
            ...c,
            subagents: { ...c.subagents, [model]: c.subagents[model] + 1 },
            fableBlocked: c.fableBlocked + (d?.fable ? 1 : 0),
          }))
        }
        const s = startOf(ran.model, e.parentModel, model !== undefined, ids)
        agents.set(ran.agentId, s)
        // A failed classification keeps today's fallback (sonnet) and says why.
        const why = failure !== undefined && d?.reason ? d.reason.replace('classifier failed', `classifier failed (${failure})`) : d?.reason
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
    const r = await read($, route)
    const done = await next(e)
    if (e.agentId === undefined && r && r.turnId === e.turnId && turnSteps > 0) {
      // A slow average of the turn's shape feeds the warm-cache decision.
      const prev = ((await $.store.get('shape')) as Shape | undefined) ?? { steps: 3, output: 800 }
      const output = turnOutput / turnSteps
      await $.store.set('shape', { steps: prev.steps * 0.8 + turnSteps * 0.2, output: prev.output * 0.8 + output * 0.2 })
    }
    if (e.agentId === undefined && !e.isAborted && r && r.turnId === e.turnId && r.model === 'opus' && (await read($, enabled))) {
      void maybeReview($, lang, reviewModel, pendingPrompt, e.answer)
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
