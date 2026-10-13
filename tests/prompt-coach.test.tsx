import { describe, expect, mock, test } from 'claude-code/testing'

import { expiredLogs, isTrivial, parseAdvice } from '../hooks/advice'
import { isPersonOrigin } from '../hooks/origin'
import { redact } from '../hooks/redact'

describe('redact', () => {
  test('masks common credentials', async () => {
    const tg = `${'12345678'}:${'A'.repeat(35)}`
    const out = redact(
      `key sk-ant-api03-${'x'.repeat(30)} gh ghp_${'a'.repeat(36)} tg ${tg} TOKEN=hunter2secret`,
    )
    expect(out).not.toContain('sk-ant-api03')
    expect(out).not.toContain('ghp_')
    expect(out).not.toContain(tg)
    expect(out).not.toContain('hunter2secret')
    expect(out).toContain('TOKEN=[REDACTED]')
  })

  test('leaves ordinary prose alone', async () => {
    const text = '帮我把 password 输入框的 label 改成中文，token 数量限制 4096'
    expect(redact(text)).toBe(text)
  })
})

test('logs a redacted prompt and shows the advice in the pane', async ($, on) => {
  mock.env(on, { HOME: '/home/t' })
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 13, 12, 0) })
  const files: Record<string, string> = {}
  const asked: string[] = []
  on('fs.read', async (_$, e) => (e.path in files ? { value: files[e.path]! } : { deny: 'ENOENT' }))
  on('fs.write', async (_$, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('session.messages', async () => ({ value: [] }))
  on('model.complete', async (_$, e) => {
    asked.push(e.prompt)
    return {
      value: {
        isAnswered: true as const,
        text: '缺少验收标准',
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    }
  })
  on('prompt.submit', async (_$, e) => ({ text: e.text }))

  const secret = `sk-ant-api03-${'z'.repeat(30)}`
  await $.prompt.submit({ text: `fix the login bug, key ${secret}` } as never)
  await clock.advance(0)

  expect(asked[0]).toContain('fix the login bug')
  expect(asked[0]).not.toContain(secret)
  const log = Object.entries(files)
  expect(log.length).toBe(1)
  expect(log[0]![0]).toMatch(/^\/home\/t\/\.claude\/prompt-coach\/log\/\d{8}\.jsonl$/)
  expect(log[0]![1]).not.toContain(secret)
  expect(log[0]![1]).toContain('"type":"advice"')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'prompt-coach', surface, component: 'Pane', requestId: 'prompt-coach', props: {} as never })
    expect(await ui.find({ text: /缺少验收标准/ })).toBeDefined()
  }
})

test('only the person\'s prompts are coached', async () => {
  expect(isPersonOrigin(undefined)).toBe(true)
  expect(isPersonOrigin({ kind: 'composer' })).toBe(true)
  expect(isPersonOrigin({ kind: 'sdk' })).toBe(true)
  expect(isPersonOrigin({ kind: 'task-notification' })).toBe(false)
  expect(isPersonOrigin({ kind: 'scheduled-trigger' })).toBe(false)
  expect(isPersonOrigin({ kind: 'plugin', name: 'x' } as never)).toBe(false)
  expect(isPersonOrigin({ kind: 'plugin', name: 'x', asUser: true } as never)).toBe(true)
})

describe('parseAdvice', () => {
  test('reads the structured reply', async () => {
    const p = parseAdvice('{"grade":"B","verdict":"没说验收方式","tips":["补上怎么验证"],"rewrite":"把 X 做完，跑测试确认"}')
    expect(p.grade).toBe('B')
    expect(p.verdict).toBe('没说验收方式')
    expect(p.tips).toEqual(['补上怎么验证'])
    expect(p.rewrite).toBe('把 X 做完，跑测试确认')
  })

  test('drops a rewrite on an A and tolerates a code fence', async () => {
    const p = parseAdvice('```json\n{"grade":"A","verdict":"清楚","tips":[],"rewrite":"x"}\n```')
    expect(p.grade).toBe('A')
    expect(p.rewrite).toBe(null)
  })

  test('falls back to the first line when the reply is not JSON', async () => {
    const p = parseAdvice('缺少验收标准\n更多')
    expect(p.grade).toBe(null)
    expect(p.verdict).toBe('缺少验收标准')
  })
})

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 11 },
  view: {},
} as never

async function submitWith($: any, on: any, reply: object) {
  mock.env(on, { HOME: '/home/t' })
  const clock = mock.clock(on)
  on('fs.read', async () => ({ deny: 'ENOENT' }))
  on('fs.write', async () => ({ value: undefined }))
  on('session.messages', async () => ({ value: [] }))
  on('model.complete', async () => ({
    value: {
      isAnswered: true as const,
      text: JSON.stringify(reply),
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  }))
  on('prompt.submit', async (_$: unknown, e: { text: string }) => ({ text: e.text }))
  on('ui.render', { component: 'AbovePrompt' }, async ($$: any, e: any) => {
    const { Text } = $$.ui.resolve(e)
    return <Text>engine band</Text>
  })
  await $.prompt.submit({ text: 'make it better' } as never)
  await clock.advance(0)
}

test('band shows a B with its chip, expands, and closes', async ($, on) => {
  await submitWith($, on, { grade: 'B', verdict: '没说做完怎么判断', tips: ['补上验收标准'], rewrite: '改好后跑测试确认' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'prompt-coach', surface, component: 'AbovePrompt', props: BAND_PROPS })
    expect(await ui.find({ text: /没说做完怎么判断/ })).toBeDefined()
    expect(await ui.find({ text: /engine band/ })).toBeDefined()
    expect(await ui.find({ text: / B / })).toBeDefined()
    expect(await ui.find({ key: 'rewrite' })).toBeDefined()
    expect(await ui.find({ text: /补上验收标准/ })).toBeUndefined()
    await ui.press({ key: 'toggle' })
    expect(await ui.find({ text: /补上验收标准/ })).toBeDefined()
    await ui.press({ key: 'toggle' })
  }
  const ui = await $.ui.mount({ plugin: 'prompt-coach', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  await ui.press({ key: 'close' })
  expect(await ui.find({ text: /没说做完怎么判断/ })).toBeUndefined()
})

test('band shows an A as one dim line with no buttons', async ($, on) => {
  await submitWith($, on, { grade: 'A', verdict: '很清楚', tips: [], rewrite: null })
  const ui = await $.ui.mount({ plugin: 'prompt-coach', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ text: /很清楚/ })).toBeDefined()
  expect(await ui.find({ key: 'toggle' })).toBeUndefined()
  expect(await ui.find({ key: 'close' })).toBeUndefined()
})

test('a short confirmation is logged but not sent to the model', async ($, on) => {
  mock.env(on, { HOME: '/home/t' })
  const clock = mock.clock(on)
  const files: Record<string, string> = {}
  on('fs.read', async (_$: unknown, e: { path: string }) => (e.path in files ? { value: files[e.path]! } : { deny: 'ENOENT' }))
  on('fs.write', async (_$: unknown, e: { path: string; text: string }) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  let calls = 0
  on('model.complete', async () => {
    calls += 1
    return { deny: 'unexpected' }
  })
  on('prompt.submit', async (_$: unknown, e: { text: string }) => ({ text: e.text }))
  on('ui.render', { component: 'AbovePrompt' }, async ($$: any, e: any) => {
    const { Text } = $$.ui.resolve(e)
    return <Text>engine band</Text>
  })
  await $.prompt.submit({ text: '做吧' } as never)
  await clock.advance(0)
  expect(calls).toBe(0)
  expect(Object.values(files)[0]).toContain('"skipped":true')
  const ui = await $.ui.mount({ plugin: 'prompt-coach', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ text: /跳过分析/ })).toBeDefined()
})

test('isTrivial and expiredLogs', async () => {
  expect(isTrivial('做吧')).toBe(true)
  expect(isTrivial(' yes ')).toBe(true)
  expect(isTrivial('修复登录页的 bug')).toBe(false)
  expect(isTrivial('ok\nok')).toBe(false)
  expect(expiredLogs(['20260601.jsonl', '20260720.jsonl', 'notes.txt', '20261013.jsonl'], '20260715')).toEqual(['20260601.jsonl'])
})

test('review command summarizes the logged week', async ($, on) => {
  mock.env(on, { HOME: '/home/t' })
  mock.clock(on, { now: new Date(2026, 9, 13, 12).getTime() })
  const dir = '/home/t/.claude/prompt-coach/log'
  const log = [
    { type: 'prompt', id: '1', prompt: 'fix the bug' },
    { type: 'advice', id: '1', status: 'done', grade: 'B', verdict: 'no success criteria', tips: ['say how to verify'] },
  ].map(r => JSON.stringify(r)).join('\n')
  on('fs.exists', async () => ({ value: true }))
  on('fs.list', async () => ({ value: [{ name: '20261012.jsonl', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] as never }))
  on('fs.read', async (_$: unknown, e: { path: string }) => (e.path === `${dir}/20261012.jsonl` ? { value: log } : { deny: 'ENOENT' }))
  const asked: string[] = []
  on('model.complete', async (_$: unknown, e: { prompt: string }) => {
    asked.push(e.prompt)
    return {
      value: {
        isAnswered: true as const,
        text: '1 B: you skip success criteria',
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    }
  })
  const r = (await $.command.run({ command: 'prompt-coach', args: 'review' } as never)) as { text: string }
  expect(asked[0]).toContain('[B] fix the bug')
  expect(asked[0]).toContain('say how to verify')
  expect(r.text).toContain('you skip success criteria')
})
