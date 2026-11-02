import type { Tier } from '../types'
import { redact } from './redact'
import type { Lang } from './route'

export const MAX_CORRECTIONS = 300
export const FEW_SHOT_MAX = 8
// The examples a classification gets: the most similar stored corrections, at most EXAMPLES_K, each scoring at least
// MIN_SIMILARITY (Jaccard over character n-grams). Two wordings of one task score 0.36 to 0.86 ("rename the helper in
// utils" / "rename the helper function in the utils file" 0.54) and unrelated work 0 to 0.08, so 0.12 sits just above the
// noise. Limits: a short related pair can fall under it ("find every TODO" / "grep for TODO comments" 0.10), and shared
// stop words can lift an unrelated pair to about 0.12; the tests pin both sides. Refit it with the replay's examples mode.
export const EXAMPLES_K = 6
export const MIN_SIMILARITY = 0.12
export const SNIPPET_MAX = 200

export type Correction = { at: number; text: string; routed: Tier; right: Tier; source: 'manual' | 'escalate' }

// The prompt as kept: masked, whitespace collapsed, cut. Masked before cutting so a secret split by the cut is caught.
export function snippetOf(prompt: string): string {
  return redact(prompt).replace(/\s+/g, ' ').trim().slice(0, SNIPPET_MAX)
}

// Newest last, at most MAX_CORRECTIONS; the same text again replaces the earlier entry rather than repeating it.
export function addCorrection(list: readonly Correction[], c: Correction): Correction[] {
  return [...list.filter(x => x.text !== c.text), c].slice(-MAX_CORRECTIONS)
}

// Kana, Han (with extension A and the compatibility block) and Hangul.
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]+/g

// The text as compared: masked, lowercased, whitespace collapsed.
function normalised(text: string): string {
  return redact(text).toLowerCase().replace(/\s+/g, ' ').trim()
}

// Character trigrams of the non-CJK text and bigrams of each run of CJK characters (a single character stands for
// itself), so Chinese, English and mixed messages compare without a tokenizer or a model.
export function grams(text: string): Set<string> {
  const out = new Set<string>()
  const t = normalised(text)
  let rest = ''
  let last = 0
  const flush = (chunk: string) => { rest += `${chunk} ` }
  for (const m of t.matchAll(CJK)) {
    flush(t.slice(last, m.index))
    last = m.index + m[0].length
    const run = m[0]
    if (run.length === 1) out.add(`c:${run}`)
    for (let i = 0; i + 2 <= run.length; i++) out.add(`c:${run.slice(i, i + 2)}`)
  }
  flush(t.slice(last))
  const flat = rest.replace(/\s+/g, ' ').trim()
  if (flat.length > 0 && flat.length < 3) out.add(`t:${flat}`)
  for (let i = 0; i + 3 <= flat.length; i++) out.add(`t:${flat.slice(i, i + 3)}`)
  return out
}

// Jaccard similarity of the two texts' n-gram sets, 0 to 1; two texts with no grams are not similar.
export function similarity(a: string, b: string): number {
  const x = grams(a)
  const y = grams(b)
  if (x.size === 0 || y.size === 0) return 0
  let both = 0
  for (const g of x) if (y.has(g)) both++
  return both / (x.size + y.size - both)
}

// The stored corrections most like the message: the best EXAMPLES_K scoring at least MIN_SIMILARITY, a tie going to the
// newer entry, returned oldest first so the block still reads newest last. None similar: none at all.
export function similarExamples<T extends Correction>(list: readonly T[], message: string, k = EXAMPLES_K, min = MIN_SIMILARITY): T[] {
  const target = grams(message)
  if (target.size === 0) return []
  const scored: { c: T; score: number; i: number }[] = []
  list.forEach((c, i) => {
    const g = grams(c.text)
    if (g.size === 0) return
    let both = 0
    for (const x of target) if (g.has(x)) both++
    const score = both / (target.size + g.size - both)
    if (score >= min) scored.push({ c, score, i })
  })
  return scored
    .sort((a, b) => b.score - a.score || b.c.at - a.c.at || b.i - a.i)
    .slice(0, k)
    .map(x => x.c)
    .sort((a, b) => a.at - b.at)
}

function isTier(x: unknown): x is Tier {
  return x === 'lookup' || x === 'execute' || x === 'decide'
}

// What the store holds is not trusted: anything that is not a well-formed entry is dropped.
export function readCorrections(raw: unknown): Correction[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((x): x is Correction => typeof x === 'object' && x !== null &&
      typeof (x as Correction).text === 'string' && typeof (x as Correction).at === 'number' &&
      isTier((x as Correction).routed) && isTier((x as Correction).right) &&
      ((x as Correction).source === 'manual' || (x as Correction).source === 'escalate'))
    .slice(-MAX_CORRECTIONS)
}

// The block appended to the classifier system prompt; empty (no block at all) without corrections. The classifier
// prompt is English whatever the UI language, so lang is accepted for symmetry and does not change the block.
export function fewShot(list: readonly Correction[], _lang: Lang): string {
  if (list.length === 0) return ''
  const lines = list.slice(-FEW_SHOT_MAX).map(c => `- "${c.text.replaceAll('"', "'")}" → ${c.right} (was routed ${c.routed})`)
  return [
    'Corrections this developer made to earlier routing (newest last). When a new message is clearly the same kind of',
    'work, follow the correction over the rules above:',
    ...lines,
  ].join('\n')
}
