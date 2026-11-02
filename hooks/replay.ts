import type { Tier } from '../types'
import { redact } from './redact'
import type { Decision, Lang, Probs } from './route'

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
const RAW_CHARS = 400

export type ReplayVariant = 'current' | 'legacy'
export type ReplayItem = { id: string; message: string; context: string; previous: Tier | null }
export type ReplayRow = {
  id: string
  variant: ReplayVariant
  ok: boolean
  raw: string
  p?: Probs
  risk?: number
  tier?: Tier
  sure?: boolean
  legacyTier?: Tier
  legacySure?: boolean
  why?: string
}

// The arguments after "replay": a path (it may hold spaces) and an optional variant after it.
export function parseReplayArgs(rest: string): { path: string; variants: ReplayVariant[] } | null {
  const m = /^(.*?)(?:\s+(current|legacy|both))?$/.exec(rest.trim())
  const path = m?.[1]?.trim() ?? ''
  if (path === '') return null
  const which = m?.[2] ?? 'both'
  return { path, variants: which === 'both' ? ['current', 'legacy'] : [which as ReplayVariant] }
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

type Outcome = { ok: true; raw: string; decision: Decision } | { ok: false; raw: string; why: string }

// One result row. The raw reply is masked whole before it is cut, so a secret split by the cut is still caught.
export function replayRow(id: string, variant: ReplayVariant, o: Outcome): ReplayRow {
  const raw = redact(o.raw).slice(0, RAW_CHARS)
  if (!o.ok) return { id, variant, ok: false, raw, why: o.why }
  const d = o.decision
  return variant === 'legacy'
    ? { id, variant, ok: true, raw, legacyTier: d.tier, legacySure: d.sure }
    : { id, variant, ok: true, raw, ...(d.p ? { p: d.p, risk: d.risk } : {}), tier: d.tier, sure: d.sure }
}

export function replaySummary(rows: ReplayRow[], variants: ReplayVariant[], path: string, total: number): string {
  const lines = [`Replay of ${total} item${total === 1 ? '' : 's'}: results in ${path}`]
  for (const v of variants) {
    const mine = rows.filter(r => r.variant === v)
    const ok = mine.filter(r => r.ok).length
    const picks = { lookup: 0, execute: 0, decide: 0 }
    for (const r of mine) if (r.ok) picks[(v === 'legacy' ? r.legacyTier : r.tier)!]++
    const unsure = mine.filter(r => r.ok && (v === 'legacy' ? r.legacySure === false : r.sure === false)).length
    lines.push(`${v}: ${ok}/${mine.length} answered · lookup ${picks.lookup} · execute ${picks.execute} · decide ${picks.decide} · unsure ${unsure}`)
    const failed = new Map<string, number>()
    for (const r of mine) if (!r.ok) failed.set(r.why ?? 'failed', (failed.get(r.why ?? 'failed') ?? 0) + 1)
    if (failed.size > 0) lines.push(`  failures: ${[...failed].map(([why, n]) => `${why} ×${n}`).join(' · ')}`)
  }
  return lines.join('\n')
}
