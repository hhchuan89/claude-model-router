import type { Tier } from '../types'
import { redact } from './redact'
import type { Lang } from './route'

export const MAX_CORRECTIONS = 40
export const FEW_SHOT_MAX = 8
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
