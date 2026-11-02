import type { Tier } from '../types'
import { redact } from './redact'
import type { Lang } from './route'

// Dev-only, for /model-router replay: the 1.1.0 classifier prompt, word for word, so a labelled file can be run through
// both and compared. Nothing in routing uses it.
export function legacyClassifierSystem(lang: Lang): string {
  return `You route a developer's message to Claude Code (an AI coding agent) to the cheapest model that can do it well.
Return ONLY one JSON object: {"tier":"lookup"|"execute"|"decide","sure":true|false,"reason":string}

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
- If a message mixes tiers, use the highest one it contains.
- When unsure between two tiers, pick the higher one.
- sure: set false when the message is ambiguous, could reasonably be read at two tiers, or depends on context you cannot
  see; otherwise true. An unsure verdict is never used to move work to a cheaper model.
- reason: ${lang === 'zh' ? 'Simplified Chinese, at most 15 字' : 'English, at most 10 words'}, says what kind of work it is.`
}

export const REPLAY_MAX_ITEMS = 500
export const REPLAY_CONCURRENCY = 4
export const REPLAY_MAX_REPEAT = 3
// After a timeout no new request starts for this long, so one slow spell does not turn into a run of timeouts.
export const REPLAY_PAUSE_MS = 3000
const RAW_CHARS = 400

export type ReplayVariant = 'current' | 'legacy'
export type ReplayItem = { id: string; message: string; context: string; previous: Tier | null }
// run: which repeat (1 to n). risk: what the code's risk detector says about the item's message (the classifier's tier is
// recorded as it came back, before the risk floor). ms: how long the call took, timeouts included.
export type ReplayRow = {
  id: string
  variant: ReplayVariant
  run: number
  ok: boolean
  raw: string
  tier?: Tier
  sure?: boolean
  risk: boolean
  ms: number
  why?: string
}

// "--name value" flags after the leading words; the value runs to the next flag, so a path may hold spaces.
export function parseFlags(rest: string): { head: string; flags: Record<string, string> } {
  const at = rest.search(/(?:^|\s)--\w+(?:\s|$)/)
  if (at === -1) return { head: rest.trim(), flags: {} }
  const flags: Record<string, string> = {}
  for (const m of rest.slice(at).matchAll(/--(\w+)\s+(.+?)(?=\s+--\w+(?:\s|$)|$)/g)) flags[m[1]!] = m[2]!.trim()
  return { head: rest.slice(0, at).trim(), flags }
}

// The arguments after "replay": a path (it may hold spaces), an optional variant after it, and --repeat <1-3>.
// null: no path, an unknown flag, or a repeat that is not a whole number from 1 to 3.
export function parseReplayArgs(rest: string): { path: string; variants: ReplayVariant[]; repeat: number } | null {
  const { head, flags } = parseFlags(rest)
  const m = /^(.*?)(?:\s+(current|legacy|both))?$/.exec(head)
  const path = m?.[1]?.trim() ?? ''
  if (path === '') return null
  if (Object.keys(flags).some(k => k !== 'repeat')) return null
  const repeat = flags.repeat === undefined ? 1 : /^\d+$/.test(flags.repeat) ? Number(flags.repeat) : NaN
  if (!(repeat >= 1 && repeat <= REPLAY_MAX_REPEAT)) return null
  const which = m?.[2] ?? 'both'
  const variants: ReplayVariant[] = which === 'both' ? ['current', 'legacy'] : [which as ReplayVariant]
  return { path, variants, repeat }
}

// Results go next to the input: labelled.json -> labelled.replay.json.
export function replayOutPath(path: string): string {
  return `${path.replace(/\.json$/i, '')}.replay.json`
}

// A file of up to 500 items { id, message, context, previous }; anything else is refused with the reason.
export function parseReplayFile(text: string): { ok: true; items: ReplayItem[] } | { ok: false; why: string } {
  let data: unknown
  try { data = JSON.parse(text) } catch { return { ok: false, why: 'not valid JSON' } }
  if (!Array.isArray(data)) return { ok: false, why: 'not a JSON array' }
  if (data.length > REPLAY_MAX_ITEMS) return { ok: false, why: `${data.length} items; at most ${REPLAY_MAX_ITEMS}` }
  const items: ReplayItem[] = []
  for (const [i, x] of data.entries()) {
    const o = x as Record<string, unknown> | null
    if (typeof o !== 'object' || o === null || typeof o.message !== 'string') return { ok: false, why: `item ${i} has no message` }
    const previous = o.previous === 'lookup' || o.previous === 'execute' || o.previous === 'decide' ? o.previous : null
    items.push({
      id: typeof o.id === 'string' || typeof o.id === 'number' ? String(o.id) : String(i),
      message: o.message,
      context: typeof o.context === 'string' ? o.context : '',
      previous,
    })
  }
  return { ok: true, items }
}

type Outcome = { ok: true; raw: string; decision: { tier: Tier; sure: boolean } } | { ok: false; raw: string; why: string }

// One result row. The raw reply is masked whole before it is cut, so a secret split by the cut is still caught.
export function replayRow(id: string, variant: ReplayVariant, run: number, risk: boolean, ms: number, o: Outcome): ReplayRow {
  const raw = redact(o.raw).slice(0, RAW_CHARS)
  if (!o.ok) return { id, variant, run, ok: false, raw, risk, ms, why: o.why }
  return { id, variant, run, ok: true, raw, tier: o.decision.tier, sure: o.decision.sure, risk, ms }
}

export function replaySummary(rows: ReplayRow[], variants: ReplayVariant[], path: string, total: number, repeat: number, risky: number): string {
  const runs = repeat === 1 ? '' : ` × ${repeat} runs`
  const lines = [`Replay of ${total} item${total === 1 ? '' : 's'}${runs} (${risky} risky by the code check): results in ${path}`]
  for (const v of variants) {
    const mine = rows.filter(r => r.variant === v)
    const ok = mine.filter(r => r.ok).length
    const picks = { lookup: 0, execute: 0, decide: 0 }
    for (const r of mine) if (r.ok) picks[r.tier!]++
    const unsure = mine.filter(r => r.ok && r.sure === false).length
    lines.push(`${v}: ${ok}/${mine.length} answered · lookup ${picks.lookup} · execute ${picks.execute} · decide ${picks.decide} · unsure ${unsure}`)
    const failed = new Map<string, number>()
    for (const r of mine) if (!r.ok) failed.set(r.why ?? 'failed', (failed.get(r.why ?? 'failed') ?? 0) + 1)
    if (failed.size > 0) lines.push(`  failures: ${[...failed].map(([why, n]) => `${why} ×${n}`).join(' · ')}`)
  }
  return lines.join('\n')
}
