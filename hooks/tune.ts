import type { ModelKey, Tier } from '../types'
import { priceOf } from './meter'
import { pickTier, RISK_BAR, TIER_BARS } from './route'
import type { Lang, Probs } from './route'

// What one classified main turn decided, kept per day in the store (calib:YYYYMMDD:<session>) for /model-router tune. It
// holds the classifier's numbers and the outcomes that followed, never the prompt. turnId only lets an outcome find its
// record. tier and sure are the pick the bars made; right is a correction, escalatedTo a later move to a higher model.
export type Calib = {
  at: number
  turnId: string
  p: Probs
  risk: number
  tier: Tier
  sure: boolean
  guard?: 'risk'
  right?: Tier
  escalatedTo?: ModelKey
}

export const CALIB_KEY = /^calib:(\d{8}):/

// The most one apply may move a bar, and the range a bar may ever take.
export const STEP_MAX = 0.05
export const BAR_MIN = 0.2
export const BAR_MAX = 0.95
// Fewer labelled turns than this and no bars are suggested.
export const MIN_LABELLED = 30
// A cost proxy, one unit for the cheapest: a main turn's cost is mostly cache reads of a large conversation, so each
// tier is weighed by its model's cache-read price at a 200k-token context (Haiku's long-prompt tier applies there).
const PROXY_CONTEXT = 200_000
const READ = { haiku: priceOf('haiku', PROXY_CONTEXT).read, sonnet: priceOf('sonnet', PROXY_CONTEXT).read, opus: priceOf('opus', PROXY_CONTEXT).read }
export const COST: Record<Tier, number> = { lookup: 1, execute: READ.sonnet / READ.haiku, decide: READ.opus / READ.haiku }

const TIERS: Tier[] = ['lookup', 'execute', 'decide']
const RANK: Record<Tier, number> = { lookup: 0, execute: 1, decide: 2 }
const MODEL_TIER: Record<ModelKey, Tier> = { haiku: 'lookup', sonnet: 'execute', opus: 'decide' }

const isTier = (x: unknown): x is Tier => x === 'lookup' || x === 'execute' || x === 'decide'
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const round2 = (x: number) => Math.round(x * 100) / 100

// A stored override, or nothing when it is not three numbers in the allowed range.
export function readBars(raw: unknown): Probs | undefined {
  const o = raw as Record<string, unknown> | null
  if (typeof o !== 'object' || o === null) return undefined
  const bars = { lookup: o.lookup, execute: o.execute, decide: o.decide }
  return isNum(bars.lookup) && isNum(bars.execute) && isNum(bars.decide) &&
    TIERS.every(t => (bars[t] as number) >= BAR_MIN && (bars[t] as number) <= BAR_MAX)
    ? { lookup: bars.lookup, execute: bars.execute, decide: bars.decide }
    : undefined
}

// A day's stored records; anything malformed is dropped.
export function readCalib(raw: unknown): Calib[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is Calib => {
    const c = x as Calib | null
    return typeof c === 'object' && c !== null && isNum(c.at) && typeof c.turnId === 'string' && isTier(c.tier) &&
      typeof c.sure === 'boolean' && isNum(c.risk) && typeof c.p === 'object' && c.p !== null &&
      isNum(c.p.lookup) && isNum(c.p.execute) && isNum(c.p.decide)
  })
}

// One turn with a known right tier: what the classifier said, and what it should have been.
export type Sample = { p: Probs; risk: number; right: Tier }

export type Evaluation = { n: number; accuracy: number; under: number; over: number; cost: number }

// Rates over the samples: right, routed below the right tier (under), routed above it (over), and the mean cost proxy.
export function evaluate(samples: readonly Sample[], bars: Probs, riskBar: number = RISK_BAR): Evaluation {
  let right = 0
  let under = 0
  let over = 0
  let cost = 0
  for (const s of samples) {
    const t = pickTier(s.p, s.risk, bars, riskBar).tier
    if (t === s.right) right++
    else if (RANK[t] < RANK[s.right]) under++
    else over++
    cost += COST[t]
  }
  const n = samples.length
  return n === 0 ? { n, accuracy: 0, under: 0, over: 0, cost: 0 } : { n, accuracy: right / n, under: under / n, over: over / n, cost: cost / n }
}

const GRID: number[] = Array.from({ length: Math.round((BAR_MAX - BAR_MIN) / STEP_MAX) + 1 }, (_, i) => round2(BAR_MIN + i * STEP_MAX))

// The bars on a 0.05 grid with the lowest cost proxy whose under-routing rate does not exceed the current bars' own. The
// current bars are always a candidate, so the answer is never worse than they are on under-routing. Ties: lower
// under-routing, then nearer the current bars, then the lower bars.
export function fitBars(samples: readonly Sample[], current: Probs, riskBar: number = RISK_BAR): { bars: Probs; current: Evaluation; suggested: Evaluation } {
  const now = evaluate(samples, current, riskBar)
  let best = { bars: current, ev: now, dist: 0 }
  const candidates: Probs[] = []
  for (const lookup of GRID) for (const execute of GRID) for (const decide of GRID) candidates.push({ lookup, execute, decide })
  for (const bars of candidates) {
    const ev = evaluate(samples, bars, riskBar)
    if (ev.under > now.under + 1e-12) continue
    const dist = Math.abs(bars.lookup - current.lookup) + Math.abs(bars.execute - current.execute) + Math.abs(bars.decide - current.decide)
    const better = ev.cost < best.ev.cost - 1e-12 ||
      (Math.abs(ev.cost - best.ev.cost) <= 1e-12 && (ev.under < best.ev.under - 1e-12 ||
        (Math.abs(ev.under - best.ev.under) <= 1e-12 && dist < best.dist - 1e-12)))
    if (better) best = { bars, ev, dist }
  }
  return { bars: best.bars, current: now, suggested: best.ev }
}

// One apply: each bar moves toward the suggestion by at most STEP_MAX, and stays inside [BAR_MIN, BAR_MAX].
export function stepBars(current: Probs, suggested: Probs): Probs {
  const one = (t: Tier) => {
    const delta = Math.max(-STEP_MAX, Math.min(STEP_MAX, suggested[t] - current[t]))
    return round2(Math.max(BAR_MIN, Math.min(BAR_MAX, current[t] + delta)))
  }
  return { lookup: one('lookup'), execute: one('execute'), decide: one('decide') }
}

export type LabelRow = { id: string; right: Tier }
export type ReplayRowLike = { id: string; variant: string; ok: boolean; p?: Probs; risk?: number }

// --labels: a JSON array of { id, right }. Anything else is refused with the reason.
export function parseLabels(text: string): { ok: true; labels: LabelRow[] } | { ok: false; why: string } {
  let data: unknown
  try { data = JSON.parse(text) } catch { return { ok: false, why: 'labels file is not valid JSON' } }
  if (!Array.isArray(data)) return { ok: false, why: 'labels file is not a JSON array' }
  const labels: LabelRow[] = []
  for (const [i, x] of data.entries()) {
    const o = x as Record<string, unknown> | null
    if (typeof o !== 'object' || o === null || !isTier(o.right) || !(typeof o.id === 'string' || typeof o.id === 'number')) return { ok: false, why: `labels item ${i} needs an id and a right tier` }
    labels.push({ id: String(o.id), right: o.right })
  }
  return { ok: true, labels }
}

// --replay: the results file /model-router replay wrote; only answered rows of the plain current variant have p and risk to join.
export function parseReplayResults(text: string): { ok: true; rows: ReplayRowLike[] } | { ok: false; why: string } {
  let data: unknown
  try { data = JSON.parse(text) } catch { return { ok: false, why: 'replay file is not valid JSON' } }
  if (!Array.isArray(data)) return { ok: false, why: 'replay file is not a JSON array' }
  return { ok: true, rows: data.filter((r): r is ReplayRowLike => typeof r === 'object' && r !== null && typeof (r as ReplayRowLike).id === 'string') }
}

export type Labelled = { samples: Sample[]; fromCorrections: number; fromReplay: number }

// The labelled turns: corrections the router recorded, plus labels joined to replay rows by id. A label with no answered
// replay row of the current variant is left out.
export function labelledSamples(calib: readonly Calib[], labels: readonly LabelRow[] = [], replay: readonly ReplayRowLike[] = []): Labelled {
  const samples: Sample[] = []
  let fromCorrections = 0
  for (const c of calib) {
    if (c.right === undefined) continue
    samples.push({ p: c.p, risk: c.risk, right: c.right })
    fromCorrections++
  }
  const byId = new Map(replay.filter(r => r.variant === 'current' && r.ok && r.p !== undefined && r.risk !== undefined).map(r => [r.id, r]))
  let fromReplay = 0
  for (const l of labels) {
    const r = byId.get(l.id)
    if (!r) continue
    samples.push({ p: r.p!, risk: r.risk!, right: l.right })
    fromReplay++
  }
  return { samples, fromCorrections, fromReplay }
}

export type Plan = { enough: boolean; labelled: number; need: number; fit?: ReturnType<typeof fitBars> }

export function planFor(labelled: Labelled, current: Probs, riskBar: number = RISK_BAR): Plan {
  const n = labelled.samples.length
  if (n < MIN_LABELLED) return { enough: false, labelled: n, need: MIN_LABELLED - n }
  return { enough: true, labelled: n, need: 0, fit: fitBars(labelled.samples, current, riskBar) }
}

export function isTuned(bars: Probs): boolean {
  return TIERS.some(t => bars[t] !== TIER_BARS[t])
}

export function barsLine(bars: Probs, riskBar: number = RISK_BAR): string {
  return `lookup ${bars.lookup} · execute ${bars.execute} · decide ${bars.decide} · risk ${riskBar}`
}

const TEXT = {
  en: {
    head: (n: number) => `Classifier calibration: ${n} classified turn${n === 1 ? '' : 's'} recorded in the last 30 days.`,
    tier: (t: Tier, n: number, fixed: number, esc: number) => `${t}: ${n} routed · corrected ${fixed} (${pct(fixed, n)}) · escalated to a higher model ${esc} (${pct(esc, n)})`,
    weak: 'Weak signal: escalations are not proof the tier was wrong.',
    bars: (b: string, tuned: boolean) => `Bars (${tuned ? 'tuned' : 'default'}): ${b}`,
    labelled: (n: number, c: number, r: number) => `Labelled turns: ${n} (corrections ${c}, labels joined to a replay ${r}).`,
    notEnough: (n: number, need: number) => `Not enough labelled turns to suggest bars: ${n} of ${MIN_LABELLED}, ${need} more needed. Correct routes with /model-router wrong, or pass --labels <file> and --replay <file>.`,
    cols: 'current → suggested',
    rows: { accuracy: 'accuracy', under: 'under-routing', over: 'over-routing', cost: 'cost proxy (current = 100%)' },
    suggested: (b: string) => `Suggested bars: ${b}`,
    bias: 'Labels from corrections alone are only the turns that were wrong, so they lean toward under-routing; labels joined to a replay are not biased that way.',
    howApply: 'Nothing has changed. /model-router tune apply moves each bar toward these by at most 0.05; /model-router tune reset restores the defaults.',
    same: 'The current bars are already the best on this data.',
  },
  zh: {
    head: (n: number) => `分类器校准：最近 30 天记录了 ${n} 个已分类的轮次。`,
    tier: (t: Tier, n: number, fixed: number, esc: number) => `${t}：路由 ${n} 次 · 被纠正 ${fixed}（${pct(fixed, n)}）· 升级到更高模型 ${esc}（${pct(esc, n)}）`,
    weak: '弱信号：升级并不能证明档位判错了。',
    bars: (b: string, tuned: boolean) => `阈值（${tuned ? '已调整' : '默认'}）：${b}`,
    labelled: (n: number, c: number, r: number) => `已标注轮次：${n}（纠正 ${c}，与回放关联的标注 ${r}）。`,
    notEnough: (n: number, need: number) => `已标注的轮次不足，无法给出阈值建议：${n}/${MIN_LABELLED}，还需 ${need} 个。可用 /model-router wrong 纠正路由，或传入 --labels <文件> 和 --replay <文件>。`,
    cols: '当前 → 建议',
    rows: { accuracy: '准确率', under: '偏低路由', over: '偏高路由', cost: '成本代理（当前 = 100%）' },
    suggested: (b: string) => `建议阈值：${b}`,
    bias: '仅来自纠正的标注只包含判错的轮次，会偏向“偏低路由”；与回放关联的标注没有这种偏差。',
    howApply: '尚未更改任何设置。/model-router tune apply 会让每个阈值朝建议值移动，每次最多 0.05；/model-router tune reset 恢复默认值。',
    same: '在这些数据上，当前阈值已是最优。',
  },
} as const

function pct(n: number, of: number): string {
  return of === 0 ? '0%' : `${Math.round((n / of) * 100)}%`
}

const rate = (x: number) => `${(x * 100).toFixed(1)}%`

// The /model-router tune report. It changes nothing.
export function tuneReport(lang: Lang, calib: readonly Calib[], bars: Probs, riskBar: number, labelled: Labelled, plan: Plan): string {
  const t = TEXT[lang]
  const lines = [t.head(calib.length)]
  for (const tier of TIERS) {
    const mine = calib.filter(c => c.tier === tier)
    const esc = mine.filter(c => c.escalatedTo !== undefined && RANK[MODEL_TIER[c.escalatedTo]] > RANK[tier]).length
    lines.push(t.tier(tier, mine.length, mine.filter(c => c.right !== undefined).length, esc))
  }
  lines.push(t.weak, t.bars(barsLine(bars, riskBar), isTuned(bars)), t.labelled(labelled.samples.length, labelled.fromCorrections, labelled.fromReplay))
  if (!plan.enough || !plan.fit) return [...lines, t.notEnough(plan.labelled, plan.need)].join('\n')
  const { current, suggested, bars: next } = plan.fit
  const rel = current.cost === 0 ? 1 : suggested.cost / current.cost
  lines.push(
    t.suggested(barsLine(next, riskBar)),
    t.cols,
    `  ${t.rows.accuracy}: ${rate(current.accuracy)} → ${rate(suggested.accuracy)}`,
    `  ${t.rows.under}: ${rate(current.under)} → ${rate(suggested.under)}`,
    `  ${t.rows.over}: ${rate(current.over)} → ${rate(suggested.over)}`,
    `  ${t.rows.cost}: 100% → ${Math.round(rel * 100)}%`,
  )
  if (next.lookup === bars.lookup && next.execute === bars.execute && next.decide === bars.decide) lines.push(t.same)
  lines.push(t.bias, t.howApply)
  return lines.join('\n')
}
