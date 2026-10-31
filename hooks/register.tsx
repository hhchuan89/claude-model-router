import { atom, memberOf, read, update } from 'claude-code'
import type { ElementConstructor, EngineInterface, Register, SessionRateLimit, SvgProps, Timer } from 'claude-code'

import type { Effort, ModelKey, Route, SpendRole, SpendUsage, Tally, Tier, TurnHow, TurnRecord } from '../types'
import type { LastRequest, Shape, Usage } from './meter'
import { add, CACHE_TTL_MS, CHECKPOINT_COOLDOWN_MS, CHECKPOINT_GROWTH, checkpointPays, EMPTY, fmtTokens, fmtUsd, isSwitchStep, isWarmOpus, keepWarm, merge, PRICES, priceKey, saved, tokensOf } from './meter'
import { looksLikeCode, outputLimit, outputPath, outputSlice, reduceOutput } from './output'
import { addCorrection, fewShot, readCorrections, snippetOf } from './learn'
import type { Correction } from './learn'
import { isPersonOrigin } from './origin'
import { fmtPace, isPaceMode, paceOf, sameWindow } from './pace'
import type { PaceMode } from './pace'
import { barChartSvg, chartAlt, hhmm, lastDays, sparkline, trailStep } from './pane'
import type { DayCost } from './pane'
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
import { Backoff, EventLogs } from './log'
import type { AgentTier } from './subagent'
import {
  AUTO_ESCALATE_AFTER,
  capSent,
  decideSpawn,
  describeTier,
  effortCap,
  escalateAgent,
  familyOf,
  isCallerPin,
  logDir,
  modelCap,
  needsClassifier,
  startOf,
  stepUp,
} from './subagent'

const FETCH_TOOL = 'fetch_output'
const FETCH_CALL = `mcp__model-router__${FETCH_TOOL}`
const TOOL = 'escalate'
const TOOL_CALL = `mcp__model-router__${TOOL}`
const CLASSIFY_MS = 8000
const PROBE_EVERY_MS = 24 * 3600 * 1000
// The verdict is a JSON object with a tier, a confidence and a reason; 120 tokens cut it off mid-reply.
const CLASSIFY_MAX_TOKENS = 300
const SNIPPET_CHARS = 120
const PANE = 'model-router'
const MAX_TURNS = 50
const PACE_DAYS = 7

// A lifetime starts with empty routing and turn spend; loading history never clears either.
const route = atom({ plugin: 'model-router', key: 'route' } as const, null)
const enabled = atom({ plugin: 'model-router', key: 'enabled' } as const, true)
const meter = atom({ plugin: 'model-router', key: 'meter' } as const, { turn: EMPTY, today: EMPTY })
// The pane's turn list. Change the shape tag when a record's fields change: it declines what an earlier version stored.
const turns = atom({ plugin: 'model-router', key: 'turns' } as const, [], { shape: 'turns-1' })

// The route chosen for a submitted prompt, waiting for its turn to start.
let pending: Route | null = null
// The person's prompt for the running turn, kept for the decision review.
let pendingPrompt = ''
let runningMain: string | null = null
let checkpointRunning = false
let checkpointTimer: Timer | null = null
let lastHint: { at: number; context: number } | null = null
// Fable blocks already counted: a main turn once per turnId, a subagent once per agent. Without this every step of a
// turn would add one.
const fableCounted = new Set<string>()
// The main thread's last non-Fable request, for switch accounting and continuing a route; and the running turn's
// step count.
let last: LastRequest | null = null
let turnSteps = 0
let turnOutput = 0
// The main thread's last request of ANY model family, Fable included (`last` skips Fable, which keepWarm never
// routes). The compaction guards and the cache-expiry counter read this one. Null after a compaction: the context is
// small now, so the old figure must not trigger again, and the next request is not a cache rewrite.
let lastMain: { at: number; context: number } | null = null
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
let guardPending: { at: number; kind: 'idle' | 'cap'; waiting?: number } | null = null
let lastSkipped: string | null = null
let skippedEpoch = -1
let rateLimits: SessionRateLimit[] = []
let uiTick: Timer | null = null
let agentStatus: string | undefined
let statusText: string | undefined
let uiNow = 0
let uiLang: Lang = 'en'
// A reading newer than the last main request. Cleared by the next request; measurements never move the cache timestamp.
let measuredContext: number | undefined
// A summary keeps the observed request family after forgetContext clears its timestamp. The session model is
// only a fallback: routing may have sent the request to a different family.
let observedModel: keyof typeof PRICES | undefined
let sessionModel: keyof typeof PRICES = 'opus'
// Pin: the main conversation's model for the next `left` person turns (left absent: until unpin or the session ends).
let pin: { model: ModelKey; left?: number } | null = null
// Set from the options at register. Off: nothing is recorded and the classifier prompt is the plain one.
let learning = true
let corrections: Correction[] = []
// The masked snippet of each classified turn's prompt, by turn id, for corrections. Memory only: it never reaches an
// atom, a log or the UI.
const snippets = new Map<string, string>()
const SNIPPETS_KEPT = 50
// Turns whose escalation was already recorded as a correction (once per turn), and the tier it moved them to.
const escalationRight = new Map<string, Tier>()
let pacingOption: PaceMode = 'warn'
// /model-router pacing <mode> persists across sessions and wins over the option.
let pacingOverride: PaceMode | undefined
// The weekly window (its resetsAt) the pace toast last fired for.
let paceWarned: string | undefined
// Once per process, not per session: a pane the person closed stays closed across /clear.
let paneAutoTried = false
// Whether the model-router pane is open, so a closed pane costs no redraw requests.
let paneOpen = false
// The running main turn's first request rewrote a cold cache; and the turn tally the turn started from (an inherited
// turn does not reset the tally, so its figures are the difference).
let turnCold = false
let turnBase = { tokens: 0, cost: 0 }
// An inherited turn's route already carries earlier escalations: its own start at this many trail steps.
let turnTrailBase = 0
// What the pane shows beyond the turn list, computed when it opens and after each main turn, never per render.
let paneData: { day: string; series: DayCost[]; session: Tally } | undefined
let paneDirty = true
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
const CHECKPOINT_INSTRUCTIONS =
  'Keep the current goal; all constraints and rules given; decisions made and why; unresolved findings and open questions; next steps; and file paths, commands and IDs needed to continue.'
// What each tiered subagent is on now, by agent id.
const agents = new Map<string, AgentTier>()
// Observed prices are separate from routing: forks and workflow agents have requests too.
const agentModels = new Map<string, keyof typeof PRICES>()
// Resumes after a reload resolve their effort on the first step, not in the spawn result.
const resumed = new Set<string>()
// The effort an Agent tool call set explicitly, by tool_use_id, until its spawn reads it. agent.spawn does not carry the
// call's arguments, so tool.call records them; the subagent's steps carry that effort, and the router must not replace
// it with its own starting effort.
const askedEffort = new Map<string, Effort>()
const AGENT_TOOLS: readonly string[] = ['Agent', 'Task']
const logs = new EventLogs()

function logIO($: EngineInterface) {
  return {
    root: $.plugin.root,
    now: Date.now,
    read: (path: string) => $.fs.read(path),
    write: (path: string, text: string) => $.fs.write(path, text),
    list: (path: string) => $.fs.list(path),
    stat: (path: string) => $.fs.stat(path),
    run: (argv: string[]) => $.process.run(argv),
    log: (text: string) => $.ui.log(text),
  }
}

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
    checkpointCompacted: (size: string) => `任务检查点：已压缩 ${size}`,
    checkpointStarted: '正在创建任务检查点…',
    checkpointHint: '预计检查点可在后续 15 步内抵消费用。任务之间可运行 /model-router checkpoint [备注]。',
    turnBusy: '无法创建检查点：主会话正在运行。请在轮次之间重试。',
    checkpointBusy: '无法创建检查点：另一个检查点正在运行。',
    checkpointCancelled: '检查点已取消：会话或路由状态已变化。',
    checkpointCount: (n: number) => `任务检查点：${n}。`,
    reductions: (n: number, chars: number) => `已精简工具输出：${n}；减少字符：${chars}。`,
    omitted: (n: number) => `[已省略 ${n} 行]`,
    archived: (path: string, id: string) => `原始输出已归档至 ${path}。调用 mcp__model-router__fetch_output，id 为 "${id}"，可指定 startLine/endLine 或 pattern（字面搜索）；offset 用于分页。`,
    fetchDescription: '按 id 获取本会话中精简前的原始工具输出。可选 startLine/endLine（从 1 开始，含末行）、pattern（不区分大小写的字面搜索）及 offset（所选内容中的字符偏移）。每次返回有字符上限，按下一个偏移继续。',
    patternDescription: '不区分大小写的字面子字符串',
    fetchOff: '工具输出精简已关闭。',
    fetchInvalid: '归档 id、行范围、搜索文本或偏移无效。',
    fetchMissing: '无法读取归档输出。',
    fetchMore: (offset: number) => `\n[输出已截断；使用相同范围和 offset ${offset} 继续获取。]`,
    weekly: '每周',
    resets: '重置',
    ctx: '上下文',
    step: '步',
    cold: '冷恢复',
    warm: (n: number) => `缓存仍热 ~${n}分钟`,
    expired: (size: string,
    cost: string) => `缓存已过期：下次提示重写 ≈${size}（≈${cost}）`,
    unknownContext: '上下文尚无读数',
    unknownCache: '缓存期限未知',
    idleIn: (n: number) => `空闲压缩将在 ${n} 分钟后执行`,
    capIn: '上下文上限压缩待执行',
    waiting: (n: number) => n < 0 ? '空闲压缩等待：无法确认代理状态' : `空闲压缩等待 ${n} 个代理`,
    skipped: (why: string) => `已跳过压缩：${why}`,
    deadlinePassed: '缓存安全期限已过',
    agentsBusy: '代理仍忙碌',
    agentUnavailable: '无法确认代理状态',
    routerOff: '路由已关闭',
    vetoed: '压缩被钩子跳过',
    rejected: '引擎拒绝压缩',
    usage: '用法：/model-router stats | status | context | checkpoint [备注] | on | off | pane | pin <haiku|sonnet|opus> [轮数] | unpin | wrong <lookup|execute|decide> | corrections [clear] | pacing [off|warn|steer|default]',
    commandDescription: '模型路由：stats 查看费用，status 查看设置，context 查看上下文，checkpoint [备注] 创建检查点，pane 侧栏，pin / unpin 固定模型，wrong 纠正路由，corrections 纠正记录，pacing 每周节奏，on / off 开关',
    pinned: (left?: number) => left === undefined ? '已固定模型' : `已固定模型（剩 ${left} 轮）`,
    pinNeedsRouting: '固定模型需要主会话路由（mainRouting 已关闭）。',
    pinSet: (model: string, left?: number) => left === undefined ? `已固定为 ${model}，直到 /model-router unpin 或会话结束。` : `已固定为 ${model}，接下来 ${left} 轮。`,
    pinRouterOff: ' 路由当前已关闭，开启后才生效。',
    unpinned: '已取消固定。',
    notPinned: '当前没有固定模型。',
    wrongOff: '从纠正中学习已关闭（learnFromCorrections）。',
    wrongNone: '没有可纠正的已分类轮次（强制、固定、沿用和失败的轮次不经分类）。',
    wrongNoText: '该轮的提示内容已不在内存中，无法记录。',
    wrongFailed: '无法保存纠正。',
    correctionsClearFailed: '已停止使用纠正记录，但无法删除磁盘上的副本，它可能仍然存在。',
    pacingNotSaved: '（无法保存：仅对本会话有效。）',
    wrongSame: (tier: string) => `该轮已被分到 ${tier}，没有记录。`,
    wrongDone: (at: string, routed: string, right: string) => `已记录：${at} 的轮次，分类为 ${routed}，应为 ${right}。`,
    corrections: '路由纠正',
    correctionsNone: '没有纠正记录。',
    correctionsCleared: '已清除纠正记录。',
    learnedOff: '（学习已关闭）',
    pacingMode: (mode: string, from: string) => `每周节奏：${mode}（${from}）`,
    pacingOption: '选项',
    pacingOverride: '覆盖',
    pacingSet: (mode: string) => `每周节奏已设为 ${mode}。`,
    pacingDefault: (mode: string) => `已取消覆盖，使用选项：${mode}。`,
    pacingFigures: (used: string, pace: string, state: string) => `已用 ${used}%，节奏 ${pace}（${state}）`,
    pacingNoWindow: '没有每周用量窗口',
    paceAhead: (x: string) => ` · 节奏 ${x} 超前`,
    paceToast: (used: string, x: string, steer: boolean) => `每周用量 ${used}%，节奏 ${x}，超过均匀消耗。${steer ? '未确定的决策将改用 Sonnet。' : ''}`,
    paneTitle: '路由器',
    paneNoTurns: '本会话还没有路由记录。',
    paneOn: '路由开',
    paneOff: '路由关',
    paneToday: '今日',
    paneSession: '本会话',
    paneWeek: '7 天花费',
    paneShould: '应为：',
    paneOpened: '已打开路由器侧栏。',
    paneClosed: '已关闭路由器侧栏。',
    paneUnavailable: '无法打开路由器侧栏。',
    tagCold: '冷',
    tagKept: '保缓存',
    tagPinned: '固定',
    tagForced: '指定',
    tagCorrected: '纠正',
    sessionRow: '会话模型',
    enabled: '启用',
    disabled: '关闭',
    enable: '启用路由',
    disable: '关闭路由',
    session: '本会话',
    settings: '当前设置',
    pending: '待执行',
    none: '无',
    deadline: '缓存期限',
    safeDeadline: '压缩安全期限',
    lastSkip: '上次跳过',
    unavailable: '无读数',
    categories: '本地估算分类（≈token）',
    noBreakdown: '无本地分类数据。',
    roles: { main: '主会话', subagents: '子代理', classifier: '分类器', reviewer: '审查器', compaction: '压缩' },
    usages: { read: '缓存读取', write: '缓存写入', input: '未缓存输入', output: '输出' },
    spendHeader: '| 类别 | token | 估算费用 |',
    peak: '主上下文峰值',
    rewrites: '冷重写次数',
    compactions: '压缩前 → 后',
    unknownSize: '未知',
    unattributed: '旧记录未分类费用',
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
    checkpointCompacted: (size: string) => `Checkpoint: compacted ${size}`,
    checkpointStarted: 'Creating checkpoint…',
    checkpointHint: 'A checkpoint may pay for itself over the next 15 steps. Between tasks, use /model-router checkpoint [note].',
    turnBusy: 'Checkpoint refused: a main turn is running. Try again between turns.',
    checkpointBusy: 'Checkpoint refused: a checkpoint is already running.',
    checkpointCancelled: 'Checkpoint cancelled: the conversation or router state changed.',
    checkpointCount: (n: number) => `Task-boundary checkpoints: ${n}.`,
    reductions: (n: number, chars: number) => `Tool outputs reduced: ${n}; characters removed: ${chars}.`,
    omitted: (n: number) => `[${n} lines omitted]`,
    archived: (path: string, id: string) => `Original archived at ${path}. Use mcp__model-router__fetch_output with id "${id}" and optional startLine/endLine or pattern (literal grep); offset pages through long results.`,
    fetchDescription: 'Fetch the exact original of a reduced tool output by id in this session. Optional startLine/endLine (1-based, inclusive), pattern (literal case-insensitive grep), and offset (character offset within that selection). Each call is capped; follow the next offset to continue.',
    patternDescription: 'Literal case-insensitive substring',
    fetchOff: 'Tool output reduction is off.',
    fetchInvalid: 'Invalid archive id, line range, pattern or offset.',
    fetchMissing: 'Archived output could not be read.',
    fetchMore: (offset: number) => `\n[Output capped; fetch the same selection with offset ${offset} to continue.]`,
    weekly: 'Weekly',
    resets: 'resets',
    ctx: 'ctx',
    step: 'step',
    cold: 'cold resume',
    warm: (n: number) => `cache warm ~${n}m`,
    expired: (size: string,
    cost: string) => `cache expired: next prompt rewrites ≈${size} (≈${cost})`,
    unknownContext: 'Context not measured yet',
    unknownCache: 'cache deadline unknown',
    idleIn: (n: number) => `idle compact in ${n}m`,
    capIn: 'context cap compact pending',
    waiting: (n: number) => n < 0 ? 'idle compact waiting: agent status unavailable' : `idle compact waiting for ${n} agent${n === 1 ? '' : 's'}`,
    skipped: (why: string) => `Compaction skipped: ${why}`,
    deadlinePassed: 'cache deadline passed',
    agentsBusy: 'agents still busy',
    agentUnavailable: 'agent status unavailable',
    routerOff: 'router off',
    vetoed: 'compaction skipped by hook',
    rejected: 'engine refused compaction',
    usage: 'Usage: /model-router stats | status | context | checkpoint [note] | on | off | pane | pin <haiku|sonnet|opus> [turns] | unpin | wrong <lookup|execute|decide> | corrections [clear] | pacing [off|warn|steer|default]',
    commandDescription: 'Model router: stats for spend, status for settings, context for context size, checkpoint [note] to compact, pane for the side pane, pin / unpin to hold a model, wrong to correct a route, corrections to list them, pacing for weekly pace, on / off to toggle',
    pinned: (left?: number) => left === undefined ? 'pinned' : `pinned (${left} left)`,
    pinNeedsRouting: 'Pinning needs main routing (mainRouting is off).',
    pinSet: (model: string, left?: number) => left === undefined ? `Pinned to ${model} until /model-router unpin or the session ends.` : `Pinned to ${model} for the next ${left} turn${left === 1 ? '' : 's'}.`,
    pinRouterOff: ' The router is off now; the pin applies once it is on.',
    unpinned: 'Unpinned.',
    notPinned: 'No model is pinned.',
    wrongOff: 'Learning from corrections is off (learnFromCorrections).',
    wrongNone: 'No classified turn to correct (forced, pinned, inherited and failed-classification turns were not classified).',
    wrongNoText: 'The prompt of that turn is no longer in memory, so nothing was recorded.',
    wrongFailed: 'Could not save the correction.',
    correctionsClearFailed: 'Corrections are no longer used, but the copy on disk could not be deleted and may remain.',
    pacingNotSaved: '(Could not be saved: this session only.)',
    wrongSame: (tier: string) => `That turn was already routed ${tier}; nothing recorded.`,
    wrongDone: (at: string, routed: string, right: string) => `Recorded: the ${at} turn was routed ${routed} and should have been ${right}.`,
    corrections: 'Routing corrections',
    correctionsNone: 'No corrections recorded.',
    correctionsCleared: 'Corrections cleared.',
    learnedOff: '(learning is off)',
    pacingMode: (mode: string, from: string) => `Weekly pacing: ${mode} (${from})`,
    pacingOption: 'option',
    pacingOverride: 'override',
    pacingSet: (mode: string) => `Weekly pacing set to ${mode}.`,
    pacingDefault: (mode: string) => `Override removed; using the option: ${mode}.`,
    pacingFigures: (used: string, pace: string, state: string) => `${used}% used, pace ${pace} (${state})`,
    pacingNoWindow: 'no weekly usage window',
    paceAhead: (x: string) => ` · pace ${x} ahead`,
    paceToast: (used: string, x: string, steer: boolean) => `Weekly usage ${used}% is using the week ${x} faster than an even pace.${steer ? ' Unsure decisions now route to Sonnet.' : ''}`,
    paneTitle: 'Router',
    paneNoTurns: 'No routed turns in this session yet.',
    paneOn: 'router on',
    paneOff: 'router off',
    paneToday: 'today',
    paneSession: 'session',
    paneWeek: '7-day spend',
    paneShould: 'Should have been:',
    paneOpened: 'Router pane opened.',
    paneClosed: 'Router pane closed.',
    paneUnavailable: 'The router pane could not be opened.',
    tagCold: 'cold',
    tagKept: 'kept',
    tagPinned: 'pinned',
    tagForced: 'forced',
    tagCorrected: 'corrected',
    sessionRow: 'session model',
    enabled: 'enabled',
    disabled: 'disabled',
    enable: 'Enable',
    disable: 'Disable router',
    session: 'This session',
    settings: 'Current settings',
    pending: 'Pending',
    none: 'none',
    deadline: 'Cache deadline',
    safeDeadline: 'Compaction safe deadline',
    lastSkip: 'Last skipped action',
    unavailable: 'unavailable',
    categories: 'Local category estimates (≈tokens)',
    noBreakdown: 'No local breakdown available.',
    roles: { main: 'Main', subagents: 'Subagents', classifier: 'Classifier', reviewer: 'Reviewer', compaction: 'Compaction' },
    usages: { read: 'Cache reads', write: 'Cache writes', input: 'Uncached input', output: 'Output' },
    spendHeader: '| category | tokens | estimated cost |',
    peak: 'Peak main context',
    rewrites: 'Cold rewrites counted',
    compactions: 'Compactions before → after',
    unknownSize: 'unknown',
    unattributed: 'Unattributed legacy spend',
  },
} as const

const LABEL: Record<ModelKey, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' }
// Named colours every surface accepts; one per model so a turn's model reads at a glance.
const TURN_COLOR: Record<ModelKey | 'session', string> = { haiku: 'green', sonnet: 'cyan', opus: 'magenta', session: 'gray' }
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
  // Compactions this plugin started: idle (cache warm), context cap and explicit task-boundary checkpoint.
  idleCompactions: number
  capCompactions: number
  checkpointCompactions: number
  outputReductions: number
  outputCharsRemoved: number
  // Main-thread requests that rewrote 100k+ tokens of cache after a gap past the TTL, and what those writes cost.
  cacheExpiryRewrites: number
  cacheExpiryRewriteCost: number
  // Routing corrections recorded, by source (the learning feature).
  correctionsManual: number
  correctionsEscalate: number
  // Unsure decide verdicts the weekly pacing steer moved to execute.
  pacingSteered: number
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
  checkpointCompactions: 0,
  outputReductions: 0,
  outputCharsRemoved: 0,
  cacheExpiryRewrites: 0,
  cacheExpiryRewriteCost: 0,
  correctionsManual: 0,
  correctionsEscalate: 0,
  pacingSteered: 0,
}

function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

function resetTime(at: string, lang: Lang): string {
  const d = new Date(at)
  if (!Number.isFinite(d.getTime())) return ''
  return `${d.toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-GB', { weekday: 'short' })} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function weeklyText(lang: Lang): string {
  const w = rateLimits.find(w => w.kind === 'seven_day')
  if (!w) return ''
  const reset = w.resetsAt ? resetTime(w.resetsAt, lang) : ''
  const p = pacingMode() === 'off' ? undefined : paceOf(w, uiNow)
  return `${STR[lang].weekly} ${w.percentUsed}%${reset ? ` · ${STR[lang].resets} ${reset}` : ''}${p?.state === 'ahead' ? STR[lang].paceAhead(fmtPace(p)) : ''}`
}

// The stored override wins over the option.
function pacingMode(): PaceMode {
  return pacingOverride ?? pacingOption
}

function weeklyLimit(): SessionRateLimit | undefined {
  return rateLimits.find(w => w.kind === 'seven_day')
}

// One redraw request for the pane (and the band); a missing surface must not affect the caller.
function redraw($: EngineInterface) {
  try {
    $.ui.invalidate('ui.render')
  } catch {
    // Nothing is drawn there.
  }
}

// Read at session start and by the first thing that needs them, not on every hook. A failed read is retried later
// with the other loads' backoff, and defaults stand until it succeeds.
function ensurePrefs($: EngineInterface, session: Session) {
  return loadPart($, session.prefs, () => loadPrefs($, session))
}

// A redraw for the pane's own content (turns, corrections): nothing to redraw while it is closed.
function redrawPane($: EngineInterface) {
  if (paneOpen) redraw($)
}

// The persisted choices: corrections, the pacing override and the window the pace toast last fired for.
async function loadPrefs($: EngineInterface, session: Session) {
  const stored = await $.store.get('corrections')
  const mode = await $.store.get('pacing')
  const warned = await $.store.get('paceWarned')
  if (!here(session)) return
  corrections = readCorrections(stored)
  pacingOverride = isPaceMode(mode) ? mode : undefined
  paceWarned = typeof warned === 'string' ? warned : undefined
}

// One toast when weekly use first runs ahead of an even pace in a window, remembered across sessions.
async function paceNotice($: EngineInterface, session: Session, now: number) {
  if (pacingMode() === 'off') return
  const w = weeklyLimit()
  const p = paceOf(w, now)
  if (p.state !== 'ahead' || !w?.resetsAt || sameWindow(paceWarned, w.resetsAt)) return
  paceWarned = w.resetsAt
  try {
    $.ui.toast(STR[uiLang].paceToast(String(w.percentUsed), fmtPace(p), pacingMode() === 'steer'))
  } catch {
    // A missing toast surface must not affect the status line.
  }
  await bookkeeping($, () => $.store.set('paceWarned', w.resetsAt!), undefined, retryFor(session, 'pace write'))
}

function pendingText(lang: Lang, now: number): string {
  if (!guardPending) return ''
  const str = STR[lang]
  if (guardPending.waiting !== undefined) return str.waiting(guardPending.waiting)
  return guardPending.kind === 'cap' ? str.capIn : str.idleIn(Math.max(0, Math.ceil((guardPending.at - now) / 60_000)))
}

function publishStatus($: EngineInterface) {
  const text = [weeklyText(uiLang), guardPending ? pendingText(uiLang, uiNow) : agentStatus].filter(Boolean).join(' │ ') || undefined
  if (text === statusText) return
  statusText = text
  try {
    $.ui.status(text)
  } catch {
    // A missing status surface must not affect a guard.
  }
}

// A minute tick redraws estimates and countdowns even while the person is away. It makes no model or usage calls.
function refreshUi($: EngineInterface, session: Session, now: number) {
  if (!here(session)) return
  uiNow = now
  publishStatus($)
  uiTick?.cancel()
  uiTick = $.clock.every(60_000, async () => {
    const identity = await stillHere($, session)
    if (identity !== 'same') {
      // An id change without session.end still retires this lifetime. A newer activation owns its own UI.
      if (identity === 'different' && here(session)) {
        session.ended = true
        sessionGeneration += 1
        resetSession($)
      }
      return
    }
    const now = await $.clock.now()
    if (await stillHere($, session) !== 'same') return
    uiNow = now
    publishStatus($)
    $.ui.invalidate('ui.render')
  })
  $.ui.invalidate('ui.render')
}

function skipCompact($: EngineInterface, why: string) {
  if (skippedEpoch === timerEpoch) return
  skippedEpoch = timerEpoch
  lastSkipped = STR[uiLang].skipped(why)
  try {
    $.ui.toast(lastSkipped)
  } catch {
    // The skipped action still belongs in status.
  }
}

function clearGuard($: EngineInterface) {
  guardPending = null
  publishStatus($)
}

// A person coming back, or any new turn, must never be compacted under.
function cancelCompact($: EngineInterface) {
  timerEpoch += 1
  compactTimer?.cancel()
  compactTimer = null
  checkpointTimer?.cancel()
  checkpointTimer = null
  clearGuard($)
  $.ui.invalidate('ui.render')
}

// A hook and every callback it starts keep the originating session, including across /clear and resume.
// The id alone is not enough: an ended session can be resumed again in this process.
type Load = { done: boolean; pending?: Promise<void>; retry: Backoff }
type Session = { id: string; stateId: string; ended: boolean; history: Load; daily: Load; prefs: Load; retries: Map<string, Backoff>; today?: Tally }
let activeSession: Session | undefined
// Host state survives hot reload; a new module must never select an earlier activation's members.
const activationId = crypto.randomUUID()
// Every lifetime (including end and same-id resume) invalidates older identity lookups.
let sessionGeneration = 0
let identityRetry = new Backoff()

function newSession(id: string, ended = false): Session {
  identityRetry = new Backoff()
  return { id, stateId: `${activationId}-${++sessionGeneration}`, ended, history: { done: false, retry: new Backoff() }, daily: { done: false, retry: new Backoff() }, prefs: { done: false, retry: new Backoff() }, retries: new Map() }
}

function retryFor(session: Session, key: string): Backoff {
  let retry = session.retries.get(key)
  if (!retry) session.retries.set(key, retry = new Backoff())
  return retry
}

function sessionId($: EngineInterface) {
  return bookkeeping($, () => $.session.id(), undefined, identityRetry)
}

function here(session: Session | undefined): session is Session {
  return session !== undefined && session === activeSession && !session.ended
}

async function useSession($: EngineInterface): Promise<Session | undefined> {
  const generation = sessionGeneration
  const id = await sessionId($)
  if (id === undefined || generation !== sessionGeneration) return undefined
  if (activeSession?.id === id && !activeSession.ended) {
    const session = activeSession
    await readySession($, session)
    void logs.flush(logIO($))
    return session
  }
  const first = activeSession === undefined
  const session = newSession(id)
  activeSession = session
  resetSession($, !first)
  await readySession($, session)
  void logs.flush(logIO($))
  return session
}

// Activation rereads disk history without keeping it. Each load finishes independently; backoff never holds a hook.
async function readySession($: EngineInterface, session: Session) {
  await Promise.all([
    loadPart($, session.history, async () => { await logs.read(logIO($), session.id) }),
    loadPart($, session.daily, async () => {
      const now = await $.clock.now()
      if (!here(session)) return
      const { today } = await totals($, now, true)
      if (here(session) && session.today === undefined) session.today = today
    }),
  ])
}

async function loadPart($: EngineInterface, part: Load, job: () => Promise<void>) {
  if (part.done || part.retry.waiting(Date.now())) return
  part.pending ??= Promise.resolve().then(() => bookkeeping($, async () => {
    await job()
    part.done = true
  }, undefined, part.retry)).finally(() => { part.pending = undefined })
  await part.pending
}

// An unavailable id (including backoff) skips this action without ending the lifetime or cancelling its timers.
async function stillHere($: EngineInterface, session: Session): Promise<'same' | 'different' | 'unavailable'> {
  if (!here(session)) return 'different'
  const id = await sessionId($)
  if (!here(session)) return 'different'
  return id === undefined ? 'unavailable' : id === session.id ? 'same' : 'different'
}

function resetSession($: EngineInterface, cancel = true) {
  // The first activation has no work to cancel; its entry-point generation is already current.
  if (cancel) cancelCompact($)
  uiTick?.cancel()
  uiTick = null
  checkpointRunning = false
  pending = null
  pendingPrompt = ''
  runningMain = null
  last = null
  lastMain = null
  mainRequestSequence = 0
  justCompacted = false
  turnSteps = 0
  turnOutput = 0
  lastHint = null
  measuredContext = undefined
  observedModel = undefined
  sessionModel = 'opus'
  pin = null
  snippets.clear()
  escalationRight.clear()
  turnCold = false
  turnBase = { tokens: 0, cost: 0 }
  turnTrailBase = 0
  paneData = undefined
  paneDirty = true
  rateLimits = []
  lastSkipped = null
  skippedEpoch = -1
  agentStatus = undefined
  agents.clear()
  agentModels.clear()
  resumed.clear()
  askedEffort.clear()
  fableCounted.clear()
  publishStatus($)
}

// The context is a summary now (whoever compacted): the old figures must not steer routing or trigger a guard.
function forgetContext() {
  last = null
  lastMain = null
  justCompacted = true
  measuredContext = undefined
}

// Measurements are newer than lastMain; the next recorded request clears them. A local usage query can supply
// an even newer size. Size changes never replace an observed request model or move its cache timestamp.
function contextReading(tokens?: number) {
  return { tokens: tokens ?? measuredContext ?? lastMain?.context, model: observedModel ?? sessionModel }
}

function warmRequest(): LastRequest | null {
  const { tokens, model } = contextReading()
  return lastMain === null || model === 'fable' ? null : { at: lastMain.at, context: tokens ?? 0, model }
}

function exposureText(lang: Lang, now: number, columns: number): string {
  const str = STR[lang]
  const { tokens: context, model } = contextReading()
  if (context === undefined) return str.unknownContext
  const size = fmtTokens(context)
  const cold = fmtUsd(context * PRICES[model].write / 1e6)
  const label = model === 'fable' ? 'Fable' : LABEL[model]
  const prefix = `${columns >= 55 ? `${label} · ` : ''}${str.ctx} ${size}`
  if (lastMain && now >= lastMain.at + CACHE_TTL_MS) return `${prefix} │ ${str.expired(size, cold)}`
  const read = columns >= 90 ? ` · ≈$${(context * PRICES[model].read / 1e6).toFixed(3)}/${str.step}` : ''
  const warmth = columns >= 65 ? ` · ${lastMain ? str.warm(Math.max(0, Math.ceil((lastMain.at + CACHE_TTL_MS - now) / 60_000))) : str.unknownCache}` : ''
  return `${prefix}${read} │ ${str.cold} ≈${cold}${warmth}`
}

async function setEnabled($: EngineInterface, session: Session, isOn: boolean) {
  if (!here(session)) return
  // Off must also stop a compaction already scheduled.
  compactEnabled = isOn
  if (!isOn) {
    if (guardPending) skipCompact($, STR[uiLang].routerOff)
    cancelCompact($)
  }
  if (await stillHere($, session) !== 'same') return
  await update($, enabled, previous => here(session) ? isOn : previous)
  if (await stillHere($, session) !== 'same') return
  await bookkeeping($, () => $.store.set('enabled', isOn), undefined, retryFor(session, 'enabled write'))
}

// Each session owns its daily keys. The chain also keeps parallel subagent increments in this process in order.
let writes: Promise<void> = Promise.resolve()
const RETAIN_DAYS = 30
let prunedDay = ''
let prunedLogsDay = ''
const pruneRetry = new Backoff()
const pruneLogsRetry = new Backoff()

function oldestDay(now: number): string {
  const d = new Date(now)
  d.setDate(d.getDate() - RETAIN_DAYS + 1)
  return dayKey(d.getTime())
}

async function prune($: EngineInterface, now: number) {
  const day = dayKey(now)
  if (prunedDay !== day) await bookkeeping($, async () => {
    const oldest = oldestDay(now)
    for (const key of await $.store.keys()) {
      const day = /^(?:meter|counts):(\d{8}):/.exec(key)?.[1]
      if (day !== undefined && day < oldest) await $.store.delete(key)
    }
    prunedDay = day
  }, undefined, pruneRetry)
  if (prunedLogsDay !== day) await bookkeeping($, async () => {
    await logs.prune(logIO($), now, RETAIN_DAYS)
    prunedLogsDay = day
  }, undefined, pruneLogsRetry)
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

function storeFailure($: EngineInterface, err: unknown) {
  try { $.ui.log(`model-router: bookkeeping failed: ${String(err)}`) } catch { /* Logging is best effort too. */ }
}

async function bookkeeping<T>($: EngineInterface, job: () => Promise<T>, fallback: T, retry?: Backoff): Promise<T> {
  if (retry?.waiting(Date.now())) return fallback
  try {
    const value = await job()
    retry?.reset()
    return value
  } catch (err) {
    // Concurrent readers may have started before the first one failed. They share its backoff step.
    if (!retry || !retry.waiting(Date.now())) {
      retry?.fail(Date.now())
      storeFailure($, err)
    }
    return fallback
  }
}

function serial($: EngineInterface, session: Session, key: string, job: () => Promise<void>): Promise<void> {
  writes = writes.then(async () => { if (await stillHere($, session) === 'same') await bookkeeping($, job, undefined, retryFor(session, key)) }).catch(err => storeFailure($, err))
  return writes
}

function count($: EngineInterface, session: Session, change: (c: Counts) => Counts): Promise<void> {
  return serial($, session, 'counts', async () => {
    const now = await $.clock.now()
    await prune($, now)
    const key = `counts:${dayKey(now)}:${session.id}`
    const c = ((await $.store.get(key)) as Counts | undefined) ?? NO_COUNTS
    if (await stillHere($, session) !== 'same') return
    await $.store.set(key, change(c))
  })
}

// Every model call this session pays for, the router's own included, goes on the turn, the day and the total.
// switched: a main-thread step that changed model family within the cache TTL (see baselineOf).
function record($: EngineInterface, session: Session, modelId: string, u: Usage, switched = false, overhead = false, role: SpendRole = 'main'): Promise<void> {
  return serial($, session, 'meter', async () => {
    const now = await $.clock.now()
    await prune($, now)
    const key = `meter:${dayKey(now)}:${session.id}`
    const previous = ((await $.store.get(key)) as Tally | undefined) ?? EMPTY
    if (await stillHere($, session) !== 'same') return
    await $.store.set(key, add(previous, modelId, u, switched, overhead, role))
    const loaded = await bookkeeping($, async () => {
      const { today } = await totals($, now, true)
      return today
    }, undefined, session.daily.retry)
    if (await stillHere($, session) !== 'same') return
    if (loaded !== undefined) {
      session.today = loaded
      session.daily.done = true
    }
    const today = session.today ?? EMPTY
    await update($, memberOf(meter, { requestId: session.stateId }), m => here(session) ? { turn: add((m ?? { turn: EMPTY }).turn, modelId, u, switched, overhead, role), today } : m)
  })
}

function recordDetail($: EngineInterface, session: Session, change: (t: Tally, now: number) => Tally): Promise<void> {
  return serial($, session, 'meter detail', async () => {
    const now = await $.clock.now()
    const key = `meter:${dayKey(now)}:${session.id}`
    const previous = ((await $.store.get(key)) as Tally | undefined) ?? EMPTY
    if (await stillHere($, session) !== 'same') return
    await $.store.set(key, change(previous, now))
  })
}

async function sessionTally($: EngineInterface, session: Session): Promise<Tally> {
  const id = session.id
  let t = EMPTY
  for (const key of await $.store.keys()) {
    if (!/^meter:\d{8}:/.test(key) || !key.endsWith(`:${id}`)) continue
    const value = (await $.store.get(key)) as Tally | undefined
    if (value) t = merge(t, value)
  }
  return t
}

async function rewriteCount($: EngineInterface, day?: string, id?: string): Promise<number> {
  let n = 0
  for (const key of await $.store.keys()) {
    const m = /^counts:(\d{8}):(.+)$/.exec(key)
    if (!m || (day !== undefined && m[1] !== day) || (id !== undefined && m[2] !== id)) continue
    const c = (await $.store.get(key)) as Counts | undefined
    n += c?.cacheExpiryRewrites ?? 0
  }
  return n
}

// Guard status takes the subagent event slot only while a guard is pending.
async function logEvent($: EngineInterface, session: Session, agentId: string, event: string, to: string, reason: string) {
  const now = await $.clock.now()
  if (await stillHere($, session) !== 'same') return
  logs.event(session.id, { at: new Date(now).toISOString(), agentId, event, to, reason })
  if (agentId !== 'main') {
    agentStatus = `subagent ${event}: ${to} (${reason})`
    publishStatus($)
  }
  void logs.flush(logIO($))
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

// The few-shot block of earlier corrections; nothing at all (the prompt is the plain one) when learning is off or
// there are none.
function learnedBlock(lang: Lang): string {
  const block = learning ? fewShot(corrections, lang) : ''
  return block === '' ? '' : `\n\n${block}`
}

// Haiku sorts a text into a tier. withContext adds the last two messages.
async function classifyTier($: EngineInterface, session: Session, lang: Lang, text: string, previous: Tier | null, withContext: boolean): Promise<Classified> {
  try {
    await ensurePrefs($, session)
    const context = withContext ? await recentContext($) : ''
    if (await stillHere($, session) !== 'same') return { ok: false, why: 'session changed' }
    const r = await $.model.complete({
      model: 'haiku',
      system: classifierSystem(lang) + learnedBlock(lang),
      prompt:
        `<previous_tier>${previous ?? 'none'}</previous_tier>\n` +
        `<context>\n${context || '(none)'}\n</context>\n\n<message>\n${redact(text).slice(0, 6000)}\n</message>`,
      maxTokens: CLASSIFY_MAX_TOKENS,
      effort: 'low',
      timeoutMs: CLASSIFY_MS,
    })
    if (await stillHere($, session) !== 'same') return { ok: false, why: 'session changed' }
    await record($, session, 'claude-haiku-5-5', r.usage, false, true, 'classifier')
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

function countFailure($: EngineInterface, session: Session, why: string): Promise<void> {
  return count($, session, c => {
    const failures = c.classifierFailures ?? {}
    return { ...c, classifierFailures: { ...failures, [why]: (failures[why] ?? 0) + 1 } }
  })
}

// A failed classification never downgrades: it keeps the previous route's tier, and with no previous route the
// turn is left unrouted, on the session's own model (sessionModel). Switching to Sonnet on failure cost money:
// 24% of those turns later escalated to Opus, against 6% of classified ones.
async function classify($: EngineInterface, session: Session, lang: Lang, text: string, previous: Route | null): Promise<Route> {
  const how = (r: Route, how: TurnHow): Route => ({ ...r, how })
  const forced = forcedModel(text)
  if (forced) return how(routeFor(TIER_OF[forced], STR[lang].forced), 'forced')
  // A pin acts as a #model in every message: no classifier, and the cache is not kept (see prompt.submit).
  if (pin) return how(routeFor(TIER_OF[pin.model], STR[lang].pinned(pin.left)), 'pinned')
  await ensurePrefs($, session)
  const now = await $.clock.now()
  // The verdict could not change anything: keepWarm keeps a warm large Opus context on Opus whatever the tier.
  if (isWarmOpus(warmRequest(), now)) {
    await count($, session, c => ({ ...c, classifierSkipped: (c.classifierSkipped ?? 0) + 1 }))
    return how(routeFor('decide', STR[lang].warmSkip), 'warm-skip')
  }
  // A steered turn hands on the tier the classifier settled on, not the one pacing moved it to.
  const previousTier = previous ? previous.steeredFrom ?? previous.tier : null
  const c = await classifyTier($, session, lang, text, previousTier, true)
  if (!c.ok) {
    await countFailure($, session, c.why)
    if (previous) return how(routeFor(previousTier!, STR[lang].keptTier(failText(c))), 'kept-tier')
    return { ...routeFor('execute', STR[lang].sessionModel(failText(c))), sessionModel: true, how: 'session-model' }
  }
  const s = settleTier(c.verdict, previousTier)
  // Weekly pacing, steer mode only: while use runs ahead of an even pace, a decide the classifier was unsure of goes to
  // execute. Whatever follows still applies: keepWarm keeps a warm large Opus context where it is, a sure decide stays
  // on Opus, escalate can raise the turn, and #model or a pin never get here.
  const w = weeklyLimit()
  const pace = paceOf(w, now)
  if (pacingMode() === 'steer' && c.verdict.tier === 'decide' && !c.verdict.sure && pace.state === 'ahead' && w) {
    const reason = `${s.reason} (pacing: weekly ${w.percentUsed}%, ${fmtPace(pace)} pace)`.trim()
    return { ...how(routeFor('execute', reason), 'classified'), steered: true, steeredFrom: s.tier }
  }
  return how(routeFor(s.tier, s.reason), 'classified')
}

// Keeps a classified turn's masked prompt for a later correction, newest SNIPPETS_KEPT only.
function rememberSnippet(turnId: string, prompt: string) {
  const text = snippetOf(prompt)
  if (text === '') return
  snippets.set(turnId, text)
  while (snippets.size > SNIPPETS_KEPT) snippets.delete(snippets.keys().next().value!)
}

// Writes one correction (newest last, capped, a repeated text replaced) and counts it by source. False when the store
// could not be written; nothing is claimed then.
async function recordCorrection($: EngineInterface, session: Session, c: Correction, counted = true): Promise<boolean> {
  let ok = false
  await serial($, session, 'corrections', async () => {
    const next = addCorrection(readCorrections(await $.store.get('corrections')), c)
    if (await stillHere($, session) !== 'same') return
    await $.store.set('corrections', next)
    corrections = next
    ok = true
  })
  if (ok && counted) {
    await count($, session, k => c.source === 'manual'
      ? { ...k, correctionsManual: (k.correctionsManual ?? 0) + 1 }
      : { ...k, correctionsEscalate: (k.correctionsEscalate ?? 0) + 1 })
  }
  return ok
}

// The only turns a correction can apply to: the classifier sorted them and nothing moved them since. A steered turn
// was routed by pacing, so correcting it would teach a verdict the classifier never gave. The pane's buttons and the
// command both choose by this.
function isCorrectable(t: TurnRecord): boolean {
  return t.how === 'classified' && !t.steered
}

// The turn a correction applies to: the one named (a pane button names the turn it drew), else the latest correctable.
async function correctionTarget($: EngineInterface, session: Session, turnId?: string): Promise<TurnRecord | undefined> {
  const list = await bookkeeping($, () => read($, memberOf(turns, { requestId: session.stateId })), [] as TurnRecord[])
  return turnId === undefined ? [...list].reverse().find(isCorrectable) : list.find(t => t.turnId === turnId && isCorrectable(t))
}

// "/model-router wrong <tier>" and the pane's buttons. Answers with what was recorded, or why nothing was.
async function correctTurn($: EngineInterface, session: Session, lang: Lang, right: Tier, turnId?: string): Promise<string> {
  const str = STR[lang]
  if (!learning) return str.wrongOff
  const rec = await correctionTarget($, session, turnId)
  if (await stillHere($, session) !== 'same') return str.checkpointCancelled
  if (!rec) return str.wrongNone
  if (rec.tier === right) return str.wrongSame(rec.tier)
  const text = snippets.get(rec.turnId)
  if (text === undefined) return str.wrongNoText
  const at = await $.clock.now()
  if (await stillHere($, session) !== 'same') return str.checkpointCancelled
  if (!(await recordCorrection($, session, { at, text, routed: rec.tier, right, source: 'manual' }))) return str.wrongFailed
  await bookkeeping($, () => update($, memberOf(turns, { requestId: session.stateId }), list => here(session) ? list.map(t => t.turnId === rec.turnId ? { ...t, corrected: right } : t) : list), undefined)
  paneDirty = true
  redrawPane($)
  return str.wrongDone(hhmm(rec.at), rec.tier, right)
}

async function pressWrong($: EngineInterface, session: Session, lang: Lang, right: Tier, turnId: string) {
  const text = await correctTurn($, session, lang, right, turnId)
  try {
    $.ui.toast(text)
  } catch {
    // The answer is also what the command gives.
  }
}

// The small per-turn record the pane lists, written when a main turn the route governs completes.
async function writeTurnRecord($: EngineInterface, session: Session, r: Route, turnId: string) {
  const m = await bookkeeping($, () => read($, memberOf(meter, { requestId: session.stateId })), undefined)
  const at = await $.clock.now()
  if (await stillHere($, session) !== 'same') return
  const rec: TurnRecord = {
    turnId,
    at,
    tier: r.tier,
    model: r.sessionModel ? 'session' : r.model,
    ...(r.sessionModel ? {} : { effort: r.effort }),
    // An inherited turn's route carries the earlier turn's cache keep and escalations: only its own are its.
    ...(r.keptFrom && r.how !== 'inherited' ? { keptFrom: r.keptFrom } : {}),
    reason: r.reason,
    trail: r.trail.slice(turnTrailBase),
    tokens: Math.max(0, (m?.turn.tokens ?? 0) - turnBase.tokens),
    cost: Math.max(0, (m?.turn.cost ?? 0) - turnBase.cost),
    cold: turnCold,
    // A route without a tag (one an earlier version stored) was not classified by this one: not correctable.
    how: r.how ?? 'inherited',
    ...(r.steered ? { steered: true } : {}),
    ...(escalationRight.has(turnId) ? { corrected: escalationRight.get(turnId) } : {}),
  }
  await bookkeeping($, () => update($, memberOf(turns, { requestId: session.stateId }), list => here(session) ? [...list, rec].slice(-MAX_TURNS) : list), undefined, retryFor(session, 'turn record'))
  paneDirty = true
  redrawPane($)
}

// The seven-day series and the session total in one pass over the store keys.
async function refreshPaneData($: EngineInterface, session: Session, now: number) {
  const days = lastDays(now, PACE_DAYS, dayKey)
  const byDay = new Map<string, Tally>()
  let mine = EMPTY
  for (const key of await $.store.keys()) {
    const m = /^meter:(\d{8})(?::(.+))?$/.exec(key)
    if (!m) continue
    const inWeek = days.includes(m[1]!)
    const own = m[2] === session.id
    if (!inWeek && !own) continue
    const t = (await $.store.get(key)) as Tally | undefined
    if (!t) continue
    if (inWeek) byDay.set(m[1]!, merge(byDay.get(m[1]!) ?? EMPTY, t))
    if (own) mine = merge(mine, t)
  }
  if (await stillHere($, session) !== 'same') return
  paneData = { day: dayKey(now), series: days.map(day => ({ day, cost: byDay.get(day)?.cost ?? 0, baseline: byDay.get(day)?.baseline ?? 0 })), session: mine }
  paneDirty = false
}

async function openPane($: EngineInterface, title: string): Promise<boolean> {
  paneDirty = true
  try {
    const opened = await $.ui.open({ id: PANE, title })
    paneOpen = true
    return opened.isPlaced
  } catch {
    return false
  }
}

async function togglePane($: EngineInterface, lang: Lang): Promise<string> {
  const str = STR[lang]
  try {
    if ((await $.ui.panes()).some(p => p.id === PANE)) {
      await $.ui.close({ id: PANE })
      paneOpen = false
      return str.paneClosed
    }
  } catch {
    // Not listed: try to open it.
  }
  // An answer to the person's own command is placed at any width.
  return (await openPane($, str.paneTitle)) ? str.paneOpened : str.paneUnavailable
}

async function pinCommand($: EngineInterface, lang: Lang, arg: string, mainRouting: boolean): Promise<string> {
  const str = STR[lang]
  if (arg === 'unpin') {
    if (!pin) return str.notPinned
    pin = null
    redraw($)
    return str.unpinned
  }
  if (!mainRouting) return str.pinNeedsRouting
  const m = /^pin\s+(haiku|sonnet|opus)(?:\s+(\d{1,3}))?$/i.exec(arg)
  const left = m?.[2] === undefined ? undefined : Number(m[2])
  if (!m || left === 0) return str.usage
  const model = m[1]!.toLowerCase() as ModelKey
  pin = left === undefined ? { model } : { model, left }
  redraw($)
  return str.pinSet(LABEL[model], left) + ((await read($, enabled)) ? '' : str.pinRouterOff)
}

function pacingLine(lang: Lang, now: number): string {
  const str = STR[lang]
  const from = pacingOverride === undefined ? str.pacingOption : str.pacingOverride
  const w = weeklyLimit()
  const p = paceOf(w, now)
  const figures = w ? str.pacingFigures(String(w.percentUsed), p.state === 'unknown' ? '–' : fmtPace(p), p.state) : str.pacingNoWindow
  return `${str.pacingMode(pacingMode(), from)} · ${figures}`
}

async function pacingCommand($: EngineInterface, session: Session, lang: Lang, arg: string): Promise<string> {
  const str = STR[lang]
  const value = arg.replace(/^pacing\s*/, '').toLowerCase()
  await ensurePrefs($, session)
  if (value === '') return pacingLine(lang, await $.clock.now())
  if (value !== 'default' && !isPaceMode(value)) return str.usage
  if (await stillHere($, session) !== 'same') return str.checkpointCancelled
  // Takes effect at once; the store write is what makes it last across sessions.
  pacingOverride = value === 'default' ? undefined : value as PaceMode
  let saved = false
  await bookkeeping($, async () => { await (value === 'default' ? $.store.delete('pacing') : $.store.set('pacing', value)); saved = true }, undefined, retryFor(session, 'pacing write'))
  const now = await $.clock.now()
  if (await stillHere($, session) !== 'same') return str.checkpointCancelled
  publishStatus($)
  redraw($)
  await paceNotice($, session, now)
  return (value === 'default' ? str.pacingDefault(pacingMode()) : str.pacingSet(value)) + (saved ? '' : ` ${str.pacingNotSaved}`)
}

async function correctionsCommand($: EngineInterface, session: Session, lang: Lang, arg: string): Promise<string> {
  const str = STR[lang]
  // Loaded first: a later load must not bring back what clear emptied.
  await ensurePrefs($, session)
  if (/^corrections\s+clear$/.test(arg)) {
    let deleted = false
    await bookkeeping($, async () => { await $.store.delete('corrections'); deleted = true }, undefined, retryFor(session, 'corrections write'))
    // Whatever the disk says, nothing more is sent to the classifier.
    corrections = []
    return deleted ? str.correctionsCleared : str.correctionsClearFailed
  }
  if (arg !== 'corrections') return str.usage
  const list = readCorrections(await bookkeeping($, () => $.store.get('corrections'), undefined, retryFor(session, 'corrections read')))
  const off = learning ? '' : ` ${str.learnedOff}`
  if (list.length === 0) return `${str.correctionsNone}${off}`
  return [`${str.corrections}${off}:`,
    ...list.map((c, i) => `${i + 1}. "${c.text}" ${c.routed} → ${c.right} · ${c.source} · ${dayKey(c.at).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3')}`)].join('\n')
}

// The last route that actually routed a turn: an unrouted (session model) turn is not one.
function routed(r: Route | null): Route | null {
  return r && !r.sessionModel ? r : null
}

// Whether the reviewer model exists on this account; asked at most once a day.
async function reviewerAvailable($: EngineInterface, session: Session, reviewModel: string): Promise<boolean> {
  if (reviewModel === '') return false
  if (/fable-5-1\b/i.test(reviewModel)) return false
  const now = await $.clock.now()
  const seen = (await $.store.get('reviewer')) as { model: string; ok: boolean; at: number } | undefined
  if (await stillHere($, session) !== 'same') return false
  if (seen && seen.model === reviewModel && now - seen.at < PROBE_EVERY_MS) return seen.ok
  let ok = false
  try {
    const r = await $.model.complete({ model: reviewModel, prompt: 'Reply with OK.', maxTokens: 5, timeoutMs: 15000 })
    if (await stillHere($, session) !== 'same') return false
    await record($, session, reviewModel, r.usage, false, true, 'reviewer')
    ok = r.isAnswered
  } catch {
    ok = false
  }
  if (await stillHere($, session) !== 'same') return false
  await $.store.set('reviewer', { model: reviewModel, ok, at: now })
  return ok
}

async function reviewDecision($: EngineInterface, session: Session, lang: Lang, reviewModel: string, prompt: string, answer: string) {
  const r = await $.model.complete({
    model: reviewModel,
    system: reviewSystem(lang),
    prompt: `<request>\n${prompt.slice(0, 6000)}\n</request>\n\n<opus_decision>\n${answer.slice(-12000)}\n</opus_decision>`,
    maxTokens: 600,
    timeoutMs: 120000,
  })
  if (await stillHere($, session) !== 'same') return
  await record($, session, reviewModel, r.usage, false, false, 'reviewer')
  if (await stillHere($, session) !== 'same' || !r.isAnswered) return
  await $.session.append({ message: { type: 'system', content: [{ type: 'text', text: `${STR[lang].review} (${reviewModel})：\n${r.text.trim()}` }] } })
}

// Runs after the turn, unawaited: an Opus decision goes to the reviewer only when one is set and exists.
async function maybeReview($: EngineInterface, session: Session, lang: Lang, reviewModel: string, prompt: string, answer: string) {
  if (reviewModel === '') return
  try {
    if (await bookkeeping($, () => reviewerAvailable($, session, reviewModel), false, retryFor(session, 'reviewer')) && await stillHere($, session) === 'same') await reviewDecision($, session, lang, reviewModel, prompt, answer)
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

function detailLines(t: Tally, lang: Lang, rewrites: number): string {
  const str = STR[lang]
  const roles = (Object.keys(str.roles) as SpendRole[]).map(k => {
    const v = t.byRole?.[k] ?? { tokens: 0, cost: 0 }
    return `| ${str.roles[k]} | ${fmtTokens(v.tokens)} | ≈${fmtUsd(v.cost)} |`
  })
  const usages = (Object.keys(str.usages) as SpendUsage[]).map(k => {
    const v = t.byUsage?.[k] ?? { tokens: 0, cost: 0 }
    return `| ${str.usages[k]} | ${fmtTokens(v.tokens)} | ≈${fmtUsd(v.cost)} |`
  })
  const attributed = Object.values(t.byRole ?? {}).reduce((sum, v) => sum + v.cost, 0)
  return [
    str.spendHeader, '|---|---|---|', ...roles, '', str.spendHeader, '|---|---|---|', ...usages,
    ...(t.cost - attributed > 1e-9 ? [`${str.unattributed}: ≈${fmtUsd(t.cost - attributed)}.`] : []),
    `${str.peak}: ${t.peakMainContext === undefined ? str.unavailable : fmtTokens(t.peakMainContext)}. ${str.rewrites}: ${rewrites}.`,
    `${str.compactions}: ${(t.compactions ?? []).map(c => `${new Date(c.at).toISOString()} ${c.before === undefined ? str.unknownSize : fmtTokens(c.before)} → ${c.after === undefined ? str.unknownSize : fmtTokens(c.after)}`).join(' · ') || str.none}.`,
  ].join('\n')
}

async function statsText($: EngineInterface, session: Session, lang: Lang, compaction: string): Promise<string> {
  const now = await $.clock.now()
  const { today, all, counts: c } = await bookkeeping($, () => totals($, now), { today: session.today ?? EMPTY, all: EMPTY, counts: NO_COUNTS }, retryFor(session, 'stats totals'))
  const tally = await bookkeeping($, () => sessionTally($, session), EMPTY, retryFor(session, 'stats session'))
  const sessionRewrites = await bookkeeping($, () => rewriteCount($, undefined, session.id), 0, retryFor(session, 'stats session rewrites'))
  const dayRewrites = await bookkeeping($, () => rewriteCount($, dayKey(now)), 0, retryFor(session, 'stats day rewrites'))
  if (await stillHere($, session) !== 'same') return STR[lang].checkpointCancelled
  const failures = Object.entries(c.classifierFailures ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([why, n]) => `${why} ×${n}`)
  return [
    compaction,
    '',
    tallyLines(STR[lang].session, tally),
    detailLines(tally, lang, sessionRewrites),
    '',
    tallyLines('Today', today),
    detailLines(today, lang, dayRewrites),
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
      `${STR[lang].checkpointCount(c.checkpointCompactions ?? 0)} ` +
      `${STR[lang].reductions(c.outputReductions ?? 0, c.outputCharsRemoved ?? 0)} ` +
      `Cache rewrites after the TTL (100k+ tokens): ${c.cacheExpiryRewrites ?? 0}, costing ${fmtUsd(c.cacheExpiryRewriteCost ?? 0)}. ` +
      `Routing corrections recorded: manual ${c.correctionsManual ?? 0} · escalate ${c.correctionsEscalate ?? 0}. ` +
      `Unsure decisions steered to execute by weekly pacing: ${c.pacingSteered ?? 0}.`,
    '',
    '_API-equivalent prices; work tokens are priced on Opus with switch writes priced as warm reads. Classification and availability probes add cost only. Another model would not use exactly the same tokens. Session records are retained for 30 days; legacy totals are included unchanged._',
  ].join('\n')
}

async function contextText($: EngineInterface, session: Session, lang: Lang, columns: number): Promise<string> {
  const str = STR[lang]
  try {
    const { context } = await $.session.usage({ breakdown: 'summary', columns })
    if (await stillHere($, session) !== 'same') return str.checkpointCancelled
    const n = contextReading(context.tokens).tokens
    const rows = context.breakdown?.categories
    return [n === undefined ? str.unknownContext : `${str.ctx}: ${fmtTokens(n)}`,
      rows?.length ? `${str.categories}:\n${rows.map(r => `${r.name}: ≈${fmtTokens(r.tokens)}`).join('\n')}` : str.noBreakdown,
    ].join('\n\n')
  } catch {
    const n = contextReading().tokens
    return [n === undefined ? str.unknownContext : `${str.ctx}: ${fmtTokens(n)}`, str.noBreakdown].join('\n\n')
  }
}

async function statusScreen($: EngineInterface, session: Session, lang: Lang, settings: Record<string, unknown>, compaction: string): Promise<string> {
  const str = STR[lang]
  await ensurePrefs($, session)
  try {
    const usage = await $.session.usage()
    if (await stillHere($, session) !== 'same') return str.checkpointCancelled
    rateLimits = usage.rateLimits
  } catch {
    // Keep the last measurement.
  }
  const now = await $.clock.now()
  if (await stillHere($, session) !== 'same') return str.checkpointCancelled
  uiNow = now
  publishStatus($)
  return [compaction, '', str.settings,
    `enabled: ${await read($, enabled)}`,
    ...Object.entries(settings).map(([key, value]) => `${key}: ${value === '' ? '""' : String(value)}`),
    `${str.pending}: ${pendingText(lang, uiNow) || str.none}${guardPending ? ` (${new Date(guardPending.at).toISOString()})` : ''}`,
    `${str.deadline}: ${lastMain ? new Date(lastMain.at + CACHE_TTL_MS).toISOString() : str.unavailable}`,
    `${str.safeDeadline}: ${lastMain ? new Date(lastMain.at + CACHE_TTL_MS - SAFE_MARGIN_MS).toISOString() : str.unavailable}`,
    weeklyText(lang), pacingLine(lang, now), `${str.lastSkip}: ${lastSkipped ?? str.none}`,
  ].filter(Boolean).join('\n')
}

// Timer paths keep the entry epoch across every await; only a current, enabled path may arm or start compacting,
// with no await after its last check.
// A completed compaction forgets context even while off, unless a newer main request was recorded.
// Its timer cleanup still requires the current, enabled epoch.
type CompactOutcome = 'done' | 'skipped' | 'rejected'
let pluginCompaction: { session: Session } | null = null

// Issued attempts keep their session id even after end/resume. Logging has its own queue: a slow write
// must not hold up the result, accounting, or cancellation of the running compaction.
function logCompact($: EngineInterface, session: Session, kind: string, to: CompactOutcome, reason: string) {
  void $.clock.now().then(now => {
    logs.event(session.id, { at: new Date(now).toISOString(), agentId: 'main', event: `compact ${kind}`, to, reason })
    return logs.flush(logIO($))
  }).catch(err => storeFailure($, err))
}

// Compacts the main conversation between turns; explicit checkpoints can also run with a cold cache. $.session.compact rejects while a turn
// runs ('rejected') and resolves { skip } when a hook vetoed it ('skipped'): neither is a compaction, so neither is
// counted. Never throws.
async function compactMain($: EngineInterface, session: Session, lang: Lang, kind: 'idle' | 'cap' | 'checkpoint', note = ''): Promise<CompactOutcome> {
  // The caller just checked the live id, clock and epoch. No await may precede compact.
  if (!here(session) || pluginCompaction !== null) return 'rejected'
  const epoch = timerEpoch
  const request = mainRequestSequence
  // Compact usage has no model id: estimate it at the last main request's rates, including Fable.
  const { tokens: before = 0, model } = contextReading()
  const instructions = kind === 'checkpoint' ? `${CHECKPOINT_INSTRUCTIONS}${note ? `\nCheckpoint note: ${note}` : ''}` : COMPACT_INSTRUCTIONS
  const owner = { session }
  let r
  try {
    // Mutable hook instructions do not change accounting ownership. It lasts for this invocation,
    // with at most one plugin compaction in flight, even across cancellation or a session change.
    pluginCompaction = owner
    try {
      r = await $.session.compact({ instructions })
    } finally {
      if (pluginCompaction === owner) pluginCompaction = null
    }
  } catch (err) {
    logCompact($, session, kind, 'rejected', err instanceof Error ? err.message : String(err))
    return 'rejected'
  }
  if (r.skip !== undefined) {
    logCompact($, session, kind, 'skipped', String(r.skip))
    return 'skipped'
  }
  const size = r.tokensAfter === undefined ? fmtTokens(r.tokensBefore ?? before) : `${fmtTokens(r.tokensBefore ?? before)} → ${fmtTokens(r.tokensAfter)}`
  try {
    if (await stillHere($, session) !== 'same') return 'done'
    // The compact has already happened. Account for it without clearing a newer turn's context.
    let notificationEpoch = epoch
    if (request === mainRequestSequence) {
      forgetContext()
      measuredContext = r.tokensAfter
      if (!stale(epoch)) {
        cancelCompact($)
        notificationEpoch = timerEpoch
      }
    }
    if (r.usage) await record($, session, model, r.usage, false, false, 'compaction')
    if (await stillHere($, session) !== 'same') return 'done'
    await count($, session, c =>
      kind === 'checkpoint' ? { ...c, checkpointCompactions: (c.checkpointCompactions ?? 0) + 1 }
        : kind === 'idle' ? { ...c, idleCompactions: (c.idleCompactions ?? 0) + 1 } : { ...c, capCompactions: (c.capCompactions ?? 0) + 1 },
    )
    await recordDetail($, session, (t, now) => ({ ...t, compactions: [...(t.compactions ?? []), { at: now, before: r.tokensBefore ?? before, after: r.tokensAfter }] }))
    if (await stillHere($, session) !== 'same' || notificationEpoch !== timerEpoch) return 'done'
    const str = STR[lang]
    try {
      $.ui.toast((kind === 'checkpoint' ? str.checkpointCompacted : kind === 'idle' ? str.idleCompacted : str.capCompacted)(size))
    } catch {
      // A missing toast surface is not worth failing a compaction that happened.
    }
    return 'done'
  } finally {
    // Enqueue after accounting: a slow log write must not delay the result or its toast.
    logCompact($, session, kind, 'done', size)
  }
}

// The host refuses compact inside command.run (that hook holds a turn open). Run on the next clock tick,
// never behind a running turn: a prompt/off cancels the timer, and every await rechecks its epoch.
async function runCheckpoint($: EngineInterface, session: Session, lang: Lang, epoch: number, note: string) {
  if (!here(session) || epoch !== timerEpoch) return
  checkpointRunning = true
  const str = STR[lang]
  try {
    if (await stillHere($, session) !== 'same' || epoch !== timerEpoch) return
    const busy = await agentsBusy($)
    if (await stillHere($, session) !== 'same' || epoch !== timerEpoch || runningMain !== null) return
    if (busy !== 0) {
      $.ui.toast(str.skipped(busy < 0 ? str.agentUnavailable : str.agentsBusy))
      return
    }
    await $.clock.now()
    if (!here(session) || epoch !== timerEpoch || runningMain !== null) return
    const outcome = await compactMain($, session, lang, 'checkpoint', note)
    if (await stillHere($, session) === 'same' && epoch === timerEpoch && outcome !== 'done') $.ui.toast(str.skipped(outcome === 'skipped' ? str.vetoed : str.rejected))
  } finally {
    if (here(session)) checkpointRunning = false
  }
}

// Whether the idle guard should compact now: a big enough context, last used safely inside the cache TTL.
function idleDue(now: number, minContext: number): boolean {
  return lastMain !== null && (contextReading().tokens ?? 0) >= minContext && now - lastMain.at <= CACHE_TTL_MS - SAFE_MARGIN_MS
}

// Whether any subagent or teammate is still working. A failed lookup counts as busy: not compacting is the safe side.
async function agentsBusy($: EngineInterface): Promise<number> {
  try {
    return (await $.agent.list()).filter(a => BUSY_STATUSES.includes(a.status)).length
  } catch {
    return -1
  }
}

// What the timer callbacks need from the options.
type Guard = { lang: Lang; idleMs: number; minContext: number; completedAt?: number }

// Synchronous so a prompt or off cannot slip between the last check and arming or compacting.
function stale(epoch: number): boolean {
  return epoch !== timerEpoch || !compactEnabled
}

// A fired timer no longer owns a pending handle, even when identity validation is unavailable.
function scheduleCompact($: EngineInterface, ms: number, run: () => Promise<void>) {
  const timer = $.clock.after(ms, () => {
    if (compactTimer === timer) compactTimer = null
    void run().catch(() => {})
  })
  compactTimer = timer
}

// The idle compaction, a single re-check later while background agents run, never past the safe window.
async function runIdle($: EngineInterface, session: Session, g: Guard, epoch: number, rechecked: boolean): Promise<void> {
  if (await stillHere($, session) !== 'same' || stale(epoch)) return
  const isOn = await read($, enabled)
  if (await stillHere($, session) !== 'same' || stale(epoch) || !isOn) return
  const now = await $.clock.now()
  if (!here(session) || stale(epoch)) return
  if (!idleDue(now, g.minContext)) {
    clearGuard($)
    if (lastMain && (contextReading().tokens ?? 0) >= g.minContext) skipCompact($, STR[g.lang].deadlinePassed)
    return
  }
  const busy = await agentsBusy($)
  if (await stillHere($, session) !== 'same' || stale(epoch)) return
  if (busy !== 0) {
    const checkedAt = await $.clock.now()
    if (!here(session) || stale(epoch)) return
    const deadline = lastMain === null ? 0 : lastMain.at + CACHE_TTL_MS - SAFE_MARGIN_MS - IDLE_HEADROOM_MS
    if (!rechecked && checkedAt < deadline) {
      const at = Math.min(checkedAt + AGENT_RECHECK_MS, deadline)
      guardPending = { at, kind: 'idle', waiting: busy }
      refreshUi($, session, checkedAt)
      scheduleCompact($, at - checkedAt, () => runIdle($, session, g, epoch, true))
    } else {
      clearGuard($)
      skipCompact($, busy < 0 ? STR[g.lang].agentUnavailable : STR[g.lang].agentsBusy)
    }
    return
  }
  const checkedAt = await $.clock.now()
  if (!here(session) || stale(epoch)) return
  if (!idleDue(checkedAt, g.minContext)) {
    clearGuard($)
    skipCompact($, STR[g.lang].deadlinePassed)
    return
  }
  clearGuard($)
  const outcome = await compactMain($, session, g.lang, 'idle')
  if (!stale(epoch) && outcome !== 'done') skipCompact($, outcome === 'skipped' ? STR[g.lang].vetoed : STR[g.lang].rejected)
}

async function armIdle($: EngineInterface, session: Session, g: Guard, epoch: number) {
  if (g.idleMs <= 0 || lastMain === null || (contextReading().tokens ?? 0) < g.minContext) return
  const isOn = await read($, enabled)
  if (await stillHere($, session) !== 'same' || stale(epoch) || !isOn) return
  const now = await $.clock.now()
  if (!here(session) || stale(epoch) || lastMain === null) return
  const completedAt = g.completedAt ?? now
  const deadline = lastMain.at + CACHE_TTL_MS - SAFE_MARGIN_MS - IDLE_HEADROOM_MS
  const earliest = Math.max(now, completedAt + IDLE_MIN_MINUTES * 60_000)
  if (earliest > deadline) {
    clearGuard($)
    skipCompact($, STR[g.lang].deadlinePassed)
    return
  }
  const at = Math.max(earliest, Math.min(completedAt + g.idleMs, deadline))
  guardPending = { at, kind: 'idle' }
  refreshUi($, session, now)
  scheduleCompact($, at - now, () => runIdle($, session, g, epoch, false))
}

// The cap compaction, retried when refused; if it never lands, the idle guard takes over for this turn.
async function runCap($: EngineInterface, session: Session, g: Guard, epoch: number, attempt: number): Promise<void> {
  if (await stillHere($, session) !== 'same' || stale(epoch)) return
  const isOn = await read($, enabled)
  if (await stillHere($, session) !== 'same' || stale(epoch) || !isOn) return
  const busy = await agentsBusy($)
  if (await stillHere($, session) !== 'same' || stale(epoch)) return
  if (busy !== 0) {
    await armIdle($, session, g, epoch)
    if (!stale(epoch) && compactTimer === null) {
      clearGuard($)
      skipCompact($, busy < 0 ? STR[g.lang].agentUnavailable : STR[g.lang].agentsBusy)
    }
    return
  }
  const checkedAt = await $.clock.now()
  if (!here(session) || stale(epoch)) return
  if (!idleDue(checkedAt, 0)) {
    clearGuard($)
    skipCompact($, STR[g.lang].deadlinePassed)
    return
  }
  const outcome = await compactMain($, session, g.lang, 'cap')
  if (await stillHere($, session) !== 'same' || stale(epoch) || outcome === 'done') return
  if (outcome === 'rejected' && attempt < CAP_RETRIES) {
    const now = await $.clock.now()
    if (!here(session) || stale(epoch)) return
    if (!idleDue(now + CAP_RETRY_MS, 0)) {
      clearGuard($)
      skipCompact($, STR[g.lang].deadlinePassed)
      return
    }
    guardPending = { at: now + CAP_RETRY_MS, kind: 'cap' }
    publishStatus($)
    scheduleCompact($, CAP_RETRY_MS, () => runCap($, session, g, epoch, attempt + 1))
    return
  }
  await armIdle($, session, g, epoch)
  if (!stale(epoch) && compactTimer === null) {
    clearGuard($)
    skipCompact($, outcome === 'skipped' ? STR[g.lang].vetoed : STR[g.lang].rejected)
  }
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
  const checkpointHints = options.checkpointHints === true
  const shrinkToolOutput = outputLimit(options.shrinkToolOutput)
  // Off (the default): the pane opens only when the person asks (/model-router pane). On: it also opens by itself where it
  // would be a sidebar, once per session.
  const autoOpenPane = options.autoOpenPane === true
  // On (the default): corrections are recorded and sent to the classifier. Off: none are written or sent.
  learning = options.learnFromCorrections !== false
  // off | warn (the default) | steer; /model-router pacing overrides it and persists.
  pacingOption = isPaceMode(options.weeklyPacing) ? options.weeklyPacing : 'warn'
  const str = STR[lang]
  const guard: Guard = { lang, idleMs, minContext: compactMinContext }
  const compactionText =
    `idle ${idleMs > 0 ? `after ${idleMs / 60_000} min` : 'off'} · cap ${capOn ? `at ${fmtTokens(compactAtContext)}` : 'off'} · ` +
    `min context ${fmtTokens(compactMinContext)}. Changing plugin options reloads the plugin with the new values. ` +
    'Explicit checkpoints remain available when the router is off.'
  uiLang = lang
  const settings = {
    language: lang, mainRouting, blockFable, haikuModel: ids.haiku, sonnetModel: ids.sonnet, opusModel: ids.opus,
    reviewModel, idleCompactMinutes: idleMinutes, compactMinContext, compactAtContext, checkpointHints, shrinkToolOutput,
    autoOpenPane, learnFromCorrections: learning, weeklyPacing: pacingOption,
  }

  on('session.end', async ($, e, next) => {
    if (!activeSession || activeSession.id === e.sessionId) {
      const session = newSession(e.sessionId, true)
      activeSession = session
      resetSession($)
    }
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    const session = await useSession($)
    if (!here(session)) return next(e)
    await $.command.register({
      name: 'model-router',
      description: str.commandDescription,
      argumentHint: '[stats|status|context|checkpoint [note]|on|off|pane|pin <model> [turns]|unpin|wrong <tier>|corrections [clear]|pacing [mode]]',
      immediate: true,
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
    if (shrinkToolOutput > 0) await $.tool.register({
      name: FETCH_TOOL,
      description: str.fetchDescription,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          startLine: { type: 'integer', minimum: 1 },
          endLine: { type: 'integer', minimum: 1 },
          pattern: { type: 'string', description: str.patternDescription },
          offset: { type: 'integer', minimum: 0 },
        },
        required: ['id'],
        additionalProperties: false,
      },
    })
    const stored = await bookkeeping($, () => $.store.get('enabled'), compactEnabled, retryFor(session, 'enabled read'))
    if (await stillHere($, session) !== 'same') return next(e)
    compactEnabled = stored !== false
    await update($, enabled, () => compactEnabled)
    const now = await $.clock.now()
    await bookkeeping($, () => prune($, now), undefined)
    if (await stillHere($, session) !== 'same') return next(e)
    try {
      const usage = await $.session.usage()
      if (await stillHere($, session) !== 'same') return next(e)
      rateLimits = usage.rateLimits
      measuredContext = usage.context.tokens
      const model = priceKey(await $.session.model())
      if (await stillHere($, session) !== 'same') return next(e)
      sessionModel = model
    } catch {
      // No measurement yet.
    }
    // The stored pacing override decides whether the first status line carries a pace.
    await ensurePrefs($, session)
    if (await stillHere($, session) !== 'same') return next(e)
    refreshUi($, session, now)
    try {
      paneOpen = (await $.ui.panes()).some(p => p.id === PANE)
    } catch {
      // Not listed: treated as closed until it is opened or drawn.
    }
    if (await stillHere($, session) !== 'same') return next(e)
    await paceNotice($, session, now)
    // Desktop docks a pane beside the chat. The terminal says so only when it draws (see the AbovePrompt hook).
    if (autoOpenPane && !paneAutoTried && e.surface === 'desktop' && e.isInteractive) {
      paneAutoTried = true
      void openPane($, str.paneTitle)
    }
    return next(e)
  })

  on('command.run', { command: 'model-router' }, async ($, e) => {
    const epoch = timerEpoch
    const entrySession = activeSession
    const arg = e.args.trim()
    // Cancellation precedes even the local session-id lookup.
    if (arg === 'off') {
      compactEnabled = false
      if (guardPending) skipCompact($, str.routerOff)
      cancelCompact($)
    }
    const session = await useSession($)
    if (!here(session)) return { text: str.checkpointCancelled }
    if (/^checkpoint(?:\s|$)/.test(arg)) {
      if (epoch !== timerEpoch || (entrySession !== undefined && session !== entrySession)) return { text: str.checkpointCancelled }
      if (runningMain !== null) return { text: str.turnBusy }
      if (checkpointRunning || checkpointTimer !== null) return { text: str.checkpointBusy }
      checkpointRunning = true
      // Keep the existing guard until compaction succeeds, including refusals on the immediate tick.
      try {
        const busy = await agentsBusy($)
        if (await stillHere($, session) !== 'same' || epoch !== timerEpoch || runningMain !== null) return { text: str.checkpointCancelled }
        if (busy !== 0) return { text: str.skipped(busy < 0 ? str.agentUnavailable : str.agentsBusy) }
        await $.clock.now()
        if (!here(session) || epoch !== timerEpoch || runningMain !== null) return { text: str.checkpointCancelled }
        // Explicit checkpoints work even with routing off; this is an immediate tick, not a queue behind work.
        const timer = $.clock.after(0, () => {
          if (checkpointTimer === timer) checkpointTimer = null
          void runCheckpoint($, session, lang, epoch, arg.slice('checkpoint'.length).trim()).catch(() => {})
        })
        checkpointTimer = timer
        return { text: str.checkpointStarted }
      } finally {
        if (here(session)) checkpointRunning = false
      }
    }
    if (arg === 'stats' || arg === '' || arg === 'status') {
      const isOn = await read($, enabled)
      if (await stillHere($, session) !== 'same') return { text: str.checkpointCancelled }
      const compaction = `Compaction in this session: ${isOn ? 'router on' : 'router off, so no automatic compaction runs'} · ${compactionText}`
      return { text: arg === 'status' ? await statusScreen($, session, lang, settings, compaction) : await statsText($, session, lang, compaction) }
    }
    if (arg === 'context') return { text: await contextText($, session, lang, e.presentation?.columns ?? 80) }
    if (arg === 'pane') return { text: await togglePane($, lang) }
    if (arg === 'unpin' || /^pin(?:\s|$)/.test(arg)) return { text: await pinCommand($, lang, arg, mainRouting) }
    if (/^wrong(?:\s|$)/.test(arg)) {
      const tier = /^wrong\s+(lookup|execute|decide)$/i.exec(arg)?.[1]?.toLowerCase()
      return { text: tier === undefined ? str.usage : await correctTurn($, session, lang, tier as Tier) }
    }
    if (/^corrections(?:\s|$)/.test(arg)) return { text: await correctionsCommand($, session, lang, arg) }
    if (/^pacing(?:\s|$)/.test(arg)) return { text: await pacingCommand($, session, lang, arg) }
    if (arg !== 'on' && arg !== 'off') return { text: str.usage }
    // setEnabled cancels a pending compaction when switching off.
    await setEnabled($, session, arg === 'on')
    return { text: `Model router ${arg === 'on' ? str.enabled : str.disabled}.` }
  })

  on('session.measure', async ($, e, next) => {
    const session = await useSession($)
    if (!here(session)) return next(e)
    if (await stillHere($, session) !== 'same') return next(e)
    rateLimits = e.rateLimits
    measuredContext = e.context.tokens ?? measuredContext
    try {
      const model = priceKey(await $.session.model())
      if (await stillHere($, session) !== 'same') return next(e)
      sessionModel = model
    } catch {
      // Keep the last known model.
    }
    if (await stillHere($, session) !== 'same') return next(e)
    // With routing off, steps pass through without recording a send time. Do not keep an old cache deadline.
    if (!compactEnabled) {
      lastMain = null
      last = null
      observedModel = undefined
    }
    const measuredAt = await $.clock.now()
    await ensurePrefs($, session)
    if (await stillHere($, session) !== 'same') return next(e)
    refreshUi($, session, measuredAt)
    await paceNotice($, session, measuredAt)
    return next(e)
  })

  // Every compaction of the main conversation: the plugin's own, a manual /compact and the engine's auto-compact. The
  // old context figures are stale after any of them, and a pending timer would compact a summary.
  on('session.compact', async ($, e, next) => {
    const epoch = timerEpoch
    const entrySession = activeSession
    const request = mainRequestSequence
    const owner = pluginCompaction
    const session = await useSession($)
    if (!here(session) || (entrySession !== undefined && session !== entrySession)) return next(e)
    // Timer callbacks may re-enter this observer. compactMain owns its usage and history either way;
    // capture that ownership before next, while its marker is still in flight.
    const owned = e.agentId === undefined && e.trigger !== 'precompute' && owner?.session === session
    const reading = contextReading()
    const before = reading.tokens
    const model = (e.agentId === undefined ? undefined : agentModels.get(e.agentId) ?? agents.get(e.agentId)?.family) ?? reading.model
    const result = await next(e)
    if (await stillHere($, session) !== 'same') return result
    if (owned) return result
    if (e.agentId === undefined && e.trigger !== 'precompute' && result.skip === undefined) {
      if (request === mainRequestSequence) {
        forgetContext()
        measuredContext = result.tokensAfter
        if (!stale(epoch)) cancelCompact($)
      }
      await recordDetail($, session, (t, now) => ({ ...t, compactions: [...(t.compactions ?? []), {
        at: now, before: result.tokensBefore ?? before, after: result.tokensAfter,
      }] }))
    }
    // Precomputing and subagent summaries also spend tokens, but neither installs a new main context.
    if (result.skip === undefined && result.usage) await record($, session, model, result.usage, false, false, 'compaction')
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    cancelCompact($)
    const session = await useSession($)
    if (!here(session)) return next(e)
    const origin = e.origin as typeof e.origin | undefined
    // A prompt typed into a running turn joins that turn's route.
    if (!(await read($, enabled)) || !isPersonOrigin(origin) || e.turnId !== undefined || e.text.trim() === '') {
      return next(e)
    }
    if (await stillHere($, session) !== 'same') return next(e)
    // The turn's tally starts here, so it includes the classifier's own call.
    await bookkeeping($, () => update($, memberOf(meter, { requestId: session.stateId }), m => here(session) ? { turn: EMPTY, today: (m ?? { today: EMPTY }).today } : m), undefined)
    if (!mainRouting) return next(e)
    let r = await classify($, session, lang, e.text, routed(await read($, memberOf(route, { requestId: session.stateId }))))
    if (await stillHere($, session) !== 'same') return next(e)
    if (r.sessionModel) {
      // Unrouted: nothing to rewrite and nothing to tell the model; turn.start still binds the reason for the band.
      pending = r
      pendingPrompt = e.text
      const entered = await next(e)
      if (await stillHere($, session) === 'same' && entered.drop !== undefined) {
        pending = null
        pendingPrompt = ''
      }
      return entered
    }
    const shape = ((await bookkeeping($, () => $.store.get('shape'), undefined, retryFor(session, 'shape read'))) as Shape | undefined) ?? { steps: 3, output: 800 }
    const now = await $.clock.now()
    if (await stillHere($, session) !== 'same') return next(e)
    // A #model in the message and a /model-router pin both name the model: no cache keeping.
    const pinned = r.how === 'forced' || r.how === 'pinned'
    const warm = warmRequest()
    if (pinned && r.model !== 'opus' && isWarmOpus(warm, now)) {
      const cost = fmtUsd((warm!.context * (PRICES[r.model].write + PRICES.opus.write)) / 1e6)
      r = { ...r, reason: `${r.reason}; ${str.abandoned(cost)}` }
    }
    const model = pinned ? r.model : keepWarm(r.model, warm, now, shape)
    if (model !== r.model) {
      r = { ...r, keptFrom: r.model, model, effort: TIER_ROUTE[r.tier].effort }
      await count($, session, c => ({ ...c, cacheKeeps: c.cacheKeeps + 1 }))
    }
    if (await stillHere($, session) !== 'same') return next(e)
    // Set before next: next resolves only after the turn has started, and turn.start binds this route.
    pending = r
    pendingPrompt = e.text
    const entered = await next({ ...e, context: [...(e.context ?? []), assignmentContext(r)] })
    if (await stillHere($, session) === 'same' && entered.drop !== undefined) {
      // Held back by another plugin: no turn starts, so the route must not bind to the next one.
      pending = null
      pendingPrompt = ''
    }
    return entered
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) cancelCompact($)
    const session = await useSession($)
    if (!here(session)) return next(e)
    if (await stillHere($, session) !== 'same') return next(e)
    // A subagent's or teammate's run is not a main turn: it neither takes the pending route nor inherits one.
    if (e.agentId !== undefined) return next(e)
    runningMain = e.turnId
    turnCold = false
    turnBase = { tokens: 0, cost: 0 }
    turnTrailBase = 0
    if (pending) {
      const r = { ...pending, turnId: e.turnId }
      pending = null
      turnSteps = 0
      turnOutput = 0
      // A pin counts down when its turn starts, not when the prompt is submitted: a dropped prompt keeps it whole.
      if (r.how === 'pinned' && pin) {
        pin = pin.left === undefined ? pin : pin.left > 1 ? { ...pin, left: pin.left - 1 } : null
        redraw($)
      }
      if (r.how === 'classified') rememberSnippet(e.turnId, pendingPrompt)
      // Counted when the turn starts (a dropped prompt is not a steer), and only if the steer held: a warm cache that
      // kept the turn on a bigger model was not steered.
      if (r.steered && !r.keptFrom) await count($, session, c => ({ ...c, pacingSteered: (c.pacingSteered ?? 0) + 1 }))
      await update($, memberOf(route, { requestId: session.stateId }), previous => here(session) ? r : previous)
      if (r.sessionModel) {
        await logEvent($, session, 'main', 'turn route', 'session model', r.reason)
      } else {
        await count($, session, c => ({ ...c, turns: { ...c.turns, [r.tier]: c.turns[r.tier] + 1 } }))
        await logEvent($, session, 'main', 'turn route', `${r.model}/${r.effort}`, r.reason)
      }
    } else if (mainRouting && (await read($, enabled))) {
      // A turn without a person prompt (a task notification, an agent message, a scheduled prompt) is never
      // classified. While the previous route's cache is warm it continues that route: left on the session model it
      // would switch away from, and back to, the model the cache is on. Without a previous route it stays unrouted.
      const prev = routed(await read($, memberOf(route, { requestId: session.stateId })))
      const now = await $.clock.now()
      if (await stillHere($, session) !== 'same') return next(e)
      if (prev && last && now - last.at <= CACHE_TTL_MS) {
        const r: Route = { ...prev, turnId: e.turnId, reason: str.inherited, how: 'inherited', steered: undefined }
        turnSteps = 0
        turnOutput = 0
        // No prompt reset the turn tally: this turn's figures are what it adds.
        const before = await bookkeeping($, () => read($, memberOf(meter, { requestId: session.stateId })), undefined)
        if (await stillHere($, session) !== 'same') return next(e)
        turnBase = { tokens: before?.turn.tokens ?? 0, cost: before?.turn.cost ?? 0 }
        turnTrailBase = prev.trail.length
        await update($, memberOf(route, { requestId: session.stateId }), previous => here(session) ? r : previous)
        await logEvent($, session, 'main', 'turn inherit', `${r.model}/${r.effort}`, r.reason)
      }
    }
    return next(e)
  })

  // Every model request: the turn's route on the main thread, no Fable where blockFable says so, and its usage on the meter.
  on('turn.step', async function* ($, e, next) {
    const session = await useSession($)
    if (!here(session)) return yield* next(e)
    if (!(await read($, enabled))) return yield* next(e)
    let model = e.model
    let effort = e.effort
    const r = await read($, memberOf(route, { requestId: session.stateId }))
    if (await stillHere($, session) !== 'same') return yield* next(e)
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
        await count($, session, c => ({ ...c, fableBlocked: c.fableBlocked + 1 }))
      }
    }
    // When the request was sent: the cache is touched then, and a long streamed response must not stretch the TTL.
    const sentAt = isMain ? await $.clock.now() : 0
    if (await stillHere($, session) !== 'same') return yield* next(e)
    const result =
      model === e.model && effort === e.effort ? yield* next(e) : yield* next({ ...e, model, effort })
    if (await stillHere($, session) !== 'same') return result
    const u = result?.usage
    if (e.agentId !== undefined) {
      const family = familyOf(u?.model || model)
      if (family !== undefined) agentModels.set(e.agentId, family)
    }
    if (u) {
      const key = priceKey(u.model || model)
      const now = await $.clock.now()
      if (await stillHere($, session) !== 'same') return result
      // Read before `last` moves on: a main step that switched family within the TTL is priced for what it cost.
      // Send time, like lastMain: the cache is touched when the request goes out, not when a long reply ends.
      const switched = isMain && isSwitchStep(last, key, sentAt)
      await record($, session, u.model || model, u, switched, false, isMain ? 'main' : 'subagents')
      if (await stillHere($, session) !== 'same') return result
      if (isMain) {
        // A cache rewrite after the TTL: the person was away over an hour and the whole context was written again.
        // Also the first request of this process (a --resume): nothing was read from the cache and a big context was
        // written. Not right after a compaction, whose summary is written fresh. After a gap, the write must also
        // outweigh the read: a big read means a warm prefix survived (say a background fork kept it), and the
        // write is new input, not expiry.
        const afterGap =
          lastMain !== null && sentAt - lastMain.at > CACHE_TTL_MS && u.cache_read_input_tokens < u.cache_creation_input_tokens
        const coldStart = lastMain === null && !justCompacted && u.cache_read_input_tokens < COLD_READ_TOKENS
        const rewrote = (afterGap || coldStart) && u.cache_creation_input_tokens >= REWRITE_MIN_TOKENS
        // The turn started on an expired cache: its first request is the one that rewrote it.
        if (rewrote && turnSteps === 0) turnCold = true
        if (rewrote) {
          const cost = (u.cache_creation_input_tokens * PRICES[key].write) / 1e6
          await count($, session, c => ({
            ...c,
            cacheExpiryRewrites: (c.cacheExpiryRewrites ?? 0) + 1,
            cacheExpiryRewriteCost: (c.cacheExpiryRewriteCost ?? 0) + cost,
          }))
        }
        if (await stillHere($, session) !== 'same') return result
        justCompacted = false
        mainRequestSequence += 1
        lastMain = { at: sentAt, context: tokensOf(u) - u.output_tokens }
        observedModel = key
        measuredContext = undefined
        refreshUi($, session, now)
        if (key !== 'fable') last = { model: key, at: sentAt, context: tokensOf(u) - u.output_tokens }
        turnSteps += 1
        turnOutput += u.output_tokens
      }
      // Proof the rewrite took effect: the family that answered is the family asked for.
      if (model !== e.model || effort !== e.effort) {
        const asked = familyOf(model)
        const got = familyOf(u.model)
        if (asked !== undefined && got !== undefined && asked !== got) {
          await count($, session, c => ({ ...c, modelMismatch: (c.modelMismatch ?? 0) + 1 }))
        }
      }
      if (await stillHere($, session) !== 'same') return result
      if (e.agentId !== undefined && sub) {
        logs.usage(session.id, e.agentId, u.model || model, effort === undefined ? undefined : String(effort), u)
        void logs.flush(logIO($))
      }
    }
    return result
  })

  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    const session = await useSession($)
    if (!here(session)) return next(e)
    if (shrinkToolOutput === 0 || e.origin.kind !== 'tool' ||
      !(e.origin.tool === 'Bash' || (e.origin.tool.startsWith('mcp__') && e.origin.tool !== FETCH_CALL))) return next(e)
    let content = e.message.content
    let removed = 0
    let reductions = 0
    try {
      if (!compactEnabled || !(await read($, enabled))) return next(e)
      const id = session.id
      content = [...content]
      for (let i = 0; i < content.length; i++) {
        const block = content[i]!
        if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
        const parts = Array.isArray(block.content) ? block.content as { type: string; text?: unknown }[] : undefined
        const original = typeof block.content === 'string' ? block.content
          : parts?.every(p => p.type === 'text' && typeof p.text === 'string') ? parts.map(p => p.text).join('') : undefined
        if (original === undefined || original.length <= shrinkToolOutput || looksLikeCode(original)) continue
        const path = outputPath(logDir($.plugin.root), id, block.tool_use_id)
        if (!path) continue
        const reduced = `${reduceOutput(original, shrinkToolOutput, str.omitted)}\n\n${str.archived(path, block.tool_use_id)}`
        if (reduced.length >= original.length) continue
        // Archive first. A failed write leaves this row untouched, even if earlier blocks were candidates.
        await $.fs.write(path, original)
        if (await stillHere($, session) !== 'same' || !compactEnabled) return next(e)
        content[i] = { ...block, content: typeof block.content === 'string' ? reduced : [{ ...parts![0], type: 'text', text: reduced }] }
        reductions++
        removed += original.length - reduced.length
      }
    } catch {
      return next(e)
    }
    const result = await next({ ...e, message: { ...e.message, content } })
    if (await stillHere($, session) === 'same' && reductions) await count($, session, c => ({ ...c, outputReductions: (c.outputReductions ?? 0) + reductions, outputCharsRemoved: (c.outputCharsRemoved ?? 0) + removed }))
    return result
  })

  on('tool.call', { tool: FETCH_CALL }, async ($, e) => {
    const session = await useSession($)
    if (shrinkToolOutput === 0) return { result: str.fetchOff }
    if (!here(session)) return { result: str.checkpointCancelled }
    const input = e as unknown as { id?: unknown; startLine?: number; endLine?: number; pattern?: unknown; offset?: number }
    const { startLine = 1, endLine, offset = 0, pattern } = input
    if (typeof input.id !== 'string' || !Number.isInteger(startLine) || startLine < 1 ||
      (endLine !== undefined && (!Number.isInteger(endLine) || endLine < startLine)) ||
      !Number.isInteger(offset) || offset < 0 || (pattern !== undefined && typeof pattern !== 'string')) return { result: str.fetchInvalid }
    try {
      const path = outputPath(logDir($.plugin.root), session.id, input.id)
      if (!path) return { result: str.fetchInvalid }
      const selected = outputSlice(await $.fs.read(path), startLine, endLine, pattern as string | undefined)
      if (await stillHere($, session) !== 'same') return { result: str.checkpointCancelled }
      const rest = selected.slice(offset)
      if (rest.length <= shrinkToolOutput) return { result: rest }
      // Reserve space for a continuation instruction; even a single enormous line can be paged without loss.
      const n = shrinkToolOutput - str.fetchMore(offset + shrinkToolOutput).length - 20
      return { result: rest.slice(0, n) + str.fetchMore(offset + n) }
    } catch {
      return { result: str.fetchMissing }
    }
  })

  on('tool.call', { tool: TOOL_CALL }, async ($, e) => {
    const session = await useSession($)
    if (!here(session)) return { result: str.checkpointCancelled }
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
      await logEvent($, session, input.agent, 'raised by main', describeTier(up), input.reason ?? 'no reason given')
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
      if (up.effort === 'max' && s.effort !== 'max') await count($, session, c => ({ ...c, maxEffort: (c.maxEffort ?? 0) + 1 }))
      await logEvent($, session, input.agentId, 'escalated', describeTier(up), input.reason ?? 'no reason given')
      return { result: `Escalated to ${describeTier(up)} from your next step.` }
    }
    const r = await read($, memberOf(route, { requestId: session.stateId }))
    if (await stillHere($, session) !== 'same') return { result: str.checkpointCancelled }
    if (!mainRouting || !r || r.turnId === null || r.sessionModel) {
      return { result: 'No routed turn here: escalate only applies to the main conversation of a routed turn. Carry on.' }
    }
    const out = applyEscalation(r, input)
    if (!out.ok) return { result: `Not changed: ${out.why}. Carry on with the current route.` }
    await update($, memberOf(route, { requestId: session.stateId }), previous => here(session) ? out.route : previous)
    await count($, session, c => ({
      ...c,
      escalations: c.escalations + 1,
      maxEffort: (c.maxEffort ?? 0) + (out.route.effort === 'max' && r.effort !== 'max' ? 1 : 0),
    }))
    // Moving to a higher MODEL than the classified tier's own means the classifier sorted it too low. An effort-only
    // raise, or a turn the warm cache kept on a bigger model, is not a correction. One entry per turn, counted once;
    // a later, higher raise in the same turn moves it up to the highest model reached.
    const text = snippets.get(r.turnId)
    const reached = escalationRight.get(r.turnId)
    const right = TIER_OF[out.route.model]
    if (learning && r.how === 'classified' && !r.steered && text !== undefined && out.route.model !== r.model &&
      MODELS.indexOf(out.route.model) > MODELS.indexOf(TIER_ROUTE[r.tier].model) &&
      (reached === undefined || MODELS.indexOf(out.route.model) > MODELS.indexOf(TIER_ROUTE[reached].model))) {
      const at = await $.clock.now()
      if (await stillHere($, session) === 'same' && await recordCorrection($, session, { at, text, routed: r.tier, right, source: 'escalate' }, reached === undefined)) {
        escalationRight.set(r.turnId, right)
      }
    }
    redrawPane($)
    return {
      result: `Route updated: from your next step this turn runs on ${out.route.model} at ${out.route.effort} effort. Now do the work.`,
    }
  })

  // Automatic fallback: a subagent that keeps failing is raised one step: effort first, then the next model.
  on('tool.call', async ($, e, next) => {
    const session = await useSession($)
    if (!here(session)) return next(e)
    const asked = AGENT_TOOLS.includes(e.tool) ? (e as { effort?: unknown }).effort : undefined
    if (typeof asked === 'string' && (EFFORTS as string[]).includes(asked)) askedEffort.set(e.tool_use_id, asked as Effort)
    let ran: Awaited<ReturnType<typeof next>>
    try {
      ran = await next(e)
    } finally {
      // Read by the spawn inside this call, or never: a call that spawned nothing must not leave it behind.
      if (here(session)) askedEffort.delete(e.tool_use_id)
    }
    if (await stillHere($, session) !== 'same') return ran
    const s = e.agentId === undefined ? undefined : agents.get(e.agentId)
    if (e.agentId === undefined || s === undefined || e.tool === TOOL_CALL || !(await read($, enabled))) return ran
    if (await stillHere($, session) !== 'same') return ran
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
      await logEvent($, session, e.agentId, 'ceiling reached', at, `${AUTO_ESCALATE_AFTER} tool errors in a row at the subagent ceiling`)
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
    await logEvent($, session, e.agentId, 'auto-escalated', describeTier(up), `${AUTO_ESCALATE_AFTER} tool errors in a row${again}: ${why}`)
    return ran
  })

  // A subagent the call gives no model gets one by its job: search on Haiku, work on Sonnet, judgment
  // inherits the parent. Never above the parent, never Fable; forks and workflow agents are left alone.
  on('agent.spawn', async ($, e, next) => {
    const session = await useSession($)
    if (!here(session)) return next(e)
    if (!(await read($, enabled)) || e.fork || e.workflow !== undefined) return next(e)
    if (e.resume !== undefined) {
      const ran = await next(e)
      if (await stillHere($, session) !== 'same') return ran
      // A reload loses tracking, but a resume must keep the engine's model and effort and any entry still here.
      if (ran.deny === undefined && ran.agentId !== undefined && !agents.has(ran.agentId)) {
        agents.set(ran.agentId, { ...startOf(ran.model, e.parentModel, false, ids), model: ran.model })
        resumed.add(ran.agentId)
      }
      return ran
    }
    const verdict = needsClassifier(e) ? await classifyTier($, session, lang, e.prompt, null, false) : null
    const failure = verdict && !verdict.ok ? verdict.why : undefined
    if (failure !== undefined) await countFailure($, session, failure)
    const failureText = verdict && !verdict.ok ? failText(verdict) : undefined
    const ok = verdict?.ok ? verdict.verdict : null
    if (await stillHere($, session) !== 'same') return next(e)
    const d = decideSpawn(e, ok?.tier ?? null, ok?.sure ?? true, blockFable)
    const ran = await next(d?.model === undefined ? e : { ...e, model: d.model })
    if (await stillHere($, session) !== 'same') return ran
    try {
      if (ran.deny === undefined && ran.agentId !== undefined) {
        const model = d?.model
        if (model !== undefined) {
          // The spawn counts its own Fable block; the agent's steps then run on Opus, and fableCounted keeps any later one from counting again.
          if (d?.fable) fableCounted.add(`agent:${ran.agentId}`)
          await count($, session, c => ({
            ...c,
            subagents: { ...c.subagents, [model]: c.subagents[model] + 1 },
            fableBlocked: c.fableBlocked + (d?.fable ? 1 : 0),
          }))
        }
        if (await stillHere($, session) !== 'same') return ran
        const started = startOf(ran.model, e.parentModel, model !== undefined, ids, model === undefined && isCallerPin(e.model))
        // An effort the caller set explicitly is kept, router pin or not; the hard cap (high) still applies per step.
        const explicit = askedEffort.get(e.tool_use_id)
        const s = explicit === undefined ? started : { ...started, effort: capSent(explicit) as Effort }
        agents.set(ran.agentId, s)
        // A failed classification keeps today's fallback (sonnet) and says why.
        const why = failureText !== undefined && d?.reason ? d.reason.replace('classifier failed', `classifier failed (${failureText})`) : d?.reason
        await logEvent($, session, ran.agentId, `${e.subagentType} start`, describeTier(s), why ?? 'as asked')
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
    const entrySession = activeSession
    const session = await useSession($)
    if (!here(session) || (entrySession !== undefined && session !== entrySession)) return next(e)
    // Completion still reaches the engine when the compaction path has been cancelled.
    const done = await next(e)
    if (await stillHere($, session) !== 'same') return done
    if (e.agentId === undefined && runningMain === e.turnId) runningMain = null
    // An agent ending can make the last busy count stale before the scheduled re-check.
    if (e.agentId !== undefined && guardPending?.waiting !== undefined) {
      const pending = guardPending
      const busy = await agentsBusy($)
      if (await stillHere($, session) === 'same' && guardPending === pending && !stale(epoch)) {
        guardPending = { ...pending, waiting: busy === 0 ? undefined : busy }
        publishStatus($)
      }
    }
    if (await stillHere($, session) !== 'same' || stale(epoch)) return done
    const r = await bookkeeping($, () => read($, memberOf(route, { requestId: session.stateId })), null)
    if (await stillHere($, session) !== 'same' || stale(epoch)) return done
    if (e.agentId === undefined && r && r.turnId === e.turnId && turnSteps > 0) {
      // A slow average of the turn's shape feeds the warm-cache decision.
      const prev = ((await bookkeeping($, () => $.store.get('shape'), undefined, retryFor(session, 'shape read'))) as Shape | undefined) ?? { steps: 3, output: 800 }
      if (await stillHere($, session) !== 'same' || stale(epoch)) return done
      const output = turnOutput / turnSteps
      await bookkeeping($, () => $.store.set('shape', { steps: prev.steps * 0.8 + turnSteps * 0.2, output: prev.output * 0.8 + output * 0.2 }), undefined, retryFor(session, 'shape write'))
      if (await stillHere($, session) !== 'same' || stale(epoch)) return done
    }
    // New with 1.1.0, after everything main did before it: the pane's record of this turn.
    if (e.agentId === undefined && r && r.turnId === e.turnId) await writeTurnRecord($, session, r, e.turnId)
    if (await stillHere($, session) !== 'same' || stale(epoch)) return done
    const isOn = await read($, enabled)
    if (await stillHere($, session) !== 'same' || stale(epoch) || !isOn) return done
    if (e.agentId === undefined && !e.isAborted && r && r.turnId === e.turnId && r.model === 'opus') {
      void maybeReview($, session, lang, reviewModel, pendingPrompt, e.answer)
    }
    if (e.agentId === undefined && !e.isAborted && checkpointHints) {
      const now = await $.clock.now()
      if (await stillHere($, session) !== 'same' || stale(epoch) || runningMain !== null) return done
      const { tokens = 0, model } = contextReading()
      if (!(capOn && tokens >= compactAtContext) && tokens >= compactMinContext && checkpointPays(tokens, model) &&
        (!lastHint || tokens >= lastHint.context * CHECKPOINT_GROWTH || now - lastHint.at >= CHECKPOINT_COOLDOWN_MS)) {
        lastHint = { at: now, context: tokens }
        try { $.ui.toast(str.checkpointHint) } catch { /* A missing toast must not fail completion. */ }
      }
    }
    if (e.agentId === undefined && (capOn || idleMs > 0)) {
      if (await stillHere($, session) !== 'same' || stale(epoch)) return done
      const completedAt = await $.clock.now()
      if (!here(session) || stale(epoch)) return done
      const g = { ...guard, completedAt }
      // Replace an earlier timer without moving past a cancel that landed during this completion.
      compactTimer?.cancel()
      compactTimer = null
      if (!e.isAborted && capOn && lastMain !== null && (contextReading().tokens ?? 0) >= compactAtContext) {
        if (!idleDue(completedAt, 0)) {
          clearGuard($)
          skipCompact($, str.deadlinePassed)
          return done
        }
        // The hook runs as the turn ends and compact rejects while a turn runs, so it goes on the next tick of the clock.
        guardPending = { at: completedAt, kind: 'cap' }
        refreshUi($, session, completedAt)
        scheduleCompact($, 0, () => runCap($, session, g, epoch, 0))
      } else {
        await armIdle($, session, g, epoch)
      }
    }
    return done
  })

  // A close (the person's mark, a command, an unload) leaves nothing to redraw.
  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE) paneOpen = false
    return closed
  })

  // The router pane: this session's turns, the totals, the last seven days and, with learning on, correction buttons.
  // Drawn only while the person has it open (/model-router pane, or autoOpenPane), so a closed pane costs nothing here.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const session = await useSession($)
    if (!here(session)) return next(e)
    // Being asked to draw means it is open.
    paneOpen = true
    const now = await $.clock.now()
    if (await stillHere($, session) !== 'same') return next(e)
    await ensurePrefs($, session)
    const isOn = await read($, enabled)
    const list = await bookkeeping($, () => read($, memberOf(turns, { requestId: session.stateId })), [] as TurnRecord[])
    const m = await bookkeeping($, () => read($, memberOf(meter, { requestId: session.stateId })), { turn: EMPTY, today: session.today ?? EMPTY })
    // Recomputed when the pane opened or a main turn completed since, or the day turned; never per render.
    if (paneDirty || paneData?.day !== dayKey(now)) await bookkeeping($, () => refreshPaneData($, session, now), undefined, retryFor(session, 'pane data'))
    if (await stillHere($, session) !== 'same') return next(e)
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    // The terminal's table has no Svg (it would draw a fragment: nothing): it gets a text sparkline instead.
    const Svg = e.surface === 'terminal' ? undefined : (table as unknown as { Svg?: ElementConstructor<SvgProps> }).Svg
    const room = Math.max(3, (e.props.scroll?.bodyRows ?? 24) - 9)
    const shown = list.slice(-room)
    const today = session.today ?? m.today
    const mine = paneData?.session ?? EMPTY
    const series = paneData?.series ?? []
    const weekCost = series.reduce((sum, d) => sum + d.cost, 0)
    const weekBase = series.reduce((sum, d) => sum + d.baseline, 0)
    const weekLine = `${str.paneWeek}: ${fmtUsd(weekCost)} (Opus ${fmtUsd(weekBase)})`
    const target = learning ? [...list].reverse().find(isCorrectable) : undefined
    const head = [isOn ? str.paneOn : str.paneOff, weeklyText(lang), pin ? `📌 ${LABEL[pin.model]}${pin.left === undefined ? '' : ` (${pin.left})`}` : ''].filter(Boolean).join(' · ')
    const figures = (name: string, t: Tally) => `${name} ${fmtTokens(t.tokens)} token · ${fmtUsd(t.cost)}, ${str.save} ≈${fmtUsd(saved(t).usd)} (${saved(t).pct}%)`
    return (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate-end">{head}</Text>
        {shown.length === 0 && <Text dimColor>{str.paneNoTurns}</Text>}
        {shown.map(t => {
          const tags = [
            t.cold ? str.tagCold : '',
            t.keptFrom ? str.tagKept : '',
            t.trail.length > 0 ? `→ ${t.trail.map(trailStep).join(' → ')}` : '',
            t.how === 'pinned' ? str.tagPinned : t.how === 'forced' ? str.tagForced : '',
            t.corrected ? `${str.tagCorrected} → ${t.corrected}` : '',
          ].filter(Boolean)
          const detail = `${fmtUsd(t.cost)} · ${fmtTokens(t.tokens)}${tags.length > 0 ? ` · ${tags.join(' · ')}` : ''}${t.reason ? ` — ${t.reason}` : ''}`
          return (
            <Box key={t.turnId} flexDirection="row" gap={1}>
              <Box flexShrink={0}>
                <Text dimColor>{hhmm(t.at)}</Text>
              </Box>
              <Box flexShrink={0}>
                <Text color={TURN_COLOR[t.model]}>{t.model === 'session' ? str.sessionRow : `${LABEL[t.model]} ${t.effort ?? ''}`.trim()}</Text>
              </Box>
              <Box flexGrow={1} flexShrink={1} width={0}>
                <Text dimColor wrap="truncate-end">{detail}</Text>
              </Box>
            </Box>
          )
        })}
        <Text dimColor wrap="truncate-end">{figures(str.paneSession, mine)}</Text>
        <Text dimColor wrap="truncate-end">{figures(str.paneToday, today)}</Text>
        {series.length > 0 && (Svg
          ? (
            <Box flexDirection="column">
              <Text dimColor wrap="truncate-end">{weekLine}</Text>
              <Svg source={barChartSvg(series)} alt={chartAlt(series)} />
            </Box>
          )
          : <Text dimColor wrap="truncate-end">{`${weekLine}  ${sparkline(series.map(d => d.cost))}`}</Text>)}
        {target && (
          <Box flexDirection="row" gap={1} alignItems="center">
            <Text dimColor>{`${str.paneShould} (${hhmm(target.at)})`}</Text>
            {(['lookup', 'execute', 'decide'] as const).filter(t => t !== target.tier).map(t => (
              <Button key={`wrong-${t}`} label={t} onPress={() => pressWrong($, session, lang, t, target.turnId)} />
            ))}
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const session = await useSession($)
    if (!here(session)) return next(e)
    const below = await next(e)
    if (await stillHere($, session) !== 'same') return below
    if (e.props.hasSurvey) return below
    // The terminal says whether it docks a pane; a pane opened unasked is then a sidebar. Once per session.
    if (autoOpenPane && !paneAutoTried && e.viewport?.isFullscreen === true) {
      paneAutoTried = true
      void openPane($, str.paneTitle)
    }
    const { Box, Text, Button } = $.ui.resolve(e)
    const exposure = exposureText(lang, await $.clock.now(), e.props.bodyColumns)
    if (await stillHere($, session) !== 'same') return below
    const narrow = e.props.bodyColumns < 100

    if (!(await read($, enabled))) {
      return (
        <Box flexDirection="column">
          <Text dimColor>{exposure}</Text>
          <Box flexDirection="row" gap={1} alignItems="center">
            <Text dimColor>⚙ {str.off}</Text>
            <Button key="router-enable" label={str.enable} onPress={() => setEnabled($, session, true)} />
          </Box>
          {below}
        </Box>
      )
    }

    const r = await bookkeeping($, () => read($, memberOf(route, { requestId: session.stateId })), null)
    const m = await bookkeeping($, () => read($, memberOf(meter, { requestId: session.stateId })), { turn: EMPTY, today: session.today ?? EMPTY })
    if (await stillHere($, session) !== 'same') return below
    const routeBase = !r
      ? ''
      : r.sessionModel
        ? r.reason
        : `${LABEL[r.keptFrom ?? TIER_ROUTE[r.tier].model]} · ${TIER_ROUTE[r.tier].effort}` +
          (r.keptFrom ? ` → ${LABEL[r.model]} (${str.kept})` : '') +
          (r.trail.length > 0 ? ` → ${r.trail.join(' → ')}` : '') +
          (r.reason ? ` — ${r.reason}` : '')
    // A pin shows in front of the route, and without one nothing here changes.
    const pinTag = pin ? `📌 ${LABEL[pin.model]}${pin.left === undefined ? '' : ` (${pin.left})`}` : ''
    const routeText = r?.how === 'pinned' ? `📌 ${routeBase}` : pinTag === '' ? routeBase : `${pinTag} │ ${routeBase}`
    const today = session.today ?? m.today
    const s = saved(today)
    const meterText =
      `${str.turn} ${fmtTokens(m.turn.tokens)} token · ${fmtUsd(m.turn.cost)}   ` +
      `${str.today} ${fmtTokens(today.tokens)} token · ${fmtUsd(today.cost)}, ${str.save} ≈${fmtUsd(s.usd)} (${s.pct}%) ${str.vs}`

    // No route, or no room for it: the meter takes the gear's row, so there is no empty route row.
    if (!r || narrow) {
      return (
        <Box flexDirection="column">
          <Text dimColor>{exposure}</Text>
          <Box flexDirection="row" gap={1} alignItems="center">
            <Box flexShrink={0}>
              <Text dimColor>⚙</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1} width={0}>
              <Text dimColor wrap="truncate-end">
                {pinTag === '' ? meterText : `${pinTag}  ${meterText}`}
              </Text>
            </Box>
            <Button key="router-disable" label={str.disable} onPress={() => setEnabled($, session, false)} />
          </Box>
          {below}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text dimColor>{exposure}</Text>
        <Box flexDirection="row" gap={1} alignItems="center">
          <Box flexShrink={0}>
            <Text dimColor>⚙</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1} width={0}>
            <Text dimColor wrap="truncate-end">
              {routeText}
            </Text>
          </Box>
          <Button key="router-disable" label={str.disable} onPress={() => setEnabled($, session, false)} />
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
