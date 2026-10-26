import { describe, expect, mock, test } from 'claude-code/testing'

import { add, costOf, EMPTY, keepWarm, saved } from '../hooks/meter'
import { applyEscalation, assignmentContext, forcedModel, isFable, parseDecision, routeFor, settleTier, withSuffixOf } from '../hooks/route'
import { decideSpawn, escalateAgent, logDir, startOf, stepUp } from '../hooks/subagent'

describe('route rules', () => {
  test('parses the classifier reply and rejects junk', async () => {
    expect(parseDecision('{"tier":"decide","reason":"架构取舍"}')).toEqual({ tier: 'decide', reason: '架构取舍', sure: true })
    expect(parseDecision('```json\n{"tier":"lookup","reason":"x"}\n```')?.tier).toBe('lookup')
    expect(parseDecision('{"tier":"huge"}')).toBe(null)
    expect(parseDecision('no json')).toBe(null)
  })

  test('parseDecision reads sure, and a reply without it counts as sure so old-format replies still route', async () => {
    expect(parseDecision('{"tier":"lookup","sure":false,"reason":"maybe"}')).toEqual({ tier: 'lookup', reason: 'maybe', sure: false })
    expect(parseDecision('{"tier":"lookup","sure":true,"reason":"x"}')?.sure).toBe(true)
    expect(parseDecision('{"tier":"lookup","reason":"x"}')?.sure).toBe(true)
  })

  test('settleTier: only an unsure verdict is changed, and only upward', async () => {
    expect(settleTier({ tier: 'lookup', reason: 'r', sure: true }, 'decide')).toEqual({ tier: 'lookup', reason: 'r' })
    expect(settleTier({ tier: 'execute', reason: 'r', sure: false }, 'decide')).toEqual({ tier: 'decide', reason: 'r (unsure: not downgrading)' })
    expect(settleTier({ tier: 'decide', reason: 'r', sure: false }, 'lookup').tier).toBe('decide')
    expect(settleTier({ tier: 'lookup', reason: 'r', sure: false }, null).tier).toBe('execute')
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

type Seen = { clock: { advance: (ms: number) => Promise<void> }; submits: { text: string; context?: readonly string[] }[]; steps: { model: string; effort?: unknown; agentId?: string }[]; asked: string[]; prompts: string[]; usage: any[]; agents: (string | undefined)[]; files: Record<string, string> }

const IDS: Record<string, string> = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' }

function world($: any, on: any, classifier: string | null | (string | null)[], opts: { reviewer?: boolean; drop?: boolean } = {}): Seen {
  mock.store(on)
  const seen: Seen = { clock: mock.clock(on), submits: [], steps: [], asked: [], prompts: [], usage: [], agents: [], files: {} }
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
  // As the engine does: the alias resolves to an id, no model means the parent's.
  let spawned = 0
  on('agent.spawn', async (_$: unknown, e: { model?: string; parentModel: string }) => {
    seen.agents.push(e.model)
    const id = e.model === undefined ? e.parentModel : (IDS[e.model] ?? e.model)
    return { model: id, agentId: `agent-${++spawned}` }
  })
  on('ui.status', async () => ({ value: undefined }))
  on('session.id', async () => ({ value: 'sess-1' }))
  on('fs.read', async (_$: unknown, e: { path: string }) => ({ deny: `no file ${e.path}` }))
  on('fs.write', async (_$: unknown, e: { path: string; text: string }) => {
    seen.files[e.path] = e.text
    return { value: undefined }
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

test('an Opus decision is reviewed by Fable 5.5 when it is configured and exists', { options: { reviewModel: 'claude-fable-5-5' } }, async ($, on) => {
  const session = mock.session(on)
  const seen = world($, on, '{"tier":"decide","reason":"选方案"}', { reviewer: true })
  await $.prompt.submit({ text: 'which queue should we use' } as never)
  await $.turn.complete({ answer: '用 SQS', durationMs: 1000, isAborted: false, turnId: 't1', text: '用 SQS', reason: 'completed' } as never)
  await seen.clock.advance(0)
  expect(seen.asked.filter(m => m === 'claude-fable-5-5').length).toBe(2)
  expect(JSON.stringify(session.appended())).toContain('少考虑了回滚方案')
})

test('a configured reviewer that does not exist leaves no review notice', { options: { reviewModel: 'claude-fable-5-5' } }, async ($, on) => {
  const session = mock.session(on)
  const seen = world($, on, '{"tier":"decide","reason":"选方案"}', { reviewer: false })
  await $.prompt.submit({ text: 'which queue should we use' } as never)
  await $.turn.complete({ answer: '用 SQS', durationMs: 1000, isAborted: false, turnId: 't1', text: '用 SQS', reason: 'completed' } as never)
  await seen.clock.advance(0)
  expect(seen.asked.filter(m => m === 'claude-fable-5-5').length).toBe(1)
  expect(JSON.stringify(session.appended())).not.toContain('Fable 5.5')
})

test('the reviewer is off by default: no probe and no review call, so no surprise Fable spend', async ($, on) => {
  const session = mock.session(on)
  const seen = world($, on, '{"tier":"decide","reason":"选方案"}', { reviewer: true })
  await $.prompt.submit({ text: 'which queue should we use' } as never)
  await $.turn.complete({ answer: '用 SQS', durationMs: 1000, isAborted: false, turnId: 't1', text: '用 SQS', reason: 'completed' } as never)
  await seen.clock.advance(0)
  expect(seen.asked).toEqual(['haiku'])
  expect(JSON.stringify(session.appended())).not.toContain('少考虑了回滚方案')
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
})

test('each step goes on the meter, shown in the band and in /model-router stats', { options: { language: 'zh' } }, async ($, on) => {
  const seen = world($, on, '{"tier":"lookup","reason":"找文件"}')
  await $.prompt.submit({ text: 'find files' } as never)
  seen.usage.push(U(1000, 200, 20_000, 0, 'claude-haiku-5-5'))
  await step($, 't1')
  const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ text: /本轮 21\.2k token · / })).toBeDefined()
  expect(await ui.find({ text: /省 ≈/ })).toBeDefined()
  const r = (await $.command.run({ command: 'model-router', args: 'stats' } as never)) as { text: string }
  expect(r.text).toContain('haiku')
  expect(r.text).toContain('saved')
})

test('a warm Opus cache on a long context keeps the next execute turn on Opus', { options: { language: 'zh' } }, async ($, on) => {
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

const OPUS = 'claude-opus-5-5'
const IDS_BY_KEY = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: OPUS }

const spawnInput = (over: Record<string, unknown> = {}) =>
  ({
    tool_use_id: 't1',
    prompt: 'find the config files',
    description: 'find',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: OPUS,
    background: false,
    fork: false,
    ...over,
  }) as never

async function spawnAgent($: any, over: Record<string, unknown> = {}): Promise<string> {
  return ((await $.agent.spawn(spawnInput(over))) as { agentId: string }).agentId
}

describe('subagent rules', () => {
  test('lookup work goes to haiku and settled work to sonnet: the answer is already in the input', async () => {
    expect(decideSpawn(spawnInput({ subagentType: 'Explore' }), null)).toMatchObject({ model: 'haiku' })
    expect(decideSpawn(spawnInput(), 'lookup')?.model).toBe('haiku')
    expect(decideSpawn(spawnInput(), 'execute')?.model).toBe('sonnet')
  })

  test('decisions inherit the parent and are never pinned to opus; a failed classifier means sonnet', async () => {
    expect(decideSpawn(spawnInput(), 'decide')?.model).toBeUndefined()
    expect(decideSpawn(spawnInput(), null)?.model).toBe('sonnet')
  })

  test('forks, workflow agents, Plan and named agents are left to their own model', async () => {
    expect(decideSpawn(spawnInput({ fork: true }), null)).toBeUndefined()
    expect(decideSpawn(spawnInput({ workflow: { runId: 'wf_1', agentIndex: 1 } }), null)).toBeUndefined()
    expect(decideSpawn(spawnInput({ subagentType: 'Plan' }), null)?.model).toBeUndefined()
    expect(decideSpawn(spawnInput({ subagentType: 'thorough-reviewer' }), null)?.model).toBeUndefined()
  })

  test('a named model is kept, but never above the parent and never Fable', async () => {
    expect(decideSpawn(spawnInput({ model: 'sonnet' }), null)).toBeUndefined()
    expect(decideSpawn(spawnInput({ model: 'opus', parentModel: 'claude-sonnet-5-5' }), null)?.model).toBe('sonnet')
    expect(decideSpawn(spawnInput({ model: 'fable' }), null)).toMatchObject({ model: 'opus', fable: true })
  })

  test('a Fable parent hands Opus down, even to agents that would inherit', async () => {
    const parentModel = 'claude-fable-5-1[1m]'
    expect(decideSpawn(spawnInput({ parentModel }), 'decide')).toMatchObject({ model: 'opus', fable: true })
    expect(decideSpawn(spawnInput({ parentModel, subagentType: 'thorough-reviewer' }), null)?.model).toBe('opus')
    expect(decideSpawn(spawnInput({ parentModel, subagentType: 'Explore' }), null)?.model).toBe('haiku')
  })

  test('an unsure lookup goes to sonnet, a sure one to haiku; Explore, pins and decisions are unaffected', async () => {
    expect(decideSpawn(spawnInput(), 'lookup', false)).toMatchObject({ model: 'sonnet', reason: 'unsure lookup: sonnet' })
    expect(decideSpawn(spawnInput(), 'lookup', true)?.model).toBe('haiku')
    expect(decideSpawn(spawnInput(), 'execute', false)?.model).toBe('sonnet')
    expect(decideSpawn(spawnInput(), 'decide', false)?.model).toBeUndefined()
    expect(decideSpawn(spawnInput({ subagentType: 'Explore' }), null, false)?.model).toBe('haiku')
    // a model the caller named wins over everything, sure or not
    expect(decideSpawn(spawnInput({ model: 'haiku' }), 'decide', false)).toBeUndefined()
  })

  test('a haiku parent never gets a sonnet subagent: tiers are capped at the parent', async () => {
    expect(decideSpawn(spawnInput({ parentModel: 'claude-haiku-5-5' }), 'execute')?.model).toBe('haiku')
  })

  test('escalation goes up only, lands no lower than the new tier starts, and stops at the parent', async () => {
    const haiku = startOf('haiku', OPUS, true, IDS_BY_KEY)
    expect(haiku).toMatchObject({ tier: 'haiku', effort: 'low', model: IDS_BY_KEY.haiku })
    expect(escalateAgent(haiku, { model: 'sonnet' }, IDS_BY_KEY)).toMatchObject({ tier: 'sonnet', effort: 'medium' })
    expect(escalateAgent(startOf('sonnet', OPUS, true, IDS_BY_KEY), { model: 'haiku', effort: 'low' }, IDS_BY_KEY)).toBeUndefined()
    // A haiku agent raised to opus is doing decision work now: it must not stay on haiku's low effort.
    expect(escalateAgent(haiku, { model: 'opus' }, IDS_BY_KEY)).toMatchObject({ tier: 'opus', effort: 'high' })
    expect(escalateAgent(startOf('haiku', 'claude-sonnet-5-5', true, IDS_BY_KEY), { model: 'opus' }, IDS_BY_KEY)?.tier).toBe('sonnet')
    expect(escalateAgent(startOf('haiku', 'claude-fable-5-1', true, IDS_BY_KEY), { model: 'fable' }, IDS_BY_KEY)?.tier).toBe('opus')
  })

  // Changed from v0.3 ("tier first, then effort"): the first step is now more effort on the same model.
  test('the first step up is more effort on the same model: cheaper than a switch, and often enough', async () => {
    const haiku = startOf('haiku', OPUS, true, IDS_BY_KEY)
    expect(stepUp(haiku, IDS_BY_KEY)).toMatchObject({ tier: 'haiku', model: IDS_BY_KEY.haiku, effort: 'medium', retriedAtTier: true })
  })

  test('the second step up raises the model at the new tier starting effort, and the new tier gets its own retry', async () => {
    const retried = stepUp(startOf('haiku', OPUS, true, IDS_BY_KEY), IDS_BY_KEY)!
    const sonnet = stepUp(retried, IDS_BY_KEY)!
    expect(sonnet).toMatchObject({ tier: 'sonnet', model: IDS_BY_KEY.sonnet, effort: 'medium', retriedAtTier: false })
    expect(stepUp(sonnet, IDS_BY_KEY)).toMatchObject({ tier: 'sonnet', effort: 'high', retriedAtTier: true })
    // opus starts at high: a sonnet agent already on medium lands there, not on medium
    const sonnetRetried = { ...sonnet, retriedAtTier: true }
    expect(stepUp(sonnetRetried, IDS_BY_KEY)).toMatchObject({ tier: 'opus', effort: 'high', retriedAtTier: false })
  })

  test('at the ceiling only effort rises, one step each time, and max stops it', async () => {
    const top = startOf('opus', OPUS, true, IDS_BY_KEY)
    const xhigh = stepUp(top, IDS_BY_KEY)!
    const max = stepUp(xhigh, IDS_BY_KEY)!
    expect(xhigh).toMatchObject({ tier: 'opus', effort: 'xhigh' })
    expect(max).toMatchObject({ tier: 'opus', effort: 'max' })
    expect(stepUp(max, IDS_BY_KEY)).toBeUndefined()
    // a sonnet parent caps a sonnet agent the same way: no opus, effort only
    const capped = startOf('sonnet', 'claude-sonnet-5-5', true, IDS_BY_KEY)
    expect(stepUp({ ...capped, retriedAtTier: true }, IDS_BY_KEY)).toMatchObject({ tier: 'sonnet', effort: 'high' })
  })

  test('an agent that inherits the session effort counts as high, so its first step is xhigh on the same model', async () => {
    const inheriting = startOf(OPUS, OPUS, false, IDS_BY_KEY)
    expect(inheriting.effort).toBeUndefined()
    expect(stepUp(inheriting, IDS_BY_KEY)).toMatchObject({ tier: 'opus', model: undefined, effort: 'xhigh', retriedAtTier: true })
  })

  test('a manual effort-only escalate keeps the model and the retry flag; a model change resets the flag', async () => {
    const retried = stepUp(startOf('haiku', OPUS, true, IDS_BY_KEY), IDS_BY_KEY)!
    expect(escalateAgent(retried, { effort: 'high' }, IDS_BY_KEY)).toMatchObject({ tier: 'haiku', model: IDS_BY_KEY.haiku, effort: 'high', retriedAtTier: true })
    expect(escalateAgent(retried, { model: 'sonnet' }, IDS_BY_KEY)).toMatchObject({ tier: 'sonnet', retriedAtTier: false })
  })

  test('the events log lands in ~/.claude/model-tiering wherever the plugin is installed under ~/.claude', async () => {
    expect(logDir('C:\\Users\\me\\.claude\\plugins\\cache\\model-router')).toBe('C:/Users/me/.claude/model-tiering')
    expect(logDir('/home/me/.claude/plugins/x/model-router/0.3.0')).toBe('/home/me/.claude/model-tiering')
  })
})

test('Explore runs on haiku at low effort from its first request, keeping the context suffix; main is untouched', async ($, on) => {
  const seen = world($, on, null)
  const id = await spawnAgent($, { subagentType: 'Explore' })
  await step($, 'sub', 'claude-opus-5-5[1m]', id)
  await step($, 'other', 'claude-opus-5-5[1m]')
  expect(seen.agents).toEqual(['haiku'])
  expect(seen.steps[0]).toEqual({ model: 'claude-haiku-5-5[1m]', effort: 'low', agentId: id })
  expect(seen.steps[1]).toEqual({ model: 'claude-opus-5-5[1m]', effort: 'high', agentId: undefined })
})

test('general-purpose is classified: lookup runs on haiku, a decision inherits the parent and its effort', async ($, on) => {
  const seen = world($, on, ['{"tier":"lookup","reason":"find"}', '{"tier":"decide","reason":"audit"}'])
  const lookup = await spawnAgent($, { prompt: 'grep for TODO' })
  const decide = await spawnAgent($, { prompt: 'audit the save system for exploits' })
  await step($, 'sub', OPUS, lookup)
  await step($, 'sub', OPUS, decide)
  expect(seen.agents).toEqual(['haiku', undefined])
  expect(seen.steps[0]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'low' })
  expect(seen.steps[1]).toMatchObject({ model: OPUS, effort: 'high' })
})

test('a classifier failure sends general-purpose to sonnet at medium, not to the parent', async ($, on) => {
  const seen = world($, on, null)
  const id = await spawnAgent($)
  await step($, 'sub', OPUS, id)
  expect(seen.agents).toEqual(['sonnet'])
  expect(seen.steps[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' })
})

test('a named agent declares its own model: the router neither classifies nor rewrites it', async ($, on) => {
  const seen = world($, on, '{"tier":"lookup","reason":"x"}')
  const id = await spawnAgent($, { subagentType: 'thorough-reviewer' })
  await step($, 'sub', 'claude-sonnet-5-5', id)
  expect(seen.asked).toEqual([])
  expect(seen.agents).toEqual([undefined])
  expect(seen.steps[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' })
})

test('a sonnet parent never gets an opus subagent: the cap holds for named models and for escalation', async ($, on) => {
  const seen = world($, on, null)
  await spawnAgent($, { model: 'opus', parentModel: 'claude-sonnet-5-5' })
  expect(seen.agents).toEqual(['sonnet'])
  const id = await spawnAgent($, { subagentType: 'Explore', parentModel: 'claude-sonnet-5-5' })
  const up = (await $.tool.call({ tool: 'mcp__model-router__escalate', agentId: id, model: 'opus', reason: 'hard' } as never)) as { result: string }
  expect(up.result).toBe('Escalated to sonnet/medium from your next step.')
  const again = (await $.tool.call({ tool: 'mcp__model-router__escalate', agentId: id, model: 'opus', reason: 'harder' } as never)) as { result: string }
  expect(again.result).toContain('the ceiling is sonnet')
  await step($, 'sub', 'claude-sonnet-5-5', id)
  expect(seen.steps[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' })
})

test('a Fable parent hands opus to subagents and the block is counted', async ($, on) => {
  const seen = world($, on, '{"tier":"decide","reason":"audit"}')
  await spawnAgent($, { parentModel: 'claude-fable-5-1' })
  expect(seen.agents).toEqual(['opus'])
  const r = (await $.command.run({ command: 'model-router', args: 'stats' } as never)) as { text: string }
  expect(r.text).toContain('Fable requests moved to Opus: 1')
  expect(r.text).toContain('opus 1')
})

test('subagent escalation applies from its next request, so the request after the call is what changes', async ($, on) => {
  const seen = world($, on, null)
  const id = await spawnAgent($, { subagentType: 'Explore' })
  await step($, 'sub', OPUS, id)
  const r = (await $.tool.call({ tool: 'mcp__model-router__escalate', agentId: id, model: 'sonnet', effort: 'high', reason: 'results contradict' } as never)) as { result: string }
  expect(r.result).toBe('Escalated to sonnet/high from your next step.')
  await step($, 'sub', OPUS, id)
  expect(seen.steps[0]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'low' })
  expect(seen.steps[1]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' })
})

test('an unknown subagent cannot move the main route when it escalates', async ($, on) => {
  const seen = world($, on, '{"tier":"lookup","reason":"找文件"}')
  await $.prompt.submit({ text: 'find files' } as never)
  const r = (await $.tool.call({ tool: 'mcp__model-router__escalate', agentId: 'ghost', model: 'opus', reason: 'x' } as never)) as { result: string }
  expect(r.result).toContain('No routed agent')
  await step($, 't1')
  expect(seen.steps[0]).toMatchObject({ model: 'claude-haiku-5-5[1m]', effort: 'low' })
})

// Changed from v0.3: the first auto-escalation is now effort on the same model (haiku/low -> haiku/medium);
// the model switch comes with the second run of three errors.
test('three tool errors in a row raise a subagent one step; a success in between starts the count over', async ($, on) => {
  const seen = world($, on, null)
  on('tool.call', async (_$: unknown, e: any) => ({ result: 'out', isError: e.file_path === 'bad' }) as never)
  const id = await spawnAgent($, { subagentType: 'Explore' })
  const read = (file: string) => $.tool.call({ tool: 'Read', file_path: file, agentId: id } as never)
  await read('bad')
  await read('bad')
  await read('ok')
  await read('bad')
  await read('bad')
  await step($, 'sub', OPUS, id)
  expect(seen.steps[0]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'low' })
  await read('bad')
  await step($, 'sub', OPUS, id)
  expect(seen.steps[1]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'medium' })
})

test('the second run of three errors raises the model; the log says which stage fired', async ($, on) => {
  const seen = world($, on, null)
  on('tool.call', async (_$: unknown, e: any) => ({ result: 'out', isError: e.file_path === 'bad' }) as never)
  const id = await spawnAgent($, { subagentType: 'Explore' })
  const bad = () => $.tool.call({ tool: 'Read', file_path: 'bad', agentId: id } as never)
  for (let i = 0; i < 3; i++) await bad()
  await step($, 'sub', OPUS, id)
  for (let i = 0; i < 3; i++) await bad()
  await step($, 'sub', OPUS, id)
  expect(seen.steps[0]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'medium' })
  expect(seen.steps[1]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' })
  const file = Object.keys(seen.files).find(k => k.replaceAll('\\', '/').endsWith('/model-tiering/events-sess-1.json'))
  const log = JSON.parse(seen.files[file!]!) as { events: { event: string; to: string; reason: string }[] }
  expect(log.events.filter(ev => ev.event === 'auto-escalated')).toMatchObject([
    { to: 'haiku/medium', reason: '3 tool errors in a row: more effort on the same model' },
    { to: 'sonnet/medium', reason: '3 tool errors in a row again: next model' },
  ])
})

test('a subagent can raise only its effort by hand: the model stays', async ($, on) => {
  const seen = world($, on, null)
  const id = await spawnAgent($, { subagentType: 'Explore' })
  const r = (await $.tool.call({ tool: 'mcp__model-router__escalate', agentId: id, effort: 'high', reason: 'needs more thought' } as never)) as { result: string }
  expect(r.result).toBe('Escalated to haiku/high from your next step.')
  await step($, 'sub', OPUS, id)
  expect(seen.steps[0]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'high' })
})

test('an unsure turn after a decide turn stays on opus: low confidence never downgrades', async ($, on) => {
  const seen = world($, on, ['{"tier":"decide","sure":true,"reason":"选方案"}', '{"tier":"execute","sure":false,"reason":"不确定"}'])
  await $.prompt.submit({ text: 'which design' } as never)
  await $.prompt.submit({ text: 'ok, and the rest?' } as never)
  expect(seen.submits[1]!.context?.[0]).toContain('assigned to opus at high')
  await step($, 't2')
  expect(seen.steps[0]).toMatchObject({ model: 'claude-opus-5-5[1m]', effort: 'high' })
  const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ text: /unsure: not downgrading/ })).toBeDefined()
})

test('a sure downgrade still happens', async ($, on) => {
  const seen = world($, on, ['{"tier":"decide","sure":true,"reason":"a"}', '{"tier":"execute","sure":true,"reason":"b"}'])
  await $.prompt.submit({ text: 'which design' } as never)
  await $.prompt.submit({ text: 'implement it' } as never)
  expect(seen.submits[1]!.context?.[0]).toContain('assigned to sonnet at medium')
})

test('an unsure first turn never starts on lookup', async ($, on) => {
  const seen = world($, on, '{"tier":"lookup","sure":false,"reason":"maybe a search"}')
  await $.prompt.submit({ text: 'look into the auth thing' } as never)
  expect(seen.submits[0]!.context?.[0]).toContain('assigned to sonnet at medium')
})

test('an unsure general-purpose lookup subagent runs on sonnet, a sure one on haiku', async ($, on) => {
  const seen = world($, on, ['{"tier":"lookup","sure":false,"reason":"maybe"}', '{"tier":"lookup","sure":true,"reason":"grep"}'])
  const unsure = await spawnAgent($, { prompt: 'look into the config' })
  const sure = await spawnAgent($, { prompt: 'grep for TODO' })
  await step($, 'sub', OPUS, unsure)
  await step($, 'sub', OPUS, sure)
  expect(seen.agents).toEqual(['sonnet', 'haiku'])
  expect(seen.steps[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' })
  expect(seen.steps[1]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'low' })
})

test('#haiku still wins when the classifier would have been unsure, and the classifier is not asked', async ($, on) => {
  const seen = world($, on, '{"tier":"decide","sure":false,"reason":"maybe"}')
  await $.prompt.submit({ text: 'list the files #haiku' } as never)
  expect(seen.asked).toEqual([])
  expect(seen.submits[0]!.context?.[0]).toContain('assigned to haiku at low')
})

test('a model the router asked for that is not the one answering is counted as a mismatch', async ($, on) => {
  const seen = world($, on, null)
  const id = await spawnAgent($, { subagentType: 'Explore' })
  seen.usage.push(U(10, 1, 0, 0, 'claude-haiku-5-5'))
  await step($, 'sub', OPUS, id)
  let r = (await $.command.run({ command: 'model-router', args: 'stats' } as never)) as { text: string }
  expect(r.text).toContain('the one that answered: 0')
  seen.usage.push(U(10, 1, 0, 0, 'claude-opus-5-5'))
  await step($, 'sub', OPUS, id)
  r = (await $.command.run({ command: 'model-router', args: 'stats' } as never)) as { text: string }
  expect(r.text).toContain('the one that answered: 1')
})

test('main routes and subagent changes land in the events file the weekly report reads', async ($, on) => {
  const seen = world($, on, '{"tier":"lookup","reason":"找文件"}')
  await $.prompt.submit({ text: 'find files' } as never)
  const id = await spawnAgent($, { subagentType: 'Explore' })
  seen.usage.push(U(10, 1, 0, 0, 'claude-haiku-5-5'))
  await step($, 'sub', OPUS, id)
  await $.tool.call({ tool: 'mcp__model-router__escalate', agentId: id, model: 'sonnet', reason: 'contradiction' } as never)
  const file = Object.keys(seen.files).find(k => k.replaceAll('\\', '/').endsWith('/model-tiering/events-sess-1.json'))
  const log = JSON.parse(seen.files[file!]!) as { sessionId: string; events: { agentId: string; event: string; to: string; reason: string }[]; stats: Record<string, unknown> }
  expect(log.sessionId).toBe('sess-1')
  expect(log.events).toMatchObject([
    { agentId: 'main', event: 'turn route', to: 'haiku/low', reason: '找文件' },
    { agentId: id, event: 'Explore start', to: 'haiku/low' },
    { agentId: id, event: 'escalated', to: 'sonnet/medium', reason: 'contradiction' },
  ])
  expect(log.stats[id]).toEqual({ byModel: { 'claude-haiku-5-5': { steps: 1, input: 10, output: 1, cacheRead: 0, cacheWrite: 0 } }, byEffort: { low: 1 } })
})

test('parallel subagent steps all land on the meter, and the turn includes the classifier call', { options: { language: 'zh' } }, async ($, on) => {
  const seen = world($, on, '{"tier":"execute","reason":"实现"}')
  await $.prompt.submit({ text: 'build it' } as never)
  for (let i = 0; i < 5; i++) seen.usage.push(U(1000, 0, 0, 0, 'claude-sonnet-5-5'))
  await Promise.all([0, 1, 2, 3, 4].map(i => step($, 'sub', 'claude-sonnet-5-5', `agent-${i}`)))
  const r = (await $.command.run({ command: 'model-router', args: 'stats' } as never)) as { text: string }
  expect(r.text).toContain('| sonnet | 5.0k |')
  const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ text: /本轮 5\.0k token/ })).toBeDefined()
})

test('the band speaks English by default', async ($, on) => {
  const seen = world($, on, '{"tier":"lookup","reason":"find files"}')
  await $.prompt.submit({ text: 'find files' } as never)
  seen.usage.push(U(1000, 200, 20_000, 0, 'claude-haiku-5-5'))
  await step($, 't1')
  const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ text: /Haiku · low — find files/ })).toBeDefined()
  expect(await ui.find({ text: /turn 21\.2k token · / })).toBeDefined()
  expect(await ui.find({ text: /today 21\.2k token · / })).toBeDefined()
  expect(await ui.find({ text: /saved ≈/ })).toBeDefined()
  expect(await ui.find({ text: /vs all on Opus/ })).toBeDefined()
})

test('a classifier failure reads in English by default and in Chinese on request', async ($, on) => {
  world($, on, null)
  await $.prompt.submit({ text: 'do the thing' } as never)
  const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ text: /classifier failed, defaulted to Sonnet/ })).toBeDefined()
})

test('language zh gives the Chinese band', { options: { language: 'zh' } }, async ($, on) => {
  world($, on, null)
  await $.prompt.submit({ text: 'do the thing' } as never)
  const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ text: /分类失败，默认 Sonnet/ })).toBeDefined()
})
