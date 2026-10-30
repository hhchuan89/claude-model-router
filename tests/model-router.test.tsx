import { describe, expect, mock, test } from 'claude-code/testing'

import { add, baselineOf, CACHE_TTL_MS, costOf, EMPTY, fmtUsd, isSwitchStep, keepWarm, saved, WARM_CONTEXT_KEEP } from '../hooks/meter'
import { applyEscalation, assignmentContext, classifierSystem, forcedModel, isFable, parseDecision, routeFor, settleTier, shorten, withSuffixOf } from '../hooks/route'
import { capSent, decideSpawn, escalateAgent, HARD_EFFORT_CAP, isCallerPin, logDir, MAIN_RAISE_CAP, SELF_EFFORT_CAP, startOf, stepUp, SUBAGENT_SELF_CAP } from '../hooks/subagent'

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

  // Seen in the band on 2026-10-26: "…scope of repo changes u (unsure: not downgrading)", a word sliced in half.
  test('a long reason is cut at a word boundary with an ellipsis, never mid-word', async () => {
    const long = 'Carrying out an agreed cleanup plan; scope of repo changes unclear'
    const out = shorten(long, 60)
    expect(out).toBe('Carrying out an agreed cleanup plan; scope of repo changes…')
    expect(out.length).toBeLessThanOrEqual(60)
    expect(parseDecision(`{"tier":"decide","reason":"${long}"}`)?.reason).toBe(out)
  })

  test('a short reason is left alone; one very long word is cut where it stands', async () => {
    expect(shorten('  find the file  ', 60)).toBe('find the file')
    expect(shorten('x'.repeat(80), 60)).toBe(`${'x'.repeat(59)}…`)
    expect(shorten('架构取舍'.repeat(20), 60).length).toBe(60)
  })

  test('an escalation reason on the band is cut the same way', async () => {
    const cur = routeFor('execute', 'x')
    const out = applyEscalation(cur, { model: 'opus', reason: 'the design question turned out to need a real trade-off decision first' })
    expect(out.ok && out.route.trail[0]).toBe('opus · medium (the design question turned out to need a real trade-off…)')
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

    // A decide route now starts at medium, so raise it to high first: lowering must be proved from above.
    const raised = applyEscalation(routeFor('decide', ''), { effort: 'high', reason: 'multi-step design' })
    expect(raised.ok && raised.route.effort).toBe('high')
    const opus = raised.ok ? raised.route : routeFor('decide', '')
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
    expect(text).toContain('haiku at medium effort')
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

type Seen = { clock: { advance: (ms: number) => Promise<void> }; submits: { text: string; context?: readonly string[] }[]; steps: { model: string; effort?: unknown; agentId?: string }[]; asked: string[]; maxTokens: (number | undefined)[]; prompts: string[]; usage: any[]; agents: (string | undefined)[]; files: Record<string, string>; stepMs?: number }

const IDS: Record<string, string> = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' }

// null: the call timed out (aborted). { fail }: the API refused, or the reply had no text.
type Reply = string | null | { fail: 'api-error' | 'empty-reply' }

function world(
  $: any,
  on: any,
  classifier: Reply | Reply[],
  opts: { reviewer?: boolean; drop?: boolean; messages?: { role: 'user' | 'assistant'; text: string }[]; store?: Record<string, unknown> } = {},
): Seen {
  mock.store(on, opts.store)
  const seen: Seen = { clock: mock.clock(on), submits: [], steps: [], asked: [], maxTokens: [], prompts: [], usage: [], agents: [], files: {} }
  on('session.messages', async () => ({ value: (opts.messages ?? []).map(m => ({ ...m, toolUses: [] })) }))
  on('model.complete', async (_$: unknown, e: { model: string; prompt: string; maxTokens?: number }) => {
    seen.asked.push(e.model)
    seen.maxTokens.push(e.maxTokens)
    seen.prompts.push(e.prompt)
    const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    if (e.model === 'haiku') {
      const reply = Array.isArray(classifier) ? (classifier.shift() ?? null) : classifier
      if (reply !== null && typeof reply === 'object') {
        return reply.fail === 'api-error'
          ? { value: { isAnswered: false as const, reason: 'api-error' as const, status: 529, error: 'overloaded', usage } }
          : { value: { isAnswered: false as const, reason: 'empty-reply' as const, usage } }
      }
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
    // A response that takes this long to stream: the clock moves while the request is in flight.
    if (seen.stepMs) await seen.clock.advance(seen.stepMs)
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

async function step($: any, turnId: string, model = 'claude-opus-5-5[1m]', agentId?: string, effort = 'high') {
  const s = $.turn.step({ turnId, index: 0, model, effort, messageCount: 3, agentId } as never)
  for await (const _ of s) {
    // drain
  }
}

test('a lookup turn runs on Haiku at medium effort, with the assignment in context', async ($, on) => {
  const seen = world($, on, '{"tier":"lookup","reason":"找文件"}')
  await $.prompt.submit({ text: 'find every TODO in the repo' } as never)
  expect(seen.submits[0]!.context?.[0]).toContain('assigned to haiku at medium effort')
  await step($, 't1')
  expect(seen.steps[0]).toEqual({ model: 'claude-haiku-5-5[1m]', effort: 'medium', agentId: undefined })

  const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ text: /Haiku · medium — 找文件/ })).toBeDefined()
  expect(await ui.find({ text: /other mods/ })).toBeDefined()
})

// WHY: lookup work gets headroom at medium without a model switch, so a slightly harder lookup does not need Sonnet.
test('a lookup main turn starts Haiku at medium: headroom without a model switch', async ($, on) => {
  const seen = world($, on, '{"tier":"lookup","reason":"find"}')
  expect(routeFor('lookup', '')).toMatchObject({ model: 'haiku', effort: 'medium' })
  await $.prompt.submit({ text: 'grep for TODO' } as never)
  await step($, 't1')
  expect(seen.steps[0]).toMatchObject({ model: 'claude-haiku-5-5[1m]', effort: 'medium' })
})

// WHY: main decisions start at medium however the turn got to Opus (Opus picks its own effort from there), so a
// skipped Sonnet step does not carry the haiku effort over, and a higher effort still wins when it is asked.
test('main-thread escalation from haiku to opus lands at opus/medium unless a higher effort is asked', async ($, on) => {
  const seen = world($, on, '{"tier":"lookup","reason":"find"}')
  await $.prompt.submit({ text: 'look at the auth flow' } as never)
  const up = (await $.tool.call({ tool: 'mcp__model-router__escalate', model: 'opus', reason: 'design call' } as never)) as { result: string }
  expect(up.result).toContain('opus at medium')
  await step($, 't1')
  expect(seen.steps[0]).toMatchObject({ model: 'claude-opus-5-5[1m]', effort: 'medium' })
  const haiku = routeFor('lookup', '')
  const direct = applyEscalation(haiku, { model: 'opus', reason: 'x' })
  expect(direct.ok && direct.route).toMatchObject({ model: 'opus', effort: 'medium' })
  const asked = applyEscalation(haiku, { model: 'opus', effort: 'high', reason: 'x' })
  expect(asked.ok && asked.route).toMatchObject({ model: 'opus', effort: 'high' })
})

test('the running model escalates itself, and the next step follows; downgrades are refused', async ($, on) => {
  const seen = world($, on, '{"tier":"lookup","reason":"找文件"}')
  await $.prompt.submit({ text: 'look at the auth flow' } as never)
  await step($, 't1')
  const up = (await $.tool.call({ tool: 'mcp__model-router__escalate', model: 'opus', reason: '要做设计决策' } as never)) as { result: string }
  expect(up.result).toContain('opus at medium')
  await step($, 't1')
  expect(seen.steps[1]).toEqual({ model: 'claude-opus-5-5[1m]', effort: 'medium', agentId: undefined })
  const down = (await $.tool.call({ tool: 'mcp__model-router__escalate', model: 'sonnet', reason: 'x' } as never)) as { result: string }
  expect(down.result).toContain('Not changed')

  const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ text: /Haiku · medium → opus · medium \(要做设计决策\)/ })).toBeDefined()
})

test('Fable 5.1 never runs, not even in a subagent; other subagent models are left alone', async ($, on) => {
  const seen = world($, on, '{"tier":"execute","reason":"实现"}')
  await step($, 'other', 'claude-fable-5-1[1m]', 'agent-1')
  await step($, 'other', 'claude-sonnet-5-5', 'agent-2')
  expect(seen.steps[0]!.model).toBe('claude-opus-5-5[1m]')
  expect(seen.steps[1]!.model).toBe('claude-sonnet-5-5')
})

// Changed from v0.6 ("falls back to Sonnet at medium"): 24% of the turns that fell back later escalated to Opus
// (6% of classified ones), so a failed first classification now leaves the turn on the session's own model.
test('a classifier failure on the first turn leaves the turn unrouted: the session model and effort, no assignment', async ($, on) => {
  const seen = world($, on, null)
  await $.prompt.submit({ text: 'do the thing' } as never)
  expect(seen.submits[0]!.context).toBeUndefined()
  await step($, 't1')
  expect(seen.steps[0]).toEqual({ model: 'claude-opus-5-5[1m]', effort: 'high', agentId: undefined })
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
  // The notice names the configured reviewer rather than assuming one model.
  expect(JSON.stringify(session.appended())).toContain('Decision review (claude-fable-5-5)')
})

test('the classifier context is masked too: earlier messages can hold secrets the new one does not', async ($, on) => {
  const seen = world($, on, '{"tier":"lookup","reason":"x"}', {
    messages: [
      { role: 'user', text: `here is the key sk-ant-api03-${'z'.repeat(30)} for staging` },
      { role: 'assistant', text: 'noted' },
    ],
  })
  await $.prompt.submit({ text: 'and now list the files' } as never)
  expect(seen.prompts[0]).toContain('[REDACTED')
  expect(seen.prompts[0]).not.toContain('zzzzzzzzzz')
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

  // Changed from v0.6: the haiku line used to follow the cost comparison; a 200k context is now never moved down.
  test('a downgrade keeps the warm model only when the cold read costs more', async () => {
    const shape = { steps: 5, output: 1000 }
    const warm = { model: 'opus' as const, at: 0, context: 200_000 }
    expect(keepWarm('sonnet', warm, 60_000, shape)).toBe('opus')
    expect(keepWarm('haiku', warm, 60_000, shape)).toBe('opus')
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
  // Changed in v0.8.2: the context is past WARM_CONTEXT_KEEP, so the classifier is skipped and the turn is Opus outright
  // (it used to be classified execute, then kept on Opus: "Sonnet → Opus (保缓存)").
  expect(await ui.find({ text: /Opus · medium — 大上下文缓存仍热：跳过分类/ })).toBeDefined()
  expect(seen.asked).toEqual(['haiku'])
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
    expect(haiku).toMatchObject({ tier: 'haiku', effort: 'medium', model: IDS_BY_KEY.haiku })
    expect(escalateAgent(haiku, { model: 'sonnet' }, IDS_BY_KEY)).toMatchObject({ tier: 'sonnet', effort: 'medium' })
    expect(escalateAgent(startOf('sonnet', OPUS, true, IDS_BY_KEY), { model: 'haiku', effort: 'low' }, IDS_BY_KEY)).toBeUndefined()
    // Every tier starts at medium, so a raised model starts at medium too.
    expect(escalateAgent(haiku, { model: 'opus' }, IDS_BY_KEY)).toMatchObject({ tier: 'opus', effort: 'medium' })
    expect(escalateAgent(startOf('haiku', 'claude-sonnet-5-5', true, IDS_BY_KEY), { model: 'opus' }, IDS_BY_KEY)?.tier).toBe('sonnet')
    expect(escalateAgent(startOf('haiku', 'claude-fable-5-1', true, IDS_BY_KEY), { model: 'fable' }, IDS_BY_KEY)?.tier).toBe('opus')
  })

  // Changed from v0.3 ("tier first, then effort"): the first step is now more effort on the same model.
  test('the first step up is more effort on the same model: cheaper than a switch, and often enough', async () => {
    const haiku = startOf('haiku', OPUS, true, IDS_BY_KEY)
    expect(stepUp(haiku, IDS_BY_KEY)).toMatchObject({ tier: 'haiku', model: IDS_BY_KEY.haiku, effort: 'high', retriedAtTier: true })
  })

  test('the second step up raises the model at the new tier starting effort, and the new tier gets its own retry', async () => {
    const retried = stepUp(startOf('haiku', OPUS, true, IDS_BY_KEY), IDS_BY_KEY)!
    const sonnet = stepUp(retried, IDS_BY_KEY)!
    expect(sonnet).toMatchObject({ tier: 'sonnet', model: IDS_BY_KEY.sonnet, effort: 'medium', retriedAtTier: false })
    expect(stepUp(sonnet, IDS_BY_KEY)).toMatchObject({ tier: 'sonnet', effort: 'high', retriedAtTier: true })
    // opus starts at medium like every tier: a sonnet agent already on high does not carry that effort over
    const sonnetRetried = { ...stepUp(sonnet, IDS_BY_KEY)!, retriedAtTier: true }
    expect(stepUp(sonnetRetried, IDS_BY_KEY)).toMatchObject({ tier: 'opus', effort: 'medium', retriedAtTier: false })
  })

  // WHY: hard judgement belongs to the main conversation, which verifies what subagents return; a subagent that keeps
  // failing reports back instead of thinking longer, so its own ladder ends at opus/medium.
  test('the automatic ladder ends at opus/medium: no effort step on opus, and nothing above', async () => {
    expect(SUBAGENT_SELF_CAP).toEqual({ model: 'opus', effort: 'medium' })
    expect(SELF_EFFORT_CAP).toEqual({ haiku: 'high', sonnet: 'high', opus: 'medium' })
    const walk: string[] = []
    let cur: ReturnType<typeof startOf> | undefined = startOf('haiku', OPUS, true, IDS_BY_KEY)
    while (cur) {
      walk.push(`${cur.tier}/${cur.effort}`)
      cur = stepUp(cur, IDS_BY_KEY)
    }
    expect(walk).toEqual(['haiku/medium', 'haiku/high', 'sonnet/medium', 'sonnet/high', 'opus/medium'])
    // a sonnet parent caps the ladder at sonnet's own last step
    const sonnet = startOf('sonnet', 'claude-sonnet-5-5', true, IDS_BY_KEY)
    const high = stepUp(sonnet, IDS_BY_KEY)!
    expect(high).toMatchObject({ tier: 'sonnet', effort: 'high' })
    expect(stepUp(high, IDS_BY_KEY)).toBeUndefined()
  })

  // WHY: an inheriting agent counts as high, which is already above opus's self cap, so it has no effort step left.
  test('an agent that inherits the session effort counts as high: on opus it has nowhere to go by itself', async () => {
    const inheriting = startOf(OPUS, OPUS, false, IDS_BY_KEY)
    expect(inheriting.effort).toBeUndefined()
    expect(stepUp(inheriting, IDS_BY_KEY)).toBeUndefined()
    expect(escalateAgent(inheriting, { effort: 'xhigh' }, IDS_BY_KEY)).toBeUndefined()
    // an inherited sonnet (a named agent) can still move to opus at medium
    expect(stepUp(startOf('claude-sonnet-5-5', OPUS, false, IDS_BY_KEY), IDS_BY_KEY)).toMatchObject({ tier: 'opus', model: IDS_BY_KEY.opus, effort: 'medium' })
  })

  test('a manual effort-only escalate keeps the model and the retry flag; a model change resets the flag', async () => {
    const retried = stepUp(startOf('haiku', OPUS, true, IDS_BY_KEY), IDS_BY_KEY)!
    const fresh = startOf('haiku', OPUS, true, IDS_BY_KEY)
    expect(escalateAgent({ ...fresh, retriedAtTier: true }, { effort: 'high' }, IDS_BY_KEY)).toMatchObject({ tier: 'haiku', model: IDS_BY_KEY.haiku, effort: 'high', retriedAtTier: true })
    // xhigh is above a subagent's own cap: the request changes nothing
    expect(escalateAgent(retried, { effort: 'xhigh' }, IDS_BY_KEY)).toBeUndefined()
    expect(escalateAgent(retried, { model: 'sonnet' }, IDS_BY_KEY)).toMatchObject({ tier: 'sonnet', retriedAtTier: false })
  })

  // WHY: effort is the cheap lever and can be raised later, but a bigger model at medium beats a smaller one at max,
  // so a model change throws away the old model's effort instead of carrying it over.
  test('a haiku at high raised to sonnet runs sonnet at medium: effort resets on a model change', async () => {
    const haiku = startOf('haiku', OPUS, true, IDS_BY_KEY)
    const high = escalateAgent(haiku, { effort: 'high' }, IDS_BY_KEY)!
    expect(high).toMatchObject({ tier: 'haiku', effort: 'high' })
    expect(escalateAgent(high, { model: 'sonnet' }, IDS_BY_KEY)).toMatchObject({ tier: 'sonnet', model: IDS_BY_KEY.sonnet, effort: 'medium', retriedAtTier: false })
  })

  // WHY: resetting to medium must not swallow a deliberate request for more thought on the new model.
  test('an asked effort above medium on a model escalation is honoured: sonnet plus high is sonnet at high', async () => {
    const haiku = startOf('haiku', OPUS, true, IDS_BY_KEY)
    expect(escalateAgent(haiku, { model: 'sonnet', effort: 'high' }, IDS_BY_KEY)).toMatchObject({ tier: 'sonnet', effort: 'high' })
    expect(escalateAgent(haiku, { model: 'sonnet', effort: 'low' }, IDS_BY_KEY)).toMatchObject({ tier: 'sonnet', effort: 'medium' })
  })

  // WHY: the automatic ladder spends effort before it spends a model switch, and the new model starts fresh at medium.
  test('the automatic ladder from haiku/medium is haiku/high first, then sonnet/medium', async () => {
    const start = startOf('haiku', OPUS, true, IDS_BY_KEY)
    expect(start).toMatchObject({ tier: 'haiku', effort: 'medium' })
    const first = stepUp(start, IDS_BY_KEY)!
    expect(first).toMatchObject({ tier: 'haiku', effort: 'high', retriedAtTier: true })
    expect(stepUp(first, IDS_BY_KEY)).toMatchObject({ tier: 'sonnet', model: IDS_BY_KEY.sonnet, effort: 'medium', retriedAtTier: false })
  })

  test('the events log lands in ~/.claude/model-router wherever the plugin is installed under ~/.claude', async () => {
    expect(logDir('C:\\Users\\me\\.claude\\plugins\\cache\\model-router')).toBe('C:/Users/me/.claude/model-router')
    expect(logDir('/home/me/.claude/plugins/x/model-router/0.3.0')).toBe('/home/me/.claude/model-router')
  })
})

test('Explore runs on haiku at medium effort from its first request, keeping the context suffix; main is untouched', async ($, on) => {
  const seen = world($, on, null)
  const id = await spawnAgent($, { subagentType: 'Explore' })
  await step($, 'sub', 'claude-opus-5-5[1m]', id)
  await step($, 'other', 'claude-opus-5-5[1m]')
  expect(seen.agents).toEqual(['haiku'])
  expect(seen.steps[0]).toEqual({ model: 'claude-haiku-5-5[1m]', effort: 'medium', agentId: id })
  expect(seen.steps[1]).toEqual({ model: 'claude-opus-5-5[1m]', effort: 'high', agentId: undefined })
})

test('general-purpose is classified: lookup runs on haiku, a decision inherits the parent and its effort', async ($, on) => {
  const seen = world($, on, ['{"tier":"lookup","reason":"find"}', '{"tier":"decide","reason":"audit"}'])
  const lookup = await spawnAgent($, { prompt: 'grep for TODO' })
  const decide = await spawnAgent($, { prompt: 'audit the save system for exploits' })
  await step($, 'sub', OPUS, lookup)
  await step($, 'sub', OPUS, decide)
  expect(seen.agents).toEqual(['haiku', undefined])
  expect(seen.steps[0]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'medium' })
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
  expect(seen.steps[0]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'medium' })
  expect(seen.steps[1]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' })
})

test('an unknown subagent cannot move the main route when it escalates', async ($, on) => {
  const seen = world($, on, '{"tier":"lookup","reason":"找文件"}')
  await $.prompt.submit({ text: 'find files' } as never)
  const r = (await $.tool.call({ tool: 'mcp__model-router__escalate', agentId: 'ghost', model: 'opus', reason: 'x' } as never)) as { result: string }
  expect(r.result).toContain('No routed agent')
  await step($, 't1')
  expect(seen.steps[0]).toMatchObject({ model: 'claude-haiku-5-5[1m]', effort: 'medium' })
})

// Changed from v0.3: the first auto-escalation is now effort on the same model (haiku/medium -> haiku/high);
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
  expect(seen.steps[0]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'medium' })
  await read('bad')
  await step($, 'sub', OPUS, id)
  expect(seen.steps[1]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'high' })
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
  expect(seen.steps[0]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'high' })
  expect(seen.steps[1]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' })
  const file = Object.keys(seen.files).find(k => k.replaceAll('\\', '/').endsWith('/model-router/events-sess-1.json'))
  const log = JSON.parse(seen.files[file!]!) as { events: { event: string; to: string; reason: string }[] }
  expect(log.events.filter(ev => ev.event === 'auto-escalated')).toMatchObject([
    { to: 'haiku/high', reason: '3 tool errors in a row: more effort on the same model' },
    { to: 'sonnet/medium', reason: '3 tool errors in a row again: next model' },
  ])
})

test('a subagent can raise only its effort by hand: the model stays, and effort stops at high on haiku', async ($, on) => {
  const seen = world($, on, null)
  const id = await spawnAgent($, { subagentType: 'Explore' })
  const r = (await $.tool.call({ tool: 'mcp__model-router__escalate', agentId: id, effort: 'xhigh', reason: 'needs more thought' } as never)) as { result: string }
  expect(r.result).toBe('Escalated to haiku/high from your next step.')
  await step($, 'sub', OPUS, id)
  expect(seen.steps[0]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'high' })
})

test('an unsure turn after a decide turn stays on opus: low confidence never downgrades', async ($, on) => {
  const seen = world($, on, ['{"tier":"decide","sure":true,"reason":"选方案"}', '{"tier":"execute","sure":false,"reason":"不确定"}'])
  await $.prompt.submit({ text: 'which design' } as never)
  await $.prompt.submit({ text: 'ok, and the rest?' } as never)
  expect(seen.submits[1]!.context?.[0]).toContain('assigned to opus at medium')
  await step($, 't2')
  expect(seen.steps[0]).toMatchObject({ model: 'claude-opus-5-5[1m]', effort: 'medium' })
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
  expect(seen.steps[1]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'medium' })
})

test('#haiku still wins when the classifier would have been unsure, and the classifier is not asked', async ($, on) => {
  const seen = world($, on, '{"tier":"decide","sure":false,"reason":"maybe"}')
  await $.prompt.submit({ text: 'list the files #haiku' } as never)
  expect(seen.asked).toEqual([])
  expect(seen.submits[0]!.context?.[0]).toContain('assigned to haiku at medium')
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

test('main routes and subagent changes land in the events file in ~/.claude/model-router', async ($, on) => {
  const seen = world($, on, '{"tier":"lookup","reason":"找文件"}')
  await $.prompt.submit({ text: 'find files' } as never)
  const id = await spawnAgent($, { subagentType: 'Explore' })
  seen.usage.push(U(10, 1, 0, 0, 'claude-haiku-5-5'))
  await step($, 'sub', OPUS, id)
  await $.tool.call({ tool: 'mcp__model-router__escalate', agentId: id, model: 'sonnet', reason: 'contradiction' } as never)
  const file = Object.keys(seen.files).find(k => k.replaceAll('\\', '/').endsWith('/model-router/events-sess-1.json'))
  const log = JSON.parse(seen.files[file!]!) as { sessionId: string; events: { agentId: string; event: string; to: string; reason: string }[]; stats: Record<string, unknown> }
  expect(log.sessionId).toBe('sess-1')
  expect(log.events).toMatchObject([
    { agentId: 'main', event: 'turn route', to: 'haiku/medium', reason: '找文件' },
    { agentId: id, event: 'Explore start', to: 'haiku/medium' },
    { agentId: id, event: 'escalated', to: 'sonnet/medium', reason: 'contradiction' },
  ])
  expect(log.stats[id]).toEqual({ byModel: { 'claude-haiku-5-5': { steps: 1, input: 10, output: 1, cacheRead: 0, cacheWrite: 0 } }, byEffort: { medium: 1 } })
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
  expect(await ui.find({ text: /Haiku · medium — find files/ })).toBeDefined()
  expect(await ui.find({ text: /turn 21\.2k token · / })).toBeDefined()
  expect(await ui.find({ text: /today 21\.2k token · / })).toBeDefined()
  expect(await ui.find({ text: /saved ≈/ })).toBeDefined()
  expect(await ui.find({ text: /vs all on Opus/ })).toBeDefined()
})

// Changed from v0.6 ("classifier failed, defaulted to Sonnet"): the band names the reason and what happened instead.
test('a classifier failure reads in English by default, and names the reason', async ($, on) => {
  world($, on, ['{"tier":"decide","reason":"选方案"}', null])
  await $.prompt.submit({ text: 'which design' } as never)
  await $.prompt.submit({ text: 'do the thing' } as never)
  const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ text: /classifier failed \(timeout\): kept previous tier/ })).toBeDefined()
})

test('language zh gives the Chinese band', { options: { language: 'zh' } }, async ($, on) => {
  world($, on, ['{"tier":"decide","reason":"选方案"}', null])
  await $.prompt.submit({ text: 'which design' } as never)
  await $.prompt.submit({ text: 'do the thing' } as never)
  const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ text: /分类失败（timeout）：沿用上一档位/ })).toBeDefined()
})

// ---- v0.7: round trips, notification turns, classifier failures, honest baseline, mainRouting ----

function eventsOf(seen: Seen): { agentId: string; event: string; to: string; reason: string }[] {
  const file = Object.keys(seen.files).find(k => k.replaceAll('\\', '/').endsWith('/model-router/events-sess-1.json'))
  return (JSON.parse(seen.files[file!]!) as { events: { agentId: string; event: string; to: string; reason: string }[] }).events
}

const decide = '{"tier":"decide","sure":true,"reason":"选方案"}'
const execute = '{"tier":"execute","sure":true,"reason":"照方案实现"}'

describe('round-trip guard', () => {
  // WHY: 19 turns went back to Opus within the hour and rewrote 200k-800k tokens of Opus cache each time; that cost far
  // more than the cheaper model saved. Past this size the router does not even ask what the cheaper model would save.
  test('a warm context of WARM_CONTEXT_KEEP tokens or more is never moved down, even when the cost model says move', async () => {
    expect(WARM_CONTEXT_KEEP).toBe(50_000)
    // Output-heavy turns make the cost comparison favour Sonnet at 200k...
    const heavy = { steps: 5, output: 100_000 }
    const big = { model: 'opus' as const, at: 0, context: 200_000 }
    expect(keepWarm('sonnet', { ...big, context: WARM_CONTEXT_KEEP - 1 }, 60_000, heavy)).toBe('sonnet')
    // ...and the guard overrides it from the threshold up, for Sonnet and Haiku alike.
    expect(keepWarm('sonnet', { ...big, context: WARM_CONTEXT_KEEP }, 60_000, heavy)).toBe('opus')
    expect(keepWarm('haiku', big, 60_000, heavy)).toBe('opus')
    // A Sonnet context is guarded the same way: Haiku does not take it.
    expect(keepWarm('haiku', { ...big, model: 'sonnet' }, 60_000, heavy)).toBe('sonnet')
  })

  test('upgrades are never blocked, and a context past the TTL is cold so it may move down', async () => {
    const shape = { steps: 5, output: 1000 }
    const big = { model: 'sonnet' as const, at: 0, context: 400_000 }
    expect(keepWarm('opus', big, 60_000, shape)).toBe('opus')
    expect(keepWarm('sonnet', { ...big, model: 'opus' }, CACHE_TTL_MS, shape)).toBe('opus')
    expect(keepWarm('sonnet', { ...big, model: 'opus' }, CACHE_TTL_MS + 1, shape)).toBe('sonnet')
  })

  // WHY: below the threshold a rewrite is cheap, so the old comparison still decides: a small context moves down,
  // a mid-size one with several steps ahead of it stays.
  test('below the threshold the cost comparison still decides', async () => {
    const shape = { steps: 5, output: 1000 }
    const opus = { model: 'opus' as const, at: 0, context: 5_000 }
    expect(keepWarm('sonnet', opus, 60_000, shape)).toBe('sonnet')
    expect(keepWarm('sonnet', { ...opus, context: 40_000 }, 60_000, shape)).toBe('opus')
  })
})

test('a warm 200k-token Opus context is not downgraded to Sonnet for an execute turn', async ($, on) => {
  // Output-heavy turns: on cost alone Sonnet would win, so only the guard keeps this turn on Opus.
  const seen = world($, on, [decide, execute], { store: { shape: { steps: 5, output: 100_000 } } })
  await $.prompt.submit({ text: 'which design' } as never)
  seen.usage.push(U(2000, 800, 198_000, 0))
  await step($, 't1')
  await $.prompt.submit({ text: 'implement it' } as never)
  expect(seen.submits[1]!.context?.[0]).toContain('assigned to opus')
  await step($, 't2')
  expect(seen.steps[1]).toMatchObject({ model: 'claude-opus-5-5[1m]' })
  const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  // Changed in v0.8.2: at 200k tokens the classifier is skipped (one Haiku call, for the first prompt only) instead of
  // classifying execute and then keeping Opus warm. The Sonnet verdict is never asked for.
  expect(await ui.find({ text: /Opus · medium — warm large context: classifier skipped/ })).toBeDefined()
  expect(seen.asked).toEqual(['haiku'])
  const r = (await $.command.run({ command: 'model-router', args: 'stats' } as never)) as { text: string }
  expect(r.text).toContain('Classifier skipped (warm large Opus context): 1')
})

test('once the cache TTL has passed the same execute turn does move to Sonnet', async ($, on) => {
  const seen = world($, on, [decide, execute], { store: { shape: { steps: 5, output: 100_000 } } })
  await $.prompt.submit({ text: 'which design' } as never)
  seen.usage.push(U(2000, 800, 198_000, 0))
  await step($, 't1')
  await seen.clock.advance(CACHE_TTL_MS + 1000)
  await $.prompt.submit({ text: 'implement it' } as never)
  expect(seen.submits[1]!.context?.[0]).toContain('assigned to sonnet')
  await step($, 't2')
  expect(seen.steps[1]).toMatchObject({ model: 'claude-sonnet-5-5[1m]', effort: 'medium' })
})

describe('turns without a person prompt', () => {
  const notification = { text: '<task-notification>build finished</task-notification>', turnId: 'tn' } as never

  // WHY: a background task's notification is not a person prompt, so it was never routed and ran on the session model:
  // an extra round trip away from, and back to, the model the cache was on.
  test('a task-notification turn after a Sonnet route runs on Sonnet: it inherits, it does not fall back to the session model', async ($, on) => {
    const seen = world($, on, execute)
    await $.prompt.submit({ text: 'build it' } as never)
    seen.usage.push(U(1000, 200, 20_000, 0, 'claude-sonnet-5-5'))
    await step($, 't1')
    await $.turn.start(notification)
    await step($, 'tn')
    expect(seen.steps[1]).toEqual({ model: 'claude-sonnet-5-5[1m]', effort: 'medium', agentId: undefined })

    // Logged as an inherit, not as a route; and it is not counted as a routed turn.
    const log = eventsOf(seen)
    expect(log.filter(ev => ev.event === 'turn route')).toHaveLength(1)
    expect(log.filter(ev => ev.event === 'turn inherit')).toMatchObject([{ agentId: 'main', to: 'sonnet/medium', reason: 'continues previous route' }])
    const r = (await $.command.run({ command: 'model-router', args: 'stats' } as never)) as { text: string }
    expect(r.text).toContain('execute 1')
    const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await ui.find({ text: /Sonnet · medium — continues previous route/ })).toBeDefined()
  })

  test('an inherited turn keeps what the route had become: an escalated Opus stays Opus', async ($, on) => {
    const seen = world($, on, execute)
    await $.prompt.submit({ text: 'build it' } as never)
    await $.tool.call({ tool: 'mcp__model-router__escalate', model: 'opus', reason: 'design call' } as never)
    seen.usage.push(U(1000, 200, 20_000, 0, 'claude-opus-5-5'))
    await step($, 't1')
    await $.turn.start(notification)
    await step($, 'tn', 'claude-sonnet-5-5')
    expect(seen.steps[1]).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium' })
  })

  test('after the cache TTL an inherited turn stays unrouted: nothing warm is worth continuing', async ($, on) => {
    const seen = world($, on, execute)
    await $.prompt.submit({ text: 'build it' } as never)
    seen.usage.push(U(1000, 200, 20_000, 0, 'claude-sonnet-5-5'))
    await step($, 't1')
    await seen.clock.advance(CACHE_TTL_MS + 1000)
    await $.turn.start(notification)
    await step($, 'tn')
    expect(seen.steps[1]).toEqual({ model: 'claude-opus-5-5[1m]', effort: 'high', agentId: undefined })
    expect(eventsOf(seen).filter(ev => ev.event === 'turn inherit')).toHaveLength(0)
  })

  test('with no previous route a notification turn stays unrouted, as before', async ($, on) => {
    const seen = world($, on, execute)
    await $.turn.start(notification)
    await step($, 'tn')
    expect(seen.steps[0]).toEqual({ model: 'claude-opus-5-5[1m]', effort: 'high', agentId: undefined })
  })

  // WHY: a subagent's own turn.start is not a main turn; inheriting there would rebind the main route to the agent's id.
  test('a subagent run starting does not rebind the main route', async ($, on) => {
    const seen = world($, on, execute)
    await $.prompt.submit({ text: 'build it' } as never)
    seen.usage.push(U(1000, 200, 20_000, 0, 'claude-sonnet-5-5'))
    await step($, 't1')
    await $.turn.start({ text: 'sub task', turnId: 'ta', agentId: 'agent-1' } as never)
    expect(eventsOf(seen).filter(ev => ev.event === 'turn inherit')).toHaveLength(0)
    await step($, 't1')
    expect(seen.steps[1]).toMatchObject({ model: 'claude-sonnet-5-5[1m]', effort: 'medium' })
  })
})

describe('classifier failures', () => {
  // WHY: falling back to Sonnet on failure was wrong 24% of the time (those turns later escalated to Opus), against
  // 6% for classified turns; the previous tier is the better guess, and it never downgrades.
  test('a timeout keeps the previous tier, and the reason names timeout', async ($, on) => {
    const seen = world($, on, [decide, null])
    await $.prompt.submit({ text: 'which design' } as never)
    await $.prompt.submit({ text: 'and the rest?' } as never)
    expect(seen.submits[1]!.context?.[0]).toContain('assigned to opus at medium')
    expect(seen.submits[1]!.context?.[0]).toContain('classifier failed (timeout): kept previous tier')
    await step($, 't2')
    expect(seen.steps[0]).toMatchObject({ model: 'claude-opus-5-5[1m]', effort: 'medium' })
    expect(eventsOf(seen).at(-1)).toMatchObject({ event: 'turn route', to: 'opus/medium', reason: 'classifier failed (timeout): kept previous tier' })
  })

  test('a failure after an execute turn stays on execute: it does not drop to lookup, nor jump to the session model', async ($, on) => {
    const seen = world($, on, [execute, { fail: 'api-error' }])
    await $.prompt.submit({ text: 'build it' } as never)
    await $.prompt.submit({ text: 'now the tests' } as never)
    expect(seen.submits[1]!.context?.[0]).toContain('assigned to sonnet at medium')
    expect(seen.submits[1]!.context?.[0]).toContain('classifier failed (api-error 529)')
  })

  test('a failure on the first turn leaves it unrouted, says so on the band, and is not a previous tier for the next turn', async ($, on) => {
    const seen = world($, on, [null, execute])
    await $.prompt.submit({ text: 'do the thing' } as never)
    const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await ui.find({ text: /classifier failed \(timeout\): session model/ })).toBeDefined()
    expect(eventsOf(seen).at(-1)).toMatchObject({ event: 'turn route', to: 'session model' })
    // An unrouted turn gives the escalate tool nothing to change.
    const up = (await $.tool.call({ tool: 'mcp__model-router__escalate', model: 'opus', reason: 'x' } as never)) as { result: string }
    expect(up.result).toContain('No routed turn')
    await $.prompt.submit({ text: 'build it' } as never)
    expect(seen.prompts[1]).toContain('<previous_tier>none</previous_tier>')
  })

  test('failures are counted by reason and shown in /model-router stats', async ($, on) => {
    world($, on, [null, { fail: 'api-error' }, { fail: 'empty-reply' }, 'no json here', null])
    for (const text of ['one', 'two', 'three', 'four', 'five']) await $.prompt.submit({ text } as never)
    const r = (await $.command.run({ command: 'model-router', args: 'stats' } as never)) as { text: string }
    expect(r.text).toContain('Classifier failures: timeout ×2 · ')
    expect(r.text).toContain('api-error 529 ×1')
    expect(r.text).toContain('empty-reply ×1')
    expect(r.text).toContain('unparseable ×1')
  })

  test('stats say none when nothing failed', async ($, on) => {
    world($, on, execute)
    await $.prompt.submit({ text: 'build it' } as never)
    const r = (await $.command.run({ command: 'model-router', args: 'stats' } as never)) as { text: string }
    expect(r.text).toContain('Classifier failures: none.')
  })

  test('a subagent classifier failure still runs on sonnet, records the reason in its start event, and is counted', async ($, on) => {
    const seen = world($, on, null)
    const id = await spawnAgent($)
    expect(seen.agents).toEqual(['sonnet'])
    expect(eventsOf(seen)).toMatchObject([{ agentId: id, event: 'general-purpose start', to: 'sonnet/medium', reason: 'classifier failed (timeout), sonnet' }])
    const r = (await $.command.run({ command: 'model-router', args: 'stats' } as never)) as { text: string }
    expect(r.text).toContain('timeout ×1')
  })
})

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9

describe('honest meter baseline', () => {
  // WHY: staying on Opus all along would have read the context from a warm cache; a switch step's cache writes exist
  // only because of the switch, so they must not be priced as writes in the "all on Opus" baseline.
  test('a switch step prices its cache writes as Opus reads in the baseline; a normal step is unchanged', async () => {
    const u = U(1000, 500, 0, 200_000, 'claude-sonnet-5-5')
    expect(near(costOf(u, 'opus'), 1.614)).toBe(true)
    expect(near(baselineOf(u, false), 1.614)).toBe(true)
    expect(near(baselineOf(u, true), 0.054)).toBe(true)
    // The actual cost is left as it is.
    expect(near(add(EMPTY, 'claude-sonnet-5-5', u, true).cost, costOf(u, 'sonnet'))).toBe(true)
    expect(near(add(EMPTY, 'claude-sonnet-5-5', u).baseline, baselineOf(u, false))).toBe(true)
  })

  test('only a family change inside the TTL is a switch step', async () => {
    const prev = { model: 'opus' as const, at: 0, context: 1 }
    expect(isSwitchStep(null, 'sonnet', 0)).toBe(false)
    expect(isSwitchStep(prev, 'opus', 1000)).toBe(false)
    expect(isSwitchStep(prev, 'sonnet', 1000)).toBe(true)
    expect(isSwitchStep({ ...prev, model: 'sonnet' }, 'opus', 1000)).toBe(true)
    expect(isSwitchStep(prev, 'sonnet', CACHE_TTL_MS)).toBe(true)
    expect(isSwitchStep(prev, 'sonnet', CACHE_TTL_MS + 1)).toBe(false)
  })

  test('an Opus -> Sonnet -> Opus round trip shows no saving: the old baseline showed a fake one', async () => {
    const steps: [string, ReturnType<typeof U>, boolean][] = [
      ['claude-opus-5-5', U(1000, 500, 200_000, 0), false],
      ['claude-sonnet-5-5', U(1000, 500, 0, 200_000, 'claude-sonnet-5-5'), true],
      ['claude-opus-5-5', U(1000, 500, 0, 200_000), true],
    ]
    const t = steps.reduce((acc, [model, u, switched]) => add(acc, model, u, switched), EMPTY)
    const naive = steps.reduce((sum, [, u]) => sum + costOf(u, 'opus'), 0)
    expect(naive - t.cost).toBeGreaterThan(0.5)
    expect(saved(t).usd).toBeLessThan(0)
  })
})

test('the meter flags exactly the main steps that changed family, going down and coming back up', async ($, on) => {
  const seen = world($, on, execute)
  // 200k-token writes: the flagged and unflagged baselines differ by dollars, so the 2-decimal stats line tells them apart.
  const u1 = U(100, 200, 0, 200_000)
  const u2 = U(100, 200, 0, 200_000, 'claude-sonnet-5-5')
  const u3 = U(100, 200, 200_000, 0, 'claude-sonnet-5-5')
  const u4 = U(100, 200, 0, 200_000)
  const turns = [u1, u2, u3, u4]
  for (const [i, u] of turns.entries()) {
    await $.prompt.submit({ text: `prompt ${i}` } as never)
    seen.usage.push(u)
    await step($, `t${i + 1}`)
  }
  const classifier = 4 * costOf({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, 'opus')
  const flagged = classifier + costOf(u1, 'opus') + baselineOf(u2, true) + costOf(u3, 'opus') + baselineOf(u4, true)
  const unflagged = classifier + turns.reduce((sum, u) => sum + costOf(u, 'opus'), 0)
  expect(fmtUsd(flagged)).not.toBe(fmtUsd(unflagged))
  const r = (await $.command.run({ command: 'model-router', args: 'stats' } as never)) as { text: string }
  expect(r.text).toContain(`all on Opus would be ${fmtUsd(flagged)}`)
  expect(r.text).not.toContain(`all on Opus would be ${fmtUsd(unflagged)}`)
})

describe('mainRouting off (subagent-only mode)', () => {
  test('main steps are untouched and no context is injected, while subagent routing, escalation and the meter still work; a main Fable is the user\'s own choice', { options: { mainRouting: false } }, async ($, on) => {
    const seen = world($, on, decide)
    await $.prompt.submit({ text: 'find files' } as never)
    // No classification, no assignment text.
    expect(seen.asked).toEqual([])
    expect(seen.submits[0]!.context).toBeUndefined()
    await step($, 't1')
    expect(seen.steps[0]).toEqual({ model: 'claude-opus-5-5[1m]', effort: 'high', agentId: undefined })
    const main = (await $.tool.call({ tool: 'mcp__model-router__escalate', model: 'opus', reason: 'x' } as never)) as { result: string }
    expect(main.result).toContain('No routed turn')

    // A turn without a person prompt has no route to inherit.
    await $.turn.start({ text: 'notification', turnId: 'tn' } as never)
    await step($, 'tn', 'claude-sonnet-5-5')
    expect(seen.steps[1]).toMatchObject({ model: 'claude-sonnet-5-5' })

    // Changed in v0.8.2: with main routing off the main model is the user's own choice, Fable included.
    // Still on: subagent routing and escalation, and the meter.
    await step($, 't1', 'claude-fable-5-1[1m]')
    expect(seen.steps[2]!.model).toBe('claude-fable-5-1[1m]')
    const id = await spawnAgent($, { subagentType: 'Explore' })
    seen.usage.push(U(1000, 100, 0, 0, 'claude-haiku-5-5'))
    await step($, 'sub', OPUS, id)
    expect(seen.steps[3]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'medium', agentId: id })
    const up = (await $.tool.call({ tool: 'mcp__model-router__escalate', agentId: id, model: 'sonnet', reason: 'hard' } as never)) as { result: string }
    expect(up.result).toBe('Escalated to sonnet/medium from your next step.')
    const r = (await $.command.run({ command: 'model-router', args: 'stats' } as never)) as { text: string }
    expect(r.text).toContain('| haiku |')
    expect(r.text).toContain('Fable requests moved to Opus: 0')
  })

  test('the turn tally still restarts with each prompt', { options: { mainRouting: false } }, async ($, on) => {
    const seen = world($, on, null)
    await $.prompt.submit({ text: 'first' } as never)
    seen.usage.push(U(1000, 200, 20_000, 0))
    await step($, 't1')
    await $.prompt.submit({ text: 'second' } as never)
    const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await ui.find({ text: /turn 0 token/ })).toBeDefined()
    expect(await ui.find({ text: /today 21\.2k token/ })).toBeDefined()
  })

  test('on by default', async ($, on) => {
    const seen = world($, on, execute)
    await $.prompt.submit({ text: 'build it' } as never)
    expect(seen.asked).toEqual(['haiku'])
    expect(seen.submits[0]!.context?.[0]).toContain('assigned to sonnet')
  })
})

describe('the band without a route', () => {
  // WHY: with no route (a new session, or main routing off) the route row was a lone gear and an empty line; the meter
  // takes that row instead, with the Disable button beside it.
  test('shows the meter on the gear row, with the button, and no empty route row', { options: { mainRouting: false } }, async ($, on) => {
    const seen = world($, on, null)
    await $.prompt.submit({ text: 'find files' } as never)
    seen.usage.push(U(1000, 200, 20_000, 0))
    await step($, 't1')
    const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts.filter(t => t.trim() === '')).toEqual([])
    expect(texts.some(t => t.includes('⚙'))).toBe(true)
    expect(await ui.find({ text: /today 21\.2k token/ })).toBeDefined()
    expect(await ui.find({ key: 'router-disable' })).toBeDefined()
  })

  test('a fresh session, before any prompt, shows the gear row with the button', async ($, on) => {
    world($, on, null)
    const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts.filter(t => t.trim() === '')).toEqual([])
    expect(await ui.find({ key: 'router-disable' })).toBeDefined()
  })
})

describe('opus effort guidance and the max-effort guard', () => {
  // WHY: Opus at medium is the cheap default; the assignment must tell it when a task is worth more, and that max is rare.
  test('a decide turn starts Opus at medium, and the assignment says when to use high, xhigh and max', async ($, on) => {
    const seen = world($, on, decide)
    await $.prompt.submit({ text: 'which design' } as never)
    await step($, 't1')
    expect(seen.steps[0]).toMatchObject({ model: 'claude-opus-5-5[1m]', effort: 'medium' })
    const ctx = seen.submits[0]!.context?.[0] ?? ''
    expect(ctx).toContain('assigned to opus at medium')
    expect(ctx).toContain('medium for most work')
    expect(ctx).toContain('high for multi-step design, plans or reviews')
    expect(ctx).toContain('xhigh for hard debugging or architecture')
    expect(ctx).toContain('max only for an irreversible, production-affecting decision or after an attempt at xhigh has failed')
    expect(assignmentContext(routeFor('decide', 'x'))).toContain('max only for an irreversible')
  })

  // WHY: xhigh and max are main-thread only: a subagent that asks for them by hand gets the cap, and max is never counted for it.
  test('a subagent cannot reach max or xhigh by hand: the request is capped, and no max is counted', async ($, on) => {
    const seen = world($, on, null)
    const id = await spawnAgent($, { subagentType: 'Explore' })
    const r = (await $.tool.call({ tool: 'mcp__model-router__escalate', agentId: id, effort: 'max', reason: 'irreversible change' } as never)) as { result: string }
    expect(r.result).toBe('Escalated to haiku/high from your next step.')
    await step($, 'sub', OPUS, id)
    expect(seen.steps[0]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'high' })
    const stats = (await $.command.run({ command: 'model-router', args: 'stats' } as never)) as { text: string }
    expect(stats.text).toContain('Escalations to max effort: 0.')
  })

  // WHY: max should be rare; the stats line is how that is checked, so only a move to max from below may count.
  test('a main-thread escalate to max is applied and counted; an escalate to xhigh is not', async ($, on) => {
    const seen = world($, on, decide)
    await $.prompt.submit({ text: 'which design' } as never)
    const stats = async () => ((await $.command.run({ command: 'model-router', args: 'stats' } as never)) as { text: string }).text
    expect(await stats()).toContain('Escalations to max effort: 0.')
    const x = (await $.tool.call({ tool: 'mcp__model-router__escalate', effort: 'xhigh', reason: 'hard bug' } as never)) as { result: string }
    expect(x.result).toContain('opus at xhigh')
    expect(await stats()).toContain('Escalations to max effort: 0.')
    const m = (await $.tool.call({ tool: 'mcp__model-router__escalate', effort: 'max', reason: 'irreversible prod change' } as never)) as { result: string }
    expect(m.result).toContain('opus at max')
    await step($, 't1')
    expect(seen.steps[0]).toMatchObject({ model: 'claude-opus-5-5[1m]', effort: 'max' })
    expect(await stats()).toContain('Escalations to max effort: 1.')
  })
})

// ---- v0.8.1: subagent caps ----

const ESCALATE = 'mcp__model-router__escalate'
const call = ($: any, input: Record<string, unknown>) => $.tool.call({ tool: ESCALATE, ...input } as never) as Promise<{ result: string }>

describe('subagent caps (v0.8.1)', () => {
  // WHY: a subagent that keeps failing must hand the problem back to the main conversation, not think longer on its own.
  test('a subagent escalating itself to opus/high or opus/xhigh is capped at opus/medium', async ($, on) => {
    const seen = world($, on, null)
    const id = await spawnAgent($, { subagentType: 'Explore' })
    const r = await call($, { agentId: id, model: 'opus', effort: 'high', reason: 'hard' })
    expect(r.result).toBe('Escalated to opus/medium from your next step.')
    await step($, 'sub', OPUS, id)
    expect(seen.steps[0]).toMatchObject({ model: OPUS, effort: 'medium' })
    const more = await call($, { agentId: id, effort: 'xhigh', reason: 'harder' })
    expect(more.result).toContain('No change')
    expect(more.result).toContain('the ceiling is opus/medium')
    await step($, 'sub', OPUS, id)
    expect(seen.steps[1]).toMatchObject({ model: OPUS, effort: 'medium' })
  })

  // WHY: the main conversation verifies what subagents return, so it alone may spend more on one; never beyond opus/high.
  test('the main conversation raises a subagent to opus/high, but xhigh and max are cut down to high', async ($, on) => {
    const seen = world($, on, null)
    const id = await spawnAgent($, { subagentType: 'Explore' })
    const r = await call($, { agent: id, model: 'opus', effort: 'xhigh', reason: 'main judges it needs more' })
    expect(r.result).toBe(`Subagent ${id} now runs opus/high from its next step.`)
    await step($, 'sub', OPUS, id)
    expect(seen.steps[0]).toMatchObject({ model: OPUS, effort: 'high' })
    const max = await call($, { agent: id, effort: 'max', reason: 'x' })
    expect(max.result).toContain('No change')
    await step($, 'sub', OPUS, id)
    expect(seen.steps[1]).toMatchObject({ model: OPUS, effort: 'high' })
    expect(MAIN_RAISE_CAP).toEqual({ model: 'opus', effort: 'high' })
    expect(eventsOf(seen)).toContainEqual(expect.objectContaining({ agentId: id, event: 'raised by main', to: 'opus/high', reason: 'main judges it needs more' }))
  })

  test('main raising a subagent never passes the parent tier: a sonnet parent keeps its subagents on sonnet', async ($, on) => {
    const seen = world($, on, null)
    const id = await spawnAgent($, { subagentType: 'Explore', parentModel: 'claude-sonnet-5-5' })
    const r = await call($, { agent: id, model: 'opus', effort: 'high', reason: 'x' })
    expect(r.result).toBe(`Subagent ${id} now runs sonnet/high from its next step.`)
    await step($, 'sub', 'claude-sonnet-5-5', id)
    expect(seen.steps[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' })
  })

  test('main naming an agent the router does not track gets a clear reply and changes nothing', async ($, on) => {
    const seen = world($, on, '{"tier":"lookup","reason":"找文件"}')
    await $.prompt.submit({ text: 'find files' } as never)
    const r = await call($, { agent: 'ghost', model: 'opus', reason: 'x' })
    expect(r.result).toBe('No tracked subagent ghost.')
    await step($, 't1')
    expect(seen.steps[0]).toMatchObject({ model: 'claude-haiku-5-5[1m]', effort: 'medium' })
  })

  // WHY: only the main conversation judges what a subagent needs; one subagent steering another would bypass that check.
  test('a subagent passing agent cannot raise another agent, and does not raise itself either', async ($, on) => {
    const seen = world($, on, null)
    const a = await spawnAgent($, { subagentType: 'Explore' })
    const b = await spawnAgent($, { subagentType: 'Explore' })
    const r = await call($, { agentId: a, agent: b, model: 'sonnet', reason: 'x' })
    expect(r.result).toContain('only the main conversation can raise a subagent')
    await step($, 'sub', OPUS, a)
    await step($, 'sub', OPUS, b)
    expect(seen.steps[0]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'medium' })
    expect(seen.steps[1]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'medium' })
  })

  // WHY: agents that inherit (decide work, Plan, named agents) keep the session's effort, which may be xhigh or max;
  // those two are main-thread only, so the request is cut to high on its way out. The main thread keeps its own.
  test('an inheriting subagent on an xhigh or max session is sent at high; the main thread is left at its own effort', async ($, on) => {
    const seen = world($, on, null)
    const id = await spawnAgent($, { subagentType: 'thorough-reviewer' })
    await step($, 'sub', OPUS, id, 'xhigh')
    await step($, 'sub', OPUS, id, 'max')
    await step($, 'sub', OPUS, id, 'medium')
    await step($, 'main', OPUS, undefined, 'xhigh')
    expect(seen.steps.map(x => x.effort)).toEqual(['high', 'high', 'medium', 'xhigh'])
    expect(capSent('max')).toBe('high')
    expect(capSent(undefined)).toBeUndefined()
    expect(HARD_EFFORT_CAP).toBe('high')
  })

  test('a subagent raised by main to opus/high is still sent at high, never above', async ($, on) => {
    const seen = world($, on, null)
    const id = await spawnAgent($, { subagentType: 'Explore' })
    await call($, { agent: id, model: 'opus', effort: 'high', reason: 'x' })
    await step($, 'sub', OPUS, id, 'max')
    expect(seen.steps[0]).toMatchObject({ model: OPUS, effort: 'high' })
  })

  // WHY: forks and workflow agents are not tiered by the router, so they are not capped by it either.
  test('forks are untouched: not tracked, so xhigh stays xhigh', async ($, on) => {
    const seen = world($, on, null)
    const id = await spawnAgent($, { fork: true })
    await step($, 'sub', OPUS, id, 'xhigh')
    expect(seen.steps[0]).toMatchObject({ model: OPUS, effort: 'xhigh' })
    const r = await call($, { agent: id, effort: 'high', reason: 'x' })
    expect(r.result).toBe(`No tracked subagent ${id}.`)
  })

  // WHY: at the ceiling nothing more can be raised, so the failing agent is told to stop and report instead of retrying.
  test('at the ceiling, three more errors add the stop-and-report guidance to that call, and are logged', async ($, on) => {
    const seen = world($, on, null)
    on('tool.call', async (_$: unknown, e: any) => ({ result: 'boom', isError: e.file_path === 'bad' }) as never)
    const id = await spawnAgent($, { subagentType: 'Explore' })
    const bad = () => $.tool.call({ tool: 'Read', file_path: 'bad', agentId: id } as never) as Promise<{ context?: string[]; result: unknown; isError?: boolean }>
    const results = []
    // haiku/medium -> haiku/high -> sonnet/medium -> sonnet/high -> opus/medium: four climbs of three errors each
    for (let i = 0; i < 15; i++) results.push(await bad())
    expect(results.slice(0, 14).every(r => r.context === undefined)).toBe(true)
    const last = results[14]!
    expect(last.context).toEqual([
      '[model-router] You are at the subagent ceiling (opus/medium). Stop retrying: report what you found and what is blocking to the main conversation.',
    ])
    // the original result is otherwise unchanged
    expect(last).toMatchObject({ result: 'boom', isError: true })
    await step($, 'sub', OPUS, id)
    expect(seen.steps[0]).toMatchObject({ model: OPUS, effort: 'medium' })
    expect(eventsOf(seen).filter(ev => ev.event === 'ceiling reached')).toMatchObject([{ agentId: id, to: 'opus/medium' }])
  })

  test('a subagent that main raised to opus/high gets the guidance after three errors: the ladder has no step above its own cap', async ($, on) => {
    world($, on, null)
    on('tool.call', async (_$: unknown, e: any) => ({ result: 'boom', isError: e.file_path === 'bad' }) as never)
    const id = await spawnAgent($, { subagentType: 'Explore' })
    await call($, { agent: id, model: 'opus', effort: 'high', reason: 'x' })
    const bad = () => $.tool.call({ tool: 'Read', file_path: 'bad', agentId: id } as never) as Promise<{ context?: string[] }>
    await bad()
    await bad()
    expect((await bad()).context?.[0]).toContain('subagent ceiling (opus/high)')
  })
})


const statsOf = async ($: any): Promise<string> => ((await $.command.run({ command: 'model-router', args: 'stats' } as never)) as { text: string }).text

describe('blockFable (v0.8.2)', () => {
  // WHY: a user who runs Fable as the main model could not use even subagent-only mode, because the rewrite ran
  // unconditionally. Off must mean off, on the main thread and on subagents.
  test('blockFable off leaves a Fable main thread and a Fable subagent alone, and counts nothing', { options: { blockFable: false } }, async ($, on) => {
    const seen = world($, on, null)
    await $.prompt.submit({ text: 'do the thing' } as never)
    await step($, 't1', 'claude-fable-5-1[1m]')
    await step($, 'other', 'claude-fable-5-1[1m]', 'agent-1')
    expect(seen.steps[0]!.model).toBe('claude-fable-5-1[1m]')
    expect(seen.steps[1]!.model).toBe('claude-fable-5-1[1m]')
    expect(await statsOf($)).toContain('Fable requests moved to Opus: 0')
  })

  test('blockFable off: a Fable parent hands Fable down (inherit), never above the parent; a lower parent still caps a Fable ask', async () => {
    expect(decideSpawn(spawnInput({ parentModel: 'claude-fable-5-1' }), 'decide', true, false)).toMatchObject({ model: undefined, reason: 'decision work, inherits' })
    expect(decideSpawn(spawnInput({ model: 'fable', parentModel: 'claude-fable-5-1' }), null, true, false)).toBeUndefined()
    expect(decideSpawn(spawnInput({ model: 'fable', parentModel: OPUS }), null, true, false)).toMatchObject({ model: 'opus', fable: false })
    // The default is unchanged: a Fable parent still gets Opus.
    expect(decideSpawn(spawnInput({ parentModel: 'claude-fable-5-1' }), 'decide')).toMatchObject({ model: 'opus', fable: true })
  })

  test('blockFable off: a subagent under a Fable parent inherits Fable but is still capped at effort high', { options: { blockFable: false } }, async ($, on) => {
    const seen = world($, on, '{"tier":"decide","reason":"audit"}')
    const id = await spawnAgent($, { parentModel: 'claude-fable-5-1' })
    await step($, 'sub', 'claude-fable-5-1', id, 'xhigh')
    expect(seen.agents).toEqual([undefined])
    expect(seen.steps[0]).toMatchObject({ model: 'claude-fable-5-1', effort: 'high' })
    expect(await statsOf($)).toContain('Fable requests moved to Opus: 0')
  })

  // WHY: with main routing off the user chose the main model; blocking it anyway made subagent-only mode unusable on Fable.
  test('blockFable on with mainRouting off leaves the main Fable alone but still blocks a subagent Fable', { options: { mainRouting: false } }, async ($, on) => {
    const seen = world($, on, null)
    await $.prompt.submit({ text: 'do the thing' } as never)
    await step($, 't1', 'claude-fable-5-1[1m]')
    await step($, 'other', 'claude-fable-5-1[1m]', 'agent-1')
    expect(seen.steps[0]!.model).toBe('claude-fable-5-1[1m]')
    expect(seen.steps[1]!.model).toBe('claude-opus-5-5[1m]')
    expect(await statsOf($)).toContain('Fable requests moved to Opus: 1')
  })

  // WHY: the counter incremented on every request, so one Fable turn of 40 steps read as 40 blocks.
  test('fableBlocked counts once per turn on the main thread and once per subagent, however many steps', async ($, on) => {
    world($, on, null)
    await $.prompt.submit({ text: 'first' } as never)
    for (let i = 0; i < 6; i++) await step($, 't1', 'claude-fable-5-1[1m]')
    expect(await statsOf($)).toContain('Fable requests moved to Opus: 1')
    await $.prompt.submit({ text: 'second' } as never)
    for (let i = 0; i < 4; i++) await step($, 't2', 'claude-fable-5-1[1m]')
    expect(await statsOf($)).toContain('Fable requests moved to Opus: 2')
    for (let i = 0; i < 5; i++) await step($, 't2', 'claude-fable-5-1[1m]', 'agent-1')
    expect(await statsOf($)).toContain('Fable requests moved to Opus: 3')
    await step($, 't2', 'claude-fable-5-1[1m]', 'agent-2')
    expect(await statsOf($)).toContain('Fable requests moved to Opus: 4')
  })

  test('a subagent pinned to Opus at spawn because of a Fable parent is counted once, not again on its steps', async ($, on) => {
    world($, on, '{"tier":"decide","reason":"audit"}')
    const id = await spawnAgent($, { parentModel: 'claude-fable-5-1' })
    await step($, 'sub', 'claude-fable-5-1', id)
    await step($, 'sub', 'claude-fable-5-1', id)
    expect(await statsOf($)).toContain('Fable requests moved to Opus: 1')
  })
})

describe('classifier robustness (v0.8.2)', () => {
  // WHY: the verdict carries tier, sure and reason; at 120 tokens it was cut before its closing brace and every such
  // turn counted as unparseable.
  test('the classifier gets 300 tokens, enough for the whole verdict', async ($, on) => {
    const seen = world($, on, execute)
    await $.prompt.submit({ text: 'build it' } as never)
    expect(seen.maxTokens).toEqual([300])
  })

  test('a reply cut off after the tier still parses, as unsure with no reason; a cut-off junk reply does not', async () => {
    expect(parseDecision('{"tier":"lookup","sure":tr')).toEqual({ tier: 'lookup', reason: '', sure: false })
    expect(parseDecision('```json\n{"tier":"decide"')).toEqual({ tier: 'decide', reason: '', sure: false })
    expect(parseDecision('{"tier":"decide","sure":true,"reason":"pick a da')).toEqual({ tier: 'decide', reason: '', sure: false })
    expect(parseDecision('{"tier":"hug')).toBe(null)
    expect(parseDecision('{"tier":"huge"')).toBe(null)
    // A complete reply is unchanged.
    expect(parseDecision('{"tier":"decide","sure":true,"reason":"x"}')).toEqual({ tier: 'decide', reason: 'x', sure: true })
  })

  test('a truncated lookup after a decide turn is unsure, so it never downgrades', async ($, on) => {
    const seen = world($, on, [decide, '{"tier":"lookup","sure":tr'])
    await $.prompt.submit({ text: 'which design' } as never)
    await $.prompt.submit({ text: 'and now?' } as never)
    expect(seen.submits[1]!.context?.[0]).toContain('assigned to opus')
  })

  // WHY: "unparseable" said nothing about the cause; the start of the reply (masked) shows whether it was prose,
  // a refusal or a cut-off verdict.
  test('an unparseable reply logs its first 120 characters, single-line and masked, and is still counted as plain unparseable', async ($, on) => {
    const reply = `Sorry,\nI cannot do that. key sk-ant-api03-${'k'.repeat(30)} ${'filler '.repeat(40)}`
    const seen = world($, on, reply)
    await $.prompt.submit({ text: 'do the thing' } as never)
    const reason = eventsOf(seen).at(-1)!.reason
    expect(reason).toMatch(/^classifier failed \(unparseable: Sorry, I cannot do that\. key \[REDACTED/)
    expect(reason).not.toContain('kkkkkkkkkk')
    expect(reason).not.toContain('\n')
    const snippet = /unparseable: (.*)\): session model$/.exec(reason)![1]!
    expect(snippet.length).toBeLessThanOrEqual(120)
    expect(await statsOf($)).toContain('unparseable ×1')
  })
})

describe('classifier skipped on a warm large Opus context (v0.8.2)', () => {
  const lookup = '{"tier":"lookup","sure":true,"reason":"find"}'

  // WHY: keepWarm keeps a warm Opus context of 50k+ tokens on Opus whatever the tier, so the Haiku call could not
  // change the route and was pure cost on every prompt of a heavy session.
  test('no Haiku call: the turn goes to Opus at the decide effort, with the reason, and the skip is counted', async ($, on) => {
    const seen = world($, on, [decide, lookup])
    await $.prompt.submit({ text: 'which design' } as never)
    seen.usage.push(U(2000, 1000, 300_000, 0))
    await step($, 't1')
    await $.prompt.submit({ text: 'list the files' } as never)
    expect(seen.asked).toEqual(['haiku'])
    expect(seen.submits[1]!.context?.[0]).toContain('assigned to opus at medium')
    expect(seen.submits[1]!.context?.[0]).toContain('warm large context: classifier skipped')
    await step($, 't2')
    expect(seen.steps[1]).toMatchObject({ model: 'claude-opus-5-5[1m]', effort: 'medium' })
    expect(eventsOf(seen).at(-1)).toMatchObject({ event: 'turn route', to: 'opus/medium', reason: 'warm large context: classifier skipped' })
    expect(await statsOf($)).toContain('Classifier skipped (warm large Opus context): 1')
  })

  test('a #haiku pin still wins: no skip, and the reason is the pin', async ($, on) => {
    const seen = world($, on, [decide, lookup])
    await $.prompt.submit({ text: 'which design' } as never)
    seen.usage.push(U(2000, 1000, 300_000, 0))
    await step($, 't1')
    await $.prompt.submit({ text: 'list the files #haiku' } as never)
    expect(seen.asked).toEqual(['haiku'])
    expect(seen.submits[1]!.context?.[0]).toContain('model pinned in your message')
    expect(await statsOf($)).toContain('Classifier skipped (warm large Opus context): 0')
  })

  test('a small context still calls the classifier', async ($, on) => {
    const seen = world($, on, [decide, lookup])
    await $.prompt.submit({ text: 'which design' } as never)
    seen.usage.push(U(2000, 1000, 10_000, 0))
    await step($, 't1')
    await $.prompt.submit({ text: 'list the files' } as never)
    expect(seen.asked).toEqual(['haiku', 'haiku'])
    expect(await statsOf($)).toContain('Classifier skipped (warm large Opus context): 0')
  })

  test('a cold cache (past the TTL) still calls the classifier', async ($, on) => {
    const seen = world($, on, [decide, lookup])
    await $.prompt.submit({ text: 'which design' } as never)
    seen.usage.push(U(2000, 1000, 300_000, 0))
    await step($, 't1')
    await seen.clock.advance(CACHE_TTL_MS + 1000)
    await $.prompt.submit({ text: 'list the files' } as never)
    expect(seen.asked).toEqual(['haiku', 'haiku'])
  })
})

describe('compaction guards and the cache-expiry counter (v0.9.0)', () => {
  const MIN = 60_000
  const done = (turnId: string, agentId?: string) =>
    ({ answer: 'ok', durationMs: 1000, isAborted: false, turnId, agentId, text: 'ok', reason: 'completed' }) as never

  // The engine's side of $.session.compact and $.ui.toast: what each was asked, and how compact answers.
  // c.agents is what $.agent.list answers (statuses only); c.rejects makes the first n compact calls reject.
  function compactWorld($: any, on: any, how: 'ok' | 'reject' | 'skip' = 'ok', drop = false) {
    const seen = world($, on, '{"tier":"execute","reason":"x"}', { drop })
    const c = {
      instructions: [] as (string | undefined)[],
      toasts: [] as string[],
      agents: [] as string[],
      rejects: how === 'reject' ? Infinity : 0,
      sizes: {} as { tokensBefore?: number; tokensAfter?: number },
    }
    on('session.compact', async (_$: unknown, e: { instructions?: string }) => {
      c.instructions.push(e.instructions)
      if (c.rejects > 0) {
        c.rejects -= 1
        throw new Error('a turn is running')
      }
      return how === 'skip' ? { skip: 'vetoed' } : { messages: [{ role: 'user', text: 'summary', toolUses: [] }], ...c.sizes }
    })
    on('agent.list', async () => ({
      value: c.agents.map((status, i) => ({ id: `agent-${i}`, description: 'd', type: 'general-purpose', status })),
    }))
    on('ui.toast', async (_$: unknown, e: { text: string }) => {
      c.toasts.push(e.text)
      return { value: undefined }
    })
    return { seen, c }
  }

  // One main turn with a given context (a read-only usage of `context` tokens plus 500 output), then its completion.
  async function mainTurn($: any, seen: Seen, turnId: string, context: number, model = 'claude-opus-5-5') {
    await $.prompt.submit({ text: 'work on it' } as never)
    seen.usage.push(U(1000, 500, context - 1000, 0, model))
    await step($, turnId, model === 'claude-opus-5-5' ? undefined : `${model}[1m]`)
    await $.turn.complete(done(turnId))
  }

  test('off by default: no timer is set and nothing compacts, however long the idle', async ($, on) => {
    const { seen, c } = compactWorld($, on)
    await mainTurn($, seen, 't1', 300_000)
    await seen.clock.advance(24 * 60 * MIN)
    expect(c.instructions).toEqual([])
    const text = await statsOf($)
    expect(text).toContain('Compactions at idle (cache warm): 0')
    expect(text).toContain('Compactions at the context cap: 0')
  })

  test('fires after N minutes when the context is big enough, with short instructions, a toast and a count', { options: { idleCompactMinutes: 20 } }, async ($, on) => {
    const { seen, c } = compactWorld($, on)
    await mainTurn($, seen, 't1', 250_000)
    await seen.clock.advance(19 * MIN)
    expect(c.instructions).toEqual([])
    await seen.clock.advance(2 * MIN)
    expect(c.instructions).toHaveLength(1)
    expect(c.instructions[0]).toContain('current task')
    expect(c.toasts).toHaveLength(1)
    expect(c.toasts[0]).toContain('250.0k')
    expect(await statsOf($)).toContain('Compactions at idle (cache warm): 1')
    // It does not repeat: the context is small now and the timer was one-shot.
    await seen.clock.advance(60 * MIN)
    expect(c.instructions).toHaveLength(1)
  })

  test('a new prompt cancels the pending compaction', { options: { idleCompactMinutes: 20 } }, async ($, on) => {
    const { seen, c } = compactWorld($, on)
    await mainTurn($, seen, 't1', 250_000)
    await seen.clock.advance(10 * MIN)
    await $.prompt.submit({ text: 'I am back' } as never)
    await seen.clock.advance(30 * MIN)
    expect(c.instructions).toEqual([])
  })

  // A held-back prompt starts no turn, so turn.start never cancels: prompt.submit has to.
  test('a prompt held back by another plugin still cancels the pending compaction', { options: { idleCompactMinutes: 20 } }, async ($, on) => {
    const { seen, c } = compactWorld($, on, 'ok', true)
    await $.turn.complete(done('t0'))
    seen.usage.push(U(1000, 500, 250_000, 0))
    await step($, 't0')
    await $.turn.complete(done('t0'))
    await $.prompt.submit({ text: 'I am back' } as never)
    await seen.clock.advance(30 * MIN)
    expect(c.instructions).toEqual([])
  })

  test('a context below compactMinContext is not compacted', { options: { idleCompactMinutes: 20 } }, async ($, on) => {
    const { seen, c } = compactWorld($, on)
    await mainTurn($, seen, 't1', 99_000)
    await seen.clock.advance(30 * MIN)
    expect(c.instructions).toEqual([])
  })

  test('compactMinContext is configurable', { options: { idleCompactMinutes: 20, compactMinContext: 20_000 } }, async ($, on) => {
    const { seen, c } = compactWorld($, on)
    await mainTurn($, seen, 't1', 30_000)
    await seen.clock.advance(30 * MIN)
    expect(c.instructions).toHaveLength(1)
  })

  test('a compact that rejects (a turn is running) is swallowed: nothing counted, no toast', { options: { idleCompactMinutes: 20 } }, async ($, on) => {
    const { seen, c } = compactWorld($, on, 'reject')
    await mainTurn($, seen, 't1', 250_000)
    await seen.clock.advance(30 * MIN)
    expect(c.instructions).toHaveLength(1)
    expect(c.toasts).toEqual([])
    expect(await statsOf($)).toContain('Compactions at idle (cache warm): 0')
  })

  test('a vetoed compact ({ skip }) is not a compaction', { options: { idleCompactMinutes: 20 } }, async ($, on) => {
    const { seen, c } = compactWorld($, on, 'skip')
    await mainTurn($, seen, 't1', 250_000)
    await seen.clock.advance(30 * MIN)
    expect(c.instructions).toHaveLength(1)
    expect(c.toasts).toEqual([])
    expect(await statsOf($)).toContain('Compactions at idle (cache warm): 0')
  })

  test('a subagent turn completing does not arm the guard', { options: { idleCompactMinutes: 20 } }, async ($, on) => {
    const { seen, c } = compactWorld($, on)
    await $.turn.complete(done('sub', 'agent-1'))
    await seen.clock.advance(30 * MIN)
    expect(c.instructions).toEqual([])
  })

  test('the cap compacts between turns when the context is at or above it', { options: { compactAtContext: 200_000 } }, async ($, on) => {
    const { seen, c } = compactWorld($, on)
    await mainTurn($, seen, 't1', 199_000)
    await seen.clock.advance(0)
    expect(c.instructions).toEqual([])
    await mainTurn($, seen, 't2', 200_000)
    await seen.clock.advance(0)
    expect(c.instructions).toHaveLength(1)
    expect(c.toasts[0]).toContain('200.0k')
    const text = await statsOf($)
    expect(text).toContain('Compactions at the context cap: 1')
    expect(text).toContain('Compactions at idle (cache warm): 0')
  })

  test('the cap does not re-trigger on stale data: the next turn is judged on its own context', { options: { compactAtContext: 200_000 } }, async ($, on) => {
    const { seen, c } = compactWorld($, on)
    await mainTurn($, seen, 't1', 300_000)
    await seen.clock.advance(0)
    expect(c.instructions).toHaveLength(1)
    await mainTurn($, seen, 't2', 30_000)
    await seen.clock.advance(0)
    expect(c.instructions).toHaveLength(1)
  })

  // WHY: `last` skips Fable, and blockFable off makes a Fable main thread the target user of these guards.
  test('a Fable main thread with blockFable off is still tracked: the cap fires on its context', { options: { blockFable: false, compactAtContext: 200_000 } }, async ($, on) => {
    const { seen, c } = compactWorld($, on)
    await mainTurn($, seen, 't1', 250_000, 'claude-fable-5-1')
    await seen.clock.advance(0)
    expect(c.instructions).toHaveLength(1)
  })

  test('a Fable main thread with blockFable off: the idle guard fires too', { options: { blockFable: false, idleCompactMinutes: 30 } }, async ($, on) => {
    const { seen, c } = compactWorld($, on)
    await mainTurn($, seen, 't1', 250_000, 'claude-fable-5-1')
    await seen.clock.advance(31 * MIN)
    expect(c.instructions).toHaveLength(1)
  })

  describe('cache-expiry rewrites', () => {
    test('counted, with the write cost, when the gap is past the TTL and the write is 100k or more', async ($, on) => {
      const { seen } = compactWorld($, on)
      await $.prompt.submit({ text: 'first' } as never)
      seen.usage.push(U(1000, 500, 200_000, 0))
      await step($, 't1')
      await seen.clock.advance(CACHE_TTL_MS + 1000)
      seen.usage.push(U(1000, 500, 0, 300_000))
      await step($, 't1')
      const text = await statsOf($)
      // 300,000 tokens at Opus's $8 per million cache write.
      expect(text).toContain('Cache rewrites after the TTL (100k+ tokens): 1, costing $2.40')
    })

    test('not counted inside the TTL, below 100k written, or for a first request that read from the cache', async ($, on) => {
      const { seen } = compactWorld($, on)
      await $.prompt.submit({ text: 'first' } as never)
      seen.usage.push(U(1000, 500, 5000, 300_000))
      await step($, 't1')
      seen.usage.push(U(1000, 500, 0, 300_000))
      await seen.clock.advance(CACHE_TTL_MS - 1000)
      await step($, 't1')
      await seen.clock.advance(CACHE_TTL_MS + 1000)
      seen.usage.push(U(1000, 500, 0, 99_999))
      await step($, 't1')
      expect(await statsOf($)).toContain('Cache rewrites after the TTL (100k+ tokens): 0, costing $0.00')
    })

    test('a subagent request is not a main-thread rewrite', async ($, on) => {
      const { seen } = compactWorld($, on)
      await $.prompt.submit({ text: 'first' } as never)
      seen.usage.push(U(1000, 500, 200_000, 0))
      await step($, 't1')
      await seen.clock.advance(CACHE_TTL_MS + 1000)
      seen.usage.push(U(1000, 500, 0, 300_000))
      await step($, 'sub', 'claude-sonnet-5-5', 'agent-1')
      expect(await statsOf($)).toContain('Cache rewrites after the TTL (100k+ tokens): 0')
    })

    test('a Fable main thread counts too', { options: { blockFable: false } }, async ($, on) => {
      const { seen } = compactWorld($, on)
      await $.prompt.submit({ text: 'first' } as never)
      seen.usage.push(U(1000, 500, 200_000, 0, 'claude-fable-5-1'))
      await step($, 't1', 'claude-fable-5-1[1m]')
      await seen.clock.advance(CACHE_TTL_MS + 1000)
      seen.usage.push(U(1000, 500, 0, 150_000, 'claude-fable-5-1'))
      await step($, 't1', 'claude-fable-5-1[1m]')
      // 150,000 tokens at Fable's $20 per million cache write.
      expect(await statsOf($)).toContain('Cache rewrites after the TTL (100k+ tokens): 1, costing $3.00')
    })
  })

  describe('cache-expiry rewrites in a new process (fix 7)', () => {
    test('the first main request with a cold cache and a big write counts (a --resume)', async ($, on) => {
      const { seen } = compactWorld($, on)
      await $.prompt.submit({ text: 'resumed' } as never)
      seen.usage.push(U(1000, 500, 200, 400_000))
      await step($, 't1')
      // 400,000 tokens at Opus's $8 per million cache write.
      expect(await statsOf($)).toContain('Cache rewrites after the TTL (100k+ tokens): 1, costing $3.20')
    })

    test('not counted right after a compaction this process saw, then counted again for a later cold start', async ($, on) => {
      const { seen } = compactWorld($, on)
      await $.prompt.submit({ text: 'first' } as never)
      seen.usage.push(U(1000, 500, 200_000, 0))
      await step($, 't1')
      await $.session.compact({ messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never)
      // The summary is written fresh: a big write with no read is not an expiry.
      seen.usage.push(U(1000, 500, 0, 150_000))
      await step($, 't1')
      expect(await statsOf($)).toContain('Cache rewrites after the TTL (100k+ tokens): 0')
      // The flag cleared on that request: after another gap it counts as usual.
      await seen.clock.advance(CACHE_TTL_MS + 1000)
      seen.usage.push(U(1000, 500, 0, 150_000))
      await step($, 't1')
      expect(await statsOf($)).toContain('Cache rewrites after the TTL (100k+ tokens): 1')
    })
  })

  describe('compaction resets routing state (fix 1)', () => {
    test('a manual /compact clears the warm-cache memory: the next prompt is classified and not kept on Opus', async ($, on) => {
      const { seen } = compactWorld($, on)
      await mainTurn($, seen, 't1', 250_000)
      await $.session.compact({ messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never)
      await $.prompt.submit({ text: 'rename a variable' } as never)
      // Classifier ran (execute -> sonnet) instead of the warm-Opus skip.
      expect(seen.asked).toContain('haiku')
      await step($, 't2')
      expect(seen.steps.at(-1)!.model).toContain('sonnet')
    })

    test("the plugin's own compaction clears it too", { options: { idleCompactMinutes: 20 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      await mainTurn($, seen, 't1', 250_000)
      await seen.clock.advance(21 * MIN)
      expect(c.instructions).toHaveLength(1)
      await $.prompt.submit({ text: 'rename a variable' } as never)
      expect(seen.asked).toContain('haiku')
      await step($, 't2')
      expect(seen.steps.at(-1)!.model).toContain('sonnet')
    })

    test('a vetoed compaction ({ skip }) resets nothing', { options: { idleCompactMinutes: 20 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on, 'skip')
      await mainTurn($, seen, 't1', 250_000)
      await $.session.compact({ messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never)
      await seen.clock.advance(21 * MIN)
      // The idle timer was not cancelled by the veto: it fired (and was itself vetoed).
      expect(c.instructions).toHaveLength(2)
    })

    test('a manual compaction cancels a pending idle timer', { options: { idleCompactMinutes: 20 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      await mainTurn($, seen, 't1', 250_000)
      await seen.clock.advance(5 * MIN)
      await $.session.compact({ messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never)
      await seen.clock.advance(60 * MIN)
      expect(c.instructions).toHaveLength(1)
    })
  })

  describe('background agents (fix 2)', () => {
    test('a running agent blocks the idle compaction; the single re-check compacts once it is done', { options: { idleCompactMinutes: 20 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      c.agents = ['running', 'completed']
      await mainTurn($, seen, 't1', 250_000)
      await seen.clock.advance(21 * MIN)
      expect(c.instructions).toEqual([])
      c.agents = ['completed', 'idle', 'failed', 'killed']
      await seen.clock.advance(5 * MIN)
      expect(c.instructions).toHaveLength(1)
    })

    for (const status of ['pending', 'waiting']) {
      test(`${status} also blocks, and a second busy check gives up`, { options: { idleCompactMinutes: 20 } }, async ($, on) => {
        const { seen, c } = compactWorld($, on)
        c.agents = [status]
        await mainTurn($, seen, 't1', 250_000)
        await seen.clock.advance(60 * MIN)
        expect(c.instructions).toEqual([])
      })
    }

    test('no re-check when it would fall outside the safe window', { options: { idleCompactMinutes: 53 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      c.agents = ['running']
      await mainTurn($, seen, 't1', 250_000)
      await seen.clock.advance(53 * MIN + 1000)
      c.agents = []
      await seen.clock.advance(10 * MIN)
      expect(c.instructions).toEqual([])
    })
  })

  describe('compactAtContext floor (fix 3)', () => {
    test('a value below 100000 counts as off', { options: { compactAtContext: 50_000 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      await mainTurn($, seen, 't1', 90_000)
      await seen.clock.advance(0)
      expect(c.instructions).toEqual([])
    })

    test('exactly 100000 is on', { options: { compactAtContext: 100_000 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      await mainTurn($, seen, 't1', 100_000)
      await seen.clock.advance(0)
      expect(c.instructions).toHaveLength(1)
    })
  })

  describe('cap retry (fix 4)', () => {
    test('a rejection is retried every 2 seconds, up to 3 retries, then it stops', { options: { compactAtContext: 200_000 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on, 'reject')
      await mainTurn($, seen, 't1', 250_000)
      await seen.clock.advance(0)
      expect(c.instructions).toHaveLength(1)
      await seen.clock.advance(2000)
      expect(c.instructions).toHaveLength(2)
      await seen.clock.advance(2000)
      await seen.clock.advance(2000)
      expect(c.instructions).toHaveLength(4)
      await seen.clock.advance(60_000)
      expect(c.instructions).toHaveLength(4)
      expect(c.toasts).toEqual([])
      expect(await statsOf($)).toContain('Compactions at the context cap: 0')
    })

    test('succeeds on a retry', { options: { compactAtContext: 200_000 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      c.rejects = 2
      await mainTurn($, seen, 't1', 250_000)
      await seen.clock.advance(0)
      await seen.clock.advance(4000)
      expect(c.instructions).toHaveLength(3)
      expect(await statsOf($)).toContain('Compactions at the context cap: 1')
    })

    test('a new prompt cancels the retries', { options: { compactAtContext: 200_000 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on, 'reject')
      await mainTurn($, seen, 't1', 250_000)
      await seen.clock.advance(0)
      await $.prompt.submit({ text: 'back' } as never)
      await seen.clock.advance(60_000)
      expect(c.instructions).toHaveLength(1)
    })

    test('when the cap compaction never lands, the idle timer is armed', { options: { compactAtContext: 200_000, idleCompactMinutes: 20 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      c.rejects = 4
      await mainTurn($, seen, 't1', 250_000)
      await seen.clock.advance(6000)
      expect(c.instructions).toHaveLength(4)
      await seen.clock.advance(21 * MIN)
      expect(c.instructions).toHaveLength(5)
    })
  })

  describe('TTL margin (fix 5)', () => {
    // 56 and above is refused by plugin.json (max 55) before the hooks module loads, so only the edge is testable here.
    test('55 minutes, the longest setting, still fires', { options: { idleCompactMinutes: 55 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      await mainTurn($, seen, 't1', 250_000)
      await seen.clock.advance(55 * MIN)
      expect(c.instructions).toHaveLength(1)
    })
  })

  describe('enabled at fire time (fix 6)', () => {
    test('turning the router off cancels a pending idle compaction', { options: { idleCompactMinutes: 20 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      await mainTurn($, seen, 't1', 250_000)
      await $.command.run({ command: 'model-router', args: 'off' } as never)
      await seen.clock.advance(30 * MIN)
      expect(c.instructions).toEqual([])
    })

    test('turning it off during the cap retries stops them', { options: { compactAtContext: 200_000 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on, 'reject')
      await mainTurn($, seen, 't1', 250_000)
      await seen.clock.advance(0)
      await $.command.run({ command: 'model-router', args: 'off' } as never)
      await seen.clock.advance(60_000)
      expect(c.instructions).toHaveLength(1)
    })
  })

  describe('second review (v0.9.1)', () => {
    test('the TTL is measured from when the request was sent, not from when a long response ended', { options: { idleCompactMinutes: 55 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      seen.stepMs = 6 * MIN
      await mainTurn($, seen, 't1', 250_000)
      seen.stepMs = 0
      await seen.clock.advance(55 * MIN)
      // Sent 61 minutes ago: past the safe window, so compacting now would pay the cold rewrite it means to avoid.
      expect(c.instructions).toEqual([])
    })

    // 0.9.2: routing measured the cache from when a response ended, the same error 0.9.1 fixed for the idle guard.
    test('routing also measures the cache from send time: 62 min after sending, a warm-Opus skip no longer applies', async ($, on) => {
      const { seen } = compactWorld($, on)
      seen.stepMs = 6 * MIN
      await mainTurn($, seen, 't1', 250_000)
      seen.stepMs = 0
      const classified = seen.asked.filter(m => m === 'haiku').length
      // Ended 56 minutes ago but sent 62 minutes ago: the Opus cache has expired, so the classifier must run again
      // rather than being skipped as "warm large context".
      await seen.clock.advance(56 * MIN)
      await $.prompt.submit({ text: 'next thing' } as never)
      expect(seen.asked.filter(m => m === 'haiku').length).toBe(classified + 1)
    })

    test('a short response still compacts at 55 minutes', { options: { idleCompactMinutes: 55 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      seen.stepMs = 30_000
      await mainTurn($, seen, 't1', 250_000)
      seen.stepMs = 0
      await seen.clock.advance(55 * MIN)
      expect(c.instructions).toHaveLength(1)
    })

    test('a gap past the TTL with a warm prefix read is new input, not a rewrite', async ($, on) => {
      const { seen } = compactWorld($, on)
      await $.prompt.submit({ text: 'first' } as never)
      seen.usage.push(U(1000, 500, 200_000, 0))
      await step($, 't1')
      await seen.clock.advance(CACHE_TTL_MS + 1000)
      seen.usage.push(U(1000, 500, 300_000, 150_000))
      await step($, 't1')
      expect(await statsOf($)).toContain('Cache rewrites after the TTL (100k+ tokens): 0')
    })

    test('a prompt that lands while the timer reads the enabled state still cancels it', { options: { idleCompactMinutes: 20 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      // Armed after the turn. runIdle reads the enabled state twice; the prompt lands during the second read, the last
      // check before compacting.
      let reads = -1
      on('state.get', { plugin: 'model-router' }, async (_$: unknown, e: any, next: any) => {
        if (reads >= 0 && e.key === 'enabled' && ++reads === 2) {
          await $.prompt.submit({ text: 'back' } as never)
        }
        return next(e)
      })
      await mainTurn($, seen, 't1', 250_000)
      reads = 0
      await seen.clock.advance(21 * MIN)
      expect(c.instructions).toEqual([])
    })
  })

  describe('toast sizes (fix 8)', () => {
    test('uses the engine figures, before and after', { options: { compactAtContext: 200_000 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      c.sizes = { tokensBefore: 412_000, tokensAfter: 31_000 }
      await mainTurn($, seen, 't1', 250_000)
      await seen.clock.advance(0)
      expect(c.toasts[0]).toContain('412.0k → 31.0k')
    })

    test('falls back to the last request when the engine gives none', { options: { compactAtContext: 200_000 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      await mainTurn($, seen, 't1', 250_000)
      await seen.clock.advance(0)
      expect(c.toasts[0]).toContain('250.0k')
      expect(c.toasts[0]).not.toContain('→')
    })
  })

  test('counts stored by an older version (no new fields) still read as 0', async ($, on) => {
    const seen = world($, on, null, {
      store: { counts: { turns: { lookup: 0, execute: 0, decide: 0 }, escalations: 0, cacheKeeps: 0, subagents: { haiku: 0, sonnet: 0, opus: 0 }, fableBlocked: 0 } },
    })
    expect(seen).toBeDefined()
    expect(await statsOf($)).toContain('Compactions at idle (cache warm): 0')
  })

  // ---- v0.10.0 ----

  describe('compaction is visible (v0.10.0)', () => {
    // WHY: a session started before the settings changed ran all day at 950k with the guard off, and nothing said so.
    test('stats name the compaction settings this session loaded, and say off when they are off', async ($, on) => {
      compactWorld($, on)
      expect(await statsOf($)).toContain('Compaction in this session: idle off · cap off.')
    })

    test('stats show loaded idle minutes and cap', { options: { idleCompactMinutes: 50, compactAtContext: 300_000 } }, async ($, on) => {
      compactWorld($, on)
      const text = await statsOf($)
      expect(text).toContain('Compaction in this session: idle after 50 min · cap at 300.0k.')
      expect(text).toContain('restart it after changing them')
    })

    test('every compaction attempt lands in the events log with its outcome', { options: { compactAtContext: 200_000 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      c.sizes = { tokensBefore: 250_000, tokensAfter: 20_000 }
      await mainTurn($, seen, 't1', 250_000)
      await seen.clock.advance(0)
      expect(eventsOf(seen)).toContainEqual(expect.objectContaining({ agentId: 'main', event: 'compact cap', to: 'done', reason: '250.0k → 20.0k' }))
    })

    test('a rejected compaction is logged with the engine error', { options: { idleCompactMinutes: 20 } }, async ($, on) => {
      const { seen } = compactWorld($, on, 'reject')
      await mainTurn($, seen, 't1', 250_000)
      await seen.clock.advance(30 * 60_000)
      // The reason is the engine's error text, which the test kit words its own way.
      expect(eventsOf(seen)).toContainEqual(expect.objectContaining({ agentId: 'main', event: 'compact idle', to: 'rejected' }))
    })

    test('a vetoed compaction is logged as skipped with the veto', { options: { idleCompactMinutes: 20 } }, async ($, on) => {
      const { seen } = compactWorld($, on, 'skip')
      await mainTurn($, seen, 't1', 250_000)
      await seen.clock.advance(30 * 60_000)
      expect(eventsOf(seen)).toContainEqual(expect.objectContaining({ event: 'compact idle', to: 'skipped', reason: 'vetoed' }))
    })
  })
})

describe('caller-pinned subagents start at medium (v0.10.0)', () => {
  // WHY: 30 subagents pinned to sonnet by the caller ran 1,649 steps at high, against "every tier starts at medium".
  test('a sonnet the caller named runs at medium, not at the session effort', async ($, on) => {
    const seen = world($, on, execute)
    const id = await spawnAgent($, { model: 'sonnet' })
    seen.usage.push(U(10, 1, 0, 0, 'claude-sonnet-5-5'))
    await step($, 'sub', 'claude-sonnet-5-5', id, 'high')
    expect(seen.steps.at(-1)).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium', agentId: id })
    expect(eventsOf(seen)).toContainEqual(expect.objectContaining({ agentId: id, to: 'sonnet/medium' }))
  })

  test('its model stays the one the caller named: only the effort starts at medium', async ($, on) => {
    const seen = world($, on, execute)
    const id = await spawnAgent($, { model: 'claude-sonnet-4-5' })
    await step($, 'sub', 'claude-sonnet-4-5', id, 'high')
    expect(seen.steps.at(-1)).toMatchObject({ model: 'claude-sonnet-4-5', effort: 'medium' })
  })

  test('it can still be raised: the ladder goes to sonnet/high first', async () => {
    expect(stepUp(startOf('claude-sonnet-5-5', OPUS, false, IDS_BY_KEY, true), IDS_BY_KEY)).toMatchObject({ tier: 'sonnet', effort: 'high' })
  })

  test('an inheriting agent, `inherit` and an unknown id keep the session effort, as before', async () => {
    expect(startOf(OPUS, OPUS, false, IDS_BY_KEY).effort).toBeUndefined()
    expect(isCallerPin(undefined)).toBe(false)
    expect(isCallerPin('inherit')).toBe(false)
    expect(isCallerPin('my-model')).toBe(false)
    expect(isCallerPin('claude-fable-5-1')).toBe(false)
    expect(isCallerPin('haiku')).toBe(true)
  })
})

describe('execute needs a settled plan; opus delegates settled work (v0.10.0)', () => {
  // WHY: 9 of 37 Sonnet main turns went to Opus at their first step. The wording read as execute ("add it to the PR",
  // "cherry-pick it") while what to change still had to be worked out.
  test('the classifier calls work execute only when what to change is visible', async () => {
    const text = classifierSystem('en')
    expect(text).toContain('already settled in the message or the context you can see')
    expect(text).toContain('is execute only when the context shows exactly')
    expect(text).toContain('porting a change to a branch whose version of the code differs')
  })

  test('opus is told to hand settled multi-file work to an unpinned subagent and verify it; other models are not', async () => {
    expect(assignmentContext(routeFor('decide', ''))).toContain('delegate it to a general-purpose subagent without a model')
    expect(assignmentContext(routeFor('decide', ''))).toContain('make small changes directly')
    expect(assignmentContext(routeFor('execute', ''))).not.toContain('delegate it')
  })
})

