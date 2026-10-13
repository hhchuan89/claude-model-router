import { describe, expect, mock, test } from 'claude-code/testing'

import { blocks, etaMs, fmtDuration, fmtElapsed, median, timeFraction } from '../hooks/progress'

describe('progress math', () => {
  test('the estimate eases up and never reaches 90%', async () => {
    const a = timeFraction(10_000, 60_000)
    const b = timeFraction(60_000, 60_000)
    const c = timeFraction(3_600_000, 60_000)
    expect(a < b && b < c).toBe(true)
    expect(c <= 0.9).toBe(true)
  })

  test('median, eta and formats', async () => {
    expect(median([5, 1, 3])).toBe(3)
    expect(median([])).toBe(null)
    expect(etaMs({ total: 4, done: 1, active: 1 }, 0, 60_000)).toBe(240_000)
    expect(etaMs({ total: 4, done: 0, active: 1 }, 0, 60_000)).toBe(null)
    expect(fmtElapsed(222_000)).toBe('3:42')
    expect(fmtElapsed(3_723_000)).toBe('1:02:03')
    expect(fmtDuration(252_000)).toBe('4m12s')
  })

  test('blocks fill to the width', async () => {
    const half = blocks(0.5, 10)
    expect(half.filled).toBe('█████')
    expect(half.rest).toBe('─────')
    expect(blocks(1, 10).rest).toBe('')
  })
})

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 12,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 11 },
  view: {},
} as never

function bottom(on: any) {
  on('prompt.submit', async (_$: unknown, e: { text: string }) => ({ text: e.text }))
  on('turn.complete', async () => ({ text: 'ok' }))
  on('ui.render', { component: 'AbovePrompt' }, async ($$: any, e: any) => {
    const { Text } = $$.ui.resolve(e)
    return <Text>coach row</Text>
  })
  let n = 0
  on('tool.call', async (_$: unknown, e: { tool: string }) =>
    e.tool === 'TaskCreate' ? { result: { task: { id: String(++n), subject: 's' } } } : { result: {} },
  )
}

test('estimate mode: bar, elapsed time, and the row beneath', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on, { now: new Date(2026, 9, 13, 21, 46).getTime() })
  bottom(on)
  await $.prompt.submit({ text: 'do the thing' } as never)
  await clock.advance(42_000)
  const desk = await $.ui.mount({ plugin: 'turn-progress', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await desk.find({ type: 'Svg' })).toBeDefined()
  expect(await desk.find({ text: /0:42/ })).toBeDefined()
  expect(await desk.find({ text: /21:46/ })).toBeDefined()
  expect(await desk.find({ text: /coach row/ })).toBeDefined()
  const term = await $.ui.mount({ plugin: 'turn-progress', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await term.find({ text: /█/ })).toBeDefined()
  expect(await term.find({ text: /coach row/ })).toBeDefined()
})

test('task mode counts this turn\'s tasks and shows the running one', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on, { now: new Date(2026, 9, 13, 21, 46).getTime() })
  bottom(on)
  await $.prompt.submit({ text: 'big job' } as never)
  for (const subject of ['a', 'b', 'c']) {
    await $.tool.call({ tool: 'TaskCreate', subject, description: subject } as never)
  }
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress', activeForm: 'Running tests' } as never)
  await clock.advance(60_000)
  const ui = await $.ui.mount({ plugin: 'turn-progress', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ text: /1\/3/ })).toBeDefined()
  expect(await ui.find({ text: /Running tests/ })).toBeDefined()
  expect(await ui.find({ text: /≈/ })).toBeDefined()
})

test('turn end collapses to a summary and records the duration', async ($, on) => {
  const kept: Record<string, unknown> = {}
  on('store.get', async (_$: unknown, e: { key: string }) => ({ value: kept[e.key] }))
  on('store.set', async (_$: unknown, e: { key: string; value: unknown }) => {
    kept[e.key] = e.value
    return { value: undefined }
  })
  const clock = mock.clock(on, { now: new Date(2026, 9, 13, 21, 46).getTime() })
  bottom(on)
  await $.prompt.submit({ text: 'quick' } as never)
  await clock.advance(252_000)
  await $.turn.complete({ answer: 'ok', durationMs: 252_000, isAborted: false, turnId: 't', text: 'ok', reason: 'completed' } as never)
  const ui = await $.ui.mount({ plugin: 'turn-progress', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ text: /4m12s · 21:46 → 21:50/ })).toBeDefined()
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  expect(kept.durations).toEqual([252_000])
})

test('a prompt another mod held back starts no bar', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  on('prompt.submit', async () => ({ drop: 'held by the coach' }))
  on('ui.render', { component: 'AbovePrompt' }, async ($$: any, e: any) => {
    const { Text } = $$.ui.resolve(e)
    return <Text>coach row</Text>
  })
  await $.prompt.submit({ text: 'vague' } as never)
  const ui = await $.ui.mount({ plugin: 'turn-progress', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  expect(await ui.find({ text: /coach row/ })).toBeDefined()
})

test('Disable hides the bar until Enable', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on)
  bottom(on)
  await $.prompt.submit({ text: 'job' } as never)
  await clock.advance(5_000)
  const ui = await $.ui.mount({ plugin: 'turn-progress', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  await ui.press({ key: 'progress-disable' })
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  expect(await ui.find({ key: 'progress-enable' })).toBeDefined()
  await $.prompt.submit({ text: 'next job' } as never)
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  await ui.press({ key: 'progress-enable' })
  await $.prompt.submit({ text: 'third job' } as never)
  expect(await ui.find({ type: 'Svg' })).toBeDefined()
})

test('the start time and the elapsed time are drawn whole, outside the bar', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on, { now: new Date(2026, 9, 13, 22, 31).getTime() })
  bottom(on)
  await $.prompt.submit({ text: 'job' } as never)
  await clock.advance(11_000)
  const ui = await $.ui.mount({ plugin: 'turn-progress', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  expect((await ui.find({ text: /^22:31$/ }))?.text).toBe('22:31')
  expect(await ui.find({ text: /^0:11$/ })).toBeDefined()
})

test('a long task label is cut short instead of squeezed', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  bottom(on)
  await $.prompt.submit({ text: 'job' } as never)
  await $.tool.call({ tool: 'TaskCreate', subject: 'x', description: 'x' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress', activeForm: 'Refactoring the entire authentication layer' } as never)
  const ui = await $.ui.mount({ plugin: 'turn-progress', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ text: /^Refactoring the entire …$/ })).toBeDefined()
})
