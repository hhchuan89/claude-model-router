import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { Advice, Grade } from '../types'
import type { Lang } from './advice'
import { expiredLogs, isTrivial, parseAdvice, reviewSystemFor, systemFor } from './advice'
import { isPersonOrigin } from './origin'
import { redact } from './redact'

const PANE = 'prompt-coach'
const TITLE = 'Prompt Coach'
const KEEP = 50
const RETAIN_DAYS = 90
const REVIEW_DAYS = 7
// How long a prompt is held for grading before it goes through unchecked.
const GATE_MS = 8000

const entries = atom({ plugin: 'prompt-coach', key: 'entries' } as const, [])
const held = atom({ plugin: 'prompt-coach', key: 'held' } as const, null)
const enabled = atom({ plugin: 'prompt-coach', key: 'enabled' } as const, true)
const isExpanded = atom({ plugin: 'prompt-coach', key: 'isExpanded' } as const, false)

const GRADE_COLOR: Record<Grade, string> = { A: 'success', B: 'warning', C: 'error' }

const STR = {
  zh: {
    analyzing: '分析中…',
    checking: '发送前检查中…',
    unchecked: '未检查，已直接发送',
    held: 'prompt-coach：先看一下建议，改好后按 Enter 发送（不会再检查）',
    hint: '原文已放回输入框，可直接修改，按 Enter 发送',
    off: 'Prompt Coach 已关闭',
    skipped: '短确认，跳过分析',
    failed: '分析失败：',
    empty: '还没有 prompt。发一条，这里会出现对它的建议。',
    copied: '改写版已复制到剪贴板',
    copyFailed: '没能填入输入框，也没能复制',
    noLogs: `最近 ${REVIEW_DAYS} 天没有日志。`,
    reviewFailed: '回顾生成失败：',
  },
  en: {
    analyzing: 'Analyzing…',
    checking: 'Checking before sending…',
    unchecked: 'Sent without checking',
    held: 'prompt-coach: review the advice, edit if you like, then press Enter to send (no second check)',
    hint: 'Your prompt is back in the box: edit it, then press Enter to send',
    off: 'Prompt Coach is off',
    skipped: 'Short confirmation, not analyzed',
    failed: 'Analysis failed: ',
    empty: 'No prompts yet. Send one and its advice shows up here.',
    copied: 'Rewrite copied to the clipboard',
    copyFailed: 'Could not fill the prompt box or copy',
    noLogs: `No log entries in the last ${REVIEW_DAYS} days.`,
    reviewFailed: 'Review failed: ',
  },
} as const

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function dayOf(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

async function logDir($: EngineInterface): Promise<string> {
  return `${await $.env.get('HOME')}/.claude/prompt-coach/log`
}

// $.fs.write replaces the whole file, so appends are read-modify-write,
// chained so two quick prompts never interleave.
let writes: Promise<void> = Promise.resolve()

function appendLog($: EngineInterface, path: string, record: object): Promise<void> {
  writes = writes
    .then(async () => {
      let old = ''
      try {
        old = await $.fs.read(path)
      } catch {
        // first record of the day
      }
      await $.fs.write(path, old + JSON.stringify(record) + '\n')
    })
    .catch(err => $.ui.log(`prompt-coach: log write failed: ${String(err)}`))
  return writes
}

async function pruneLogs($: EngineInterface, now: Date) {
  const dir = await logDir($)
  if (!(await $.fs.exists(dir))) return
  const cutoff = dayOf(new Date(now.getTime() - RETAIN_DAYS * 86_400_000))
  const old = expiredLogs((await $.fs.list(dir)).map(f => f.name), cutoff)
  if (old.length > 0) await $.process.run(['rm', '-f', ...old.map(n => `${dir}/${n}`)])
}

// A reply's closing lines usually hold the question the next prompt answers, so keep the tail.
function clip(text: string): string {
  return text.length <= 1500 ? text : `${text.slice(0, 300)}\n…\n${text.slice(-1200)}`
}

async function recentContext($: EngineInterface): Promise<string> {
  const rows = await $.session.messages()
  return rows
    .filter(m => m.text.trim() !== '')
    .slice(-4)
    .map(m => `[${m.role}] ${clip(redact(m.text))}`)
    .join('\n\n')
}

type Result = Pick<Advice, 'status' | 'grade' | 'verdict' | 'tips' | 'rewrite'>

async function analyze(
  $: EngineInterface,
  lang: Lang,
  model: string,
  id: string,
  prompt: string,
  logPath: string,
  signal: AbortSignal,
): Promise<Result> {
  let result: Result
  try {
    const context = await recentContext($)
    const r = await $.model.complete({
      model,
      system: systemFor(lang),
      prompt: `<context>\n${context || '(new session)'}\n</context>\n\n<prompt>\n${prompt}\n</prompt>`,
      maxTokens: 1000,
      timeoutMs: GATE_MS,
    }, { signal })
    if (r.isAnswered) {
      result = { status: 'done', ...parseAdvice(r.text) }
    } else if (r.reason === 'aborted') {
      // "Send now" or the gate's time limit: the prompt went through unchecked, which is no failure.
      result = { status: 'error', grade: null, verdict: STR[lang].unchecked, tips: [], rewrite: null }
    } else {
      const why = `${r.reason}${r.reason === 'api-error' ? ` (${r.status})` : ''}`
      result = { status: 'error', grade: null, verdict: STR[lang].failed + why, tips: [], rewrite: null }
    }
  } catch (err) {
    result = { status: 'error', grade: null, verdict: STR[lang].failed + String(err), tips: [], rewrite: null }
  }
  await update($, entries, list => (list ?? []).map(x => (x.id === id ? { ...x, ...result } : x)))
  await appendLog($, logPath, { type: 'advice', id, model, ...result })
  return result
}

// Lets "Send now" cut the grading short; the held hook then lets the prompt through.
let release: (() => void) | null = null

async function weeklyReview($: EngineInterface, lang: Lang, model: string): Promise<string> {
  const dir = await logDir($)
  const now = new Date(await $.clock.now())
  const from = dayOf(new Date(now.getTime() - (REVIEW_DAYS - 1) * 86_400_000))
  const names = (await $.fs.exists(dir)) ? (await $.fs.list(dir)).map(f => f.name) : []
  const days = names.filter(n => /^\d{8}\.jsonl$/.test(n) && n.slice(0, 8) >= from).sort()

  const prompts = new Map<string, string>()
  const rows: string[] = []
  for (const name of days) {
    for (const line of (await $.fs.read(`${dir}/${name}`)).split('\n')) {
      if (line.trim() === '') continue
      const r = JSON.parse(line) as Record<string, unknown>
      if (r.type === 'prompt') prompts.set(String(r.id), String(r.prompt).slice(0, 300))
      if (r.type === 'advice' && r.status === 'done' && r.grade && !r.skipped) {
        const tips = Array.isArray(r.tips) ? r.tips.join(' / ') : ''
        rows.push(`[${r.grade}] ${prompts.get(String(r.id)) ?? ''}\n  → ${r.verdict}${tips ? `\n  tips: ${tips}` : ''}`)
      }
    }
  }
  if (rows.length === 0) return STR[lang].noLogs

  const r = await $.model.complete({
    model,
    system: reviewSystemFor(lang),
    prompt: rows.slice(-200).join('\n\n'),
    maxTokens: 2000,
    timeoutMs: 120000,
  })
  return r.isAnswered ? r.text.trim() : STR[lang].reviewFailed + r.reason
}

// Puts a version of the held prompt in the composer; falls back to the clipboard.
async function fillBox($: EngineInterface, lang: Lang, text: string, surface: RenderSurface) {
  const filled = await $.prompt.fill({ text, mode: 'replace' })
  if (filled.isFilled) return
  const copied = await $.ui.copy({ text, surface })
  $.ui.toast(copied.isCopied ? STR[lang].copied : STR[lang].copyFailed)
}

// Kept across sessions, so a pause lasts until the person turns it back on.
async function setEnabled($: EngineInterface, isOn: boolean) {
  await update($, enabled, () => isOn)
  await $.store.set('enabled', isOn)
  if (!isOn) await update($, held, () => null)
}

type TextTag = ReturnType<EngineInterface['ui']['resolve']>['Text']

function gradeChip(Text: TextTag, grade: Grade | null) {
  return grade === null ? (
    <Text inverse bold>
      {' ? '}
    </Text>
  ) : (
    <Text inverse bold color={GRADE_COLOR[grade]}>
      {` ${grade} `}
    </Text>
  )
}

export const register: Register = (on, options) => {
  const lang: Lang = options.language === 'en' ? 'en' : 'zh'
  const model = typeof options.model === 'string' && options.model !== '' ? options.model : 'sonnet'
  const str = STR[lang]

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'prompt-coach',
      description: 'Prompt Coach: no argument opens the history pane; "review" summarizes your last 7 days; "on"/"off" toggles it',
      argumentHint: '[review|on|off]',
    })
    const stored = await $.store.get('enabled')
    await update($, enabled, () => stored !== false)
    void pruneLogs($, new Date(await $.clock.now())).catch(err =>
      $.ui.log(`prompt-coach: log cleanup failed: ${String(err)}`),
    )
    return next(e)
  })

  on('command.run', { command: 'prompt-coach' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'review') return { text: await weeklyReview($, lang, model) }
    if (arg === 'on' || arg === 'off') {
      await setEnabled($, arg === 'on')
      return { text: `Prompt Coach ${arg === 'on' ? 'enabled' : 'disabled'}.` }
    }
    const { isPlaced } = await $.ui.open({ id: PANE, title: TITLE })
    return { text: isPlaced ? 'Prompt Coach history opened.' : 'Prompt Coach history opened (not visible on this surface).' }
  })

  // The gate: hold the prompt while it is graded; A goes through, B/C come back to the composer.
  on('prompt.submit', async ($, e, next) => {
    const origin = e.origin as typeof e.origin | undefined
    if (!isPersonOrigin(origin) || e.text.trim() === '' || !(await read($, enabled))) return next(e)

    // The send after a hold goes straight through: the person has seen the advice.
    const wasHeld = await read($, held)
    if (wasHeld) {
      await update($, held, () => null)
      return next(e)
    }

    const now = new Date(await $.clock.now())
    const at = `${pad(now.getHours())}:${pad(now.getMinutes())}`
    const id = `${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`
    const prompt = redact(e.text)
    const logPath = `${await logDir($)}/${dayOf(now)}.jsonl`
    const isSkipped = isTrivial(e.text)

    const entry: Advice = isSkipped
      ? { id, at, prompt, status: 'done', grade: 'A', verdict: str.skipped, tips: [], rewrite: null }
      : { id, at, prompt, status: 'pending', grade: null, verdict: '', tips: [], rewrite: null }
    await update($, entries, list => [entry, ...(list ?? [])].slice(0, KEEP))
    await update($, isExpanded, () => false)
    void appendLog($, logPath, { type: 'prompt', id, ts: now.toISOString(), origin: origin?.kind ?? 'composer', prompt })

    if (isSkipped) {
      void appendLog($, logPath, { type: 'advice', id, status: 'done', grade: 'A', skipped: true })
      return next(e)
    }

    const stop = new AbortController()
    release = () => stop.abort()
    const result = await analyze($, lang, model, id, prompt, logPath, stop.signal)
    release = null

    // Anything but a finished B/C (an A, a timeout, an error, "Send now") lets the prompt through.
    if (result.status !== 'done' || (result.grade !== 'B' && result.grade !== 'C')) return next(e)

    await update($, held, () => ({ id, original: e.text }))
    // The composer was cleared by the submit; give the person's own words back.
    $.clock.after(100, () => {
      void $.prompt.fill({ text: e.text, mode: 'replace' })
    })
    return { drop: str.held }
  })

  // Stacks its row under whatever other mods draw in the band, so both stay visible.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)

    if (!(await read($, enabled))) {
      return (
        <Box flexDirection="column">
          {below}
          <Box flexDirection="row" gap={1} alignItems="center">
            <Text dimColor>💡 {str.off}</Text>
            <Button key="enable" label="Enable" onPress={() => setEnabled($, true)} />
          </Box>
        </Box>
      )
    }

    const latest = ((await read($, entries)) ?? [])[0]
    if (latest === undefined) return below
    const x = latest
    const hold = await read($, held)
    const isHeld = hold !== null && hold.id === x.id
    const disable = <Button key="disable" label="Disable" onPress={() => setEnabled($, false)} />

    if (x.status === 'pending') {
      return (
        <Box flexDirection="column">
          {below}
          <Box flexDirection="row" gap={1} alignItems="center">
            <Text dimColor>💡</Text>
            <Box flexGrow={1} flexShrink={1}>
              <Text dimColor>{str.checking}</Text>
            </Box>
            <Button key="send-now" label="Send now" onPress={() => release?.()} />
            {disable}
          </Box>
        </Box>
      )
    }

    // After the prompt went through: one dim line, whatever the grade.
    if (!isHeld) {
      return (
        <Box flexDirection="column">
          {below}
          <Box flexDirection="row" gap={1} alignItems="center">
            <Text dimColor>💡</Text>
            {x.grade !== null && (
              <Text dimColor bold color={GRADE_COLOR[x.grade]}>
                {x.grade}
              </Text>
            )}
            <Box flexGrow={1} flexShrink={1}>
              <Text dimColor wrap="truncate-end">
                {x.verdict}
              </Text>
            </Box>
            {disable}
          </Box>
        </Box>
      )
    }

    const open = (await read($, isExpanded)) ?? false
    const hasMore = x.tips.length > 0 || x.rewrite !== null
    const original = hold.original

    return (
      <Box flexDirection="column">
        {below}
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text>💡</Text>
          {gradeChip(Text, x.grade)}
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap={open ? 'wrap' : 'truncate-end'}>{x.verdict}</Text>
          </Box>
          {hasMore && (
            <Button key="toggle" label={open ? 'Less' : 'More'} onPress={() => update($, isExpanded, v => !v)} />
          )}
          <Button key="mine" label="Use mine" onPress={pe => fillBox($, lang, original, pe.surface)} />
          {x.rewrite !== null && (
            <Button
              key="rewrite"
              label="Use rewrite"
              variant="primary"
              onPress={pe => fillBox($, lang, x.rewrite!, pe.surface)}
            />
          )}
          {disable}
        </Box>
        <Box paddingLeft={3}>
          <Text dimColor>{str.hint}</Text>
        </Box>
        {open && (
          <Box flexDirection="column" paddingLeft={3} marginTop={1}>
            {x.tips.map(tip => (
              <Text>· {tip}</Text>
            ))}
            {x.rewrite !== null && <Markdown text={`> ${x.rewrite.replace(/\n/g, '\n> ')}`} />}
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Markdown } = $.ui.resolve(e)
    const list = (await read($, entries)) ?? []

    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>{str.empty}</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {list.map(x => (
          <Box key={x.id} flexDirection="column" marginBottom={1}>
            <Text dimColor wrap="truncate-end">
              {x.at} · {x.prompt.replace(/\s+/g, ' ')}
            </Text>
            {x.status === 'pending' ? (
              <Text dimColor>{str.analyzing}</Text>
            ) : (
              <Box flexDirection="column">
                <Box flexDirection="row" gap={1}>
                  {gradeChip(Text, x.grade)}
                  <Text dimColor={x.status === 'error'}>{x.verdict}</Text>
                </Box>
                {x.tips.map(tip => (
                  <Text>· {tip}</Text>
                ))}
                {x.rewrite !== null && <Markdown text={`> ${x.rewrite.replace(/\n/g, '\n> ')}`} />}
              </Box>
            )}
          </Box>
        ))}
      </Box>
    )
  })
}
