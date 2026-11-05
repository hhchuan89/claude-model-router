import { atom, memberOf, read, update } from 'claude-code'
import type { ElementConstructor, EngineInterface, Register, SessionRateLimit, SvgProps, Timer } from 'claude-code'

import type { Effort, ModelKey, Route, SpendRole, SpendUsage, Tally, Tier, TurnHow, TurnRecord } from '../types'
import type { LastRequest, Shape, Usage } from './meter'
import { add, CACHE_TTL_MS, CHECKPOINT_COOLDOWN_MS, CHECKPOINT_GROWTH, checkpointPays, EMPTY, fmtTokens, fmtUsd, isSwitchStep, isWarmOpus, keepWarm, merge, PRICES, priceKey, priceOf, promptOf, RANK, saved, tokensOf } from './meter'
import { looksLikeCode, outputLimit, outputPath, outputSlice, reduceOutput } from './output'
import { addCorrection, MAX_CORRECTIONS, readCorrections, snippetOf } from './learn'
import type { Correction } from './learn'
import { isPersonOrigin } from './origin'
import { CLASSIFY_MS, latencyBucket, latencySummary } from './latency'
import { fmtPace, isPaceMode, paceOf, sameWindow } from './pace'
import type { PaceMode } from './pace'
import { barChartSvg, cellWidth, chartAlt, hhmm, lastDays, textChart, weekdayOf } from './history'
import type { DayCost } from './history'
import { redact } from './redact'
import type { Lang } from './route'
import { isRisky, riskFloor } from './risk'
import { legacyClassifierSystem, parseReplayArgs, parseReplayFile, replayOutPath, resolveReplayPath, replayRow, replaySummary, REPLAY_CONCURRENCY, REPLAY_PAUSE_MS } from './replay'
import type { ReplayContext, ReplayRow } from './replay'
import {
  applyEscalation,
  assignmentContext,
  classifierPrompt,
  classifierSystem,
  EFFORTS,
  forcedModel,
  isAlias,
  isFable,
  MODELS,
  parseDecision,
  settleTier,
  reviewSystem,
  routeFor,
  shorten,
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
const PROBE_EVERY_MS = 24 * 3600 * 1000
// The verdict is a JSON object with a tier, a confidence and a reason; 120 tokens cut it off mid-reply.
const CLASSIFY_MAX_TOKENS = 300
const SNIPPET_CHARS = 120
// The turns /model-router history lists (text only).
const HISTORY_ROWS = 10
// The turns the expanded band lists.
const BAND_ROWS = 5
const MAX_TURNS = 50
const PACE_DAYS = 7

// A lifetime starts with empty routing and turn spend; loading history never clears either.
const route = atom({ plugin: 'model-router', key: 'route' } as const, null)
const enabled = atom({ plugin: 'model-router', key: 'enabled' } as const, true)
const meter = atom({ plugin: 'model-router', key: 'meter' } as const, { turn: EMPTY, today: EMPTY })
// The per-turn records /model-router history lists. Change the shape tag when a record's fields change: it declines what an earlier version stored.
const turns = atom({ plugin: 'model-router', key: 'turns' } as const, [], { shape: 'turns-1' })

// The route chosen for a submitted prompt, waiting for its turn to start.
let pending: Route | null = null
// The person's prompt for the running turn, kept for the decision review.
let pendingPrompt = ''
let runningMain: string | null = null
let checkpointRunning = false
let replayRunning = false
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
// The session model's context window in tokens, when the engine says (usage and measure carry it).
let contextWindow: number | undefined
// A summary keeps the observed request family after forgetContext clears its timestamp. The session model is
// only a fallback: routing may have sent the request to a different family.
let observedModel: keyof typeof PRICES | undefined
let sessionModel: keyof typeof PRICES = 'opus'
// Pin: the main conversation's model for the next `left` person turns (left absent: until unpin or the session ends).
let pin: { model: ModelKey; left?: number } | null = null
// Set from the options at register. Off: no correction is recorded and none pins the session.
let learning = true
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
// The running main turn's first request rewrote a cold cache; and the turn tally the turn started from (an inherited
// turn does not reset the tally, so its figures are the difference).
let turnCold = false
let turnBase = { tokens: 0, cost: 0 }
// An inherited turn's route already carries earlier escalations: its own start at this many trail steps.
let turnTrailBase = 0
// The seven days behind the expanded band and this session's tokens, cached by day and latest turn: no store scan per redraw.
// All three token figures in Details come from this one snapshot, so "last 7 days" is never below "today".
// Spend recorded without a turn record (subagents, main routing off, a running turn) moves `accounting`: the snapshot is
// taken again for it at most every DETAILS_REFRESH_MS.
let weekCache: { day: string; key: string; at: number; accounting: number; series: DayCost[]; sessionTokens: number; todayTokens: number } | undefined
// Bumped by every spend record() stores.
let accounting = 0
const DETAILS_REFRESH_MS = 30_000
// Whether the band shows its details; a per-person choice, kept in the store (read with the other preferences).
let bandExpanded = false
// The turn a correction was just recorded for and the model it pinned: the band thanks the person in place of the buttons.
// `note` is the switching cost the confirmation gave, if any. Cleared whenever the pin ends or another pin replaces it.
let thanks: { turnId: string; model: ModelKey; note: string } | undefined
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
    riskFloor: ' · 风险操作：至少用 Sonnet',
    riskAboveParent: ' · 风险操作：用 Sonnet，高于 Haiku 父级',
    replayBusy: '无法回放：主会话正在运行。请在轮次之间重试。',
    replayRunning: '无法回放：另一个回放正在运行。',
    replayUsage: '用法：/model-router replay <文件路径> [current|legacy|both] [--repeat <1-3>]',
    replayCancelled: '回放已取消：会话已变化。',
    replayRefused: (why: string) => `无法回放：${why}`,
    sessionModel: (why: string) => `分类失败（${why}）：用会话模型`,
    inherited: '沿用上一轮路由',
    forced: '你在消息里指定了模型',
    abandoned: (cost: string) => `放弃 Opus 热缓存，预计往返重写 ${cost}`,
    warmSkip: '大上下文缓存仍热：跳过分类',
    review: '决策审查',
    idleCompacted: (size: string) => `空闲压缩：已压缩 ${size} 上下文（缓存仍热）`,
    capCompacted: (size: string) => `上下文达到上限：已压缩 ${size}`,
    checkpointCompacted: (size: string) => `任务检查点：已压缩 ${size}`,
    checkpointStarted: '正在创建任务检查点…',
    checkpointHint: '预计检查点可在后续 15 步内抵消费用。任务之间可运行 /model-router checkpoint [备注]。',
    turnBusy: '无法创建检查点：主会话正在运行。请在轮次之间重试。',
    checkpointBusy: '无法创建检查点：另一个检查点正在运行。',
    checkpointCancelled: '检查点已取消：会话或路由状态已变化。',
    sessionChanged: '会话已变化，未显示。',
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
    ctx: '对话大小',
    unknownContext: '对话大小尚无读数',
    idleIn: (n: number) => `空闲压缩将在 ${n} 分钟后执行`,
    capIn: '上下文上限压缩待执行',
    waiting: (n: number) => n < 0 ? '空闲压缩等待：无法确认代理状态' : `空闲压缩等待 ${n} 个代理`,
    skipped: (why: string) => `已跳过压缩：${why}`,
    deadlinePassed: '缓存已过期',
    agentsBusy: '代理仍忙碌',
    agentUnavailable: '无法确认代理状态',
    routerOff: '路由已关闭',
    vetoed: '压缩被钩子跳过',
    rejected: '引擎拒绝压缩',
    usage: '用法：/model-router stats | status | context | checkpoint [备注] | on | off | history | pin <haiku|sonnet|opus> [轮数] | unpin | wrong <lookup|execute|decide> | corrections [clear] | pacing [off|warn|steer|default]',
    commandDescription: '模型路由：stats 查看费用，status 查看设置，context 查看上下文，checkpoint [备注] 创建检查点，history 查看详情，pin / unpin 固定模型，wrong 纠正路由，corrections 纠正记录，pacing 每周节奏，on / off 开关',
    pinned: (left?: number) => left === undefined ? '已固定模型' : `已固定模型（剩 ${left} 轮）`,
    pinNeedsRouting: '固定模型需要主会话路由（mainRouting 已关闭）。',
    pinSet: (model: string, left?: number) => left === undefined ? `已固定为 ${model}，直到 /model-router unpin 或会话结束。` : `已固定为 ${model}，接下来 ${left} 轮。`,
    pinRouterOff: ' 路由当前已关闭，开启后才生效。',
    unpinned: '已取消固定。',
    notPinned: '当前没有固定模型。',
    wrongOff: '纠正已关闭（learnFromCorrections）：没有记录，也没有固定模型。',
    wrongNone: '没有可纠正的已分类轮次（强制、固定、沿用和失败的轮次不经分类）。',
    wrongNoText: '该轮的提示内容已不在内存中，无法记录。',
    wrongFailed: '无法保存纠正。',
    correctionsClearFailed: '无法删除磁盘上的纠正记录，它们可能仍然存在。',
    correctionsClearPartial: '未能删除全部纠正记录：另一个窗口可能仍在写入。请稍后再运行 /model-router corrections clear。',
    pacingNotSaved: '（无法保存：仅对本会话有效。）',
    wrongSame: (tier: string) => `该轮已被分到 ${tier}，没有记录。`,
    wrongDone: (at: string, routed: string, right: string, model: string) => `已记录：${at} 的轮次，分类为 ${routed}，应为 ${right}。本会话余下部分固定使用 ${model}。/model-router unpin 可撤销。`,
    corrections: '路由纠正',
    correctionsNone: '没有纠正记录。',
    correctionsCleared: '已清除纠正记录。',
    learnedOff: '（记录已关闭）',
    pacingMode: (mode: string, from: string) => `每周节奏：${mode}（${from}）`,
    pacingOption: '选项',
    pacingOverride: '覆盖',
    pacingSet: (mode: string) => `每周节奏已设为 ${mode}。`,
    pacingDefault: (mode: string) => `已取消覆盖，使用选项：${mode}。`,
    pacingFigures: (used: string, pace: string, state: string) => `已用 ${used}%，节奏 ${pace}（${state}）`,
    pacingNoWindow: '没有每周用量窗口',
    paceAhead: (x: string) => ` · 节奏 ${x} 超前`,
    paceToast: (used: string, x: string, steer: boolean) => `每周用量 ${used}%，节奏 ${x}，超过均匀消耗。${steer ? '未确定的决策将改用 Sonnet。' : ''}`,
    modelFallback: (configured: string, alias: string) => `model-router：本账户找不到 ${configured}，这一档暂时改用 ${alias}（该系列最新的模型）。请在插件选项里改成现有的 id，或直接用别名。`,
    modelNotFound: (alias: string) => `（找不到；改用 ${alias}）`,
    histNone: '本会话还没有路由过的回复。',
    paused: '路由器已暂停——每一轮都由你自己的模型回答',
    details: '详情',
    hideDetails: '收起详情',
    bandIdle: '路由器会为你发送的每条消息选择模型',
    bandSubagents: '路由器只负责子代理——你的消息由你自己的模型回答',
    pinnedMore: (left?: number) => left === undefined ? '已固定，直到你取消' : left === 0 ? '已固定' : `已固定，还有 ${left} 条回复`,
    pinWaiting: (left?: number) => left === undefined ? '已固定，直到你取消' : `已固定，接下来 ${left} 条回复使用`,
    youChose: (m: string) => `你指定了它（#${m}）`,
    keptOn: (m: string) => `保持 ${m}：切换会重新读取整个对话`,
    raisedFrom: (m: string) => `由 ${m} 升级`,
    unrouted: (why: string) => `路由器没有为这一轮选择模型${why ? `（${why}）` : ''}`,
    thisReply: '本次回复',
    todayWord: '今天',
    todayTokens: (n: string) => `${n} token`,
    tokensUsed: (session: string, today: string, week: string) => `已用 token：本会话 ${session} · 今天 ${today} · 近 7 天 ${week}`,
    week: (pct: string) => `本周已用 ${pct}%`,
    aheadOfPace: '，进度偏快',
    underCent: '不足 $0.01',
    cmpLess: (usd: string) => `（比全程 Opus 少 ${usd}）`,
    cmpMore: (usd: string) => `（比全程 Opus 多 ${usd}）`,
    contextPart: (size: string, window?: string) => `上下文 ${size}${window ? ` / ${window}` : ''}`,
    ctxLine: (size: string, window: string | undefined, pct: number | undefined) => `上下文 ${size}${window ? ` / ${window}` : ''} token${pct === undefined ? '' : `（${pct}%）`}`,
    cacheWarm: (n: number) => `缓存还能保持 ${n} 分钟`,
    cacheOver: '缓存已过期',
    chartTitle: (n: number) => `每日花费，近 ${n} 天（API 价格）`,
    chartTotal: (cost: string, base: string) => `合计 ${cost} · 全程 Opus 则为 ${base}`,
    comma: '，',
    cacheSoon: (min: number, extra: string) => `⏳ 请在 ${min} 分钟内回复以保持对话缓存——之后下一条回复将重新读取它，约 ${extra}`,
    cacheGone: (size: string, cost: string) => `⏳ 缓存已过期——下一条回复将重新读取 ${size} 个 token（约 ${cost}）`,
    wrongAsk: '上一条回复的模型不对？应该是：',
    thanks: (model: string) => `谢谢——本会话余下部分固定使用 ${model}。/model-router unpin 可撤销。`,
    switchCost: (cost: string, model: string) => ` 切换后，下一条回复会在 ${model} 上重新读取整个对话，约 ${cost}。`,
    footer: '/model-router 查看统计、设置和命令',
    raisedTo: (m: string) => `（升级到 ${m}）`,
    histTotal: (cost: string, base: string) => `近 7 天 ${cost} · 全程 Opus 则为 ${base}`,
    histUnavailable: '近 7 天：无法读取存储，合计无读数',
    tagCold: '（缓存已过期）',
    tagKept: (m: string) => `（保持 ${m}）`,
    tagPinned: '（已固定）',
    tagForced: '（你指定）',
    tagCorrected: '（已纠正）',
    sessionRow: '你的模型',
    notRouted: '路由器没有为这一轮选择模型',
    enabled: '启用',
    disabled: '关闭',
    enable: '恢复路由器',
    disable: '暂停路由器',
    session: '本会话',
    settings: '当前设置',
    pending: '待执行',
    none: '无',
    deadline: '缓存到期时间',
    safeDeadline: '最晚压缩时间',
    lastSkip: '上次跳过',
    unavailable: '无读数',
    categories: '本地估算分类（≈token）',
    noBreakdown: '无本地分类数据。',
    roles: { main: '主会话', subagents: '子代理', classifier: '分类器', reviewer: '审查器', compaction: '压缩' },
    usages: { read: '缓存读取', write: '缓存写入', input: '未缓存输入', output: '输出' },
    spendHeader: '| 类别 | token | 估算费用 |',
    peak: '主上下文峰值',
    rewrites: '已记录的缓存重写次数',
    compactions: '压缩前 → 后',
    unknownSize: '未知',
    unattributed: '旧记录未分类费用',
  },
  en: {
    keptTier: (why: string) => `classifier failed (${why}): kept previous tier`,
    riskFloor: ' · risky action: at least Sonnet',
    riskAboveParent: ' · risky action: Sonnet, above the Haiku parent',
    replayBusy: 'Replay refused: a main turn is running. Try again between turns.',
    replayRunning: 'Replay refused: another replay is running.',
    replayUsage: 'Usage: /model-router replay <path> [current|legacy|both] [--repeat <1-3>]',
    replayCancelled: 'Replay cancelled: the conversation changed.',
    replayRefused: (why: string) => `Replay refused: ${why}`,
    sessionModel: (why: string) => `classifier failed (${why}): session model`,
    inherited: 'continues previous route',
    forced: 'model pinned in your message',
    abandoned: (cost: string) => `warm Opus cache abandoned, estimated round-trip rewrite ${cost}`,
    warmSkip: 'warm large context: classifier skipped',
    review: 'Decision review',
    idleCompacted: (size: string) => `Idle compact: compacted ${size} of context while the cache was warm`,
    capCompacted: (size: string) => `Context cap reached: compacted ${size}`,
    checkpointCompacted: (size: string) => `Checkpoint: compacted ${size}`,
    checkpointStarted: 'Creating checkpoint…',
    checkpointHint: 'A checkpoint may pay for itself over the next 15 steps. Between tasks, use /model-router checkpoint [note].',
    turnBusy: 'Checkpoint refused: a main turn is running. Try again between turns.',
    checkpointBusy: 'Checkpoint refused: a checkpoint is already running.',
    checkpointCancelled: 'Checkpoint cancelled: the conversation or router state changed.',
    sessionChanged: 'The session changed; nothing shown.',
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
    ctx: 'Conversation size',
    unknownContext: 'Conversation size not measured yet',
    idleIn: (n: number) => `idle compact in ${n}m`,
    capIn: 'context cap compact pending',
    waiting: (n: number) => n < 0 ? 'idle compact waiting: agent status unavailable' : `idle compact waiting for ${n} agent${n === 1 ? '' : 's'}`,
    skipped: (why: string) => `Compaction skipped: ${why}`,
    deadlinePassed: 'the cache has expired',
    agentsBusy: 'agents still busy',
    agentUnavailable: 'agent status unavailable',
    routerOff: 'router off',
    vetoed: 'compaction skipped by hook',
    rejected: 'engine refused compaction',
    usage: 'Usage: /model-router stats | status | context | checkpoint [note] | on | off | history | pin <haiku|sonnet|opus> [turns] | unpin | wrong <lookup|execute|decide> | corrections [clear] | pacing [off|warn|steer|default]',
    commandDescription: 'Model router: stats for spend, status for settings, context for context size, checkpoint [note] to compact, history for the details, pin / unpin to hold a model, wrong to correct a route, corrections to list them, pacing for weekly pace, on / off to toggle',
    pinned: (left?: number) => left === undefined ? 'pinned' : `pinned (${left} left)`,
    pinNeedsRouting: 'Pinning needs main routing (mainRouting is off).',
    pinSet: (model: string, left?: number) => left === undefined ? `Pinned to ${model} until /model-router unpin or the session ends.` : `Pinned to ${model} for the next ${left} turn${left === 1 ? '' : 's'}.`,
    pinRouterOff: ' The router is off now; the pin applies once it is on.',
    unpinned: 'Unpinned.',
    notPinned: 'No model is pinned.',
    wrongOff: 'Corrections are off (learnFromCorrections): nothing was recorded or pinned.',
    wrongNone: 'No classified turn to correct (forced, pinned, inherited and failed-classification turns were not classified).',
    wrongNoText: 'The prompt of that turn is no longer in memory, so nothing was recorded.',
    wrongFailed: 'Could not save the correction.',
    correctionsClearFailed: 'The stored corrections could not be deleted and may remain on disk.',
    correctionsClearPartial: 'Not every correction could be removed: another window may still be writing them. Run /model-router corrections clear again later.',
    pacingNotSaved: '(Could not be saved: this session only.)',
    wrongSame: (tier: string) => `That turn was already routed ${tier}; nothing recorded.`,
    wrongDone: (at: string, routed: string, right: string, model: string) => `Recorded: the ${at} turn was routed ${routed} and should have been ${right}. The rest of this session stays on ${model}. /model-router unpin to undo.`,
    corrections: 'Routing corrections',
    correctionsNone: 'No corrections recorded.',
    correctionsCleared: 'Corrections cleared.',
    learnedOff: '(recording is off)',
    pacingMode: (mode: string, from: string) => `Weekly pacing: ${mode} (${from})`,
    pacingOption: 'option',
    pacingOverride: 'override',
    pacingSet: (mode: string) => `Weekly pacing set to ${mode}.`,
    pacingDefault: (mode: string) => `Override removed; using the option: ${mode}.`,
    pacingFigures: (used: string, pace: string, state: string) => `${used}% used, pace ${pace} (${state})`,
    pacingNoWindow: 'no weekly usage window',
    paceAhead: (x: string) => ` · pace ${x} ahead`,
    paceToast: (used: string, x: string, steer: boolean) => `Weekly usage ${used}% is using the week ${x} faster than an even pace.${steer ? ' Unsure decisions now route to Sonnet.' : ''}`,
    modelFallback: (configured: string, alias: string) => `model-router: ${configured} was not found on this account, so that tier runs on ${alias} (the newest model of its family) for now. Set an id that exists, or the alias, in the plugin options.`,
    modelNotFound: (alias: string) => `(not found; running on ${alias})`,
    histNone: 'No replies routed in this session yet.',
    paused: 'Router paused — your own model answers every turn',
    details: 'Details',
    hideDetails: 'Hide details',
    bandIdle: 'The router picks a model for each message you send',
    bandSubagents: 'Router on for subagents only — your own model answers your messages',
    pinnedMore: (left?: number) => left === undefined ? 'pinned until you unpin' : left === 0 ? 'pinned' : `pinned, ${left} more repl${left === 1 ? 'y' : 'ies'}`,
    pinWaiting: (left?: number) => left === undefined ? 'pinned until you unpin' : `pinned for the next ${left} repl${left === 1 ? 'y' : 'ies'}`,
    youChose: (m: string) => `you chose it (#${m})`,
    keptOn: (m: string) => `kept on ${m}: switching would re-read the whole conversation`,
    raisedFrom: (m: string) => `raised from ${m}`,
    unrouted: (why: string) => `the router did not choose this turn${why ? ` (${why})` : ''}`,
    thisReply: 'This reply',
    todayWord: 'Today',
    todayTokens: (n: string) => `${n} tok`,
    tokensUsed: (session: string, today: string, week: string) => `Tokens used: this session ${session} · today ${today} · last 7 days ${week}`,
    week: (pct: string) => `Week ${pct}% used`,
    aheadOfPace: ', ahead of pace',
    underCent: 'under $0.01',
    cmpLess: (usd: string) => `(−${usd} vs all-Opus)`,
    cmpMore: (usd: string) => `(+${usd} vs all-Opus)`,
    contextPart: (size: string, window?: string) => `Context ${size}${window ? ` of ${window}` : ''}`,
    ctxLine: (size: string, window: string | undefined, pct: number | undefined) => `Context ${size}${window ? ` of ${window}` : ''} tokens${pct === undefined ? '' : ` (${pct}%)`}`,
    cacheWarm: (n: number) => `cache warm for ${n} more min`,
    cacheOver: 'cache expired',
    chartTitle: (n: number) => `Spend per day, last ${n} days (API prices)`,
    chartTotal: (cost: string, base: string) => `Total ${cost} · all-Opus would be ${base}`,
    comma: ', ',
    cacheSoon: (min: number, extra: string) => `⏳ Reply within ${min} min to keep the conversation cached — after that the next reply re-reads it for ≈${extra}`,
    cacheGone: (size: string, cost: string) => `⏳ The cache expired — your next reply re-reads ${size} tokens (≈${cost})`,
    wrongAsk: 'Wrong model for the last reply? Should have been:',
    thanks: (model: string) => `Thanks — the rest of this session stays on ${model}. /model-router unpin to undo.`,
    switchCost: (cost: string, model: string) => ` Switching re-reads the whole conversation at about ${cost} on ${model}.`,
    footer: '/model-router for stats, settings and commands',
    raisedTo: (m: string) => `(raised to ${m})`,
    histTotal: (cost: string, base: string) => `Last 7 days ${cost} · all-Opus would be ${base}`,
    histUnavailable: 'Last 7 days: total unavailable (the store could not be read)',
    tagCold: '(cache expired)',
    tagKept: (m: string) => `(kept on ${m})`,
    tagPinned: '(pinned)',
    tagForced: '(you chose)',
    tagCorrected: '(corrected)',
    sessionRow: 'your model',
    notRouted: 'the router did not choose this turn',
    enabled: 'enabled',
    disabled: 'disabled',
    enable: 'Resume router',
    disable: 'Pause router',
    session: 'This session',
    settings: 'Current settings',
    pending: 'Pending',
    none: 'none',
    deadline: 'Cache expires',
    safeDeadline: 'Compact before',
    lastSkip: 'Last skipped action',
    unavailable: 'unavailable',
    categories: 'Local category estimates (≈tokens)',
    noBreakdown: 'No local breakdown available.',
    roles: { main: 'Main', subagents: 'Subagents', classifier: 'Classifier', reviewer: 'Reviewer', compaction: 'Compaction' },
    usages: { read: 'Cache reads', write: 'Cache writes', input: 'Uncached input', output: 'Output' },
    spendHeader: '| category | tokens | estimated cost |',
    peak: 'Peak main context',
    rewrites: 'Cache rewrites counted',
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
  // Lookups the risk floor raised to execute (main turns and subagents alike).
  riskFloors: number
  // Live classifier calls by how long they took (hooks/latency.ts buckets), with their summed time for a mean. Replay
  // calls are not counted: they measure a prompt, not what a person waits for.
  classifierLatency: Record<string, number>
  classifierMsTotal: number
  classifierTimed: number
  // Tiers whose configured full model id the API reported as not found, so they ran on the family alias instead.
  modelFallbacks: number
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
  riskFloors: 0,
  classifierLatency: {},
  classifierMsTotal: 0,
  classifierTimed: 0,
  modelFallbacks: 0,
}

// "≈$3.51", and "<$0.01" without a sign in front of it.
function approxUsd(n: number): string {
  return n > 0 && n < 0.01 ? fmtUsd(n) : `≈${fmtUsd(n)}`
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

// One redraw request for the band and the history row; a missing surface must not affect the caller.
function redraw($: EngineInterface) {
  try {
    $.ui.invalidate('ui.render')
  } catch {
    // Nothing is drawn there.
  }
}

// Read at session start and by the first thing that needs them, then again once the last good read is over a minute
// old, so a change made in another window reaches this one; never one store read per hook or render. A failed read is
// retried later with the other loads' backoff, and the last values (or the defaults) stand until it succeeds.
const PREFS_FRESH_MS = 60_000
// Bumped by every local change to a preference, so a read already in flight cannot put back the value it replaced.
let prefsChanges = 0
// Preferences changed here whose store write failed: the local value holds ("this session only") and a refresh never
// puts the stored one back, until a later write of that preference succeeds or the session ends.
const prefsUnsaved = new Set<'pacing' | 'paceWarned'>()

function prefSaved(key: 'pacing' | 'paceWarned', ok: boolean) {
  if (ok) prefsUnsaved.delete(key)
  else prefsUnsaved.add(key)
}

async function ensurePrefs($: EngineInterface, session: Session, now?: number) {
  const part = session.prefs
  if (part.done && !part.pending) {
    const at = now ?? await $.clock.now()
    if (!here(session) || at - (part.at ?? -Infinity) <= PREFS_FRESH_MS) return
    part.done = false
  }
  return loadPart($, part, () => loadPrefs($, session))
}

// The persisted choices: the pacing override, the window the pace toast last fired for and the band's details state.
// The details state is read on a session's first load only: a running window keeps its own open or closed band, and a
// new session starts with the last choice saved.
async function loadPrefs($: EngineInterface, session: Session) {
  const changes = prefsChanges
  const at = await $.clock.now()
  const mode = await $.store.get('pacing')
  const warned = await $.store.get('paceWarned')
  const first = session.prefs.at === undefined
  const expanded = first ? await $.store.get('bandExpanded') : undefined
  if (!here(session)) return
  session.prefs.at = at
  // A local change landed while this read ran: it is newer than what was read.
  if (changes !== prefsChanges) return
  if (!prefsUnsaved.has('pacing')) pacingOverride = isPaceMode(mode) ? mode : undefined
  if (!prefsUnsaved.has('paceWarned')) paceWarned = typeof warned === 'string' ? warned : undefined
  if (first) bandExpanded = expanded === true
}

// The window a pace check is reading the store for, so a second check in this process does not toast alongside it.
let paceChecking: string | undefined

// One toast when weekly use first runs ahead of an even pace in a window, remembered across sessions and windows: the
// store is read again first, because another open window may have toasted for this one since the last read.
async function paceNotice($: EngineInterface, session: Session, now: number) {
  if (pacingMode() === 'off') return
  const w = weeklyLimit()
  const p = paceOf(w, now)
  if (p.state !== 'ahead' || !w?.resetsAt || sameWindow(paceWarned, w.resetsAt) || paceChecking === w.resetsAt) return
  const resetsAt = w.resetsAt
  paceChecking = resetsAt
  let stored: unknown
  try {
    // A failed read toasts: one toast too many beats none.
    stored = await bookkeeping($, () => $.store.get('paceWarned'), undefined, retryFor(session, 'pace read'))
  } finally {
    if (paceChecking === resetsAt) paceChecking = undefined
  }
  if (await stillHere($, session) !== 'same') return
  if (typeof stored === 'string' && sameWindow(stored, resetsAt)) {
    paceWarned = stored
    return
  }
  if (sameWindow(paceWarned, resetsAt) || pacingMode() === 'off') return
  paceWarned = resetsAt
  prefsChanges++
  try {
    $.ui.toast(STR[uiLang].paceToast(String(w.percentUsed), fmtPace(p), pacingMode() === 'steer'))
  } catch {
    // A missing toast surface must not affect the status line.
  }
  let ok = false
  await bookkeeping($, async () => { await $.store.set('paceWarned', resetsAt); ok = true }, undefined, retryFor(session, 'pace write'))
  if (await stillHere($, session) !== 'same') return
  prefSaved('paceWarned', ok)
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
        sessionRetirements += 1
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
type Load = { done: boolean; pending?: Promise<void>; retry: Backoff; at?: number }
type Session = { id: string; stateId: string; ended: boolean; history: Load; daily: Load; prefs: Load; retries: Map<string, Backoff>; today?: Tally }
let activeSession: Session | undefined
// Host state survives hot reload; a new module must never select an earlier activation's members.
const activationId = crypto.randomUUID()
// Every lifetime (including end and same-id resume) invalidates older identity lookups.
let sessionGeneration = 0
// Ends, retirements and replacements: a raced lookup may join only the first activation in this process.
let sessionRetirements = 0
let identityRetry = new Backoff()

function newSession(id: string, ended = false): Session {
  identityRetry = new Backoff()
  if (ended) sessionRetirements += 1
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
  const retirements = sessionRetirements
  const id = await sessionId($)
  if (id === undefined) return undefined
  // A lookup that raced another hook may join the lifetime that hook activated for this id (interactive
  // ui.render often wins against session.start), but never one that began after an end or retirement.
  const joined = retirements === sessionRetirements && activeSession?.id === id && !activeSession.ended
  if (generation !== sessionGeneration && !joined) return undefined
  if (activeSession?.id === id && !activeSession.ended) {
    const session = activeSession
    await readySession($, session)
    void logs.flush(logIO($))
    return session
  }
  const first = activeSession === undefined
  if (!first) sessionRetirements += 1
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
  contextWindow = undefined
  observedModel = undefined
  sessionModel = 'opus'
  pin = null
  snippets.clear()
  escalationRight.clear()
  turnCold = false
  turnBase = { tokens: 0, cost: 0 }
  turnTrailBase = 0
  weekCache = undefined
  thanks = undefined
  // A preference that could not be saved held for its own session only: the next session reads the stored one.
  if (prefsUnsaved.has('pacing')) pacingOverride = undefined
  if (prefsUnsaved.has('paceWarned')) paceWarned = undefined
  prefsUnsaved.clear()
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

// The one cache notice the band ever shows, and only when it matters: a conversation big enough to be costly to re-read,
// whose cache is about to expire (15 minutes or less) or already has. A cache of unknown age (after a reload) says nothing.
function cacheWarning(lang: Lang, now: number, minContext: number): string {
  const str = STR[lang]
  const { tokens: context, model } = contextReading()
  if (context === undefined || lastMain === null || context < minContext) return ''
  const rewrite = fmtUsd(context * priceOf(model, context).write / 1e6)
  const left = lastMain.at + CACHE_TTL_MS - now
  if (left <= 0) return str.cacheGone(fmtTokens(context), rewrite)
  const minutes = Math.ceil(left / 60_000)
  return minutes <= 15 ? str.cacheSoon(minutes, rewrite) : ''
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
      const day = /^(?:meter|counts|corrections):(\d{8}):/.exec(key)?.[1]
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
    await showSpend($, session, now, turn => add(turn, modelId, u, switched, overhead, role))
  })
}

// Rereads today's figure and shows it, with the turn tally changed by `turn`, while the session is still here. Spend has
// landed, so the Details snapshot may refresh (`accounting`).
async function showSpend($: EngineInterface, session: Session, now: number, turn: (t: Tally) => Tally): Promise<void> {
  accounting++
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
  await update($, memberOf(meter, { requestId: session.stateId }), m => {
    if (!here(session)) return m
    return { turn: turn((m ?? { turn: EMPTY }).turn), today }
  })
}

// One replay call's (or availability probe's) spend, on the day and the total of the session it started in, never on a
// turn. Each call is priced on its own: Haiku's long-prompt rate is per request, so a sum priced as one request would cost
// about 5x too much. Unlike serial, this write does not check that the session is still here: the call was paid for, so
// it stays on the originating session's ledger after a clear or a switch. It still queues on `writes`, so it never races
// a live write in this process. Nothing else (routing, counts, the band) is touched here.
function recordReplay($: EngineInterface, session: Session, u: Usage, modelId = 'claude-haiku-5-5'): Promise<void> {
  writes = writes.then(() => bookkeeping($, async () => {
    const key = `meter:${dayKey(await $.clock.now())}:${session.id}`
    const previous = ((await $.store.get(key)) as Tally | undefined) ?? EMPTY
    await $.store.set(key, add(previous, modelId, u, false, true, 'classifier'))
  }, undefined, retryFor(session, 'replay meter'))).catch(err => storeFailure($, err))
  return writes
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

// One context message as the classifier sees it: masked first, so a secret cut by the trim is still caught whole, then,
// over 1,200 characters, cut to its first 200 and last 1,000.
function contextMessage(text: string): string {
  const masked = redact(text)
  return masked.length > 1200 ? `${masked.slice(0, 200)}\n…\n${masked.slice(-1000)}` : masked
}

// The classifier's context from a list of messages: the last two that are not empty, each trimmed by contextMessage.
// Live classification and a structured replay context both go through here, so the two are the same byte for byte.
function contextOf(messages: readonly { role: string; text: string }[]): string {
  const rows = messages.filter(m => m.text.trim() !== '').slice(-2)
  return rows.map(m => `[${m.role}] ${contextMessage(m.text)}`).join('\n\n')
}

async function recentContext($: EngineInterface): Promise<string> {
  return contextOf(await $.session.messages())
}

// A replay item's context. Structured ({ role, text } messages) goes through contextOf exactly as live context does. A
// string is approximate: it is cut back into messages at a blank line followed by "[role] ", so a message that itself
// holds such a paragraph is split and its parts trimmed on their own, and every block is kept (no last-two cut).
function replayContext(context: ReplayContext): string {
  if (typeof context !== 'string') return contextOf(context)
  return context
    .split(/\n\n(?=\[\w+\] )/)
    .map(block => {
      const m = /^(\[\w+\] )([\s\S]*)$/.exec(block)
      return m ? `${m[1]}${contextMessage(m[2]!)}` : contextMessage(block)
    })
    .join('\n\n')
}

type Verdict = { tier: Tier; reason: string; sure: boolean }
// A verdict, or why there is none: 'timeout', 'api-error <status>', 'empty-reply', 'unparseable' or 'exception'.
// why is the counted reason; detail (the start of an unparseable reply) is only for the person reading the log.
type Classified = { ok: true; verdict: Verdict } | { ok: false; why: string; detail?: string }

function failText(c: { why: string; detail?: string }): string {
  return c.detail ? `${c.why}: ${c.detail}` : c.why
}

// The risk floor (hooks/risk.ts): a message the code check finds risky does not start on Haiku. Only a sure lookup is
// raised, to execute, and the reason says so; every raise is counted. An unsure lookup is left alone: settleTier and
// decideSpawn raise it anyway, so flooring it would change nothing but the count. Effort is left to the tier.
async function floorRisk($: EngineInterface, session: Session, lang: Lang, v: Verdict, text: string): Promise<Verdict> {
  if (!v.sure) return v
  const tier = riskFloor(v.tier, isRisky(redact(text).slice(0, 6000)))
  if (tier === v.tier) return v
  await count($, session, c => ({ ...c, riskFloors: (c.riskFloors ?? 0) + 1 }))
  return { ...v, tier, reason: `${v.reason}${STR[lang].riskFloor}`.trim() }
}

// Haiku sorts a text into a tier. withContext adds the last two messages.
async function classifyTier($: EngineInterface, session: Session, lang: Lang, text: string, previous: Tier | null, withContext: boolean): Promise<Classified> {
  try {
    await ensurePrefs($, session)
    const context = withContext ? await recentContext($) : ''
    if (await stillHere($, session) !== 'same') return { ok: false, why: 'session changed' }
    // Timed around the call alone, so the figure is what the person waits on the classifier, not the context read.
    const sentAt = await $.clock.now()
    const r = await $.model.complete({
      model: 'haiku',
      system: classifierSystem(lang),
      prompt: classifierPrompt(previous, context, redact(text).slice(0, 6000)),
      maxTokens: CLASSIFY_MAX_TOKENS,
      effort: 'low',
      timeoutMs: CLASSIFY_MS,
    })
    const ms = (await $.clock.now()) - sentAt
    if (await stillHere($, session) !== 'same') return { ok: false, why: 'session changed' }
    await countLatency($, session, ms, !r.isAnswered && r.reason === 'aborted')
    await record($, session, 'claude-haiku-5-5', r.usage, false, true, 'classifier')
    if (!r.isAnswered) {
      if (r.reason === 'aborted') return { ok: false, why: 'timeout' }
      if (r.reason === 'api-error') return { ok: false, why: `api-error ${r.status ?? 'none'}` }
      return { ok: false, why: 'empty-reply' }
    }
    const verdict = parseDecision(r.text)
    if (verdict) return { ok: true, verdict: await floorRisk($, session, lang, verdict, text) }
    // Masked whole before cutting, so a secret split by the cut is still caught.
    return { ok: false, why: 'unparseable', detail: redact(r.text).replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS) }
  } catch {
    return { ok: false, why: 'exception' }
  }
}

// One live classifier call's time, whatever it returned, except an abort well before the cap (the person's Escape, which
// lands in no bucket and is not counted); the bucket keys are fixed so day counts merge by addition.
function countLatency($: EngineInterface, session: Session, ms: number, aborted: boolean): Promise<void> {
  const bucket = latencyBucket(ms, aborted)
  if (bucket === null) return Promise.resolve()
  return count($, session, c => {
    const hist = c.classifierLatency ?? {}
    return {
      ...c,
      classifierLatency: { ...hist, [bucket]: (hist[bucket] ?? 0) + 1 },
      classifierMsTotal: (c.classifierMsTotal ?? 0) + ms,
      classifierTimed: (c.classifierTimed ?? 0) + 1,
    }
  })
}

// The classifier call as classifyTier makes it: same model, effort, limits, masking and cut. Returns the raw text, or why
// there was none; never throws.
async function replayCall($: EngineInterface, system: string, prompt: string): Promise<{ ok: true; raw: string; usage: Usage } | { ok: false; why: string; usage?: Usage }> {
  try {
    const r = await $.model.complete({ model: 'haiku', system, prompt, maxTokens: CLASSIFY_MAX_TOKENS, effort: 'low', timeoutMs: CLASSIFY_MS })
    if (r.isAnswered) return { ok: true, raw: r.text, usage: r.usage }
    if (r.reason === 'aborted') return { ok: false, why: 'timeout', usage: r.usage }
    if (r.reason === 'api-error') return { ok: false, why: `api-error ${r.status ?? 'none'}`, usage: r.usage }
    return { ok: false, why: 'empty-reply', usage: r.usage }
  } catch {
    return { ok: false, why: 'exception' }
  }
}

function pause($: EngineInterface, ms: number): Promise<void> {
  return new Promise(resolve => { $.clock.after(ms, () => resolve()) })
}

// /model-router replay <path> [current|legacy|both] [--repeat <1-3>]: the maintainer's instrument for measuring the
// classifier prompt. It runs the real classifier call over a labelled file, each variant repeat times, and writes what came
// back with the code's risk check and each call's time. At most REPLAY_CONCURRENCY calls are in flight; after a timeout no
// new call starts until REPLAY_PAUSE_MS after the latest one. It changes no routing state, count, correction or turn
// record; each call's spend is added to the day and the total as it completes (recordReplay), as classifier cost, and
// never to a turn. It runs beside live turns: a turn started during a replay classifies alongside its calls.
async function runReplay($: EngineInterface, session: Session, lang: Lang, rest: string): Promise<string> {
  const str = STR[lang]
  const parsed = parseReplayArgs(rest)
  if (!parsed) return str.replayUsage
  // Only a `~` path needs the home folder and only a relative one the session's folder; an absolute path is used as given.
  let home: string | undefined
  let cwd = ''
  try {
    if (parsed.path.startsWith('~')) home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
    if (!/^(?:~|[\\/]|[A-Za-z]:[\\/])/.test(parsed.path)) cwd = await $.session.cwd()
  } catch {
    // Left as given: the read below reports the path it could not open.
  }
  const args = { ...parsed, path: resolveReplayPath(parsed.path, home, cwd) }
  if (await stillHere($, session) !== 'same') return str.replayCancelled
  let text: string
  try {
    text = (await $.fs.read(args.path)) as string
  } catch (err) {
    return str.replayRefused(`cannot read ${args.path} (${String(err).slice(0, 120)})`)
  }
  if (await stillHere($, session) !== 'same') return str.replayCancelled
  const file = parseReplayFile(text)
  if (!file.ok) return str.replayRefused(file.why)
  const risky = file.items.map(item => isRisky(redact(item.message).slice(0, 6000)))
  const jobs = file.items.flatMap((item, n) => args.variants.flatMap(variant => Array.from({ length: args.repeat }, (_, i) => ({ item, risk: risky[n]!, variant, run: i + 1 }))))
  const rows: (ReplayRow | undefined)[] = new Array(jobs.length)
  let ledger: Promise<void> = Promise.resolve()
  let next = 0
  let cancelled = false
  // No new call starts before this time; every timeout moves it to at least 3 seconds after itself.
  let holdUntil = 0
  const worker = async () => {
    while (!cancelled && next < jobs.length) {
      const now = await $.clock.now()
      if (now < holdUntil) {
        await pause($, holdUntil - now)
        continue
      }
      if (cancelled || next >= jobs.length) return
      const i = next++
      const { item, risk, variant, run } = jobs[i]!
      const system = variant === 'legacy' ? legacyClassifierSystem(lang) : classifierSystem(lang)
      const prompt = classifierPrompt(item.previous, replayContext(item.context), redact(item.message).slice(0, 6000))
      const started = await $.clock.now()
      const r = await replayCall($, system, prompt)
      const ended = await $.clock.now()
      const ms = ended - started
      // Recorded before the session check: a call that finished after a switch was still paid for.
      if (r.usage) ledger = recordReplay($, session, r.usage)
      if (await stillHere($, session) !== 'same') { cancelled = true; return }
      if (!r.ok) {
        rows[i] = replayRow(item.id, variant, run, risk, ms, { ok: false, raw: '', why: r.why })
        if (r.why === 'timeout') holdUntil = Math.max(holdUntil, ended + REPLAY_PAUSE_MS)
        continue
      }
      const d = parseDecision(r.raw)
      rows[i] = d
        ? replayRow(item.id, variant, run, risk, ms, { ok: true, raw: r.raw, decision: d })
        : replayRow(item.id, variant, run, risk, ms, { ok: false, raw: r.raw, why: 'unparseable' })
    }
  }
  await Promise.all(Array.from({ length: Math.min(REPLAY_CONCURRENCY, jobs.length) }, worker))
  await ledger
  if (cancelled || await stillHere($, session) !== 'same') return str.replayCancelled
  // Today's figure once at the end, not per call (that rereads every day key); the turn tally is left as it is.
  await serial($, session, 'meter', async () => showSpend($, session, await $.clock.now(), turn => turn))
  const done = rows.filter((r): r is ReplayRow => r !== undefined)
  const out = replayOutPath(args.path)
  try {
    await $.fs.write(out, JSON.stringify(done, null, 2))
  } catch (err) {
    return str.replayRefused(`cannot write ${out} (${String(err).slice(0, 120)})`)
  }
  return replaySummary(done, args.variants, out, file.items.length, args.repeat, risky.filter(Boolean).length)
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
    if (previous) {
      const kept = await floorRisk($, session, lang, { tier: previousTier!, reason: STR[lang].keptTier(failText(c)), sure: true }, text)
      return how(routeFor(kept.tier, kept.reason), 'kept-tier')
    }
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
// could not be written; nothing is claimed then. Each activation writes only its own daily key for the session (as the
// event logs keep writer-specific batches), so two open windows never overwrite each other's corrections, not even two
// on one resumed session; the 30-day prune removes old days.
async function recordCorrection($: EngineInterface, session: Session, c: Correction, counted = true): Promise<boolean> {
  let ok = false
  await serial($, session, 'corrections', async () => {
    const key = `corrections:${dayKey(c.at)}:${session.id}:${activationId}`
    const next = addCorrection(readCorrections(await $.store.get(key)), c)
    if (await stillHere($, session) !== 'same') return
    await $.store.set(key, next)
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
// was routed by pacing, so correcting it would teach a verdict the classifier never gave. The history row's buttons and the
// command both choose by this.
function isCorrectable(t: TurnRecord): boolean {
  return t.how === 'classified' && !t.steered
}

// The turn a correction applies to: the one named (a history button names the turn it drew), else the latest correctable.
async function correctionTarget($: EngineInterface, session: Session, turnId?: string): Promise<TurnRecord | undefined> {
  const list = await bookkeeping($, () => read($, memberOf(turns, { requestId: session.stateId })), [] as TurnRecord[])
  return turnId === undefined ? [...list].reverse().find(isCorrectable) : list.find(t => t.turnId === turnId && isCorrectable(t))
}

// "/model-router wrong <tier>" and the history buttons. Answers with what was recorded, or why nothing was. A recorded
// correction also pins the main conversation to the right tier's model until unpin or the session ends: the person
// said this work needs it. Corrections are not sent to the classifier; they are kept to revise its prompt offline.
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
  if (await stillHere($, session) !== 'same') return str.checkpointCancelled
  const model = TIER_ROUTE[right].model
  pin = { model }
  const note = switchNote(lang, model)
  await bookkeeping($, () => update($, memberOf(turns, { requestId: session.stateId }), list => here(session) ? list.map(t => t.turnId === rec.turnId ? { ...t, corrected: right } : t) : list), undefined)
  thanks = { turnId: rec.turnId, model, note }
  redraw($)
  return str.wrongDone(hhmm(rec.at), rec.tier, right, LABEL[model]) + note + ((await read($, enabled)) ? '' : str.pinRouterOff)
}

// A correction that pins a smaller model than the conversation is on makes the next reply re-read the whole conversation
// on that model: from 100k tokens up, the confirmation says what that costs. It informs; it never blocks the pin.
function switchNote(lang: Lang, to: ModelKey): string {
  const { tokens, model: from } = contextReading()
  if (tokens === undefined || tokens < REWRITE_MIN_TOKENS || !(from === 'fable' || RANK[to] < RANK[from])) return ''
  return STR[lang].switchCost(fmtUsd(tokens * priceOf(to, tokens).write / 1e6), LABEL[to])
}

async function pressWrong($: EngineInterface, session: Session, lang: Lang, right: Tier, turnId: string) {
  const text = await correctTurn($, session, lang, right, turnId)
  // The band thanks the person itself when it was recorded; only a refusal needs saying.
  if (thanks?.turnId === turnId) return
  try {
    $.ui.toast(text)
  } catch {
    // The answer is also what the command gives.
  }
}

// The small per-turn record /model-router history lists, written when a main turn completes. r null: the route did not
// govern the turn; the record is unrouted, on the session's own model, and cannot be corrected.
async function writeTurnRecord($: EngineInterface, session: Session, r: Route | null, turnId: string) {
  const m = await bookkeeping($, () => read($, memberOf(meter, { requestId: session.stateId })), undefined)
  const at = await $.clock.now()
  if (await stillHere($, session) !== 'same') return
  const tokens = Math.max(0, (m?.turn.tokens ?? 0) - turnBase.tokens)
  const cost = Math.max(0, (m?.turn.cost ?? 0) - turnBase.cost)
  const rec: TurnRecord = r === null ? { turnId, at, tier: 'execute', model: 'session', reason: '', trail: [], tokens, cost, cold: turnCold, how: 'unrouted' } : {
    turnId,
    at,
    tier: r.tier,
    model: r.sessionModel ? 'session' : r.model,
    ...(r.sessionModel ? {} : { effort: r.effort }),
    // An inherited turn's route carries the earlier turn's cache keep and escalations: only its own are its.
    ...(r.keptFrom && r.how !== 'inherited' ? { keptFrom: r.keptFrom } : {}),
    reason: r.reason,
    trail: r.trail.slice(turnTrailBase),
    tokens,
    cost,
    cold: turnCold,
    // A route without a tag (one an earlier version stored) was not classified by this one: not correctable.
    how: r.how ?? 'inherited',
    ...(r.steered ? { steered: true } : {}),
    ...(escalationRight.has(turnId) ? { corrected: escalationRight.get(turnId) } : {}),
  }
  await bookkeeping($, () => update($, memberOf(turns, { requestId: session.stateId }), list => here(session) ? [...list, rec].slice(-MAX_TURNS) : list), undefined, retryFor(session, 'turn record'))
}

// The seven days of spend and tokens in one pass over the store keys.
async function weekSeries($: EngineInterface, session: Session, now: number): Promise<DayCost[] | undefined> {
  const days = lastDays(now, PACE_DAYS, dayKey)
  const byDay = new Map<string, Tally>()
  for (const key of await $.store.keys()) {
    const m = /^meter:(\d{8})(?::.+)?$/.exec(key)
    if (!m || !days.includes(m[1]!)) continue
    const t = (await $.store.get(key)) as Tally | undefined
    if (t) byDay.set(m[1]!, merge(byDay.get(m[1]!) ?? EMPTY, t))
  }
  const identity = await stillHere($, session)
  // An unavailable id backs off like a failed read, so an open band does not rescan the store on every redraw.
  if (identity === 'unavailable') throw new Error('session id unavailable')
  if (identity !== 'same') return undefined
  return days.map(day => ({ day, cost: byDay.get(day)?.cost ?? 0, baseline: byDay.get(day)?.baseline ?? 0, tokens: byDay.get(day)?.tokens ?? 0 }))
}

// A dollar amount in plain words: under a cent says so.
function plainUsd(lang: Lang, n: number): string {
  return n > 0 && n < 0.01 ? STR[lang].underCent : fmtUsd(n)
}

// One turn as a row: the pieces the band colours and the plain text joins.
function turnParts(t: TurnRecord, lang: Lang) {
  const str = STR[lang]
  const markers = [
    t.how === 'pinned' ? str.tagPinned : t.how === 'forced' ? str.tagForced : '',
    t.keptFrom && t.model !== 'session' ? str.tagKept(LABEL[t.model]) : '',
    t.trail.length > 0 && t.model !== 'session' ? str.raisedTo(LABEL[t.model]) : '',
    t.cold ? str.tagCold : '',
    t.corrected ? str.tagCorrected : '',
  ].filter(Boolean)
  // A pinned or chosen turn's reason only repeats its marker.
  const why = t.how === 'pinned' || t.how === 'forced' ? '' : t.how === 'unrouted' ? str.notRouted : t.reason
  return {
    time: hhmm(t.at),
    label: t.model === 'session' ? str.sessionRow : `${LABEL[t.model]} · ${t.effort ?? ''}`.replace(/ · $/, ''),
    cost: plainUsd(lang, t.cost),
    markers: markers.join(' '),
    why,
  }
}

function weekTotals(series: readonly DayCost[]): { cost: number; base: number } {
  return { cost: series.reduce((sum, d) => sum + d.cost, 0), base: series.reduce((sum, d) => sum + d.baseline, 0) }
}

// /model-router history: the same plain rows as the expanded band, as text, with the week's total.
function historyText(lang: Lang, list: readonly TurnRecord[], series: readonly DayCost[] | undefined): string {
  const str = STR[lang]
  const rows = list.map(t => {
    const p = turnParts(t, lang)
    return `${p.time}  ${p.label}  ${p.cost}${p.markers ? ` ${p.markers}` : ''}${p.why ? ` — ${shorten(p.why, 40)}` : ''}`
  })
  // The week could not be read from the store: the rows still stand, and the total says so.
  const w = series === undefined ? undefined : weekTotals(series)
  const total = w === undefined ? str.histUnavailable : str.histTotal(fmtUsd(w.cost), fmtUsd(w.base))
  return [...(rows.length > 0 ? rows : [str.histNone]), total].join('\n')
}

async function historyCommand($: EngineInterface, session: Session, lang: Lang): Promise<string> {
  const list = await bookkeeping($, () => read($, memberOf(turns, { requestId: session.stateId })), [] as TurnRecord[])
  const now = await $.clock.now()
  const series = await bookkeeping($, () => weekSeries($, session, now), undefined, retryFor(session, 'history week'))
  if (await stillHere($, session) !== 'same') return STR[lang].sessionChanged
  return historyText(lang, list.slice(-HISTORY_ROWS), series)
}

// The band's Details button: the choice is remembered across sessions.
async function toggleDetails($: EngineInterface, session: Session) {
  bandExpanded = !bandExpanded
  prefsChanges++
  weekCache = undefined
  redraw($)
  await bookkeeping($, () => $.store.set('bandExpanded', bandExpanded), undefined, retryFor(session, 'band write'))
}

// 106k, 1M, 1.5M: how big a conversation is, at a glance.
function compactTokens(n: number): string {
  if (n >= 1e6) return `${Number.isInteger(n / 1e6) ? n / 1e6 : (n / 1e6).toFixed(1)}M`
  return n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n))
}

// Details' first line: how big the conversation is, and the cache when it is known. The one place the cache is shown when
// no warning is due.
function contextLine(lang: Lang, now: number): string {
  const str = STR[lang]
  const { tokens } = contextReading()
  const parts: string[] = []
  if (tokens !== undefined) {
    parts.push(str.ctxLine(compactTokens(tokens), contextWindow ? compactTokens(contextWindow) : undefined, contextWindow ? Math.round(tokens / contextWindow * 100) : undefined))
  }
  if (lastMain !== null) {
    const left = lastMain.at + CACHE_TTL_MS - now
    parts.push(left > 0 ? str.cacheWarm(Math.ceil(left / 60_000)) : str.cacheOver)
  }
  return parts.join(' · ')
}

// Row 1 of the band: what the router chose, in words.
function bandRoute(lang: Lang, r: Route | null, routesMain: boolean): string {
  const str = STR[lang]
  const effortOf = (m: ModelKey) => TIER_ROUTE[TIER_OF[m]].effort
  // A pin set since the last route, or one that replaced the pin the route ran on, is what the next reply will use.
  if (pin && (r?.how !== 'pinned' || r.model !== pin.model)) return `📌 ${LABEL[pin.model]} · ${effortOf(pin.model)} — ${str.pinWaiting(pin.left)}`
  if (!r) return `⚙ ${routesMain ? str.bandIdle : str.bandSubagents}`
  if (r.sessionModel) return `⚙ ${str.sessionRow} — ${str.unrouted(/\(([^)]*)\)/.exec(r.reason)?.[1] ?? '')}`
  const label = `${LABEL[r.model]} · ${r.effort}`
  if (r.how === 'pinned') return `📌 ${label} — ${pin ? str.pinnedMore(pin.left) : str.pinnedMore(0)}`
  if (r.how === 'forced') return `📌 ${label} — ${str.youChose(r.model)}`
  if (r.keptFrom) return `⚙ ${label} — ${str.keptOn(LABEL[r.model])}`
  return `⚙ ${label}${r.reason ? ` — ${r.reason}` : ''}${r.trail.length > 0 ? ` (${str.raisedFrom(LABEL[TIER_ROUTE[r.tier].model])})` : ''}`
}

async function pinCommand($: EngineInterface, lang: Lang, arg: string, mainRouting: boolean): Promise<string> {
  const str = STR[lang]
  if (arg === 'unpin') {
    if (!pin) return str.notPinned
    pin = null
    thanks = undefined
    redraw($)
    return str.unpinned
  }
  if (!mainRouting) return str.pinNeedsRouting
  const m = /^pin\s+(haiku|sonnet|opus)(?:\s+(\d{1,3}))?$/i.exec(arg)
  const left = m?.[2] === undefined ? undefined : Number(m[2])
  if (!m || left === 0) return str.usage
  const model = m[1]!.toLowerCase() as ModelKey
  pin = left === undefined ? { model } : { model, left }
  thanks = undefined
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
  prefsChanges++
  let saved = false
  await bookkeeping($, async () => { await (value === 'default' ? $.store.delete('pacing') : $.store.set('pacing', value)); saved = true }, undefined, retryFor(session, 'pacing write'))
  const now = await $.clock.now()
  if (await stillHere($, session) !== 'same') return str.checkpointCancelled
  prefSaved('pacing', saved)
  publishStatus($)
  redraw($)
  await paceNotice($, session, now)
  return (value === 'default' ? str.pacingDefault(pacingMode()) : str.pacingSet(value)) + (saved ? '' : ` ${str.pacingNotSaved}`)
}

// The legacy shared key and every session's daily keys.
const isCorrectionsKey = (key: string) => key === 'corrections' || /^corrections:\d{8}:/.test(key)

// Every stored correction, merged across sessions and the legacy key: oldest first, the newest MAX_CORRECTIONS.
async function allCorrections($: EngineInterface): Promise<Correction[]> {
  const all: Correction[] = []
  for (const key of await $.store.keys()) {
    if (isCorrectionsKey(key)) all.push(...readCorrections(await $.store.get(key)))
  }
  return all.sort((a, b) => a.at - b.at).slice(-MAX_CORRECTIONS)
}

async function correctionsCommand($: EngineInterface, session: Session, lang: Lang, arg: string): Promise<string> {
  const str = STR[lang]
  if (/^corrections\s+clear$/.test(arg)) {
    // In the corrections write queue: a correction already being written in this process lands first and is deleted
    // with the rest, rather than writing the old list back after the clear. Another open window can still write
    // between the listing and the deletes, so the keys are listed again: what reappeared is deleted once more, and
    // cleared is claimed only when a last listing finds none.
    let outcome = 'failed' as 'cleared' | 'partial' | 'failed'
    await serial($, session, 'corrections', async () => {
      const left = async () => (await $.store.keys()).filter(isCorrectionsKey)
      for (let pass = 0; pass < 2; pass++) {
        for (const key of await left()) await $.store.delete(key)
      }
      outcome = (await left()).length === 0 ? 'cleared' : 'partial'
    })
    return outcome === 'cleared' ? str.correctionsCleared : outcome === 'partial' ? str.correctionsClearPartial : str.correctionsClearFailed
  }
  if (arg !== 'corrections') return str.usage
  const list = await bookkeeping($, () => allCorrections($), [] as Correction[], retryFor(session, 'corrections read'))
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

// What a configured full model id answers, asked at most once a day per id. Only model_not_found is 'missing': any other
// failure (overloaded, a timeout, no network) is 'unknown' and not stored, so the configured id stays and the next
// session asks again. A retired id would otherwise fail every request routed to its tier.
type Probe = 'ok' | 'missing' | 'unknown'
async function modelProbe($: EngineInterface, session: Session, id: string): Promise<Probe> {
  const now = await $.clock.now()
  const key = `probe:${id}`
  const seen = (await $.store.get(key)) as { ok: boolean; at: number } | undefined
  if (await stillHere($, session) !== 'same') return 'unknown'
  if (seen && now - seen.at < PROBE_EVERY_MS) return seen.ok ? 'ok' : 'missing'
  let found: Probe = 'unknown'
  try {
    const r = await $.model.complete({ model: id, prompt: 'Reply with OK.', maxTokens: 5, timeoutMs: 15000 })
    if (await stillHere($, session) !== 'same') return 'unknown'
    // On the day and the total only: the probe is nobody's turn, and it may land while one is running.
    await recordReplay($, session, r.usage, id)
    found = r.isAnswered ? 'ok' : r.reason === 'api-error' && r.error === 'model_not_found' ? 'missing' : 'unknown'
  } catch {
    found = 'unknown'
  }
  if (found === 'unknown' || await stillHere($, session) !== 'same') return found
  await $.store.set(key, { ok: found === 'ok', at: now })
  return found
}

// Run in the background at session start (only while the router is on), never awaited by a turn: until it settles the
// configured ids are used. One probe per distinct full id; a tier whose id is missing moves to its family alias in `ids`
// (in place, so every consumer follows), with one toast and one count. A Fable id is not probed: the plugin never runs
// Fable by its own hand, so the call would only spend.
async function probeTiers($: EngineInterface, session: Session, lang: Lang, configured: Record<ModelKey, string>, ids: Record<ModelKey, string>) {
  const probes = new Map<string, Promise<Probe>>()
  await Promise.all(MODELS.map(async tier => {
    const id = configured[tier]
    if (isAlias(id) || isFable(id)) return
    if (!probes.has(id)) probes.set(id, bookkeeping($, () => modelProbe($, session, id), 'unknown' as Probe, retryFor(session, `probe ${id}`)))
    if (await probes.get(id) !== 'missing' || !here(session) || ids[tier] !== id) return
    const alias = withSuffixOf(tier, id)
    ids[tier] = alias
    await count($, session, c => ({ ...c, modelFallbacks: (c.modelFallbacks ?? 0) + 1 }))
    try {
      $.ui.toast(STR[lang].modelFallback(id, alias))
    } catch {
      // A missing toast surface must not undo the fallback.
    }
  }))
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
      `${latencySummary(c.classifierLatency, c.classifierMsTotal ?? 0, c.classifierTimed ?? 0)}. ` +
      `Escalations to max effort: ${c.maxEffort ?? 0}. ` +
      `Compactions at idle (cache warm): ${c.idleCompactions ?? 0}. ` +
      `Compactions at the context cap: ${c.capCompactions ?? 0}. ` +
      `${STR[lang].checkpointCount(c.checkpointCompactions ?? 0)} ` +
      `${STR[lang].reductions(c.outputReductions ?? 0, c.outputCharsRemoved ?? 0)} ` +
      `Cache rewrites after the TTL (100k+ tokens): ${c.cacheExpiryRewrites ?? 0}, costing ${fmtUsd(c.cacheExpiryRewriteCost ?? 0)}. ` +
      `Routing corrections recorded: manual ${c.correctionsManual ?? 0} · escalate ${c.correctionsEscalate ?? 0}. ` +
      `Unsure decisions steered to execute by weekly pacing: ${c.pacingSteered ?? 0}. ` +
      `Risky actions raised from lookup to Sonnet: ${c.riskFloors ?? 0}. ` +
      `Configured model ids not found, run on the alias instead: ${c.modelFallbacks ?? 0}.`,
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
    return [n === undefined ? str.unknownContext : `${str.ctx}: ${fmtTokens(n)} tokens`,
      rows?.length ? `${str.categories}:\n${rows.map(r => `${r.name}: ≈${fmtTokens(r.tokens)}`).join('\n')}` : str.noBreakdown,
    ].join('\n\n')
  } catch {
    const n = contextReading().tokens
    return [n === undefined ? str.unknownContext : `${str.ctx}: ${fmtTokens(n)} tokens`, str.noBreakdown].join('\n\n')
  }
}

// A tier whose configured id fell back to its alias (probeTiers) shows both: the person set one id and runs on another.
function modelSetting(lang: Lang, configured: string, running: string): string {
  return running === configured ? configured : `${configured} ${STR[lang].modelNotFound(running)}`
}

async function statusScreen($: EngineInterface, session: Session, lang: Lang, settings: Record<string, unknown>, compaction: string, configured: Record<ModelKey, string>, ids: Record<ModelKey, string>): Promise<string> {
  const str = STR[lang]
  const models = { haikuModel: modelSetting(lang, configured.haiku, ids.haiku), sonnetModel: modelSetting(lang, configured.sonnet, ids.sonnet), opusModel: modelSetting(lang, configured.opus, ids.opus) }
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
    ...Object.entries({ ...settings, ...models }).map(([key, value]) => `${key}: ${value === '' ? '""' : String(value)}`),
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
  // The family aliases by default: the engine resolves each to the newest model of its family, so a model release or
  // retirement needs no change here. A full id pins one model; probeTiers checks that it still exists.
  const ids: Record<ModelKey, string> = {
    haiku: String(options.haikuModel ?? 'haiku'),
    sonnet: String(options.sonnetModel ?? 'sonnet'),
    opus: String(options.opusModel ?? 'opus'),
  }
  // What the options said, before any fallback: probeTiers moves a missing id's tier (ids) to its alias, in place, so
  // every consumer of ids follows.
  const configured = { ...ids }
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
  // On (the default): corrections are recorded (an evaluation set, never sent to the classifier) and a manual one pins
  // the session to the right model. Off: none are written and nothing is pinned by them.
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
    learnFromCorrections: learning, weeklyPacing: pacingOption,
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
    // Registered before the session lookup and whatever it returns: session.start fires once per process, and again only
    // on an enable, a worker respawn or a reload (never on /clear), so a lookup that loses a race or sits in its backoff
    // must not leave /model-router and escalate missing until then.
    // Registering again replaces, and every command and tool call resolves its own session.
    await $.command.register({
      name: 'model-router',
      description: str.commandDescription,
      argumentHint: '[stats|status|context|checkpoint [note]|on|off|history|pin <model> [turns]|unpin|wrong <tier>|corrections [clear]|pacing [mode]]',
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
    const session = await useSession($)
    if (!here(session)) return next(e)
    const stored = await bookkeeping($, () => $.store.get('enabled'), compactEnabled, retryFor(session, 'enabled read'))
    if (await stillHere($, session) !== 'same') return next(e)
    compactEnabled = stored !== false
    await update($, enabled, () => compactEnabled)
    // Not awaited: a probe can take up to 15 s and must hold up neither the start nor a turn. Not while the router is off:
    // then no tier is routed to, so there is nothing to check and nothing to spend on.
    if (compactEnabled) void probeTiers($, session, lang, configured, ids).catch(err => storeFailure($, err))
    const now = await $.clock.now()
    await bookkeeping($, () => prune($, now), undefined)
    if (await stillHere($, session) !== 'same') return next(e)
    try {
      const usage = await $.session.usage()
      if (await stillHere($, session) !== 'same') return next(e)
      rateLimits = usage.rateLimits
      measuredContext = usage.context.tokens
      if (usage.context.window > 0) contextWindow = usage.context.window
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
    await paceNotice($, session, now)
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
    if (/^replay(?:\s|$)/.test(arg)) {
      if (runningMain !== null) return { text: str.replayBusy }
      if (replayRunning) return { text: str.replayRunning }
      replayRunning = true
      try {
        return { text: await runReplay($, session, lang, arg.slice('replay'.length)) }
      } finally {
        replayRunning = false
      }
    }
    if (arg === 'stats' || arg === '' || arg === 'status') {
      const isOn = await read($, enabled)
      if (await stillHere($, session) !== 'same') return { text: str.checkpointCancelled }
      const compaction = `Compaction in this session: ${isOn ? 'router on' : 'router off, so no automatic compaction runs'} · ${compactionText}`
      return { text: arg === 'status' ? await statusScreen($, session, lang, settings, compaction, configured, ids) : await statsText($, session, lang, compaction) }
    }
    if (arg === 'context') return { text: await contextText($, session, lang, e.presentation?.columns ?? 80) }
    if (arg === 'history') return { text: await historyCommand($, session, lang) }
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
    if (typeof e.context.window === 'number' && e.context.window > 0) contextWindow = e.context.window
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
      const cost = fmtUsd((warm!.context * (priceOf(r.model, warm!.context).write + priceOf('opus', warm!.context).write)) / 1e6)
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
        if (!pin) thanks = undefined
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
    } else {
      let inherited = false
      if (mainRouting && (await read($, enabled))) {
        // A turn without a person prompt (a task notification, an agent message, a scheduled prompt) is never
        // classified. While the previous route's cache is warm it continues that route: left on the session model it
        // would switch away from, and back to, the model the cache is on. Without a previous route it stays unrouted.
        const prev = routed(await read($, memberOf(route, { requestId: session.stateId })))
        const now = await $.clock.now()
        if (await stillHere($, session) !== 'same') return next(e)
        if (prev && last && now - last.at <= CACHE_TTL_MS) {
          inherited = true
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
      if (!inherited) {
        // Unrouted: the turn tally may still hold the previous turn (no person prompt reset it), so this turn's record
        // counts only what it adds.
        turnSteps = 0
        turnOutput = 0
        const before = await bookkeeping($, () => read($, memberOf(meter, { requestId: session.stateId })), undefined)
        if (await stillHere($, session) !== 'same') return next(e)
        turnBase = { tokens: before?.turn.tokens ?? 0, cost: before?.turn.cost ?? 0 }
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
    // A tiered subagent's own model and effort; an inheriting one keeps what the engine resolved. An agent pinned to a
    // configured id before the probe moved that tier to its alias (startOf copied the id) follows the tier: the id is
    // missing, so every step on it would fail. A caller-pinned model (sub.model undefined) is untouched.
    if (sub) {
      if (sub.model !== undefined) {
        const fellBack = sub.model === configured[sub.tier] && ids[sub.tier] !== configured[sub.tier]
        model = withSuffixOf(fellBack ? ids[sub.tier] : sub.model, e.model)
      }
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
          const cost = (u.cache_creation_input_tokens * priceOf(key, promptOf(u)).write) / 1e6
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
  // inherits the parent. Never above the parent (except a risky task under a Haiku parent, which runs on Sonnet; see
  // decideSpawn), never Fable; forks and workflow agents are left alone.
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
    // The code risk check on the task itself: under a Haiku parent it is what lets a risky task run on Sonnet.
    const risky = needsClassifier(e) && isRisky(redact(e.prompt).slice(0, 6000))
    const d = decideSpawn(e, ok?.tier ?? null, ok?.sure ?? true, blockFable, risky)
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
        const started = startOf(ran.model, e.parentModel, model !== undefined, ids, model === undefined && isCallerPin(e.model), d?.ceiling)
        // An effort the caller set explicitly is kept, router pin or not; the hard cap (high) still applies per step.
        const explicit = askedEffort.get(e.tool_use_id)
        const s = explicit === undefined ? started : { ...started, effort: capSent(explicit) as Effort }
        agents.set(ran.agentId, s)
        // A failed classification keeps today's fallback (sonnet) and says why.
        const said = failureText !== undefined && d?.reason ? d.reason.replace('classifier failed', `classifier failed (${failureText})`) : d?.reason
        const why = d?.ceiling !== undefined ? `${said ?? ''}${STR[lang].riskAboveParent}`.trim() : said
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
    // A main turn this lifetime saw start: it gets a turn record, routed or not.
    const ran = e.agentId === undefined && runningMain === e.turnId
    if (ran) runningMain = null
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
    // undefined: the route could not be read (null: there is none).
    const r = await bookkeeping<Route | null | undefined>($, () => read($, memberOf(route, { requestId: session.stateId })), undefined)
    if (await stillHere($, session) !== 'same' || stale(epoch)) return done
    if (e.agentId === undefined && r && r.turnId === e.turnId && turnSteps > 0) {
      // A slow average of the turn's shape feeds the warm-cache decision.
      const prev = ((await bookkeeping($, () => $.store.get('shape'), undefined, retryFor(session, 'shape read'))) as Shape | undefined) ?? { steps: 3, output: 800 }
      if (await stillHere($, session) !== 'same' || stale(epoch)) return done
      const output = turnOutput / turnSteps
      await bookkeeping($, () => $.store.set('shape', { steps: prev.steps * 0.8 + turnSteps * 0.2, output: prev.output * 0.8 + output * 0.2 }), undefined, retryFor(session, 'shape write'))
      if (await stillHere($, session) !== 'same' || stale(epoch)) return done
    }
    // New with 1.1.0, after everything main did before it: the record of this turn that history lists.
    if (e.agentId === undefined && r && r.turnId === e.turnId) await writeTurnRecord($, session, r, e.turnId)
    // A main turn the route did not govern (a notification after the cache TTL, main routing off) is listed too, as
    // unrouted: otherwise an older turn looks like the last reply and its buttons correct the wrong one. Not while the
    // router is paused: nothing was metered then.
    else if (ran && r !== undefined && await read($, enabled)) {
      if (await stillHere($, session) !== 'same' || stale(epoch)) return done
      await writeTurnRecord($, session, null, e.turnId)
    }
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

  // /model-router history draws its details inline in the transcript; every other model-router command keeps the
  // engine's own row. A surface that cannot draw the tree shows the command's plain text instead.
  // The band above the prompt: what the router chose and what it costs, in plain words. Details open with a click.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const session = await useSession($)
    if (!here(session)) return next(e)
    const below = await next(e)
    if (await stillHere($, session) !== 'same') return below
    if (e.props.hasSurvey) return below
    const now = await $.clock.now()
    await ensurePrefs($, session, now)
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    if (await stillHere($, session) !== 'same') return below

    if (!(await read($, enabled))) {
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row" gap={1} alignItems="center">
            <Box flexGrow={1} flexShrink={1} width={0}>
              <Text dimColor wrap="truncate-end">⚙ {str.paused}</Text>
            </Box>
            <Button key="router-enable" label={str.enable} onPress={() => setEnabled($, session, true)} />
          </Box>
          {below}
        </Box>
      )
    }

    const r = await bookkeeping($, () => read($, memberOf(route, { requestId: session.stateId })), null)
    const m = await bookkeeping($, () => read($, memberOf(meter, { requestId: session.stateId })), { turn: EMPTY, today: session.today ?? EMPTY })
    const expanded = bandExpanded
    const list = expanded ? await bookkeeping($, () => read($, memberOf(turns, { requestId: session.stateId })), [] as TurnRecord[]) : []
    // The week behind the chart is read when the details open, the day turns or a turn was recorded, not per redraw; other
    // spend recorded since is read at most every DETAILS_REFRESH_MS.
    if (expanded) {
      const key = list.at(-1)?.turnId ?? ''
      const spent = accounting
      if (weekCache === undefined || weekCache.day !== dayKey(now) || weekCache.key !== key ||
        (weekCache.accounting !== spent && now - weekCache.at >= DETAILS_REFRESH_MS)) {
        const series = await bookkeeping($, () => weekSeries($, session, now), undefined, retryFor(session, 'band week'))
        const mine = series === undefined ? undefined : await bookkeeping<Tally | undefined>($, () => sessionTally($, session), undefined, retryFor(session, 'band session'))
        if (series !== undefined && mine !== undefined && await stillHere($, session) === 'same') {
          weekCache = { day: dayKey(now), key, at: now, accounting: spent, series, sessionTokens: mine.tokens, todayTokens: series.find(d => d.day === dayKey(now))?.tokens ?? 0 }
        }
      }
    }
    if (await stillHere($, session) !== 'same') return below

    const today = session.today ?? m.today
    const diff = saved(today).usd
    const w = weeklyLimit()
    const ahead = w !== undefined && pacingMode() !== 'off' && paceOf(w, now).state === 'ahead'
    // Row 2, in the order it is cut at narrow widths: the comparison goes first, then the week, then the context, and
    // today's tokens only when nothing else is left to cut.
    const tokens = contextReading().tokens
    const warnAt = Math.min(contextWindow ? contextWindow * 0.8 : Infinity, capOn ? compactAtContext : Infinity)
    const contextPart = tokens === undefined ? undefined : { text: str.contextPart(compactTokens(tokens), contextWindow ? compactTokens(contextWindow) : undefined), warn: tokens >= warnAt }
    // A difference under a cent is not worth a comparison.
    const cmp = Math.abs(diff) >= 0.01 ? `${lang === 'zh' ? '' : ' '}${(diff >= 0 ? str.cmpLess : str.cmpMore)(fmtUsd(Math.abs(diff)))}` : ''
    type Seg = { text: string; warn?: boolean }
    const row = (withCmp: boolean, withWeek: boolean, withContext: boolean, withTokens: boolean): Seg[] => [
      { text: `${str.thisReply} ${plainUsd(lang, m.turn.cost)}` },
      { text: ` · ${str.todayWord} ${withTokens ? `${str.todayTokens(fmtTokens(today.tokens))} · ` : ''}${plainUsd(lang, today.cost)}${withCmp ? cmp : ''}` },
      ...(withContext && contextPart ? [{ text: ` · ${contextPart.text}`, warn: contextPart.warn }] : []),
      ...(withWeek && w ? [{ text: ` · ${str.week(String(w.percentUsed))}` }] : []),
      ...(withWeek && w && ahead ? [{ text: str.aheadOfPace, warn: true }] : []),
    ]
    const room = e.props.bodyColumns - 2
    const wide = (segs: Seg[]) => segs.reduce((sum, sg) => sum + cellWidth(sg.text), 0)
    // Whole parts only: the first arrangement that fits, else the shortest.
    const costSegs = [row(true, true, true, true), row(false, true, true, true), row(false, false, true, true), row(false, false, false, true), row(false, false, false, false)]
      .find(segs => wide(segs) <= room) ?? row(false, false, false, false)
    const cache = cacheWarning(lang, now, compactMinContext > 0 ? compactMinContext : 100_000)

    // The terminal's table has no Svg (it would draw a fragment: nothing): it gets a labelled text chart instead.
    const Svg = e.surface === 'terminal' ? undefined : (table as unknown as { Svg?: ElementConstructor<SvgProps> }).Svg
    const shown = list.slice(-BAND_ROWS)
    const series = weekCache?.series ?? []
    const chart = Svg === undefined && series.length > 0 ? textChart(series, e.props.bodyColumns - 2, lang) : undefined
    const total = weekTotals(chart?.days ?? series)
    const tokensLine = weekCache === undefined ? '' : str.tokensUsed(fmtTokens(weekCache.sessionTokens), fmtTokens(weekCache.todayTokens), fmtTokens(series.reduce((sum, d) => sum + d.tokens, 0)))
    // The question is about the last reply: asked only when the newest turn shown is one a correction can apply to.
    const newest = shown.at(-1)
    const target = learning && newest !== undefined && isCorrectable(newest) ? newest : undefined
    // Each button names a model and corrects to that model's tier. Hidden: the model the reply ran on (a kept cache or an
    // escalation can differ from the tier's), and the classified tier's own, which a correction refuses as unchanged.
    const answers = ([['Haiku', 'lookup'], ['Sonnet', 'execute'], ['Opus', 'decide']] as [string, Tier][])
      .filter(([, tier]) => target !== undefined && tier !== target.tier && TIER_ROUTE[tier].model !== target.model)

    return (
      <Box flexDirection="column" marginTop={1}>
        {cache !== '' && <Text color="warning" wrap="truncate-end">{cache}</Text>}
        <Box flexDirection="row" gap={1} alignItems="center">
          <Box flexGrow={1} flexShrink={1} width={0}>
            <Text dimColor wrap="truncate-end">{bandRoute(lang, r, mainRouting)}</Text>
          </Box>
          <Button key="band-details" label={expanded ? str.hideDetails : str.details} onPress={() => toggleDetails($, session)} />
          <Button key="router-disable" label={str.disable} onPress={() => setEnabled($, session, false)} />
        </Box>
        <Box paddingLeft={2}>
          <Text dimColor wrap="truncate-end">{costSegs.map((sg, i) => sg.warn ? <Text key={`cost-${i}`} color="warning">{sg.text}</Text> : sg.text)}</Text>
        </Box>
        {expanded && (
          <Box flexDirection="column" paddingLeft={2}>
            {contextLine(lang, now) !== '' && <Text dimColor wrap="truncate-end">{contextLine(lang, now)}</Text>}
            {tokensLine !== '' && <Text dimColor wrap="truncate-end">{tokensLine}</Text>}
            {shown.length === 0 && <Text dimColor>{str.histNone}</Text>}
            {shown.map(t => {
              const p = turnParts(t, lang)
              return (
                <Box key={t.turnId} flexDirection="row" gap={2}>
                  <Box flexShrink={0}>
                    <Text dimColor>{p.time}</Text>
                  </Box>
                  <Box flexShrink={0}>
                    <Text color={TURN_COLOR[t.model]}>{p.label}</Text>
                  </Box>
                  <Box flexGrow={1} flexShrink={1} width={0}>
                    <Text dimColor wrap="truncate-end">{`${p.cost}${p.markers ? ` ${p.markers}` : ''}${p.why ? ` — ${p.why}` : ''}`}</Text>
                  </Box>
                </Box>
              )
            })}
            {series.length > 0 && <Text dimColor wrap="truncate-end">{str.chartTitle((chart?.days ?? series).length)}</Text>}
            {series.length > 0 && Svg && <Svg source={barChartSvg(series, 320, 80, series.map(d => weekdayOf(d.day, lang)))} alt={chartAlt(series)} />}
            {chart && <Text dimColor>{`  ${chart.amounts.join('')}`}</Text>}
            {chart && <Text dimColor>{`  ${chart.bars.join('')}`}</Text>}
            {chart && (
              <Box flexDirection="row">
                <Text dimColor>{'  '}</Text>
                {chart.labels.map((label, i) => i === chart.today ? <Text key={`day-${i}`} weight="bold" color="claude">{label}</Text> : <Text key={`day-${i}`} dimColor>{label}</Text>)}
              </Box>
            )}
            {series.length > 0 && <Text dimColor wrap="truncate-end">{str.chartTotal(fmtUsd(total.cost), fmtUsd(total.base))}</Text>}
            {target && thanks?.turnId === target.turnId && <Text dimColor>{str.thanks(LABEL[thanks.model]) + thanks.note}</Text>}
            {target && thanks?.turnId !== target.turnId && (
              <Box flexDirection="row" gap={1} alignItems="center">
                <Text dimColor>{str.wrongAsk}</Text>
                {answers.map(([name, tier]) => (
                  <Button key={`wrong-${tier}`} label={name} onPress={() => pressWrong($, session, lang, tier, target.turnId)} />
                ))}
              </Box>
            )}
            <Text dimColor wrap="truncate-end">{str.footer}</Text>
          </Box>
        )}
        {below}
      </Box>
    )
  })
}
