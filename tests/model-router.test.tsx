import { describe, expect, mock, test } from 'claude-code/testing'

import { add, costOf, EMPTY, keepWarm, saved, subagentModel } from '../hooks/meter'
import { applyEscalation, assignmentContext, forcedModel, isFable, parseDecision, routeFor, withSuffixOf } from '../hooks/route'

describe('route rules', () => {
  test('parses the classifier reply and rejects junk', async () => {
    expect(parseDecision('{"tier":"decide","reason":"架构取舍"}')).toEqual({ tier: 'decide', reason: '架构取舍' })
    expect(parseDecision('```json\n{"tier":"lookup","reason":"x"}\n```')?.tier).toBe('lookup')
    expect(parseDecision('{"tier":"huge"}')).toBe(null)
    expect(parseDecision('no json')).toBe(null)
  })

  test('#model pins the turn', async () => {
    expect(forcedModel('fix it #opus')).toBe('opus')
    expect(forcedModel('#Haiku list files')).toBe('haiku')
    expect(forcedModel('issue #12')).toBe(null)
  })

  test('escalation only goes up; opus alone may lower its effort', async () => {
    const haiku = routeFor('lookup', '')
    const up = applyEscalation(haiku, { model: 'sonnet', reason: 'needs code' })
    expect(up.ok && up.route.model).toBe('sonnet')
    expect(up.ok && up.route.effort).toBe('medium')
    expect(applyEscalation(haiku, { effort: 'high', reason: 'harder' }).ok).toBe(true)

    const sonnet = routeFor('execute', '')
    expect(applyEscalation(sonnet, { model: 'haiku', reason: 'x' }).ok).toBe(false)
    expect(applyEscalation(sonnet, { effort: 'low', reason: 'x' }).ok).toBe(false)
    expect(applyEscalation(sonnet, { model: 'fable', reason: 'x' }).ok).toBe(false)

    const opus = routeFor('decide', '')
    const lower = applyEscalation(opus, { effort: 'medium', reason: 'small decision' })
    expect(lower.ok && lower.route.effort).toBe('medium')
    expect(applyEscalation(opus, { effort: 'high', reason: 'same' }).ok).toBe(false)
  })

  test('model ids keep the context-window suffix; Fable is recognised', async () => {
    expect(withSuffixOf('claude-haiku-5-5', 'claude-opus-5-5[1m]')).toBe('claude-haiku-5-5[1m]')
    expect(withSuffixOf('claude-haiku-5-5', 'claude-opus-5-5')).toBe('claude-haiku-5-5')
    expect(isFable('claude-fable-5-1[1m]')).toBe(true)
    expect(isFable('claude-opus-5-5')).toBe(false)
  })

  test('the assignment tells a non-opus model to judge first and escalate before any tool', async () => {
    const text = assignmentContext({ ...routeFor('lookup', '找文件'), turnId: null })
    expect(text).toContain('haiku at low effort')
    expect(text).toContain('FIRST, before any other tool')
    expect(assignmentContext(routeFor('decide', ''))).toContain('Decide the effort this task needs')
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

type Seen = { clock: { advance: (ms: number) => Promise<void> }; submits: { text: string; context?: readonly string[] }[]; steps: { model: string; effort?: unknown; agentId?: string }[]; asked: string[]; prompts: string[]; usage: any[]; agents: (string | undefined)[] }

function world($: any, on: any, classifier: string | null | (string | null)[], opts: { reviewer?: boolean; drop?: boolean } = {}): Seen {
  mock.store(on)
  const seen: Seen = { clock: mock.clock(on), submits: [], steps: [], asked: [], prompts: [], usage: [], agents: [] }
  on('session.messages', async () => ({ value: [] }))
  on('model.complete', async (_$: unknown, e: { model: string; prompt: string }) => {
    seen.asked.push(e.model)
    seen.prompts.push(e.prompt)
    const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    if (e.model === 'haiku') {
      const reply = Array.isArray(classifier) ? (classifier.shift() ?? null) : classifier
      return reply === null
        ? { value: { isAnswered: false as const, reason: 'aborted' as const, usage } }
        : { value: { isAnswered: true as const, text: reply, usage } }
    }
    if (e.model === 'claude-fable-5-5') {
      return opts.reviewer
        ? { value: { isAnswered: true as const, text: e.prompt.startsWith('Reply') ? 'OK' : '少考虑了回滚方案', usage } }
        : { value: { isAnswered: false as const, reason: 'api-error' as const, status: 404, error: 'not_found_error', usage } }
    }
    return { deny: 'unexpected model' }
  })
  // As the engine does: the turn starts before the submit resolves.
  let turns = 0
  on('prompt.submit', async (_$: unknown, e: { text: string; context?: readonly string[] }) => {
    seen.submits.push(e)
    if (opts.drop) return { drop: 'held' }
    await $.turn.start({ text: e.text, turnId: `t${++turns}` })
    return { text: e.text, context: e.context }
  })
  on('turn.start', async (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', async () => ({ text: 'ok' }))
  on('turn.step', async function* (_$: unknown, e: { model: string; effort?: unknown; agentId?: string; turnId: string; index: number }) {
    seen.steps.push({ model: e.model, effort: e.effort, agentId: e.agentId })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: seen.usage.shift() ?? null }
  })
  on('tool.call', { tool: 'Agent' }, async (_$: unknown, e: { model?: string }) => {
    seen.agents.push(e.model)
    return { result: 'done' }
  })
  on('ui.render', { component: 'AbovePrompt' }, async ($$: any, e: any) => {
    const { Text } = $$.ui.resolve(e)
    return <Text>other mods</Text>
  })
  return seen
}

async function step($: any, turnId: string, model = 'claude-opus-5-5[1m]', agentId?: string) {
  const s = $.turn.step({ turnId, index: 0, model, effort: 'high', messageCount: 3, agentId } as never)
  for await (const _ of s) {
    // drain
  }
}

test('a lookup turn runs on Haiku at low effort, with the assignment in context', async ($, on) => {
  const seen = world($, on, '{"tier":"lookup","reason":"找文件"}')
  await $.prompt.submit({ text: 'find every TODO in the repo' } as never)
  expect(seen.submits[0]!.context?.[0]).toContain('assigned to haiku at low effort')
  await step($, 't1')
  expect(seen.steps[0]).toEqual({ model: 'claude-haiku-5-5[1m]', effort: 'low', agentId: undefined })

  const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ text: /Haiku · low — 找文件/ })).toBeDefined()
  expect(await ui.find({ text: /other mods/ })).toBeDefined()
})

test('the running model escalates itself, and the next step follows; downgrades are refused', async ($, on) => {
  const seen = world($, on, '{"tier":"lookup","reason":"找文件"}')
  await $.prompt.submit({ text: 'look at the auth flow' } as never)
  await step($, 't1')
  const up = (await $.tool.call({ tool: 'mcp__model-router__escalate', model: 'opus', reason: '要做设计决策' } as never)) as { result: string }
  expect(up.result).toContain('opus at high')
  await step($, 't1')
  expect(seen.steps[1]).toEqual({ model: 'claude-opus-5-5[1m]', effort: 'high', agentId: undefined })
  const down = (await $.tool.call({ tool: 'mcp__model-router__escalate', model: 'sonnet', reason: 'x' } as never)) as { result: string }
  expect(down.result).toContain('Not changed')

  const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ text: /Haiku · low → opus · high \(要做设计决策\)/ })).toBeDefined()
})

test('Fable 5.1 never runs, not even in a subagent; other subagent models are left alone', async ($, on) => {
  const seen = world($, on, '{"tier":"execute","reason":"实现"}')
  await step($, 'other', 'claude-fable-5-1[1m]', 'agent-1')
  await step($, 'other', 'claude-sonnet-5-5', 'agent-2')
  expect(seen.steps[0]!.model).toBe('claude-opus-5-5[1m]')
  expect(seen.steps[1]!.model).toBe('claude-sonnet-5-5')
})

test('a classifier failure falls back to Sonnet at medium', async ($, on) => {
  const seen = world($, on, null)
  await $.prompt.submit({ text: 'do the thing' } as never)
  await step($, 't1')
  expect(seen.steps[0]).toEqual({ model: 'claude-sonnet-5-5[1m]', effort: 'medium', agentId: undefined })
})

test('#opus in the message skips the classifier', async ($, on) => {
  const seen = world($, on, '{"tier":"lookup","reason":"x"}')
  await $.prompt.submit({ text: 'pick a database #opus' } as never)
  expect(seen.asked).toEqual([])
  expect(seen.submits[0]!.context?.[0]).toContain('assigned to opus')
})

test('an Opus decision is reviewed by Fable 5.5 when it exists', async ($, on) => {
  const session = mock.session(on)
  const seen = world($, on, '{"tier":"decide","reason":"选方案"}', { reviewer: true })
  await $.prompt.submit({ text: 'which queue should we use' } as never)
  await $.turn.complete({ answer: '用 SQS', durationMs: 1000, isAborted: false, turnId: 't1', text: '用 SQS', reason: 'completed' } as never)
  await seen.clock.advance(0)
  expect(seen.asked.filter(m => m === 'claude-fable-5-5').length).toBe(2)
  expect(JSON.stringify(session.appended())).toContain('少考虑了回滚方案')
})

test('no reviewer: no review notice', async ($, on) => {
  const session = mock.session(on)
  const seen = world($, on, '{"tier":"decide","reason":"选方案"}', { reviewer: false })
  await $.prompt.submit({ text: 'which queue should we use' } as never)
  await $.turn.complete({ answer: '用 SQS', durationMs: 1000, isAborted: false, turnId: 't1', text: '用 SQS', reason: 'completed' } as never)
  await seen.clock.advance(0)
  expect(seen.asked.filter(m => m === 'claude-fable-5-5').length).toBe(1)
  expect(JSON.stringify(session.appended())).not.toContain('Fable 5.5')
})

test('Disable router leaves every step alone', async ($, on) => {
  const seen = world($, on, '{"tier":"lookup","reason":"找文件"}')
  const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  await $.prompt.submit({ text: 'find files' } as never)
  await ui.press({ key: 'router-disable' })
  await step($, 't1', 'claude-fable-5-1')
  expect(seen.steps[0]!.model).toBe('claude-fable-5-1')
  expect(await ui.find({ key: 'router-enable' })).toBeDefined()
})

test('a prompt held back by another mod binds no route to the next turn', async ($, on) => {
  const seen = world($, on, '{"tier":"lookup","reason":"找文件"}', { drop: true })
  await $.prompt.submit({ text: 'find files' } as never)
  await $.turn.start({ text: 'a notification turn', turnId: 'tx' } as never)
  await step($, 'tx')
  expect(seen.steps[0]!.model).toBe('claude-opus-5-5[1m]')
})

test('the classifier sees the prompt with secrets masked', async ($, on) => {
  const seen = world($, on, '{"tier":"lookup","reason":"x"}')
  await $.prompt.submit({ text: `deploy with key sk-ant-api03-${'q'.repeat(30)}` } as never)
  expect(seen.prompts[0]).toContain('[REDACTED')
  expect(seen.prompts[0]).not.toContain('qqqqqqqqqq')
})

const U = (input: number, output: number, read = 0, write = 0, model = 'claude-opus-5-5') => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
  model,
})

describe('meter', () => {
  test('prices tokens per model and the Opus baseline', async () => {
    expect(Math.round(costOf(U(1e6, 0), 'opus') * 1000) / 1000).toBe(4)
    expect(Math.round((costOf(U(0, 1e6), 'haiku')) * 1000) / 1000).toBe(0.5)
    const t = add(add(EMPTY, 'claude-haiku-5-5', U(1e6, 0)), 'claude-opus-5-5', U(1e6, 0))
    expect(Math.round((t.cost) * 1000) / 1000).toBe(4.1)
    expect(Math.round((t.baseline) * 1000) / 1000).toBe(8)
    expect(saved(t).pct).toBe(49)
  })

  test('a downgrade keeps the warm model only when the cold read costs more', async () => {
    const shape = { steps: 5, output: 1000 }
    const warm = { model: 'opus' as const, at: 0, context: 200_000 }
    expect(keepWarm('sonnet', warm, 60_000, shape)).toBe('opus')
    expect(keepWarm('haiku', warm, 60_000, shape)).toBe('haiku')
    expect(keepWarm('sonnet', { ...warm, context: 5_000 }, 60_000, shape)).toBe('sonnet')
    expect(keepWarm('sonnet', warm, 2 * 3600_000, shape)).toBe('sonnet')
    expect(keepWarm('opus', { ...warm, model: 'sonnet' }, 60_000, shape)).toBe('opus')
  })

  test('subagents: Explore on Haiku, Plan on Opus, the rest by tier', async () => {
    expect(subagentModel('Explore', null)).toBe('haiku')
    expect(subagentModel('Plan', null)).toBe('opus')
    expect(subagentModel('general-purpose', 'lookup')).toBe('haiku')
    expect(subagentModel(undefined, 'decide')).toBe('opus')
    expect(subagentModel(undefined, null)).toBe('sonnet')
  })
})

test('each step goes on the meter, shown in the band and in /model-router stats', async ($, on) => {
  const seen = world($, on, '{"tier":"lookup","reason":"找文件"}')
  await $.prompt.submit({ text: 'find files' } as never)
  seen.usage.push(U(1000, 200, 20_000, 0, 'claude-haiku-5-5'))
  await step($, 't1')
  const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ text: /本轮 21\.2k/ })).toBeDefined()
  expect(await ui.find({ text: /省 ≈/ })).toBeDefined()
  const r = (await $.command.run({ command: 'model-router', args: 'stats' } as never)) as { text: string }
  expect(r.text).toContain('haiku')
  expect(r.text).toContain('saved')
})

test('a warm Opus cache on a long context keeps the next execute turn on Opus', async ($, on) => {
  const seen = world($, on, ['{"tier":"decide","reason":"选方案"}', '{"tier":"execute","reason":"照方案实现"}'])
  await $.prompt.submit({ text: 'which design' } as never)
  seen.usage.push(U(2000, 1000, 300_000, 0))
  await step($, 't1')
  await $.prompt.submit({ text: 'implement it' } as never)
  expect(seen.submits[1]!.context?.[0]).toContain('assigned to opus')
  await step($, 't2')
  expect(seen.steps[1]!.model).toBe('claude-opus-5-5[1m]')
  const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ text: /Sonnet · medium → Opus \(保缓存\)/ })).toBeDefined()
})

test('subagents without a model are routed; Fable becomes Opus; a named model is kept', async ($, on) => {
  const seen = world($, on, '{"tier":"decide","reason":"审计"}')
  await $.tool.call({ tool: 'Agent', description: 'find', prompt: 'grep for TODO', subagent_type: 'Explore' } as never)
  await $.tool.call({ tool: 'Agent', description: 'audit', prompt: 'audit the save system for exploits' } as never)
  await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'x', model: 'fable' } as never)
  await $.tool.call({ tool: 'Agent', description: 'y', prompt: 'y', model: 'sonnet' } as never)
  expect(seen.agents).toEqual(['haiku', 'opus', 'opus', 'sonnet'])
})
