import type { Grade } from '../types'

export type Lang = 'zh' | 'en'

export type Parsed = { grade: Grade | null; verdict: string; tips: string[]; rewrite: string | null }

const VOICE: Record<Lang, { verdict: string; tips: string; review: string }> = {
  zh: {
    verdict: 'Simplified Chinese, at most 40 字',
    tips: 'Simplified Chinese',
    review: 'Simplified Chinese',
  },
  en: {
    verdict: 'English, at most 20 words',
    tips: 'English',
    review: 'English',
  },
}

export function systemFor(lang: Lang): string {
  const v = VOICE[lang]
  return `You coach a developer on how they write prompts to Claude Code (an AI coding agent).
You are given the prompt they just sent, plus the last few conversation turns as context.
Return ONLY one JSON object, no code fence, no other text:
{"grade":"A"|"B"|"C","verdict":string,"tips":string[],"rewrite":string|null}

- grade: A = clear enough that Claude won't guess wrong (a short confirmation like "做吧"/"yes"/"继续" that is clear from context is A);
  B = workable but missing something likely to cause a detour; C = likely to be misread or cause rework.
- verdict: ${v.verdict}, one sentence: the single biggest issue, or why it is fine.
- tips: 0–3 items in ${v.tips}; each says what is missing AND why it would make Claude guess or redo work. [] for A.
  Besides clarity, a tip may address how well the prompt leads Claude, only when it really matters for this prompt:
  gives orders without the why (Claude can't choose well at a fork); micromanages the steps instead of stating the outcome and limits;
  leaves the authority unclear (what Claude may decide alone vs. must ask first, e.g. changing config, pushing);
  sets no checkpoint on a large task (no point to stop and report before going far).
- rewrite: an improved version of the prompt, in the prompt's own language, only when clearly better; otherwise null. Always null for A.

The grade measures ONLY the risk that Claude misreads the prompt or has to redo work; leadership tips never change the grade, and prompt length / token cost is not a criterion.
Judge by: goal clarity, success criteria / how to verify, constraints & scope, needed context (files, errors, versions), ambiguity.
Read the context first: a prompt that answers a question the assistant just asked is not ambiguous. Do not invent problems.`
}

export function reviewSystemFor(lang: Lang): string {
  return `You review a week of a developer's prompts to Claude Code, each with the grade (A/B/C) and advice a coach gave at the time.
Find the recurring habits, not one-off slips. Write in ${VOICE[lang].review}, Markdown, under 300 words:
1. One line: the grade mix (counts of A/B/C) and the overall trend.
2. The 2–3 most frequent problems: what it is, how often (rough share of B/C), one real example quoted short, and the one habit that would fix it.
3. One thing they already do well, if any is clear.
No preamble, no generic prompt-engineering advice that the data does not show.`
}

function isGrade(x: unknown): x is Grade {
  return x === 'A' || x === 'B' || x === 'C'
}

// The model is asked for bare JSON; anything else falls back to its first line as the verdict.
export function parseAdvice(text: string): Parsed {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      const o = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
      if (isGrade(o.grade) && typeof o.verdict === 'string') {
        const tips = Array.isArray(o.tips) ? o.tips.filter((t): t is string => typeof t === 'string').slice(0, 3) : []
        const rewrite = typeof o.rewrite === 'string' && o.rewrite.trim() !== '' && o.grade !== 'A' ? o.rewrite.trim() : null
        return { grade: o.grade, verdict: o.verdict.trim(), tips, rewrite }
      }
    } catch {
      // fall through
    }
  }
  const first = text.trim().split('\n')[0] ?? ''
  return { grade: null, verdict: first.slice(0, 120), tips: [], rewrite: null }
}

// A one-line reply this short ("做吧", "yes", "继续") is a confirmation: not worth a model call.
export function isTrivial(text: string): boolean {
  const t = text.trim()
  return t.length <= 5 && !t.includes('\n')
}

// Log files are named YYYYMMDD.jsonl; returns the ones dated before the cutoff day.
export function expiredLogs(names: readonly string[], cutoffDay: string): string[] {
  return names.filter(n => /^\d{8}\.jsonl$/.test(n) && n.slice(0, 8) < cutoffDay)
}
