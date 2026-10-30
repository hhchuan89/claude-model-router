import { describe, expect, mock, test } from 'claude-code/testing'
import type { FsEntry, FsStat } from 'claude-code'
import type { Tally } from '../types'
import { Backoff, EventLogs, mergeLogs } from '../hooks/log'

import { checkpointPays, CHECKPOINT_COOLDOWN_MS } from '../hooks/meter'
import { looksLikeCode, outputLimit, outputPath, outputSlice, reduceOutput } from '../hooks/output'
import { add, baselineOf, CACHE_TTL_MS, costOf, EMPTY, fmtUsd, isSwitchStep, keepWarm, merge, PRICES, saved, WARM_CONTEXT_KEEP } from '../hooks/meter'
import { applyEscalation, assignmentContext, classifierSystem, forcedModel, isFable, parseDecision, routeFor, settleTier, shorten, withSuffixOf } from '../hooks/route'
import { addUsage, capSent, decideSpawn, escalateAgent, HARD_EFFORT_CAP, isCallerPin, logDir, MAIN_RAISE_CAP, SELF_EFFORT_CAP, startOf, stepUp, SUBAGENT_SELF_CAP } from '../hooks/subagent'

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

type Seen = { sessionId: string; clock: { advance: (ms: number) => Promise<void> }; submits: { text: string; context?: readonly string[] }[]; steps: { model: string; effort?: unknown; agentId?: string }[]; asked: string[]; maxTokens: (number | undefined)[]; prompts: string[]; usage: any[]; agents: (string | undefined)[]; files: Record<string, string>; store: Record<string, unknown>; statuses: (string | undefined)[]; stepMs?: number; tally?: Tally }

const IDS: Record<string, string> = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' }

// null: the call timed out (aborted). { fail }: the API refused, or the reply had no text.
type Reply = string | null | { fail: 'api-error' | 'empty-reply' }

function world(
  $: any,
  on: any,
  classifier: Reply | Reply[],
  opts: { reviewer?: boolean; drop?: boolean; messages?: { role: 'user' | 'assistant'; text: string }[]; store?: Record<string, unknown>; competing?: Tally } = {},
): Seen {
  const seen: Seen = { sessionId: 'sess-1', clock: mock.clock(on), submits: [], steps: [], asked: [], maxTokens: [], prompts: [], usage: [], agents: [], files: {}, statuses: [], store: { ...opts.store } }
  on('store.set', { key: /.*/ }, async (_$: unknown, e: any, next: any) => {
    const result = await next(e)
    seen.store[e.key] = e.value
    return result
  })
  on('store.delete', { key: /.*/ }, async (_$: unknown, e: any, next: any) => {
    const result = await next(e)
    delete seen.store[e.key]
    return result
  })
  on('state.set', { plugin: 'model-router', key: 'meter' }, async (_$: unknown, e: any, next: any) => {
    seen.tally = e.value.today
    return next(e)
  })
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
  on('agent.spawn', async (_$: unknown, e: { model?: string; parentModel: string; resume?: { agentId: string } }) => {
    seen.agents.push(e.model)
    const id = e.model === undefined ? e.parentModel : (IDS[e.model] ?? e.model)
    return { model: id, agentId: e.resume?.agentId ?? `agent-${++spawned}` }
  })
  on('ui.status', async (_$: unknown, e: { text?: string }) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('session.id', async () => ({ value: seen.sessionId }))
  on('session.end', async (_$: unknown, e: { sessionId: string }) => ({ sessionId: e.sessionId }))
  on('session.measure', async (_$: unknown, e: any) => ({ changed: e.changed }))
  on('fs.read', async (_$: unknown, e: { path: string }) => seen.files[e.path] === undefined ? { deny: `no file ${e.path}` } : { value: seen.files[e.path] })
  on('fs.list', async (_$: unknown, e: { path: string }) => {
    const entries = new Map<string, FsEntry['kind']>()
    for (const path of Object.keys(seen.files)) {
      if (!path.startsWith(`${e.path}/`)) continue
      const tail = path.slice(e.path.length + 1)
      entries.set(tail.split('/')[0]!, tail.includes('/') ? 'dir' : 'file')
    }
    return { value: [...entries].map(([name, kind]): FsEntry => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.stat', async () => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } satisfies FsStat }))
  on('fs.write', async (_$: unknown, e: { path: string; text: string }) => {
    seen.files[e.path] = e.text
    return { value: undefined }
  })
  on('ui.render', { component: 'AbovePrompt' }, async ($$: any, e: any) => {
    const { Text } = $$.ui.resolve(e)
    return <Text>other mods</Text>
  })
  if (opts.competing) {
    let competing: Tally | undefined = opts.competing
    on('store.get', async (_$: unknown, e: { key: string }) => ({ value: seen.store[e.key] }))
    on('store.set', async (_$: unknown, e: { key: string; value: unknown }) => {
      if (competing && /^meter:\d{8}/.test(e.key)) {
        // Another process writes after this process has read its own previous total.
        const day = e.key.split(':')[1]
        seen.store[e.key === `meter:${day}` ? e.key : `meter:${day}:sess-2`] = competing
        competing = undefined
      }
      seen.store[e.key] = e.value
      return { value: undefined }
    })
    on('store.keys', async () => ({ value: Object.keys(seen.store) }))
    on('store.delete', async (_$: unknown, e: { key: string }) => {
      delete seen.store[e.key]
      return { value: undefined }
    })
  } else {
    mock.store(on, opts.store)
  }
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
  expect(await ui.find({ text: /差额 ≈/ })).toBeDefined()
  const r = (await $.command.run({ command: 'model-router', args: 'stats' } as never)) as { text: string }
  expect(r.text).toContain('haiku')
  expect(r.text).toContain('same work tokens at Opus prices')
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
  const log = historyOf(seen) as { events: { event: string; to: string; reason: string }[] }
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
  const log = historyOf(seen) as { sessionId: string; events: { agentId: string; event: string; to: string; reason: string }[]; stats: Record<string, unknown> }
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
  expect(await ui.find({ text: /difference ≈/ })).toBeDefined()
  expect(await ui.find({ text: /vs work tokens at Opus prices/ })).toBeDefined()
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

function historyOf(seen: Seen, id = 'sess-1') {
  const batches = Object.entries(seen.files)
    .filter(([path]) => path.replaceAll('\\', '/').endsWith(`/model-router/events-${id}.json`) || path.replaceAll('\\', '/').includes(`/model-router/${id}/`))
    .map(([, text]) => JSON.parse(text))
  return mergeLogs(id, batches)
}

function eventsOf(seen: Seen, id = 'sess-1') {
  return historyOf(seen, id).events
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
  const flagged = costOf(u1, 'opus') + baselineOf(u2, true) + costOf(u3, 'opus') + baselineOf(u4, true)
  const unflagged = turns.reduce((sum, u) => sum + costOf(u, 'opus'), 0)
  expect(fmtUsd(flagged)).not.toBe(fmtUsd(unflagged))
  const r = (await $.command.run({ command: 'model-router', args: 'stats' } as never)) as { text: string }
  expect(r.text).toContain(`same work tokens at Opus prices (switch-adjusted): ${fmtUsd(flagged)}`)
  expect(r.text).not.toContain(`same work tokens at Opus prices (switch-adjusted): ${fmtUsd(unflagged)}`)
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

describe('phase 1 routing and meter fixes', () => {
  const lookup = '{"tier":"lookup","sure":true,"reason":"find"}'
  for (const effort of ['low', 'medium'] as const) {
    test(`a resumed agent at ${effort} can explicitly raise effort to high`, async ($, on) => {
      const seen = world($, on, lookup)
      const id = await spawnAgent($, { model: 'sonnet', resume: { agentId: 'resumed' } })
      await step($, 'sub', 'claude-sonnet-5-5[1m]', id, effort)
      expect(seen.steps.at(-1)).toMatchObject({ model: 'claude-sonnet-5-5[1m]', effort })
      const up = await call($, { agentId: id, effort: 'high', reason: 'harder' })
      expect(up.result).toBe('Escalated to sonnet/high from your next step.')
      await step($, 'sub', OPUS, id, effort)
      expect(seen.steps.at(-1)).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' })
      expect(seen.asked).toEqual([])
      expect(await statsOf($)).toContain('Subagents routed: haiku 0 · sonnet 0 · opus 0')
    })

    test(`three errors on a resumed agent at ${effort} raise effort before model`, async ($, on) => {
      const seen = world($, on, lookup)
      on('tool.call', async () => ({ result: 'failed', isError: true }))
      const id = await spawnAgent($, { model: 'haiku', resume: { agentId: 'resumed' } })
      await step($, 'sub', 'claude-haiku-5-5', id, effort)
      for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Read', file_path: 'bad', agentId: id } as never)
      await step($, 'sub', OPUS, id, effort)
      const raised = effort === 'low' ? 'medium' : 'high'
      expect(seen.steps.at(-1)).toMatchObject({ model: 'claude-haiku-5-5', effort: raised })
      expect(eventsOf(seen).filter(ev => ev.event === 'auto-escalated')).toMatchObject([
        { agentId: id, to: `haiku/${raised}`, reason: '3 tool errors in a row: more effort on the same model' },
      ])
      expect(seen.asked).toEqual([])
      expect(await statsOf($)).toContain('Subagents routed: haiku 0 · sonnet 0 · opus 0')
    })

    test(`a resumed agent at ${effort} reports the ceiling only after reaching it`, async ($, on) => {
      const seen = world($, on, lookup)
      on('tool.call', async () => ({ result: 'failed', isError: true }))
      const model = 'claude-sonnet-5-5'
      const id = await spawnAgent($, { model: 'sonnet', parentModel: model, resume: { agentId: 'resumed' } })
      await step($, 'sub', model, id, effort)
      const bad = () => $.tool.call({ tool: 'Read', file_path: 'bad', agentId: id } as never) as Promise<{ context?: string[] }>
      const climbs = effort === 'low' ? 2 : 1
      for (let i = 0; i < climbs * 3; i++) expect((await bad()).context).toBeUndefined()
      await step($, 'sub', model, id, effort)
      expect(seen.steps.at(-1)).toMatchObject({ model, effort: 'high' })
      expect(eventsOf(seen).filter(ev => ev.event === 'ceiling reached')).toEqual([])
      await bad()
      await bad()
      expect((await bad()).context?.[0]).toContain('subagent ceiling (sonnet/high)')
      expect(eventsOf(seen).filter(ev => ev.event === 'ceiling reached')).toMatchObject([{ agentId: id, to: 'sonnet/high' }])
      expect(seen.asked).toEqual([])
      expect(await statsOf($)).toContain('Subagents routed: haiku 0 · sonnet 0 · opus 0')
    })
  }

  test('a resumed agent missing from memory keeps its resolved model and effort and can escalate', async ($, on) => {
    const seen = world($, on, lookup)
    const id = await spawnAgent($, { model: 'sonnet', resume: { agentId: 'resumed' } })
    await step($, 'sub', 'claude-sonnet-5-5', id, 'medium')
    expect(seen.steps.at(-1)).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' })
    const up = await call($, { agentId: id, model: 'opus', reason: 'harder' })
    expect(up.result).toBe('Escalated to opus/medium from your next step.')
    await step($, 'sub', OPUS, id)
    expect(seen.steps.at(-1)).toMatchObject({ model: OPUS, effort: 'medium' })
    expect(seen.asked).toEqual([])
    expect(await statsOf($)).toContain('Subagents routed: haiku 0 · sonnet 0 · opus 0')
  })

  test('a resumed agent missing from memory gets the error ladder', async ($, on) => {
    const seen = world($, on, lookup)
    on('tool.call', async () => ({ result: 'failed', isError: true }))
    const id = await spawnAgent($, { model: 'haiku', resume: { agentId: 'resumed' } })
    await step($, 'sub', 'claude-haiku-5-5', id)
    expect(seen.steps.at(-1)).toMatchObject({ model: 'claude-haiku-5-5', effort: 'high' })
    for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Read', file_path: 'bad', agentId: id } as never)
    await step($, 'sub', 'claude-haiku-5-5', id)
    expect(seen.steps.at(-1)).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' })
    expect(seen.asked).toEqual([])
    expect(await statsOf($)).toContain('Subagents routed: haiku 0 · sonnet 0 · opus 0')
  })

  test('a resumed agent missing from memory cannot send effort above high', async ($, on) => {
    const seen = world($, on, lookup)
    const id = await spawnAgent($, { resume: { agentId: 'resumed' } })
    await step($, 'sub', OPUS, id, 'max')
    expect(seen.steps.at(-1)).toMatchObject({ model: OPUS, effort: 'high' })
  })

  test('a resumed agent keeps its escalation and is not classified or counted again', async ($, on) => {
    const seen = world($, on, lookup)
    const id = await spawnAgent($)
    await $.tool.call({ tool: 'mcp__model-router__escalate', agentId: id, model: 'sonnet', effort: 'high', reason: 'harder' } as never)
    const resumed = await spawnAgent($, { resume: { agentId: id } })
    expect(resumed).toBe(id)
    expect(seen.asked).toEqual(['haiku'])
    await step($, 'sub', OPUS, id)
    expect(seen.steps.at(-1)).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' })
    expect(await statsOf($)).toContain('Subagents routed: haiku 1 · sonnet 0 · opus 0')
  })

  test('a resumed agent keeps its consecutive tool errors', async ($, on) => {
    const seen = world($, on, null)
    on('tool.call', async () => ({ result: 'failed', isError: true }))
    const id = await spawnAgent($, { subagentType: 'Explore' })
    await $.tool.call({ tool: 'Read', file_path: 'bad', agentId: id } as never)
    await $.tool.call({ tool: 'Read', file_path: 'bad', agentId: id } as never)
    await spawnAgent($, { subagentType: 'Explore', resume: { agentId: id } })
    await $.tool.call({ tool: 'Read', file_path: 'bad', agentId: id } as never)
    await step($, 'sub', OPUS, id)
    expect(seen.steps.at(-1)).toMatchObject({ model: 'claude-haiku-5-5', effort: 'high' })
    expect(await statsOf($)).toContain('Subagents routed: haiku 1 · sonnet 0 · opus 0')
  })

  for (const model of ['haiku', 'sonnet'] as const) {
    test(`an explicit #${model} pin leaves a warm Opus context and reports the rewrite estimate`, async ($, on) => {
      const seen = world($, on, decide)
      await $.prompt.submit({ text: 'choose' } as never)
      seen.usage.push(U(1000, 500, 299_000))
      await step($, 't1')
      await $.prompt.submit({ text: `next #${model}` } as never)
      await step($, 't2')
      const cost = fmtUsd(300_000 * (PRICES[model].write + PRICES.opus.write) / 1e6)
      expect(seen.steps.at(-1)!.model).toContain(model)
      expect(seen.asked).toEqual(['haiku'])
      expect(seen.submits.at(-1)!.context?.[0]).toContain(`warm Opus cache abandoned, estimated round-trip rewrite ${cost}`)
      const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
      expect(await ui.find({ text: `warm Opus cache abandoned, estimated round-trip rewrite ${cost}` })).toBeDefined()
      expect(await statsOf($)).toContain('Kept on a warm cache: 0')
    })
  }

  test('classifier usage is pure overhead with no hypothetical Opus credit', async ($, on) => {
    const seen = world($, on, lookup)
    await $.prompt.submit({ text: 'find' } as never)
    const t = seen.tally!
    expect(t.tokens).toBe(2)
    expect(t.cost).toBe(costOf(U(1, 1), 'haiku'))
    expect(t.baseline).toBe(0)
    expect(saved(t).usd).toBeLessThan(0)
    expect(await statsOf($)).not.toContain('saved')
  })

  for (const available of [true, false]) {
    test(`a reviewer availability probe is metered when availability is ${available}`, { options: { reviewModel: 'claude-fable-5-5' } }, async ($, on) => {
      mock.session(on)
      const seen = world($, on, decide, { reviewer: available })
      await $.prompt.submit({ text: 'choose #opus' } as never)
      await $.turn.complete({ answer: 'choice', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'completed' } as never)
      await seen.clock.advance(0)
      const t = seen.tally!
      expect(t.tokens).toBe(available ? 4 : 2)
      expect(near(t.cost, costOf(U(1, 1), 'fable') * (available ? 2 : 1))).toBe(true)
      expect(near(t.baseline, available ? costOf(U(1, 1), 'opus') : 0)).toBe(true)
      await $.turn.complete({ answer: 'choice', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'completed' } as never)
      await seen.clock.advance(0)
      expect(seen.prompts.filter(p => p === 'Reply with OK.')).toHaveLength(1)
    })
  }

  test('concurrent sessions own separate totals and a competing write survives', async ($, on) => {
    const day = storeDay(0)
    const other = add(EMPTY, OPUS, U(1e6, 0))
    const seen = world($, on, lookup, { competing: other })
    await $.prompt.submit({ text: 'find' } as never)
    seen.usage.push(U(1000, 500))
    await step($, 't1')
    const expected = 4 + costOf(U(1, 1), 'haiku') + costOf(U(1000, 500), 'opus')
    const text = await statsOf($)
    expect(text).toContain(`${fmtUsd(expected)} API-equivalent`)
    expect(seen.store[`meter:${day}:sess-2`]).toEqual(other)
    expect(seen.store[`meter:${day}`]).toBeUndefined()
    expect(seen.store['meter:all']).toBeUndefined()
  })

  test('legacy daily and all-time totals are read once alongside session records', async ($, on) => {
    const day = storeDay(0)
    const legacy = add(EMPTY, OPUS, U(1e6, 0))
    const older = add(legacy, OPUS, U(1e6, 0))
    const other = add(EMPTY, 'sonnet', U(1e6, 0))
    const seen = world($, on, lookup, { store: { [`meter:${day}`]: legacy, 'meter:all': older, [`meter:${day}:sess-2`]: other } })
    await $.prompt.submit({ text: 'find' } as never)
    const text = await statsOf($)
    expect(text).toContain('**Today**: 2.0M tokens, $6.00 API-equivalent')
    expect(text).toContain('**Retained total (30 days + legacy)**: 3.0M tokens, $10.00 API-equivalent')
    expect(seen.store[`meter:${day}`]).toEqual(legacy)
    expect(seen.store['meter:all']).toEqual(older)
    expect(seen.tally!.tokens).toBe(2e6 + 2)
  })

  test('session counters aggregate without writing the shared legacy counts', async ($, on) => {
    const seen = world($, on, lookup, { store: {
      [`counts:${storeDay(0)}:sess-2`]: { turns: { lookup: 2, execute: 0, decide: 0 } },
    } })
    await $.prompt.submit({ text: 'find' } as never)
    const key = `counts:${storeDay(0)}:sess-1`
    const own = seen.store[key] as any
    expect(own.turns.lookup).toBe(1)
    expect(await statsOf($)).toContain('Turns routed: lookup 3 · execute 0 · decide 0')
    expect(seen.store['counts']).toBeUndefined()
  })

  test('session records expire after 30 calendar days and legacy totals survive', async ($, on) => {
    const t = add(EMPTY, OPUS, U(1e6, 0))
    const today = new Date(2026, 9, 30).getTime()
    const old = new Date(2026, 8, 30).getTime()
    const edge = new Date(2026, 9, 1).getTime()
    const seen = world($, on, lookup, { store: {
      [`meter:${storeDay(old)}:old`]: t,
      [`counts:${storeDay(old)}:old`]: {},
      [`meter:${storeDay(edge)}:edge`]: t,
      'meter:all': t,
    } })
    await seen.clock.advance(today)
    await $.prompt.submit({ text: 'find' } as never)
    expect(seen.store[`meter:${storeDay(old)}:old`]).toBeUndefined()
    expect(seen.store[`counts:${storeDay(old)}:old`]).toBeUndefined()
    expect(seen.store[`meter:${storeDay(edge)}:edge`]).toEqual(t)
    expect(seen.store['meter:all']).toEqual(t)
    expect(await statsOf($)).toContain('**Retained total (30 days + legacy)**: 2.0M tokens, $8.00 API-equivalent')
  })
})

function storeDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

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

describe('cost exposure and session commands (1.0)', () => {
  test('the band leads with main context, read cost, cold write cost and the send-time deadline', async ($, on) => {
    const seen = world($, on, decide)
    await $.prompt.submit({ text: 'choose #opus' } as never)
    seen.stepMs = 6 * 60_000
    seen.usage.push(U(1000, 500, 220_000))
    await step($, 't1')
    await seen.clock.advance(16 * 60_000)
    const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts[0]).toBe('Opus · ctx 221.0k · ≈$0.044/step │ cold resume ≈$1.77 · cache warm ~38m')
    expect(await ui.find({ text: /Opus · medium/ })).toBeDefined()
    await seen.clock.advance(38 * 60_000)
    expect(await ui.find({ text: /cache expired: next prompt rewrites ≈221.0k \(≈\$1.77\)/ })).toBeDefined()
  })

  for (const model of ['haiku', 'sonnet', 'opus', 'fable'] as const) {
    test(`cost exposure uses ${model}'s actual rates, including in subagent-only mode`, { options: { mainRouting: false, blockFable: false } }, async ($, on) => {
      const seen = world($, on, null)
      await $.prompt.submit({ text: 'work' } as never)
      seen.usage.push(U(1000, 500, 220_000, 0, `claude-${model}-5-5`))
      await step($, 't1', `claude-${model}-5-5`)
      const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
      expect(await ui.find({ text: `cold resume ≈${fmtUsd(221_000 * PRICES[model].write / 1e6)}` })).toBeDefined()
      expect(await ui.find({ text: `≈$${(221_000 * PRICES[model].read / 1e6).toFixed(3)}/step` })).toBeDefined()
    })
  }

  test('a subagent does not replace main-context exposure', async ($, on) => {
    const seen = world($, on, decide)
    await $.prompt.submit({ text: 'choose #opus' } as never)
    seen.usage.push(U(1000, 500, 220_000))
    await step($, 't1')
    seen.usage.push(U(1000, 500, 9000, 0, 'claude-haiku-5-5'))
    await step($, 'a1', 'claude-haiku-5-5', 'agent-1')
    const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await ui.find({ text: /Opus · ctx 221.0k/ })).toBeDefined()
  })

  test('a newer context measurement replaces request exposure without moving the cache deadline', async ($, on) => {
    const seen = world($, on, decide)
    on('session.model', async () => ({ value: 'claude-opus-5-5' }))
    await $.prompt.submit({ text: 'choose #opus' } as never)
    seen.usage.push(U(1000, 500, 220_000))
    await step($, 't1')
    await seen.clock.advance(16 * 60_000)
    await $.session.measure({ context: { window: 1e6, tokens: 60_000 }, rateLimits: [], changed: ['context'] } as never)
    const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await ui.find({ text: 'Opus · ctx 60.0k · ≈$0.012/step │ cold resume ≈$0.48 · cache warm ~44m' })).toBeDefined()
    await seen.clock.advance(44 * 60_000)
    expect(await ui.find({ text: /cache expired: next prompt rewrites ≈60.0k \(≈\$0.48\)/ })).toBeDefined()
    // The next request is newer than the rewind measurement, even though its cache deadline is separate.
    seen.usage.push(U(1000, 500, 300_000))
    await step($, 't1')
    expect(await ui.find({ text: /Opus · ctx 301.0k.*cold resume ≈\$2.41.*cache warm ~60m/ })).toBeDefined()
  })

  for (const model of ['haiku', 'sonnet', 'opus', 'fable'] as const) {
    test(`a measurement keeps the observed ${model} request prices in a different session model`, async ($, on) => {
      const seen = world($, on, null)
      on('session.model', async () => ({ value: model === 'opus' ? 'sonnet' : 'opus' }))
      await $.prompt.submit({ text: 'find #haiku' } as never)
      // The answering model wins over both the route and the session model.
      seen.usage.push(U(1000, 500, 220_000, 0, model))
      await step($, 't1')
      await seen.clock.advance(16 * 60_000)
      await $.session.measure({ context: { window: 1e6, tokens: 60_000 }, rateLimits: [], changed: ['context'] } as never)
      const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
      const cost = fmtUsd(60_000 * PRICES[model].write / 1e6)
      expect(await ui.find({ text: `cold resume ≈${cost} · cache warm ~44m` })).toBeDefined()
      expect(await ui.find({ text: `≈$${(60_000 * PRICES[model].read / 1e6).toFixed(3)}/step` })).toBeDefined()
      await seen.clock.advance(44 * 60_000)
      expect(await ui.find({ text: `cache expired: next prompt rewrites ≈60.0k (≈${cost})` })).toBeDefined()
    })
  }

  test('a measurement uses the sent model when usage omits its model id', async ($, on) => {
    const seen = world($, on, null)
    on('session.model', async () => ({ value: 'opus' }))
    await $.prompt.submit({ text: 'find #haiku' } as never)
    seen.usage.push({ ...U(1000, 500, 220_000), model: undefined })
    await step($, 't1')
    await $.session.measure({ context: { window: 1e6, tokens: 60_000 }, rateLimits: [], changed: ['context'] } as never)
    const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await ui.find({ text: /Haiku · ctx 60.0k.*cold resume ≈\$0.01/ })).toBeDefined()
  })

  for (const fallback of ['unavailable', 'no tokens']) {
    for (const tokens of [60_000, 0]) {
      test(`context uses the newest reading when usage has ${fallback}, measured size ${tokens}`, async ($, on) => {
        const seen = world($, on, null)
        on('session.model', async () => ({ value: 'opus' }))
        on('session.usage', async () => fallback === 'unavailable' ? { deny: 'unavailable' }
          : { value: { startedAt: 0, rateLimits: [], context: { window: 1e6 } } })
        await $.prompt.submit({ text: 'find #haiku' } as never)
        seen.usage.push(U(1000, 500, 220_000))
        await step($, 't1')
        await $.session.measure({ context: { window: 1e6, tokens }, rateLimits: [], changed: ['context'] } as never)
        expect((await $.command.run({ command: 'model-router', args: 'context' } as never)).text).toContain(`ctx: ${tokens ? '60.0k' : '0'}`)
        // A rate-limit-only update has no newer size to replace this reading with.
        await $.session.measure({ context: { window: 1e6 }, rateLimits: [], changed: ['rateLimits'] } as never)
        expect((await $.command.run({ command: 'model-router', args: 'context' } as never)).text).toContain(`ctx: ${tokens ? '60.0k' : '0'}`)
        // A later request replaces the measurement, including its model for pricing.
        seen.usage.push(U(1000, 500, 300_000, 0, 'sonnet'))
        await step($, 't1')
        expect((await $.command.run({ command: 'model-router', args: 'context' } as never)).text).toContain('ctx: 301.0k')
        const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
        expect(await ui.find({ text: /Sonnet · ctx 301.0k.*cold resume ≈\$1.20/ })).toBeDefined()
      })
    }
  }

  test('a pinned downgrade prices the round trip with the newer measured size', async ($, on) => {
    const seen = world($, on, null)
    on('session.model', async () => ({ value: 'opus' }))
    await $.prompt.submit({ text: 'choose #opus' } as never)
    seen.usage.push(U(1000, 500, 220_000))
    await step($, 't1')
    await $.session.measure({ context: { window: 1e6, tokens: 100_000 }, rateLimits: [], changed: ['context'] } as never)
    await $.prompt.submit({ text: 'find #haiku' } as never)
    const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await ui.find({ text: /round.trip.*\$0.82/ })).toBeDefined()
  })

  for (const tokens of [0, 100_000]) {
    test(`the warm-cache comparison uses the newer measured size, ${tokens}`, async ($, on) => {
      const seen = world($, on, '{"tier":"execute","reason":"x"}')
      on('session.model', async () => ({ value: 'opus' }))
      await $.prompt.submit({ text: 'choose #opus' } as never)
      seen.usage.push(U(1000, 500, tokens === 0 ? 220_000 : 9000))
      await step($, 't1')
      await $.session.measure({ context: { window: 1e6, tokens }, rateLimits: [], changed: ['context'] } as never)
      await $.prompt.submit({ text: 'implement it' } as never)
      await step($, 't2')
      expect(seen.steps[1]!.model).toBe(tokens === 0 ? 'claude-sonnet-5-5[1m]' : 'claude-opus-5-5[1m]')
      expect(seen.asked).toEqual(tokens === 0 ? ['haiku'] : [])
    })
  }

  test('a narrow band keeps context and cold cost and drops routing detail first', async ($, on) => {
    const seen = world($, on, decide)
    await $.prompt.submit({ text: 'choose #opus' } as never)
    seen.usage.push(U(1000, 500, 220_000))
    await step($, 't1')
    for (const bodyColumns of [95, 75, 40]) {
      const ui = await $.ui.mount({ plugin: 'model-router', surface: 'terminal', component: 'AbovePrompt', props: { ...(BAND_PROPS as {}), bodyColumns } as never })
      const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
      expect(texts[0]).toContain('ctx 221.0k')
      expect(texts[0]).toContain('cold resume ≈$1.77')
      expect(texts.some(t => t.includes('medium'))).toBe(false)
      expect(texts.some(t => t.includes('/step'))).toBe(bodyColumns >= 90)
      expect(await ui.find({ key: 'router-disable' })).toBeDefined()
    }
  })

  test('a survey keeps the other band unchanged', async ($, on) => {
    world($, on, null)
    const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: { ...(BAND_PROPS as {}), hasSurvey: true } as never })
    expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['other mods'])
  })

  test('Chinese exposure and help use the language table', { options: { language: 'zh' } }, async ($, on) => {
    const seen = world($, on, decide)
    await $.prompt.submit({ text: 'choose #opus' } as never)
    seen.usage.push(U(1000, 500, 220_000))
    await step($, 't1')
    const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await ui.find({ text: /上下文 221.0k.*冷恢复 ≈\$1.77.*缓存仍热/ })).toBeDefined()
    const help = await $.command.run({ command: 'model-router', args: 'help' } as never)
    expect(help.text).toContain('用法：/model-router stats | status | context | checkpoint [备注] | on | off')
    expect(await ui.find({ key: 'router-disable' })).toBeDefined()
  })

  for (const language of ['en', 'zh']) {
    test(`weekly status uses the reported subscription window (${language}) and clears when absent`, { options: { language } }, async ($, on) => {
      const seen = world($, on, null)
      on('session.model', async () => ({ value: 'claude-opus-5-5' }))
      const resetsAt = '2026-11-02T01:00:00.000Z'
      await $.session.measure({ context: { window: 1e6 }, rateLimits: [
        { kind: 'five_hour', percentUsed: 12 }, { kind: 'seven_day', percentUsed: 76, resetsAt },
      ], changed: ['rateLimits'] } as never)
      const d = new Date(resetsAt)
      const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      expect(seen.statuses.at(-1)).toContain(`${language === 'zh' ? '每周' : 'Weekly'} 76%`)
      expect(seen.statuses.at(-1)).toContain(time)
      expect(seen.statuses.at(-1)).not.toContain('12%')
      await $.session.measure({ context: { window: 1e6 }, rateLimits: [], changed: ['rateLimits'] } as never)
      expect(seen.statuses.at(-1)).toBeUndefined()
    })
  }

  test('weekly status without a reset time still reports the actual percentage', async ($, on) => {
    const seen = world($, on, null)
    on('session.model', async () => ({ value: 'opus' }))
    await $.session.measure({ context: { window: 1e6 }, rateLimits: [{ kind: 'seven_day', percentUsed: 76.5 }], changed: ['rateLimits'] } as never)
    expect(seen.statuses.at(-1)).toBe('Weekly 76.5%')
  })

  test('status lists every option with its value and reads the local weekly window', { options: { mainRouting: false, reviewModel: 'claude-fable-5-5', idleCompactMinutes: 12 } }, async ($, on) => {
    world($, on, null)
    on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 1e6 }, rateLimits: [{ kind: 'seven_day', percentUsed: 76 }] } }))
    const r = await $.command.run({ command: 'model-router', args: 'status' } as never)
    for (const key of ['enabled', 'language', 'mainRouting', 'blockFable', 'haikuModel', 'sonnetModel', 'opusModel', 'reviewModel', 'idleCompactMinutes', 'compactMinContext', 'compactAtContext']) expect(r.text).toContain(`${key}:`)
    expect(r.text).toContain('mainRouting: false')
    expect(r.text).toContain('reviewModel: claude-fable-5-5')
    expect(r.text).toContain('idleCompactMinutes: 12')
    expect(r.text).toContain('Weekly 76%')
    expect(r.text).toContain('Pending: none')
    expect(r.text).toContain('Last skipped action: none')
  })

  test('startup registers all subcommands in the hint and reads weekly usage without a model call', async ($, on) => {
    const seen = world($, on, null)
    let command: any
    on('command.register', async (_$: unknown, e: any) => { command = e; return { value: { command: e.name } } })
    on('tool.register', async () => ({ value: { tool: 'mcp__model-router__escalate' } }))
    on('session.start', async (_$: unknown, e: any) => ({ cwd: e.cwd }))
    on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 1e6 }, rateLimits: [{ kind: 'seven_day', percentUsed: 76 }] } }))
    on('session.model', async () => ({ value: 'opus' }))
    await $.session.start({ cwd: '/plugin', surface: 'terminal', isInteractive: true })
    expect(command.argumentHint).toBe('[stats|status|context|checkpoint [note]|on|off]')
    expect(command.immediate).toBe(true)
    expect(command.description).toContain('status')
    expect(command.description).toContain('context')
    expect(seen.statuses.at(-1)).toBe('Weekly 76%')
    expect(seen.asked).toEqual([])
  })

  for (const breakdown of [true, false]) {
    test(`context requests only local summary estimates, breakdown available: ${breakdown}`, async ($, on) => {
      const seen = world($, on, null)
      const requests: any[] = []
      on('session.usage', async (_$: unknown, e: any) => {
        requests.push(e)
        return { value: { startedAt: 0, rateLimits: [], context: { tokens: 221_000, window: 1e6,
          ...(breakdown ? { breakdown: {
            categories: [{ name: 'Messages', tokens: 200_000, kind: 'used' as const, color: 'text', isDeferred: false }],
            totalTokens: 221_000, maxTokens: 1e6, rawMaxTokens: 1e6, percentage: 22, autocompactSource: 'auto' as const,
            gridRows: [], model: 'opus', memoryFiles: [], mcpTools: [], agents: [], isAutoCompactEnabled: true, apiUsage: null,
          } } : {}),
        } } }
      })
      const r = await $.command.run({ command: 'model-router', args: 'context' } as never)
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({ breakdown: 'summary' })
      expect(r.text).toContain('ctx: 221.0k')
      expect(r.text).toContain(breakdown ? 'Messages: ≈200.0k' : 'No local breakdown available.')
      expect(seen.asked).toEqual([])
    })
  }

  test('context with no usage reading says so and never calls a model', { options: { language: 'zh' } }, async ($, on) => {
    const seen = world($, on, null)
    on('session.usage', async () => ({ deny: 'unavailable' }))
    const r = await $.command.run({ command: 'model-router', args: 'context' } as never)
    expect(r.text).toContain('上下文尚无读数')
    expect(r.text).toContain('无本地分类数据。')
    expect(seen.asked).toEqual([])
  })

  test('reviewer probes and answers have their own spend category', { options: { reviewModel: 'claude-fable-5-5' } }, async ($, on) => {
    mock.session(on)
    const seen = world($, on, decide, { reviewer: true })
    await $.prompt.submit({ text: 'choose #opus' } as never)
    await $.turn.complete({ answer: 'choice', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'completed' } as never)
    await seen.clock.advance(0)
    const text = await statsOf($)
    expect(text.split('| Reviewer | 4 |')).toHaveLength(3)
    expect(seen.tally!.byRole!.reviewer!.cost).toBe(costOf(U(1, 1), 'fable') * 2)
  })

  test('session spend spans midnight while today includes only the new day', async ($, on) => {
    const now = new Date(2026, 9, 30, 0, 0).getTime()
    const yesterday = add(EMPTY, 'opus', U(1e6, 0))
    const seen = world($, on, null, { store: { [`meter:${storeDay(now - 1)}:sess-1`]: yesterday } })
    await seen.clock.advance(now)
    await $.prompt.submit({ text: 'work #opus' } as never)
    seen.usage.push(U(1000, 500, 2000, 3000))
    await step($, 't1')
    const text = await statsOf($)
    expect(text).toContain('**This session**: 1.0M tokens')
    expect(text).toContain('**Today**: 6.5k tokens')
  })

  test('a resumed context without a request timestamp has prices but no invented cache deadline', async ($, on) => {
    world($, on, null)
    on('session.model', async () => ({ value: 'claude-sonnet-5-5' }))
    await $.session.measure({ context: { window: 1e6, tokens: 221_000 }, rateLimits: [], changed: ['context'] } as never)
    const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await ui.find({ text: /Sonnet · ctx 221.0k.*cold resume ≈\$0.88.*cache deadline unknown/ })).toBeDefined()
  })

  test('new measurements while off replace stale exposure without inventing a send time', async ($, on) => {
    const seen = world($, on, decide)
    on('session.model', async () => ({ value: 'claude-sonnet-5-5' }))
    await $.prompt.submit({ text: 'choose #opus' } as never)
    seen.usage.push(U(1000, 500, 220_000))
    await step($, 't1')
    await $.command.run({ command: 'model-router', args: 'off' } as never)
    await $.session.measure({ context: { window: 1e6, tokens: 300_000 }, rateLimits: [], changed: ['context'] } as never)
    const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await ui.find({ text: /Sonnet · ctx 300.0k.*cold resume ≈\$1.20.*cache deadline unknown/ })).toBeDefined()
    expect(await ui.find({ key: 'router-enable' })).toBeDefined()
  })

  test('phase 1 rewrite counters remain visible in session and daily breakdowns', async ($, on) => {
    const day = storeDay(0)
    world($, on, null, { store: {
      [`counts:${day}:sess-1`]: { cacheExpiryRewrites: 2 },
      [`counts:${day}:sess-2`]: { cacheExpiryRewrites: 3 },
    } })
    const text = await statsOf($)
    expect(text.split('**Today**')[0]).toContain('Cold rewrites counted: 2')
    expect(text.split('**Today**')[1]).toContain('Cold rewrites counted: 5')
  })

  test('role and token-kind costs sum to spend; merge retains peaks and sizes', async () => {
    const u = U(1000, 2000, 3000, 4000)
    const a = { ...add(EMPTY, 'opus', u), compactions: [{ at: 0, before: 8000, after: 1000 }] }
    const b = add(EMPTY, 'sonnet', U(2000, 3000, 4000, 5000), false, false, 'subagents')
    const t = merge(a, b)
    expect(near(Object.values(t.byRole!).reduce((n, v) => n + v.cost, 0), t.cost)).toBe(true)
    expect(near(Object.values(t.byUsage!).reduce((n, v) => n + v.cost, 0), t.cost)).toBe(true)
    expect(t.peakMainContext).toBe(8000)
    expect(t.compactions).toEqual(a.compactions)
  })

  test('stats separate this session from today across sessions and label legacy spend honestly', async ($, on) => {
    const day = storeDay(0)
    const other = add(EMPTY, 'opus', U(1e6, 0))
    const legacy = { tokens: 1e6, cost: 4, baseline: 4, byModel: { opus: { tokens: 1e6, cost: 4 } } }
    const seen = world($, on, '{"tier":"lookup","reason":"find"}', { store: { [`meter:${day}:sess-2`]: other, [`meter:${day}`]: legacy } })
    await $.prompt.submit({ text: 'find' } as never)
    seen.usage.push(U(1000, 500, 2000, 3000, 'haiku'))
    await step($, 't1')
    seen.usage.push(U(100, 50, 200, 300, 'sonnet'))
    await step($, 'a1', 'sonnet', 'agent-1')
    const text = await statsOf($)
    const session = text.split('**Today**')[0]!
    expect(session).toContain('**This session**: 7.2k tokens')
    expect(session).toContain('| Main | 6.5k |')
    expect(session).toContain('| Subagents | 650 |')
    expect(session).toContain('| Classifier | 2 |')
    expect(session).toContain('| Reviewer | 0 |')
    expect(session).toContain('| Compaction | 0 |')
    expect(session).toContain('| Cache reads | 2.2k |')
    expect(session).toContain('| Cache writes | 3.3k |')
    expect(session).toContain('| Uncached input | 1.1k |')
    expect(session).toContain('| Output | 551 |')
    expect(session).toContain('Peak main context: 6.0k')
    expect(text).toContain('**Today**: 2.0M tokens')
    expect(text).toContain('Unattributed legacy spend: ≈$4.00')
    expect(text).toContain('same work tokens at Opus prices')
    expect(text).not.toContain('saved')
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
      triggers: [] as string[],
      toasts: [] as string[],
      agents: [] as string[],
      rejects: how === 'reject' ? Infinity : 0,
      sizes: {} as { tokensBefore?: number; tokensAfter?: number; usage?: ReturnType<typeof U> },
      beforeAgents: undefined as (() => Promise<void>) | undefined,
    }
    on('session.compact', async (_$: unknown, e: { instructions?: string; trigger: string }) => {
      c.instructions.push(e.instructions)
      c.triggers.push(e.trigger)
      if (c.rejects > 0) {
        c.rejects -= 1
        throw new Error('a turn is running')
      }
      return how === 'skip' ? { skip: 'vetoed' } : { messages: [{ role: 'user', text: 'summary', toolUses: [] }], ...c.sizes }
    })
    on('agent.list', async () => {
      await c.beforeAgents?.()
      return { value: c.agents.map((status, i) => ({ id: `agent-${i}`, description: 'd', type: 'general-purpose', status })) }
    })
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

  async function replaceSession($: any, seen: Seen, reason: string) {
    if (reason !== 'id change') await $.session.end({ reason, sessionId: seen.sessionId, resume: { id: seen.sessionId } } as never)
    seen.sessionId = 'sess-2'
  }

  describe('retryable bookkeeping (merge review #1)', () => {
    for (const failed of ['history', 'totals']) {
      test(`100 hook entries with failed ${failed} make one history scan and one totals attempt, then recover independently`, async ($, on) => {
        let failing = true
        let scans = 0
        let lists = 0
        let totals = 0
        let diagnostics = 0
        on('fs.read', { path: /events-sess-1\.json$/ }, async (_$: unknown, e: any, next: any) => {
          scans++
          return failing && failed === 'history' ? { deny: 'history unavailable' } : next(e)
        })
        on('store.get', { key: /^meter:\d{8}$/ }, async (_$: unknown, e: any, next: any) => {
          totals++
          return failing && failed === 'totals' ? { deny: 'totals unavailable' } : next(e)
        })
        on('fs.list', { path: /\/model-router\/sess-1$/ }, async (_$: unknown, e: any, next: any) => { lists++; return next(e) })
        on('ui.log', {}, async () => { diagnostics++; return { value: undefined } })
        const seen = world($, on, null, { store: { [`meter:${storeDay(0)}`]: add(EMPTY, 'haiku', U(1_000_000, 0)) } })
        const measure = () => $.session.measure({ context: { window: 1e6, tokens: 60_000 }, rateLimits: [], changed: ['context'] } as never)
        for (let i = 0; i < 100; i++) expect(await measure()).toMatchObject({ changed: ['context'] })
        expect(scans).toBe(1)
        expect(lists).toBe(failed === 'history' ? 0 : 1)
        expect(totals).toBe(1)
        expect(diagnostics).toBe(1)
        if (failed === 'totals') {
          await $.prompt.submit({ text: 'work during backoff #sonnet' } as never)
          seen.usage.push(U(100, 50))
          await step($, 't1')
          expect(seen.steps.at(-1)!.model).toBe('claude-sonnet-5-5[1m]')
          expect(totals).toBe(1)
          expect(scans).toBe(1)
        }
        failing = false
        await new Promise(resolve => setTimeout(resolve, 1100))
        await measure()
        expect(scans).toBe(failed === 'history' ? 2 : 1)
        expect(lists).toBe(1)
        expect(totals).toBe(failed === 'totals' ? 2 : 1)
        const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
        expect(await ui.find({ text: /today 1.0M token/ })).toBeDefined()
        await measure()
        expect(scans).toBe(failed === 'history' ? 2 : 1)
        expect(totals).toBe(failed === 'totals' ? 2 : 1)
        expect(diagnostics).toBe(1)
      })
    }

    test('bookkeeping backoff doubles from one second to five minutes and resets after recovery', async () => {
      const retry = new Backoff()
      let now = 0
      expect(retry.waiting(now)).toBe(false)
      retry.fail(now)
      for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000, 300000]) {
        expect(retry.delay).toBe(delay)
        now += delay - 1
        expect(retry.waiting(now)).toBe(true)
        now++
        expect(retry.waiting(now)).toBe(false)
        retry.fail(now)
      }
      retry.reset()
      expect(retry.waiting(now)).toBe(false)
      retry.fail(now)
      expect(retry.delay).toBe(1000)
    })

    test('100 stats entries bound failed store scans to five independent readers, then recover', async ($, on) => {
      let failing = true
      let attempts = 0
      let diagnostics = 0
      on('store.keys', {}, async (_$: unknown, e: any, next: any) => {
        attempts++
        return failing ? { deny: 'store unavailable' } : next(e)
      })
      on('ui.log', {}, async () => { diagnostics++; return { value: undefined } })
      const seen = world($, on, null, { store: { [`meter:${storeDay(0)}`]: add(EMPTY, 'haiku', U(1_000_000, 0)) } })
      for (let i = 0; i < 100; i++) expect(await statsOf($)).toContain('Compaction in this session:')
      expect(attempts).toBe(5) // Initialization, retained totals, session tally, and the two rewrite counts.
      expect(diagnostics).toBe(5)
      failing = false
      await new Promise(resolve => setTimeout(resolve, 1100))
      expect(await statsOf($)).toContain('**Today**: 1.0M tokens')
      expect(attempts).toBe(10)
      expect(diagnostics).toBe(5)
    })

    test('100 prompts with failed store reads try daily totals, shape and counters once each, then recover', async ($, on) => {
      let failing = true
      let attempts = 0
      let diagnostics = 0
      on('store.get', {}, async (_$: unknown, e: any, next: any) => {
        attempts++
        return failing ? { deny: 'store unavailable' } : next(e)
      })
      on('ui.log', {}, async () => { diagnostics++; return { value: undefined } })
      const seen = world($, on, null)
      for (let i = 0; i < 100; i++) await $.prompt.submit({ text: 'keep routing #haiku' } as never)
      expect(attempts).toBe(3)
      expect(diagnostics).toBe(3)
      expect(seen.submits).toHaveLength(100)
      expect(eventsOf(seen)).toHaveLength(100)
      failing = false
      await new Promise(resolve => setTimeout(resolve, 1100))
      await $.prompt.submit({ text: 'recovered #sonnet' } as never)
      expect(attempts).toBe(6)
      expect(diagnostics).toBe(3)
      await step($, 't101')
      expect(seen.steps.at(-1)!.model).toBe('claude-sonnet-5-5[1m]')
    })

    test('100 failed session-id lookups make one attempt and never reuse the previous identity', async ($, on) => {
      let failing = false
      let attempts = 0
      let diagnostics = 0
      on('session.id', {}, async (_$: unknown, e: any, next: any) => {
        if (!failing) return next(e)
        attempts++
        return { deny: 'identity unavailable' }
      })
      on('ui.log', {}, async () => { diagnostics++; return { value: undefined } })
      const seen = world($, on, null)
      await $.prompt.submit({ text: 'first #haiku' } as never)
      failing = true
      seen.sessionId = 'sess-2'
      for (let i = 0; i < 100; i++) await $.prompt.submit({ text: 'pass through #sonnet' } as never)
      expect(attempts).toBe(1)
      expect(diagnostics).toBe(1)
      expect(seen.submits).toHaveLength(101)
      expect(eventsOf(seen, 'sess-2')).toHaveLength(0)
      failing = false
      await new Promise(resolve => setTimeout(resolve, 1100))
      await $.prompt.submit({ text: 'recovered #sonnet' } as never)
      await step($, 't102')
      expect(seen.steps.at(-1)!.model).toBe('claude-sonnet-5-5[1m]')
      expect(eventsOf(seen, 'sess-2')).toContainEqual(expect.objectContaining({ event: 'turn route', to: 'sonnet/medium' }))
    })

    // A denial rejects the SDK call; a thrown test hook is skipped by the host instead.
    for (const operation of ['get', 'set']) {
      test(`prompt.submit still classifies and routes when the meter's state.${operation} throws`, async ($, on) => {
        let failures = 0
        let resets = 0
        on(`state.${operation}` as never, { plugin: 'model-router', key: 'meter' }, async () => {
          failures++
          if (seen.asked.length === 0) resets++
          return { deny: 'meter unavailable' }
        })
        const { seen } = compactWorld($, on)
        await $.prompt.submit({ text: 'work on it' } as never)
        expect(resets).toBe(1)
        expect(failures).toBeGreaterThan(0)
        expect(seen.asked).toEqual(['haiku'])
        expect(seen.submits).toHaveLength(1)
        expect(seen.submits[0]!.context?.[0]).toContain('assigned to sonnet at medium effort')
        await step($, 't1')
        expect(seen.steps[0]).toMatchObject({ model: 'claude-sonnet-5-5[1m]', effort: 'medium' })
      })

      test(`turn.step returns the engine's answer when the meter's state.${operation} throws`, async ($, on) => {
        let failing = false
        let failures = 0
        on(`state.${operation}` as never, { plugin: 'model-router', key: 'meter' }, async (_$: unknown, e: any, next: any) => {
          if (failing) { failures++; return { deny: 'meter unavailable' } }
          return next(e)
        })
        const { seen } = compactWorld($, on)
        await $.prompt.submit({ text: 'find it #haiku' } as never)
        failing = true
        seen.usage.push(U(100, 50))
        const stream = $.turn.step({ turnId: 't1', index: 0, model: `${OPUS}[1m]`, effort: 'high', messageCount: 3 } as never)
        let result
        while (true) {
          const part = await stream.next()
          if (part.done) { result = part.value; break }
        }
        expect(failures).toBe(1)
        expect(result).toMatchObject({ turnId: 't1', stopReason: 'end_turn', usage: U(100, 50) })
        expect(seen.steps[0]).toMatchObject({ model: 'claude-haiku-5-5[1m]', effort: 'medium' })
        failing = false
        const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
        expect(await ui.find({ text: /ctx 100/ })).toBeDefined()
      })

      test(`turn.complete returns normally when shape store.${operation} throws`, { options: { checkpointHints: true } }, async ($, on) => {
        let failing = false
        let failures = 0
        on(`store.${operation}` as never, { key: 'shape' }, async (_$: unknown, e: any, next: any) => {
          if (failing) { failures++; return { deny: 'shape unavailable' } }
          return next(e)
        })
        const { seen, c } = compactWorld($, on)
        await $.prompt.submit({ text: 'find it #haiku' } as never)
        seen.usage.push(U(100, 50, 150_000, 0, 'claude-haiku-5-5'))
        await step($, 't1')
        failing = true
        expect(await $.turn.complete(done('t1'))).toMatchObject({ text: 'ok' })
        expect(failures).toBe(1)
        expect(c.toasts).toHaveLength(1)
        expect(c.toasts[0]).toContain('/model-router checkpoint')
      })
    }

    test('turn.start reaches the engine when its turn counter write throws', async ($, on) => {
      let failures = 0
      let starts = 0
      on('store.set', { key: /^counts:/ }, async () => { failures++; return { deny: 'counters unavailable' } })
      on('turn.start', {}, async (_$: unknown, e: any, next: any) => { starts++; return next(e) })
      const { seen } = compactWorld($, on)
      await $.prompt.submit({ text: 'find it #haiku' } as never)
      expect(failures).toBe(1)
      expect(starts).toBe(1)
      expect(eventsOf(seen)).toContainEqual(expect.objectContaining({ event: 'turn route', to: 'haiku/medium' }))
      await step($, 't1')
      expect(seen.steps[0]).toMatchObject({ model: 'claude-haiku-5-5[1m]', effort: 'medium' })
    })

    test('agent.spawn returns the routed agent when its counter write throws', async ($, on) => {
      let failures = 0
      on('store.set', { key: /^counts:/ }, async () => { failures++; return { deny: 'counters unavailable' } })
      const { seen } = compactWorld($, on)
      const id = await spawnAgent($, { subagentType: 'Explore' })
      expect(failures).toBe(1)
      expect(id).toBe('agent-1')
      expect(seen.agents).toEqual(['haiku'])
      await step($, 'a1', `${OPUS}[1m]`, id)
      expect(seen.steps[0]).toMatchObject({ model: 'claude-haiku-5-5[1m]', effort: 'medium', agentId: id })
    })

    test('tool.call replies with the new route when its escalation counter write throws', async ($, on) => {
      let failing = false
      let failures = 0
      on('store.set', { key: /^counts:/ }, async (_$: unknown, e: any, next: any) => {
        if (failing) { failures++; return { deny: 'counters unavailable' } }
        return next(e)
      })
      const { seen } = compactWorld($, on)
      await $.prompt.submit({ text: 'find it #haiku' } as never)
      failing = true
      const result = await $.tool.call({ tool: 'mcp__model-router__escalate', model: 'opus', reason: 'design call' } as never)
      expect(result.result).toContain('runs on opus at medium effort')
      expect(failures).toBe(1)
      await step($, 't1')
      expect(seen.steps[0]).toMatchObject({ model: 'claude-opus-5-5[1m]', effort: 'medium' })
    })

    test('session.compact returns the engine sizes when its detail and usage writes throw', async ($, on) => {
      let failures = 0
      on('store.set', { key: /^meter:/ }, async () => { failures++; return { deny: 'meter unavailable' } })
      const { c } = compactWorld($, on)
      c.sizes = { tokensBefore: 150_000, tokensAfter: 20_000, usage: U(100, 50) }
      expect(await $.session.compact({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never)).toMatchObject(c.sizes)
      expect(failures).toBe(2)
      expect(c.instructions).toHaveLength(1)
    })

    test('command.run replies with stats when retained totals cannot be read and logging fails too', async ($, on) => {
      let failing = false
      let failures = 0
      let logs = 0
      on('store.keys', {}, async (_$: unknown, e: any, next: any) => {
        if (failing) { failures++; return { deny: 'totals unavailable' } }
        return next(e)
      })
      on('ui.log', {}, async () => { logs++; return { deny: 'log unavailable' } })
      compactWorld($, on)
      await $.prompt.submit({ text: 'find it #haiku' } as never)
      failing = true
      expect(await statsOf($)).toContain('**This session**: 0 tokens')
      expect(failures).toBe(4)
      expect(logs).toBe(4)
    })

    test('session.measure reaches the engine when loading the daily meter throws', async ($, on) => {
      let failures = 0
      on('store.get', { key: /^meter:/ }, async () => { failures++; return { deny: 'totals unavailable' } })
      compactWorld($, on)
      const changed = ['context'] as const
      const result = await $.session.measure({ context: { window: 1e6, tokens: 60_000 }, rateLimits: [], changed } as never)
      expect(result).toMatchObject({ changed })
      expect(failures).toBe(1)
      const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
      expect(await ui.find({ text: /ctx 60.0k/ })).toBeDefined()
      expect(await ui.find({ text: /other mods/ })).toBeDefined()
    })

    for (const key of ['meter', 'route']) {
      test(`ui.render keeps the band and other mods when the ${key} read throws`, async ($, on) => {
        let failing = false
        let failures = 0
        on('state.get', { plugin: 'model-router', key }, async (_$: unknown, e: any, next: any) => {
          if (failing) { failures++; return { deny: 'display state unavailable' } }
          return next(e)
        })
        compactWorld($, on)
        await $.prompt.submit({ text: 'find it #haiku' } as never)
        failing = true
        const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
        expect(failures).toBe(1)
        expect(await ui.find({ text: /turn 0 token/ })).toBeDefined()
        expect(await ui.find({ text: /other mods/ })).toBeDefined()
      })
    }

    test('turn.complete returns the engine result when its route read for accounting throws', { options: { checkpointHints: true } }, async ($, on) => {
      let failing = false
      let failures = 0
      on('state.get', { plugin: 'model-router', key: 'route' }, async (_$: unknown, e: any, next: any) => {
        if (failing) { failures++; return { deny: 'route unavailable' } }
        return next(e)
      })
      const { seen, c } = compactWorld($, on)
      await $.prompt.submit({ text: 'find it #haiku' } as never)
      seen.usage.push(U(100, 50, 150_000, 0, 'claude-haiku-5-5'))
      await step($, 't1')
      failing = true
      expect(await $.turn.complete(done('t1'))).toMatchObject({ text: 'ok' })
      expect(failures).toBe(1)
      expect(c.toasts).toHaveLength(1)
      expect(c.toasts[0]).toContain('/model-router checkpoint')
    })

    for (const failure of ['get', 'keys', 'set']) {
      test(`store.${failure} failures leave commands and routing usable, then recover`, async ($, on) => {
        let failing = false
        let failures = 0
        on(`store.${failure}` as never, {}, async (_$: unknown, e: any, next: any) => {
          if (failing) { failures++; throw new Error('temporarily unavailable') }
          return failure === 'get' ? { value: seen.store[e.key] } : failure === 'keys' ? { value: Object.keys(seen.store) } : next(e)
        })
        if (failure !== 'get') on('store.get', {}, async (_$: unknown, e: any) => ({ value: seen.store[e.key] }))
        if (failure !== 'keys') on('store.keys', {}, async () => ({ value: Object.keys(seen.store) }))
        on('fs.read', {}, async (_$: unknown, e: any, next: any) => seen.files[e.path] === undefined ? next(e) : { value: seen.files[e.path] })
        on('session.start', async (_$: unknown, e: any) => ({ cwd: e.cwd }))
        on('command.register', async (_$: unknown, e: any) => ({ value: { command: e.name } }))
        on('tool.register', async () => ({ value: { tool: 'mcp__model-router__escalate' } }))
        on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 1e6 }, rateLimits: [] } }))
        on('session.model', async () => ({ value: 'opus' }))
        const { seen } = compactWorld($, on)
        await mainTurn($, seen, 't1', 150_000)
        await replaceSession($, seen, 'clear')
        const other = add(EMPTY, 'haiku', U(1_000_000, 0))
        // Read from the same store as the engine, including a second session's retained total.
        seen.store[`meter:${storeDay(0)}:other`] = other
        failing = true
        await $.session.start({ cwd: '/plugin', surface: 'terminal', isInteractive: true })
        expect((await $.command.run({ command: 'model-router', args: 'stats' } as never)).text).toContain('Compaction in this session:')
        await $.command.run({ command: 'model-router', args: 'off' } as never)
        await $.command.run({ command: 'model-router', args: 'on' } as never)
        await $.prompt.submit({ text: 'continue #sonnet' } as never)
        seen.usage.push(U(100, 50))
        await step($, 't2')
        expect(seen.steps.at(-1)!.model).toBe('claude-sonnet-5-5[1m]')
        await $.turn.complete(done('t2'))
        expect(failures).toBeGreaterThan(0)
        failing = false
        await new Promise(resolve => setTimeout(resolve, 1100))
        const text = await statsOf($)
        expect(text).toContain('**Today**: 1.')
        expect(eventsOf(seen, seen.sessionId).some(e => e.event === 'turn route' && e.to === 'sonnet/medium')).toBe(true)
        // A retry must not clear the route chosen while initialization was unavailable.
        await step($, 't2')
        expect(seen.steps.at(-1)!.model).toBe('claude-sonnet-5-5[1m]')
      })
    }

    test('a totals retry preserves restored history and events added while log writes fail', async ($, on) => {
      let failing = true
      let restores = 0
      const history = { sessionId: 'sess-1', events: [{ at: '1969-12-31T12:00:00Z', agentId: 'old-agent', event: 'Explore start', to: 'haiku/medium', reason: 'old work' }], stats: {} }
      on('fs.read', { path: /events-.*\.json$/ }, async (_$: unknown, e: any) => { restores++; seen.files[e.path] = JSON.stringify(history); return { value: seen.files[e.path] } })
      on('fs.write', { path: /\/model-router\/[^/]+\/[^/]+\.json$/ }, async (_$: unknown, e: any, next: any) => {
        if (failing) throw new Error('disk unavailable')
        return next(e)
      })
      on('store.get', {}, async (_$: unknown, e: any, next: any) => {
        if (failing && e.key.startsWith('meter:')) throw new Error('store unavailable')
        return next(e)
      })
      const { seen } = compactWorld($, on)
      await $.prompt.submit({ text: 'new work #haiku' } as never)
      failing = false
      // Event-log retry deadlines use wall time; the engine's mock clock only controls hook timers.
      await new Promise(resolve => setTimeout(resolve, 1100))
      await statsOf($)
      await spawnAgent($, { subagentType: 'Explore' })
      expect(restores).toBeGreaterThan(0)
      const events = eventsOf(seen)
      expect(events).toContainEqual(history.events[0])
      expect(events).toContainEqual(expect.objectContaining({ event: 'turn route', to: 'haiku/medium' }))
      expect(events).toHaveLength(3)
    })

    test('a failed history load never stops new batches, then reads legacy events and agent usage on retry', async ($, on) => {
      let failing = true
      let restores = 0
      const lengths: number[] = []
      const model = 'claude-haiku-5-5[1m]'
      const usage = U(100, 50, 0, 0, model)
      const history = {
        sessionId: 'sess-1',
        events: [{ at: '1969-12-31T12:00:00Z', agentId: 'agent-1', event: 'Explore start', to: 'haiku/medium', reason: 'old work' }],
        stats: { 'agent-1': addUsage(undefined, model, 'medium', usage) },
      }
      on('fs.read', { path: /events-.*\.json$/ }, async (_$: unknown, e: any) => {
        restores++
        if (failing) return { deny: 'disk unavailable' }
        seen.files[e.path] = JSON.stringify(history)
        return { value: seen.files[e.path] }
      })
      on('fs.write', { path: /\/model-router\/[^/]+\/[^/]+\.json$/ }, async (_$: unknown, e: any, next: any) => {
        lengths.push(JSON.parse(e.text).events.length)
        return next(e)
      })
      const { seen } = compactWorld($, on)
      await $.prompt.submit({ text: 'new work #haiku' } as never)
      const agentId = await spawnAgent($, { subagentType: 'Explore' })
      seen.usage.push(usage)
      await step($, 'a1', model, agentId, 'medium')
      expect(lengths).toEqual([1, 1, 0])
      failing = false
      await new Promise(resolve => setTimeout(resolve, 1100))
      await statsOf($)
      await spawnAgent($, { subagentType: 'Explore' })
      expect(restores).toBeGreaterThan(1)
      const events = eventsOf(seen)
      expect(events[0]).toEqual(history.events[0])
      expect(events).toHaveLength(4)
      expect(historyOf(seen).stats['agent-1']).toEqual(addUsage(history.stats['agent-1'], model, 'medium', usage))
      // A successful restore is never applied a second time, even on further hooks and writes.
      await statsOf($)
      await spawnAgent($, { subagentType: 'Explore' })
      expect(eventsOf(seen)).toHaveLength(5)
      expect(lengths).toEqual([1, 1, 0, 1, 1])
    })

    test('session.start preserves a route and turn spend established during registration', async ($, on) => {
      let turnTokens = 0
      on('state.set', { plugin: 'model-router', key: 'meter' }, async (_$: unknown, e: any, next: any) => {
        const result = await next(e)
        turnTokens = e.value.turn.tokens
        return result
      })
      on('session.start', async (_$: unknown, e: any) => ({ cwd: e.cwd }))
      on('command.register', async (_$: unknown, e: any) => ({ value: { command: e.name } }))
      on('tool.register', async () => {
        await $.prompt.submit({ text: 'new work #haiku' } as never)
        seen.usage.push(U(100, 50))
        await step($, 't1')
        return { value: { tool: 'mcp__model-router__escalate' } }
      })
      on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 1e6 }, rateLimits: [] } }))
      on('session.model', async () => ({ value: 'opus' }))
      const { seen } = compactWorld($, on)
      await $.session.start({ cwd: '/plugin', surface: 'terminal', isInteractive: true })
      expect(turnTokens).toBe(150)
      await step($, 't1')
      expect(seen.steps.at(-1)!.model).toBe('claude-haiku-5-5[1m]')
      expect(turnTokens).toBe(150)
    })

    test('route load failures through prompt and turn start cannot erase the assigned route on retry', async ($, on) => {
      let clears = 0
      on('state.set', { plugin: 'model-router', key: 'route' }, async (_$: unknown, e: any, next: any) => {
        if (e.value === null && ++clears <= 2) return { deny: 'initialization unavailable' }
        return next(e)
      })
      const { seen } = compactWorld($, on)
      await $.prompt.submit({ text: 'continue #haiku' } as never)
      await step($, 't1')
      expect(seen.steps.at(-1)!.model).toBe('claude-haiku-5-5[1m]')
      await statsOf($)
      await step($, 't1')
      expect(seen.steps.at(-1)!.model).toBe('claude-haiku-5-5[1m]')
    })

    test('a meter load retry keeps spend recorded after its failed initialization', async ($, on) => {
      let fail = true
      let turnTokens = 0
      on('state.set', { plugin: 'model-router', key: 'meter' }, async (_$: unknown, e: any, next: any) => {
        if (fail && e.value.turn.tokens === 0) { fail = false; return { deny: 'initialization unavailable' } }
        const result = await next(e)
        turnTokens = e.value.turn.tokens
        return result
      })
      const { seen } = compactWorld($, on)
      seen.usage.push(U(100, 50))
      await step($, 't1')
      expect(turnTokens).toBe(150)
      await statsOf($)
      expect(turnTokens).toBe(150)
      seen.usage.push(U(100, 50))
      await step($, 't1')
      expect(turnTokens).toBe(300)
    })
  })

  describe('session lifetime (final review #1)', () => {

    for (const lookup of [1, 2]) {
      test(`the minute tick retries identity failure at lookup ${lookup} without retiring the route or idle guard`, { options: { idleCompactMinutes: 20 } }, async ($, on) => {
        let remaining = 0
        let failures = 0
        on('session.id', {}, async (_$: unknown, e: any, next: any) => {
          if (remaining > 0 && --remaining === 0) { failures++; return { deny: 'identity unavailable' } }
          return next(e)
        })
        const { seen, c } = compactWorld($, on)
        await mainTurn($, seen, 't1', 150_000)
        remaining = lookup
        await seen.clock.advance(MIN)
        expect(failures).toBe(1)
        // The repeating tick stays alive during backoff, as does the not-yet-fired idle timer.
        await seen.clock.advance(MIN)
        expect(failures).toBe(1)
        await new Promise(resolve => setTimeout(resolve, 1100))
        await seen.clock.advance(MIN)
        expect(seen.statuses.at(-1)).toBe('idle compact in 17m')
        const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
        expect(await ui.find({ text: /Sonnet · medium/ })).toBeDefined()
        await seen.clock.advance(17 * MIN)
        expect(c.instructions).toHaveLength(1)
        expect(c.toasts.at(-1)).toContain('150.0k')
      })
    }

    for (const path of ['idle', 'cap', 'checkpoint']) {
      test(`${path} skips an unavailable identity and recovers without a new session`, { options: { idleCompactMinutes: 20, compactAtContext: 200_000 } }, async ($, on) => {
        on('clock.every', {}, async (_$: unknown, e: any, next: any) => next({ ...e, ms: 24 * 60 * MIN }))
        let failing = false
        let failures = 0
        on('session.id', {}, async (_$: unknown, e: any, next: any) => {
          if (failing) { failures++; return { deny: 'identity unavailable' } }
          return next(e)
        })
        const { seen, c } = compactWorld($, on)
        await mainTurn($, seen, 't1', path === 'cap' ? 250_000 : 150_000)
        if (path === 'checkpoint') {
          const r = await $.command.run({ command: 'model-router', args: 'checkpoint first' } as never)
          expect(r.text).toContain('Creating checkpoint')
        }
        failing = true
        await seen.clock.advance(path === 'idle' ? 20 * MIN : 0)
        expect(failures).toBe(1)
        expect(c.instructions).toHaveLength(0)
        // Backoff is wall time; advancing mock timers must neither compact nor retire this lifetime.
        await seen.clock.advance(MIN)
        expect(failures).toBe(1)
        failing = false
        await new Promise(resolve => setTimeout(resolve, 1100))
        if (path === 'checkpoint') {
          const r = await $.command.run({ command: 'model-router', args: 'checkpoint recovered' } as never)
          expect(r.text).toContain('Creating checkpoint')
          await seen.clock.advance(0)
          expect(c.instructions).toHaveLength(1)
          expect(c.instructions[0]).toContain('Checkpoint note: recovered')
        } else {
          // The old route and accounting still work, then a fresh completion can arm the next guard.
          seen.usage.push(U(100, 50, 149_900))
          await step($, 't1')
          expect(seen.steps.at(-1)).toMatchObject({ model: 'claude-sonnet-5-5[1m]', effort: 'medium' })
          expect(seen.tally!.tokens).toBeGreaterThan(150_500)
          await $.turn.complete(done('t1'))
          await seen.clock.advance(20 * MIN)
          expect(c.instructions).toHaveLength(1)
        }
      })
    }

    test('checkpoint validation keeps its running lock after releasing the fired handle, then unlocks on identity failure', async ($, on) => {
      let checking = false
      let checked = false
      on('session.id', {}, async (_$: unknown, e: any, next: any) => {
        if (checking) {
          checking = false
          checked = true
          const duplicate = await $.command.run({ command: 'model-router', args: 'checkpoint duplicate' } as never)
          expect(duplicate.text).toContain('already running')
          return { deny: 'identity unavailable' }
        }
        return next(e)
      })
      const { seen, c } = compactWorld($, on)
      const first = await $.command.run({ command: 'model-router', args: 'checkpoint first' } as never)
      expect(first.text).toContain('Creating checkpoint')
      checking = true
      await seen.clock.advance(0)
      expect(checked).toBe(true)
      expect(c.instructions).toHaveLength(0)
      await new Promise(resolve => setTimeout(resolve, 1100))
      const recovered = await $.command.run({ command: 'model-router', args: 'checkpoint recovered' } as never)
      expect(recovered.text).toContain('Creating checkpoint')
      await seen.clock.advance(0)
      expect(c.instructions).toHaveLength(1)
    })

    test('a routing hook passes through an unavailable identity, then uses its existing route and meter after recovery', async ($, on) => {
      let remaining = 0
      let failures = 0
      on('session.id', {}, async (_$: unknown, e: any, next: any) => {
        if (remaining > 0 && --remaining === 0) { failures++; return { deny: 'identity unavailable' } }
        return next(e)
      })
      const { seen } = compactWorld($, on)
      await $.prompt.submit({ text: 'continue #sonnet' } as never)
      remaining = 2 // useSession succeeds, then the route's stillHere check fails.
      await step($, 't1')
      expect(failures).toBe(1)
      expect(seen.steps.at(-1)).toMatchObject({ model: 'claude-opus-5-5[1m]', effort: 'high' })
      await step($, 't1')
      expect(failures).toBe(1)
      await new Promise(resolve => setTimeout(resolve, 1100))
      seen.usage.push(U(100, 50))
      await step($, 't1')
      expect(seen.steps.at(-1)).toMatchObject({ model: 'claude-sonnet-5-5[1m]', effort: 'medium' })
      expect(seen.tally!.tokens).toBe(150)
    })

    test('an ordinary routing hook starts a fresh lifetime for an ended id', { options: { idleCompactMinutes: 20 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      await mainTurn($, seen, 't1', 150_000)
      await $.session.end({ reason: 'resume', sessionId: seen.sessionId, resume: { id: seen.sessionId } } as never)
      await $.prompt.submit({ text: 'fresh work #haiku' } as never)
      seen.usage.push(U(100, 50))
      await step($, 't2')
      expect(seen.steps.at(-1)).toMatchObject({ model: 'claude-haiku-5-5[1m]', effort: 'medium' })
      const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
      expect(await ui.find({ text: /turn 150 token/ })).toBeDefined()
      await seen.clock.advance(20 * MIN)
      expect(c.instructions).toHaveLength(0)
    })

    test('a confirmed id change on the minute tick retires the old lifetime even if that id returns', { options: { idleCompactMinutes: 20 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      await mainTurn($, seen, 't1', 150_000)
      seen.sessionId = 'sess-2'
      await seen.clock.advance(MIN)
      seen.sessionId = 'sess-1'
      // No session.start: the old object is ended, so the ordinary hook must replace it.
      await $.prompt.submit({ text: 'fresh work #haiku' } as never)
      await step($, 't2')
      expect(seen.steps.at(-1)).toMatchObject({ model: 'claude-haiku-5-5[1m]', effort: 'medium' })
      await seen.clock.advance(20 * MIN)
      expect(c.instructions).toHaveLength(0)
    })

    describe('host state across module activations', () => {
      // Each test loads the hooks in a fresh module environment. Keep the host's state and store across that reload.
      const retained = new Map<string, { value: unknown; version: number }>()
      let store: Record<string, unknown> = {}
      const members = new Set<string>()
      function retainState(on: any) {
        on('state.get', { plugin: 'model-router' }, async (_$: unknown, e: any) => {
          const key = `${e.key}:${e.id ?? ''}`
          return { value: retained.get(key) ?? { value: undefined, version: 0 } }
        })
        on('state.set', { plugin: 'model-router' }, async (_$: unknown, e: any) => {
          const key = `${e.key}:${e.id ?? ''}`
          const version = (retained.get(key)?.version ?? 0) + 1
          retained.set(key, { value: e.value, version })
          if (e.id) members.add(e.id)
          return { value: { isSet: true, version } }
        })
      }

      test('retains an older route and meter after a same-id resume advances the current lifetime', async ($, on) => {
        retainState(on)
        on('command.register', async (_$: unknown, e: any) => ({ value: { command: e.name } }))
        on('tool.register', async () => ({ value: { tool: 'mcp__model-router__escalate' } }))
        on('session.start', async (_$: unknown, e: any) => ({ cwd: e.cwd }))
        on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 1e6 }, rateLimits: [] } }))
        on('session.model', async () => ({ value: 'opus' }))
        const seen = world($, on, null)
        await $.prompt.submit({ text: 'old work #haiku' } as never)
        seen.usage.push(U(100, 50))
        await step($, 't1')
        await $.session.end({ reason: 'resume', sessionId: seen.sessionId, resume: { id: seen.sessionId } } as never)
        await $.session.start({ cwd: '/plugin', surface: 'terminal', isInteractive: true })
        await $.prompt.submit({ text: 'current work #sonnet' } as never)
        seen.usage.push(U(200, 100))
        await step($, 't2')
        expect(seen.steps.at(-1)).toMatchObject({ model: 'claude-sonnet-5-5[1m]', effort: 'medium' })
        expect(members.size).toBe(2)
        expect([...retained.values()].map(state => state.value)).toContainEqual(expect.objectContaining({ turn: expect.objectContaining({ tokens: 150 }) }))
        store = { ...seen.store }
      })

      test('a reload starts with fresh route, effort and turn spend while the host retains earlier lifetimes', async ($, on) => {
        const earlier = new Set(members)
        expect(earlier.size).toBe(2)
        retainState(on)
        const seen = world($, on, null, { store })
        const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
        expect(await ui.find({ text: /turn 0 token.*today 450 token/ })).toBeDefined()
        await $.prompt.submit({ text: 'work after reload' } as never)
        expect(seen.prompts[0]).toContain('<previous_tier>none</previous_tier>')
        await step($, 't3')
        expect(seen.steps.at(-1)).toMatchObject({ model: 'claude-opus-5-5[1m]', effort: 'high' })
        expect(eventsOf(seen).at(-1)).toMatchObject({ event: 'turn route', to: 'session model' })
        expect(members.size).toBe(earlier.size + 1)
      })
    })
    for (const path of ['session.start', 'command.run', 'session.measure', 'session.measure resumed', 'session.compact', 'prompt.submit', 'turn.start', 'turn.step', 'session.append', 'fetch_output', 'escalate', 'tool.call', 'agent.spawn', 'turn.complete', 'ui.render', 'stillHere', 'UI tick']) {
      test(`a stale ${path} lookup cannot reset a newer session (third review #1)`, { options: { idleCompactMinutes: 20, shrinkToolOutput: 20_000 } }, async ($, on) => {
        let remaining = 0
        let hit = false
        let release: (() => void) | undefined
        let reading: (() => void) | undefined
        const started = new Promise<void>(resolve => { reading = resolve })
        const held = new Promise<void>(resolve => { release = resolve })
        on('session.id', {}, async (_$: unknown, e: any, next: any) => {
          const result = await next(e)
          if (remaining > 0 && --remaining === 0) {
            hit = true
            reading!()
            await held
          }
          return result
        })
        on('command.register', async (_$: unknown, e: any) => ({ value: { command: e.name } }))
        on('tool.register', async () => ({ value: { tool: 'mcp__model-router__escalate' } }))
        on('session.start', async (_$: unknown, e: any) => ({ cwd: e.cwd }))
        on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 1e6 }, rateLimits: [] } }))
        on('session.model', async () => ({ value: 'opus' }))
        on('prompt.submit', { text: 'old prompt' }, async () => ({ drop: 'held' }))
        on('tool.call', { tool: 'Bash' }, async () => ({ result: 'ok' }))
        on('session.append', { door: 'tool-result' }, async (_$: unknown, e: any, next: any) => next(e))
        const { seen, c } = compactWorld($, on)
        await mainTurn($, seen, 't1', 150_000)
        remaining = path === 'stillHere' ? 2 : 1
        const old = (async () => {
          if (path === 'session.start') await $.session.start({ cwd: '/plugin', surface: 'terminal', isInteractive: true })
          else if (path === 'command.run' || path === 'stillHere') await $.command.run({ command: 'model-router', args: 'status' } as never)
          else if (path.startsWith('session.measure')) await $.session.measure({ context: { window: 1e6, tokens: 250_000 }, rateLimits: [], changed: ['context'] } as never)
          else if (path === 'session.compact') await $.session.compact({ messages: [{ role: 'user', text: 'old summary', toolUses: [] }] } as never)
          else if (path === 'prompt.submit') await $.prompt.submit({ text: 'old prompt' } as never)
          else if (path === 'turn.start') await $.turn.start({ turnId: 'old', text: 'old work' } as never)
          else if (path === 'turn.step') await step($, 'old')
          else if (path === 'session.append') await $.session.append({ door: 'tool-result', origin: { kind: 'tool', tool: 'Bash' }, uuid: 'old', message: { type: 'user', role: 'user', content: [] } } as never)
          else if (path === 'fetch_output') await $.tool.call({ tool: 'mcp__model-router__fetch_output', id: 'old' } as never)
          else if (path === 'escalate') await $.tool.call({ tool: 'mcp__model-router__escalate', agentId: 'old-agent', reason: 'old work' } as never)
          else if (path === 'tool.call') await $.tool.call({ tool: 'Bash', agentId: 'old-agent' } as never)
          else if (path === 'agent.spawn') await spawnAgent($, { subagentType: 'Explore' })
          else if (path === 'turn.complete') await $.turn.complete(done('t1'))
          else if (path === 'UI tick') await seen.clock.advance(MIN)
          else await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
        })()
        await Promise.race([started, old])
        expect(hit).toBe(true)
        if (path === 'session.measure resumed') {
          await $.session.end({ reason: 'resume', sessionId: seen.sessionId, resume: { id: seen.sessionId } } as never)
          await $.session.start({ cwd: '/plugin', surface: 'terminal', isInteractive: true })
        } else seen.sessionId = 'sess-2'
        await mainTurn($, seen, 'replacement', 180_000)
        // This newer reading must survive alongside the route, tracked agent and idle timer.
        await $.session.measure({ context: { window: 1e6, tokens: 190_000 }, rateLimits: [], changed: ['context'] } as never)
        const replacementAgent = await spawnAgent($, { subagentType: 'Explore' })
        release!()
        await old
        expect(seen.statuses.at(-1)).toBe('idle compact in 20m')
        const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
        expect(await ui.find({ text: /ctx 190.0k/ })).toBeDefined()
        expect(await ui.find({ text: /Sonnet · medium/ })).toBeDefined()
        const raised = await $.tool.call({ tool: 'mcp__model-router__escalate', agent: replacementAgent, model: 'sonnet', reason: 'more work' } as never)
        expect(raised.result).toContain('now runs sonnet')
        const compactions = c.instructions.length
        await seen.clock.advance(20 * MIN)
        expect(c.instructions).toHaveLength(compactions + 1)
        expect(c.toasts.at(-1)).toContain('190.0k')
      })
    }

    test('session.end invalidates a pending session.start lookup even before another activation (third review #1)', async ($, on) => {
      let ending = false
      let registrations = 0
      on('session.id', {}, async (_$: unknown, e: any, next: any) => {
        const result = await next(e)
        if (ending) {
          ending = false
          await $.session.end({ reason: 'clear', sessionId: seen.sessionId, resume: { id: seen.sessionId } } as never)
        }
        return result
      })
      on('session.start', async (_$: unknown, e: any) => ({ cwd: e.cwd }))
      on('command.register', async (_$: unknown, e: any) => { registrations++; return { value: { command: e.name } } })
      on('tool.register', async () => ({ value: { tool: 'mcp__model-router__escalate' } }))
      on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 1e6 }, rateLimits: [] } }))
      const { seen } = compactWorld($, on)
      await mainTurn($, seen, 't1', 150_000)
      ending = true
      await $.session.start({ cwd: '/plugin', surface: 'terminal', isInteractive: true })
      expect(ending).toBe(false)
      expect(registrations).toBe(0)
      // An ordinary hook starts a fresh lifetime; it must never reuse the ended object.
      const r = await $.command.run({ command: 'model-router', args: 'status' } as never)
      expect(r.text).toContain('Current settings')
    })

    for (const change of ['clear', 'resume', 'id change']) {
      test(`${change} restores destination events and agent stats before concurrent new events (second review #3)`, async ($, on) => {
        let release: (() => void) | undefined
        let reading: (() => void) | undefined
        let restoring = false
        const started = new Promise<void>(resolve => { reading = resolve })
        const held = new Promise<void>(resolve => { release = resolve })
        on('fs.read', {}, async (_$: unknown, e: any, next: any) => {
          if (e.path.endsWith('/events-sess-2.json')) {
            const text = seen.files[e.path]
            restoring = true
            reading!()
            await held
            return { value: text }
          }
          return next(e)
        })
        const { seen } = compactWorld($, on)
        await mainTurn($, seen, 't1', 150_000)
        const path = `${Object.keys(seen.files)[0]!.split('/model-router/')[0]}/model-router/events-sess-2.json`
        const history = {
          sessionId: 'sess-2',
          events: Array.from({ length: 5 }, (_, i) => ({ at: '1969-12-31T12:00:00Z', agentId: 'old-agent', event: 'Explore start', to: 'haiku/medium', reason: `find files ${i}` })),
          stats: { 'old-agent': addUsage(undefined, 'haiku', 'medium', U(100, 50, 200, 300)) },
        }
        seen.files[path] = JSON.stringify(history)
        await replaceSession($, seen, change)
        const activating = $.command.run({ command: 'model-router', args: 'status' } as never)
        await Promise.race([started, activating])
        expect(restoring).toBe(true)
        const prompt = $.prompt.submit({ text: 'new work #opus' } as never)
        const agent = spawnAgent($, { subagentType: 'Explore' })
        await seen.clock.advance(0)
        expect(JSON.parse(seen.files[path]!)).toEqual(history)
        release!()
        await Promise.all([activating, prompt, agent])
        expect(JSON.parse(seen.files[path]!)).toEqual(history)
        const restored = historyOf(seen, 'sess-2')
        expect(restored.events.slice(0, history.events.length)).toEqual(history.events)
        expect(restored.events).toHaveLength(7)
        expect(restored.stats).toEqual(history.stats)
      })

      for (const first of ['stats', 'band']) {
        test(`${change} reloads today's aggregate with ${first} first and resets only the turn in the band (second review #5)`, async ($, on) => {
          on('store.get', {}, async (_$: unknown, e: any) => ({ value: seen.store[e.key] }))
          on('store.keys', {}, async () => ({ value: Object.keys(seen.store) }))
          const { seen } = compactWorld($, on)
          await mainTurn($, seen, 't1', 150_000)
          const other = add(EMPTY, 'haiku', U(1_000_000, 0))
          const legacy = add(EMPTY, 'sonnet', U(2_000_000, 0))
          const today = merge(merge(seen.tally!, other), legacy)
          seen.store[`meter:${storeDay(0)}:sess-2`] = other
          seen.store[`meter:${storeDay(0)}`] = legacy
          await replaceSession($, seen, change)
          if (first === 'stats') {
            const text = await statsOf($)
            const day = text.split('**Today**')[1]!.split('**Retained total')[0]!
            expect(day).toContain(`${fmtUsd(today.cost)} API-equivalent`)
            expect(day).toContain(`same work tokens at Opus prices (switch-adjusted): ${fmtUsd(today.baseline)}`)
          }
          const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
          expect(await ui.find({ text: new RegExp(`turn 0 token.*today .*${fmtUsd(today.cost).replace('$', '\\$')}`) })).toBeDefined()
        })
      }
    }

    for (const path of ['turn.complete cap', 'turn.complete idle', 'checkpoint command', 'session.compact observer']) {
      test(`${path} keeps its generation from before the session lookup (second review #1)`, { options: { idleCompactMinutes: 20, compactAtContext: 200_000 } }, async ($, on) => {
        let active = false
        let hit = false
        on('session.id', {}, async (_$: unknown, e: any, next: any) => {
          if (active) {
            active = false
            hit = true
            if (path === 'session.compact observer') await mainTurn($, seen, 't2', 150_000)
            else await $.prompt.submit({ text: 'back' } as never)
          }
          return next(e)
        })
        on('prompt.submit', { text: 'back' }, async () => ({ drop: 'held' }))
        const { seen, c } = compactWorld($, on)
        await $.prompt.submit({ text: 'work' } as never)
        seen.usage.push(U(1000, 500, path === 'turn.complete cap' ? 249_000 : 149_000))
        await step($, 't1')
        if (!path.startsWith('turn.complete')) await $.turn.complete(done('t1'))
        active = true
        if (path.startsWith('turn.complete')) await $.turn.complete(done('t1'))
        else if (path === 'checkpoint command') {
          const result = await $.command.run({ command: 'model-router', args: 'checkpoint' } as never)
          expect(result.text).toContain('cancelled')
        } else {
          c.sizes = { tokensAfter: 30_000 }
          await $.session.compact({ messages: [{ role: 'user', text: 'work', toolUses: [] }] } as never)
          expect(seen.statuses.at(-1)).toBe('idle compact in 20m')
        }
        expect(hit).toBe(true)
        await seen.clock.advance(30 * MIN)
        expect(c.instructions).toHaveLength(path === 'session.compact observer' ? 2 : 0)
      })
    }

    for (const change of ['clear', 'resume', 'id change']) {
      for (const path of ['idle', 'cap', 'checkpoint tick', 'checkpoint command lookup', 'checkpoint tick lookup']) {
        test(`${change} cancels ${path} and drops the previous context`, { options: { idleCompactMinutes: 20, compactAtContext: 200_000 } }, async ($, on) => {
          const { seen, c } = compactWorld($, on)
          c.agents = ['running']
          await mainTurn($, seen, 't1', 250_000)
          if (path === 'idle') await seen.clock.advance(0)
          c.agents = []
          if (path.startsWith('checkpoint') && path !== 'checkpoint command lookup') {
            await $.command.run({ command: 'model-router', args: 'checkpoint' } as never)
          }
          if (path.endsWith('lookup')) {
            c.beforeAgents = async () => { c.beforeAgents = undefined; await replaceSession($, seen, change) }
            if (path === 'checkpoint command lookup') {
              const r = await $.command.run({ command: 'model-router', args: 'checkpoint' } as never)
              expect(r.text).toContain('cancelled')
            }
          } else await replaceSession($, seen, change)
          await seen.clock.advance(path === 'idle' ? 20 * MIN : 0)
          await seen.clock.advance(60 * MIN)
          expect(c.instructions).toHaveLength(0)
          expect(seen.statuses.at(-1)).toBeUndefined()
          const status = await $.command.run({ command: 'model-router', args: 'status' } as never)
          expect(status.text).toContain('Cache deadline: unavailable')
          expect(status.text).toContain('Pending: none')
          const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
          expect(await ui.find({ text: /ctx 250.0k/ })).toBeUndefined()
          // A warm Opus context from the old conversation must not skip this classifier.
          const classified = seen.asked.length
          await $.prompt.submit({ text: 'find a file' } as never)
          expect(seen.asked.length).toBe(classified + 1)
          expect(await statsOf($)).toContain('Task-boundary checkpoints: 0')
        })
      }
    }

    for (const change of ['clear', 'resume', 'id change']) {
      for (const operation of ['main request', 'manual compact', 'plugin compact', 'classifier', 'accounting write']) {
        test(`${change} during ${operation} drops old results and accounting`, async ($, on) => {
          let active = false
          let seen: Seen
          const event = operation === 'main request' ? 'turn.step' : operation === 'classifier' ? 'model.complete'
            : operation === 'accounting write' ? 'store.get' : 'session.compact'
          if (event === 'turn.step') on('turn.step', {}, async function* (_$: unknown, e: any, next: any) {
            if (active) { active = false; await replaceSession($, seen, change) }
            return yield* next(e)
          })
          else on(event, {}, async (_$: unknown, e: any, next: any) => {
            if (active && (event !== 'store.get' || /^meter:\d{8}:/.test(e.key))) {
              active = false
              await replaceSession($, seen, change)
            }
            return next(e)
          })
          const w = compactWorld($, on)
          seen = w.seen
          const c = w.c
          await mainTurn($, seen, 't1', 250_000)
          c.sizes = { usage: U(0, 500, 250_000), tokensAfter: 30_000 }
          const before = JSON.stringify(seen.store)
          active = true
          if (operation === 'plugin compact') {
            await $.command.run({ command: 'model-router', args: 'checkpoint' } as never)
            await seen.clock.advance(0)
          } else if (operation === 'manual compact') await $.session.compact({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never)
          else if (operation === 'classifier') {
            // Expire the old cache so the classifier is actually called.
            await seen.clock.advance(61 * MIN)
            await $.prompt.submit({ text: 'different work' } as never)
          } else {
            seen.usage.push(U(1000, 500, 300_000))
            await step($, 'old-turn')
          }
          expect(active).toBe(false)
          expect(JSON.stringify(seen.store)).toBe(before)
          expect(Object.keys(seen.store).some(key => key.endsWith(':sess-2'))).toBe(false)
          const status = await $.command.run({ command: 'model-router', args: 'status' } as never)
          expect(status.text).toContain('Cache deadline: unavailable')
          expect(await statsOf($)).toContain('**This session**: 0 tokens')
          expect(c.toasts.filter(text => text.includes('compacted'))).toEqual([])
        })
      }
    }

    for (const action of ['prompt', 'off', 'main turn']) {
      test(`${action} cancels before awaiting its session id (phase 1)`, { options: { idleCompactMinutes: 20 } }, async ($, on) => {
        let active = false
        let hit = false
        on('session.id', {}, async (_$: unknown, e: any, next: any) => {
          if (active) {
            active = false
            hit = true
            await seen.clock.advance(20 * MIN)
          }
          return next(e)
        })
        const { seen, c } = compactWorld($, on)
        await mainTurn($, seen, 't1', 250_000)
        active = true
        if (action === 'prompt') await $.prompt.submit({ text: 'back' } as never)
        else if (action === 'off') await $.command.run({ command: 'model-router', args: 'off' } as never)
        else await $.turn.start({ turnId: 't2', text: 'new work' } as never)
        expect(hit).toBe(true)
        expect(c.instructions).toHaveLength(0)
      })
    }

    test('session.start revives an ended session id with a fresh lifetime', { options: { idleCompactMinutes: 20 } }, async ($, on) => {
      on('command.register', async (_$: unknown, e: any) => ({ value: { command: e.name } }))
      on('tool.register', async () => ({ value: { tool: 'mcp__model-router__escalate' } }))
      on('session.start', async (_$: unknown, e: any) => ({ cwd: e.cwd }))
      on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 1e6 }, rateLimits: [] } }))
      const { seen, c } = compactWorld($, on)
      await mainTurn($, seen, 't1', 250_000)
      c.beforeAgents = async () => {
        c.beforeAgents = undefined
        await $.session.end({ reason: 'resume', sessionId: 'sess-1', resume: { id: 'sess-1' } } as never)
        await $.session.start({ cwd: '/plugin', surface: 'terminal', isInteractive: true })
        // The old command's finally must not clear the replacement checkpoint's state.
        const r = await $.command.run({ command: 'model-router', args: 'checkpoint replacement' } as never)
        expect(r.text).toContain('Creating checkpoint')
      }
      const old = await $.command.run({ command: 'model-router', args: 'checkpoint old' } as never)
      expect(old.text).toContain('cancelled')
      const duplicate = await $.command.run({ command: 'model-router', args: 'checkpoint duplicate' } as never)
      expect(duplicate.text).toContain('already running')
      await seen.clock.advance(0)
      expect(c.instructions).toHaveLength(1)
      expect(c.instructions[0]).toContain('Checkpoint note: replacement')
      const classified = seen.asked.length
      await $.prompt.submit({ text: 'new work' } as never)
      expect(seen.asked.length).toBe(classified + 1)
    })

    for (const kind of ['manual', 'plugin']) {
      test(`an old ${kind} compaction cannot clear the replacement session's fresh context or guard`, { options: { idleCompactMinutes: 20 } }, async ($, on) => {
        let replace = false
        on('session.compact', {}, async (_$: unknown, e: any, next: any) => {
          if (replace) {
            replace = false
            await replaceSession($, seen, 'resume')
            await mainTurn($, seen, 't2', 180_000)
          }
          return next(e)
        })
        const { seen, c } = compactWorld($, on)
        await mainTurn($, seen, 't1', 250_000)
        c.sizes = { usage: U(1000, 500, 250_000), tokensAfter: 30_000 }
        replace = true
        if (kind === 'manual') await $.session.compact({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never)
        else {
          await $.command.run({ command: 'model-router', args: 'checkpoint' } as never)
          await seen.clock.advance(0)
        }
        expect(replace).toBe(false)
        expect(seen.statuses.at(-1)).toBe('idle compact in 20m')
        const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
        expect(await ui.find({ text: /Opus · ctx 180.0k/ })).toBeDefined()
        const tally = seen.store[`meter:${storeDay(0)}:sess-2`] as Tally
        expect(tally.byRole?.compaction).toBeUndefined()
        expect(tally.compactions ?? []).toEqual([])
        await seen.clock.advance(20 * MIN)
        expect(c.instructions).toHaveLength(2)
        expect(c.toasts.at(-1)).toContain('180.0k')
      })
    }

    test('session end stops countdown ticks even before the replacement id is bound', { options: { idleCompactMinutes: 20 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      await mainTurn($, seen, 't1', 250_000)
      await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } } as never)
      const statuses = seen.statuses.length
      await seen.clock.advance(60 * MIN)
      expect(seen.statuses.length).toBe(statuses)
      expect(seen.statuses.at(-1)).toBeUndefined()
      expect(c.instructions).toHaveLength(0)
    })
  })

  describe('compaction accounting owner (final review #2)', () => {
    for (const ordering of ['before observer', 'after observer']) {
      test(`rewriting instructions ${ordering} still accounts the plugin compact once (second review #4)`, { options: { idleCompactMinutes: 20 } }, async ($, on) => {
        let reenter = true
        let rewrites = 0
        on('session.compact', {}, async (_$: unknown, e: any, next: any) => {
          if (reenter) {
            reenter = false
            // Re-dispatch makes the plugin observer eligible from a timer-originated compact.
            return $.session.compact({ ...e, instructions: ordering === 'before observer' ? `${e.instructions}\nKeep deployment notes.` : e.instructions,
              messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never)
          }
          rewrites++
          return next({ ...e, instructions: `${e.instructions}\nKeep test results.` })
        })
        const { seen, c } = compactWorld($, on)
        c.sizes = { tokensBefore: 200_000, tokensAfter: 30_000, usage: U(1000, 500, 200_000) }
        await mainTurn($, seen, 't1', 200_000)
        const before = seen.tally!.tokens
        await seen.clock.advance(20 * MIN)
        expect(rewrites).toBe(1)
        expect(c.instructions).toHaveLength(1)
        expect(c.instructions[0]).toContain('Keep test results.')
        const tally = seen.store[`meter:${storeDay(0)}:sess-1`] as Tally
        expect(tally.tokens - before).toBe(201_500)
        expect(tally.byRole!.compaction!.cost).toBe(costOf(c.sizes.usage!, 'opus'))
        expect(tally.compactions).toHaveLength(1)
        // Ownership ends with the call, so the next manual compact records its own usage and history.
        await $.session.compact({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never)
        expect(seen.tally!.tokens - before).toBe(403_000)
        expect((seen.store[`meter:${storeDay(0)}:sess-1`] as Tally).compactions).toHaveLength(2)
      })
    }

    test('a checkpoint cannot overlap a plugin compaction already awaiting the engine (second review #4)', { options: { idleCompactMinutes: 20 } }, async ($, on) => {
      let release: (() => void) | undefined
      on('session.compact', {}, async (_$: unknown, e: any, next: any) => {
        if (!release) await new Promise<void>(resolve => { release = resolve })
        return next(e)
      })
      const { seen, c } = compactWorld($, on)
      await mainTurn($, seen, 't1', 200_000)
      await seen.clock.advance(20 * MIN)
      expect(release).toBeDefined()
      await $.command.run({ command: 'model-router', args: 'checkpoint' } as never)
      await seen.clock.advance(0)
      expect(c.instructions).toHaveLength(0)
      release!()
      await seen.clock.advance(0)
      expect(c.instructions).toHaveLength(1)
      expect((seen.store[`meter:${storeDay(0)}:sess-1`] as Tally).compactions).toHaveLength(1)
    })

    for (const observed of [false, true]) {
      for (const kind of ['idle', 'cap', 'checkpoint']) {
        test(`${kind} is accounted once with the own observer ${observed ? 're-entered' : 'skipped'}`, { options: { idleCompactMinutes: 20, compactAtContext: 200_000 } }, async ($, on) => {
          let reenter = observed
          let entries = 0
          // Re-dispatch from the test's frame to make the separate observer eligible even on hosts
          // that skip it for timer callbacks originating in this plugin.
          on('session.compact', {}, async (_$: unknown, e: any, next: any) => {
            entries++
            if (reenter) {
              reenter = false
              return $.session.compact({ instructions: e.instructions, messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never)
            }
            return next(e)
          })
          const { seen, c } = compactWorld($, on)
          c.sizes = { tokensBefore: 250_000, tokensAfter: 30_000, usage: U(1000, 500, 250_000) }
          if (kind !== 'cap') c.agents = ['running']
          await mainTurn($, seen, 't1', 250_000)
          await seen.clock.advance(0)
          c.agents = []
          if (kind === 'idle') await seen.clock.advance(20 * MIN)
          if (kind === 'checkpoint') {
            await $.command.run({ command: 'model-router', args: 'checkpoint' } as never)
            await seen.clock.advance(0)
          }
          expect(c.instructions).toHaveLength(1)
          expect(entries).toBe(observed ? 2 : 1)
          const tally = seen.store[`meter:${storeDay(0)}:sess-1`] as Tally
          expect(tally.byRole!.compaction!.cost).toBe(costOf(c.sizes.usage!, 'opus'))
          expect(tally.compactions).toHaveLength(1)
          expect(tally.compactions![0]).toMatchObject({ before: 250_000, after: 30_000 })
          // The marker must also be gone: a later manual compact has its own accounting owner.
          await $.session.compact({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never)
          const later = seen.store[`meter:${storeDay(0)}:sess-1`] as Tally
          expect(later.byRole!.compaction!.cost).toBe(2 * costOf(c.sizes.usage!, 'opus'))
          expect(later.compactions).toHaveLength(2)
        })
      }
    }
  })

  describe('subagent status compatibility (final review #6)', () => {
    for (const options of [{}, { idleCompactMinutes: 20 }, { compactAtContext: 200_000 }]) {
      test(`subagent events keep their status slot without a pending guard: ${JSON.stringify(options)}`, { options }, async ($, on) => {
        const { seen, c } = compactWorld($, on)
        await spawnAgent($, { subagentType: 'Explore' })
        expect(seen.statuses.at(-1)).toContain('subagent Explore start: haiku/medium')
        await seen.clock.advance(2 * MIN)
        expect(seen.statuses.at(-1)).toContain('subagent Explore start: haiku/medium')
        expect(c.toasts).toEqual([])
      })
    }
    test('a pending guard replaces the event slot and cancellation restores it', { options: { idleCompactMinutes: 20 } }, async ($, on) => {
      const { seen } = compactWorld($, on)
      await mainTurn($, seen, 't1', 250_000)
      await spawnAgent($, { subagentType: 'Explore' })
      expect(seen.statuses.at(-1)).toBe('idle compact in 20m')
      await $.prompt.submit({ text: 'back to work' } as never)
      expect(seen.statuses.at(-1)).toContain('subagent Explore start: haiku/medium')
    })
  })

  describe('task-boundary checkpoints (1.0)', () => {
    test('explicit checkpoint keeps continuation instructions and note, accounts usage and clears the guard', { options: { idleCompactMinutes: 20 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      await mainTurn($, seen, 't1', 250_000)
      c.sizes = { tokensBefore: 250_000, tokensAfter: 40_000, usage: U(0, 8000, 250_000) }
      const result = await $.command.run({ command: 'model-router', args: 'checkpoint keep ticket TASK-123' } as never)
      expect(result.text).toBe('Creating checkpoint…')
      await seen.clock.advance(0)
      expect(c.instructions).toHaveLength(1)
      for (const text of ['current goal', 'constraints and rules', 'decisions made and why', 'unresolved findings', 'open questions', 'file paths, commands and IDs', 'keep ticket TASK-123']) expect(c.instructions[0]).toContain(text)
      expect(c.toasts).toEqual(['Checkpoint: compacted 250.0k → 40.0k'])
      await seen.clock.advance(20 * MIN)
      expect(c.instructions).toHaveLength(1)
      const stats = await statsOf($)
      expect(stats).toContain('Task-boundary checkpoints: 1')
      expect(stats).toContain('Compactions at idle (cache warm): 0')
      expect(stats).toContain('Compactions at the context cap: 0')
      expect(stats).toContain('| Compaction | 258.0k |')
      await $.prompt.submit({ text: 'small task' } as never)
      expect(seen.asked).toEqual(['haiku', 'haiku'])
    })

    test('checkpoint uses the freshest reading when engine sizes are unavailable and works with routing off', async ($, on) => {
      const { seen, c } = compactWorld($, on)
      await mainTurn($, seen, 't1', 250_000)
      await $.command.run({ command: 'model-router', args: 'off' } as never)
      await $.session.measure({ context: { window: 1e6, tokens: 310_000 }, rateLimits: [], changed: ['context'] } as never)
      await $.command.run({ command: 'model-router', args: 'checkpoint' } as never)
      await seen.clock.advance(0)
      expect(c.toasts).toContain('Checkpoint: compacted 310.0k')
    })

    test('a running main turn refuses rather than deferring a checkpoint', async ($, on) => {
      const { c } = compactWorld($, on)
      await $.prompt.submit({ text: 'work' } as never)
      const result = await $.command.run({ command: 'model-router', args: 'checkpoint' } as never)
      expect(result.text).toContain('main turn is running')
      await $.turn.complete(done('t1'))
      expect(c.instructions).toHaveLength(0)
    })

    for (const status of ['pending', 'running', 'waiting', 'unavailable']) {
      test(`checkpoint refuses busy agents: ${status}`, async ($, on) => {
        if (status === 'unavailable') on('agent.list', {}, async () => { throw new Error('unavailable') })
        const { c } = compactWorld($, on)
        c.agents = [status]
        const result = await $.command.run({ command: 'model-router', args: 'checkpoint' } as never)
        expect(result.text).toContain(status === 'unavailable' ? 'agent status unavailable' : 'agents still busy')
        expect(c.instructions).toHaveLength(0)
      })
    }

    for (const how of ['reject', 'skip'] as const) {
      test(`checkpoint ${how} keeps the existing idle guard`, { options: { idleCompactMinutes: 20 } }, async ($, on) => {
        let refuse = true
        on('session.compact', {}, async (_$, e, next) => {
          if (!refuse) return next(e)
          refuse = false
          if (how === 'reject') throw new Error('a turn is running')
          return { skip: 'vetoed' }
        })
        const { seen, c } = compactWorld($, on)
        await mainTurn($, seen, 't1', 250_000)
        await seen.clock.advance(5 * MIN)
        await $.command.run({ command: 'model-router', args: 'checkpoint' } as never)
        await seen.clock.advance(0)
        expect(c.toasts[0]).toContain(how === 'reject' ? 'engine refused' : 'skipped by hook')
        expect(seen.statuses.at(-1)).toBe('idle compact in 15m')
        await seen.clock.advance(15 * MIN)
        expect(c.instructions).toHaveLength(1)
        expect(await statsOf($)).toContain('Compactions at idle (cache warm): 1')
        expect(await statsOf($)).toContain('Task-boundary checkpoints: 0')
      })

      test(`checkpoint ${how} is not counted or retried`, async ($, on) => {
        const { seen, c } = compactWorld($, on, how)
        const result = await $.command.run({ command: 'model-router', args: 'checkpoint' } as never)
        expect(result.text).toBe('Creating checkpoint…')
        await seen.clock.advance(20 * MIN)
        expect(c.toasts[0]).toContain(how === 'reject' ? 'engine refused' : 'skipped by hook')
        expect(c.instructions).toHaveLength(1)
        expect(await statsOf($)).toContain('Task-boundary checkpoints: 0')
      })
    }

    for (const boundary of ['command', 'tick']) {
      for (const status of ['pending', 'running', 'waiting', 'unavailable']) {
        test(`checkpoint refused at ${boundary} for ${status} keeps the idle deadline and freshest reading`, { options: { idleCompactMinutes: 20 } }, async ($, on) => {
          const { seen, c } = compactWorld($, on)
          await mainTurn($, seen, 't1', 250_000)
          await seen.clock.advance(5 * MIN)
          if (boundary === 'tick') await $.command.run({ command: 'model-router', args: 'checkpoint' } as never)
          if (status === 'unavailable') c.beforeAgents = async () => { throw new Error('unavailable') }
          else c.agents = [status]
          if (boundary === 'command') {
            const r = await $.command.run({ command: 'model-router', args: 'checkpoint' } as never)
            expect(r.text).toContain(status === 'unavailable' ? 'agent status unavailable' : 'agents still busy')
          } else {
            await seen.clock.advance(0)
            expect(c.toasts[0]).toContain(status === 'unavailable' ? 'agent status unavailable' : 'agents still busy')
          }
          expect(c.instructions).toHaveLength(0)
          expect(seen.statuses.at(-1)).toBe('idle compact in 15m')
          c.agents = []
          c.beforeAgents = undefined
          await $.session.measure({ context: { window: 1e6, tokens: 310_000 }, rateLimits: [], changed: ['context'] } as never)
          await seen.clock.advance(15 * MIN)
          expect(c.instructions).toHaveLength(1)
          expect(c.toasts.at(-1)).toContain('Idle compact: compacted 310.0k')
          expect(await statsOf($)).toContain('Task-boundary checkpoints: 0')
        })
      }
    }

    test('a checkpoint already checking agents refuses a second request without clearing the idle guard', { options: { idleCompactMinutes: 20 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      await mainTurn($, seen, 't1', 250_000)
      c.beforeAgents = async () => {
        c.beforeAgents = undefined
        const again = await $.command.run({ command: 'model-router', args: 'checkpoint' } as never)
        expect(again.text).toContain('already running')
      }
      c.agents = ['running']
      await $.command.run({ command: 'model-router', args: 'checkpoint' } as never)
      c.agents = []
      await seen.clock.advance(20 * MIN)
      expect(c.instructions).toHaveLength(1)
      expect(await statsOf($)).toContain('Compactions at idle (cache warm): 1')
    })

    for (const cancel of ['prompt', 'off']) {
      test(`checkpoint cancellation by ${cancel} preserves a newer turn's idle guard`, { options: { idleCompactMinutes: 20 } }, async ($, on) => {
        const { seen, c } = compactWorld($, on)
        await mainTurn($, seen, 't1', 250_000)
        await seen.clock.advance(5 * MIN)
        c.beforeAgents = async () => {
          c.beforeAgents = undefined
          if (cancel === 'off') {
            await $.command.run({ command: 'model-router', args: 'off' } as never)
            await $.command.run({ command: 'model-router', args: 'on' } as never)
          }
          await mainTurn($, seen, 't2', 310_000)
        }
        const r = await $.command.run({ command: 'model-router', args: 'checkpoint' } as never)
        expect(r.text).toContain('cancelled')
        await seen.clock.advance(15 * MIN)
        expect(c.instructions).toHaveLength(0)
        await seen.clock.advance(5 * MIN)
        expect(c.instructions).toHaveLength(1)
        expect(c.toasts.at(-1)).toContain('Idle compact: compacted 310.0k')
      })
    }

    for (const refusal of ['running turn', 'router off']) {
      test(`checkpoint with ${refusal} never revives a cancelled idle guard`, { options: { idleCompactMinutes: 20 } }, async ($, on) => {
        const { seen, c } = compactWorld($, on)
        await mainTurn($, seen, 't1', 250_000)
        if (refusal === 'running turn') await $.prompt.submit({ text: 'new work' } as never)
        else {
          await $.command.run({ command: 'model-router', args: 'off' } as never)
          c.agents = ['running']
        }
        const r = await $.command.run({ command: 'model-router', args: 'checkpoint' } as never)
        expect(r.text).toContain(refusal === 'running turn' ? 'main turn is running' : 'agents still busy')
        c.agents = []
        await $.command.run({ command: 'model-router', args: 'on' } as never)
        await seen.clock.advance(25 * MIN)
        expect(c.instructions).toHaveLength(0)
        expect(seen.statuses.at(-1)).toBeUndefined()
      })
    }

    for (const cancel of ['prompt', 'off']) {
      test(`checkpoint rechecks cancellation after agent lookup: ${cancel}`, async ($, on) => {
        const { c } = compactWorld($, on)
        c.beforeAgents = async () => {
          c.beforeAgents = undefined
          if (cancel === 'prompt') await $.prompt.submit({ text: 'work' } as never)
          else await $.command.run({ command: 'model-router', args: 'off' } as never)
        }
        const result = await $.command.run({ command: 'model-router', args: 'checkpoint' } as never)
        expect(result.text).toContain('cancelled')
        expect(c.instructions).toHaveLength(0)
      })
    }

    for (const boundary of ['before tick', 'during lookup']) {
      for (const cancel of ['prompt', 'off']) {
        test(`checkpoint ${cancel} ${boundary} cannot compact later`, async ($, on) => {
          const { seen, c } = compactWorld($, on)
          await $.command.run({ command: 'model-router', args: 'checkpoint' } as never)
          const change = async () => {
            if (cancel === 'prompt') await $.prompt.submit({ text: 'new work' } as never)
            else await $.command.run({ command: 'model-router', args: 'off' } as never)
          }
          if (boundary === 'before tick') await change()
          else c.beforeAgents = async () => { c.beforeAgents = undefined; await change() }
          await seen.clock.advance(0)
          await seen.clock.advance(20 * MIN)
          expect(c.instructions).toHaveLength(0)
        })
      }
    }

    test('checkpoint rechecks busy agents on the immediate tick and never queues behind them', async ($, on) => {
      const { seen, c } = compactWorld($, on)
      await $.command.run({ command: 'model-router', args: 'checkpoint' } as never)
      c.agents = ['running']
      await seen.clock.advance(0)
      expect(c.instructions).toHaveLength(0)
      expect(c.toasts[0]).toContain('agents still busy')
      c.agents = []
      await seen.clock.advance(20 * MIN)
      expect(c.instructions).toHaveLength(0)
    })

    test('a second checkpoint is refused while the first awaits its tick', async ($, on) => {
      const { seen, c } = compactWorld($, on)
      await $.command.run({ command: 'model-router', args: 'checkpoint' } as never)
      const again = await $.command.run({ command: 'model-router', args: 'checkpoint' } as never)
      expect(again.text).toContain('already running')
      await seen.clock.advance(0)
      expect(c.instructions).toHaveLength(1)
    })

    test('Chinese checkpoints translate success, hint and counters', { options: { language: 'zh', checkpointHints: true } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      await mainTurn($, seen, 't1', 250_000)
      expect(c.toasts[0]).toContain('/model-router checkpoint')
      const result = await $.command.run({ command: 'model-router', args: 'checkpoint 继续测试' } as never)
      expect(result.text).toBe('正在创建任务检查点…')
      await seen.clock.advance(0)
      expect(c.instructions[0]).toContain('继续测试')
      expect(c.toasts[1]).toContain('任务检查点：已压缩')
      expect(await statsOf($)).toContain('任务检查点：1')
    })

    test('hint cost includes the cached context read, output and summary rewrite at the observed model prices', async () => {
      for (const model of ['haiku', 'sonnet', 'opus', 'fable'] as const) {
        const p = PRICES[model]
        const breakeven = (40_000 * p.read * 15 + 8000 * p.output + 40_000 * p.write) / (14 * p.read)
        expect(checkpointPays(Math.floor(breakeven), model)).toBe(false)
        expect(checkpointPays(Math.ceil(breakeven) + 1, model)).toBe(true)
        expect(checkpointPays(40_000, model)).toBe(false)
      }
    })

    test('hints are off by default, even for a context that would pay', async ($, on) => {
      const { seen, c } = compactWorld($, on)
      await mainTurn($, seen, 't1', 500_000)
      expect(c.toasts).toHaveLength(0)
      expect(c.instructions).toHaveLength(0)
    })

    test('hints obey minimum context, profitability and 50% growth or 30-minute cooldown without compacting', { options: { checkpointHints: true } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      for (const [i, context] of [90_000, 150_000, 250_000, 300_000, 374_999, 375_000].entries()) await mainTurn($, seen, `t${i + 1}`, context)
      expect(c.toasts).toHaveLength(2)
      expect(c.toasts[0]).toContain('/model-router checkpoint')
      await seen.clock.advance(CHECKPOINT_COOLDOWN_MS - 1)
      await mainTurn($, seen, 't7', 375_000)
      expect(c.toasts).toHaveLength(2)
      await seen.clock.advance(1)
      await mainTurn($, seen, 't8', 375_000)
      expect(c.toasts).toHaveLength(3)
      expect(c.instructions).toHaveLength(0)
    })

    test('hints still work in subagent-only mode and stay quiet when the context cap already compacts', { options: { checkpointHints: true, mainRouting: false, compactAtContext: 300_000 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      await mainTurn($, seen, 't1', 250_000)
      expect(c.toasts).toHaveLength(1)
      expect(seen.asked).toHaveLength(0)
      await mainTurn($, seen, 't2', 400_000)
      expect(c.toasts).toHaveLength(1)
      await seen.clock.advance(0)
      expect(c.instructions).toHaveLength(1)
      expect(c.toasts[1]).toContain('Context cap reached')
    })

    test('hint uses newer measurements rather than the last request', { options: { checkpointHints: true, compactMinContext: 300_000 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      await $.prompt.submit({ text: 'work' } as never)
      seen.usage.push(U(1000, 500, 149_000))
      await step($, 't1')
      await $.session.measure({ context: { window: 1e6, tokens: 350_000 }, rateLimits: [], changed: ['context'] } as never)
      await $.turn.complete(done('t1'))
      expect(c.toasts).toHaveLength(1)
      await mainTurn($, seen, 't2', 500_000)
      await $.session.measure({ context: { window: 1e6, tokens: 20_000 }, rateLimits: [], changed: ['context'] } as never)
      await $.turn.complete(done('t2'))
      expect(c.toasts).toHaveLength(1)
    })

    for (const kind of ['agent', 'aborted', 'off']) {
      test(`no checkpoint hint at ${kind} completion`, { options: { checkpointHints: true } }, async ($, on) => {
        const { seen, c } = compactWorld($, on)
        await $.prompt.submit({ text: 'work' } as never)
        seen.usage.push(U(1000, 500, 499_000))
        await step($, 't1')
        if (kind === 'off') await $.command.run({ command: 'model-router', args: 'off' } as never)
        await $.turn.complete({ ...(done('t1', kind === 'agent' ? 'agent-1' : undefined) as any), isAborted: kind === 'aborted' })
        expect(c.toasts).toHaveLength(0)
      })
    }

    for (const cancel of ['prompt', 'off']) {
      test(`hint rechecks cancellation after its clock await: ${cancel}`, { options: { checkpointHints: true } }, async ($, on) => {
        let active = false
        on('clock.now', {}, async (_$: unknown, e: any, next: any) => {
          if (active) {
            active = false
            if (cancel === 'prompt') await $.prompt.submit({ text: 'new work' } as never)
            else await $.command.run({ command: 'model-router', args: 'off' } as never)
          }
          return next(e)
        })
        const { seen, c } = compactWorld($, on)
        await $.turn.start({ turnId: 't1', text: '' } as never)
        seen.usage.push(U(1000, 500, 499_000))
        await step($, 't1')
        // An unrouted turn has no shape writes; the clock await belongs to the hint.
        active = true
        await $.turn.complete(done('t1'))
        expect(c.toasts).toHaveLength(0)
      })
    }
  })

  describe('fresh clock after identity checks (merge review #3)', () => {
    for (const path of ['idle', 'idle re-check', 'idle arming', 'cap', 'cap arming', 'cap retry', 'checkpoint command', 'checkpoint tick']) {
      test(`${path} has no identity await between its final clock and action`, { options: { idleCompactMinutes: 20, compactAtContext: 200_000 } }, async ($, on) => {
        on('clock.every', {}, async (_$: unknown, e: any, next: any) => next({ ...e, ms: 24 * 60 * MIN }))
        let audit = false
        let wallTime = 0
        const calls: string[] = []
        const actions: { previous: string | undefined; at: number; kind: string }[] = []
        on('clock.now', {}, async (_$: unknown, e: any, next: any) => {
          const result = await next(e)
          if (!audit) return result
          calls.push('clock')
          return { value: wallTime }
        })
        on('session.id', {}, async (_$: unknown, e: any, next: any) => {
          const result = await next(e)
          if (audit) { wallTime += MIN; calls.push('id') }
          return result
        })
        on('clock.after', {}, async (_$: unknown, e: any, next: any) => {
          if (audit) actions.push({ previous: calls.at(-1), at: wallTime, kind: 'timer' })
          return next(e)
        })
        on('session.compact', {}, async (_$: unknown, e: any, next: any) => {
          if (audit) actions.push({ previous: calls.at(-1), at: wallTime, kind: 'compact' })
          try { return await next(e) } finally {
            if (path === 'cap retry') { audit = true; wallTime = 55.5 * MIN }
          }
        })
        let enabledReads = 0
        let completing = false
        on('state.get', { plugin: 'model-router', key: 'enabled' }, async (_$: unknown, e: any, next: any) => {
          const result = await next(e)
          if (completing && ++enabledReads === (path === 'idle arming' ? 2 : 1)) {
            audit = true
            wallTime = path === 'idle arming' ? 55.5 * MIN : 55 * MIN
          }
          return result
        })
        const { seen, c } = compactWorld($, on, path === 'cap retry' ? 'skip' : 'ok')
        // A rejection is needed for a retry; unlike skip, this must use the engine's rejection path.
        if (path === 'cap retry') c.rejects = 1
        if (path.endsWith('arming')) {
          await $.prompt.submit({ text: 'work' } as never)
          seen.usage.push(U(1000, 500, path === 'cap arming' ? 249_000 : 149_000))
          await step($, 't1')
          completing = true
          await $.turn.complete(done('t1'))
        } else {
          await mainTurn($, seen, 't1', path.startsWith('cap') ? 250_000 : 150_000)
          if (path.startsWith('checkpoint')) {
            c.beforeAgents = async () => { audit = true; wallTime = 56.5 * MIN }
            await $.command.run({ command: 'model-router', args: 'checkpoint' } as never)
            if (path === 'checkpoint tick') {
              actions.length = 0
              calls.length = 0
              await seen.clock.advance(0)
            }
          } else {
            audit = path !== 'cap retry'
            wallTime = 53 * MIN
            if (path === 'idle re-check') c.agents = ['running']
            await seen.clock.advance(path.startsWith('idle') ? 20 * MIN : 0)
          }
        }
        expect(actions.length).toBeGreaterThan(0)
        expect(actions.every(action => action.previous === 'clock')).toBe(true)
        if (!path.startsWith('checkpoint')) expect(actions.every(action => action.at <= 57 * MIN)).toBe(true)
        else expect(actions[0]!.at).toBeGreaterThan(57 * MIN) // Explicit checkpoints also work cold.
      })
    }

    for (const path of ['idle', 'cap', 'idle arming', 'cap arming', 'cap retry']) {
      test(`${path} refuses after a slow identity lookup crosses its deadline`, { options: { idleCompactMinutes: 20, compactAtContext: 200_000 } }, async ($, on) => {
        on('clock.every', {}, async (_$: unknown, e: any, next: any) => next({ ...e, ms: 24 * 60 * MIN }))
        let slow = false
        let wallTime: number | undefined
        let armed = 0
        on('clock.now', {}, async (_$: unknown, e: any, next: any) => wallTime === undefined ? next(e) : { value: wallTime })
        on('session.id', {}, async (_$: unknown, e: any, next: any) => {
          const result = await next(e)
          if (slow) wallTime = 57.5 * MIN
          return result
        })
        on('clock.after', {}, async (_$: unknown, e: any, next: any) => {
          if (slow) armed++
          return next(e)
        })
        let completing = false
        let reads = 0
        on('state.get', { plugin: 'model-router', key: 'enabled' }, async (_$: unknown, e: any, next: any) => {
          const result = await next(e)
          if (completing && ++reads === (path === 'idle arming' ? 2 : 1)) { slow = true; wallTime = 56 * MIN }
          return result
        })
        on('session.compact', {}, async (_$: unknown, e: any, next: any) => {
          try { return await next(e) } finally {
            if (path === 'cap retry') { slow = true; wallTime = 56 * MIN }
          }
        })
        const { seen, c } = compactWorld($, on)
        if (path === 'cap retry') c.rejects = 1
        if (path.endsWith('arming')) {
          await $.prompt.submit({ text: 'work' } as never)
          seen.usage.push(U(1000, 500, path === 'cap arming' ? 249_000 : 149_000))
          await step($, 't1')
          completing = true
          await $.turn.complete(done('t1'))
        } else {
          await mainTurn($, seen, 't1', path.startsWith('cap') ? 250_000 : 150_000)
          if (path !== 'cap retry') c.beforeAgents = async () => { slow = true; wallTime = 56 * MIN }
          await seen.clock.advance(path === 'idle' ? 20 * MIN : 0)
        }
        expect(slow).toBe(true)
        expect(armed).toBe(0)
        expect(c.instructions).toHaveLength(path === 'cap retry' ? 1 : 0)
        expect(c.toasts.at(-1)).toBe('Compaction skipped: cache deadline passed')
      })
    }
  })

  describe('cancellation at every await', () => {
    type Boundary = { at: string; event: string; key?: string; nth?: number }
    const enabledRead = { at: 'enabled', event: 'state.get', key: 'enabled' }
    const clockRead = { at: 'clock', event: 'clock.now' }
    const agentRead = { at: 'agents', event: 'agent.list' }
    const compact = { at: 'compact', event: 'session.compact' }
    const completion: Boundary[] = [
      { at: 'route', event: 'state.get', key: 'route' },
      { at: 'next', event: 'turn.complete' },
      { at: 'shape get', event: 'store.get', key: 'shape' },
      { at: 'shape set', event: 'store.set', key: 'shape' },
      enabledRead,
      clockRead,
    ]
    const idle: Boundary[] = [enabledRead, clockRead, agentRead, { ...clockRead, at: 'final clock', nth: 2 }]
    const paths: { path: string; boundaries: Boundary[] }[] = [
      { path: 'turn.complete cap', boundaries: completion },
      { path: 'turn.complete idle', boundaries: completion },
      { path: 'armIdle completion', boundaries: [{ ...enabledRead, nth: 2 }, { ...clockRead, nth: 2 }] },
      { path: 'armIdle busy cap', boundaries: [{ ...enabledRead, nth: 2 }, clockRead] },
      { path: 'armIdle skipped cap', boundaries: [{ ...enabledRead, nth: 2 }, { ...clockRead, nth: 3 }] },
      { path: 'armIdle exhausted cap', boundaries: [{ ...enabledRead, nth: 2 }, { ...clockRead, nth: 3 }] },
      { path: 'runIdle', boundaries: idle },
      { path: 'runIdle busy', boundaries: idle.map(b => b.at === 'final clock' ? { ...b, at: 're-check clock' } : b) },
      { path: 'runIdle re-check', boundaries: idle },
      { path: 'runCap', boundaries: [enabledRead, agentRead] },
      { path: 'runCap retry', boundaries: [compact] },
      { path: 'runCap fallback', boundaries: [compact] },
    ]

    for (const { path, boundaries } of paths) {
      for (const boundary of boundaries) {
        for (const cancel of ['prompt', 'off']) {
          test(`${path}: ${cancel} during ${boundary.at} stops the path`, { options: { idleCompactMinutes: 20, compactAtContext: 200_000 } }, async ($, on) => {
            // UI ticks also read the clock; keep them outside this guard-only boundary audit.
            on('clock.every', {}, async (_$: unknown, e: any, next: any) => next({ ...e, ms: 24 * 60 * MIN }))
            const how = path === 'runCap retry' || path === 'armIdle exhausted cap' ? 'reject'
              : path === 'runCap fallback' || path === 'armIdle skipped cap' ? 'skip' : 'ok'
            // Only the cancelling prompt is held: the first turn still binds a route and updates its shape.
            on('prompt.submit', { text: 'back' }, async () => ({ drop: 'held' }))
            let active = false
            let hit = false
            let reads = 0
            const later: string[] = []
            const delays: number[] = []
            const events = ['state.get', 'store.get', 'store.set', 'clock.now', 'agent.list', 'session.compact', 'turn.complete']
            for (const event of events) {
              on(event as never, (event === 'state.get' ? { plugin: 'model-router' } : event === 'store.get' || event === 'store.set' ? { key: 'shape' } : {}) as never, async (_$: unknown, e: any, next: any) => {
                // Restrict bookkeeping to this path, excluding the cancelling prompt/command itself.
                const relevant = event === 'state.get' ? e.key === 'enabled' || e.key === 'route'
                  : event === 'store.get' || event === 'store.set' ? e.key === 'shape' : true
                if (active && relevant) {
                  if (hit) later.push(`${event}:${e.key ?? ''}`)
                  if (!hit && event === boundary.event && (boundary.key === undefined || e.key === boundary.key) && ++reads === (boundary.nth ?? 1)) {
                    active = false
                    if (cancel === 'prompt') await $.prompt.submit({ text: 'back' } as never)
                    else await $.command.run({ command: 'model-router', args: 'off' } as never)
                    hit = true
                    active = true
                  }
                }
                return next(e)
              })
            }
            on('clock.after', {}, async (_$: unknown, e: any, next: any) => {
              if (active && hit) delays.push(e.ms)
              return next(e)
            })
            const { seen, c } = compactWorld($, on, how)
            const completing = path.startsWith('turn.complete') || path === 'armIdle completion'
            const context = path === 'turn.complete cap' || !completing ? 250_000 : 150_000
            await $.prompt.submit({ text: 'work on it' } as never)
            seen.usage.push(U(1000, 500, context - 1000, 0, 'claude-opus-5-5'))
            await step($, 't1')
            if (completing) {
              active = true
              await $.turn.complete(done('t1'))
            } else {
              // The idle paths start after a busy cap has handed over to idle; the others run on the first tick.
              if (path.startsWith('runIdle') || path === 'armIdle busy cap') c.agents = ['running']
              await $.turn.complete(done('t1'))
              if (path.startsWith('runIdle')) {
                await seen.clock.advance(0)
                if (path === 'runIdle re-check') await seen.clock.advance(20 * MIN)
                if (path !== 'runIdle busy') c.agents = []
              }
              if (path === 'armIdle exhausted cap') {
                await seen.clock.advance(0)
                await seen.clock.advance(4000)
              }
              active = true
              await seen.clock.advance(path === 'runIdle re-check' ? 5 * MIN : path.startsWith('runIdle') ? 20 * MIN : path === 'armIdle exhausted cap' ? 2000 : 0)
            }
            expect(hit).toBe(true)
            // An early guard must stop work immediately, even if a later guard would also catch the cancel.
            // An issued attempt still reads the clock to log its outcome after cancellation.
            expect(later).toEqual(boundary.event === 'session.compact' ? ['clock.now:'] : [])
            expect(delays).toEqual([])
            const attempts = path === 'runCap retry' || path === 'runCap fallback' || path === 'armIdle skipped cap' ? 1 : path === 'armIdle exhausted cap' ? 4 : 0
            expect(c.instructions).toHaveLength(attempts)
            c.agents = []
            await seen.clock.advance(30 * MIN)
            expect(c.instructions).toHaveLength(attempts)
            // Off now explains a pending action's cancellation once; a new prompt stays quiet.
            const wasPending = !completing && path !== 'armIdle completion'
            expect(c.toasts).toEqual(cancel === 'off' && wasPending ? ['Compaction skipped: router off'] : [])
          })
        }
      }
    }
    for (const path of ['session.compact observer', 'compactMain']) {
      for (const cancel of ['prompt', 'off']) {
        test(`${path}: ${cancel} during compact preserves the newer idle timer`, { options: { idleCompactMinutes: 20, compactAtContext: 200_000 } }, async ($, on) => {
          let active = false
          let hit = false
          on('session.compact', {}, async (_$: unknown, e: any, next: any) => {
            if (active) {
              active = false
              hit = true
              if (cancel === 'off') {
                await $.command.run({ command: 'model-router', args: 'off' } as never)
                await $.command.run({ command: 'model-router', args: 'on' } as never)
              }
              // A new prompt, request and completion all land before the old compact resolves.
              await mainTurn($, seen, 't2', 150_000)
            }
            return next(e)
          })
          const { seen, c } = compactWorld($, on)
          await mainTurn($, seen, 't1', path === 'compactMain' ? 250_000 : 150_000)
          active = true
          if (path === 'compactMain') await seen.clock.advance(0)
          else await $.session.compact({ messages: [{ role: 'user', text: 'work', toolUses: [] }] } as never)
          expect(hit).toBe(true)
          expect(c.instructions).toHaveLength(1)
          await seen.clock.advance(20 * MIN)
          // The old completion must not forget the newer context or cancel its timer.
          expect(c.instructions).toHaveLength(2)
          expect(c.toasts.at(-1)).toContain('150.0k')
        })
      }
    }

    for (const kind of ['idle', 'cap']) {
      test(`setEnabled off: switching back on never revives the ${kind} timer`, { options: { idleCompactMinutes: 20, compactAtContext: 200_000 } }, async ($, on) => {
        const { seen, c } = compactWorld($, on)
        await mainTurn($, seen, 't1', kind === 'cap' ? 250_000 : 150_000)
        await $.command.run({ command: 'model-router', args: 'off' } as never)
        await $.command.run({ command: 'model-router', args: 'on' } as never)
        await seen.clock.advance(30 * MIN)
        expect(c.instructions).toEqual([])
      })
    }

    for (const kind of ['idle', 'cap']) {
      for (const boundary of ['enabled get', 'enabled set', 'store set']) {
        test(`setEnabled off: ${kind} stays cancelled during ${boundary}`, { options: { idleCompactMinutes: 20, compactAtContext: 200_000 } }, async ($, on) => {
          let active = false
          let hit = false
          const delays: number[] = []
          let completing = false
          const later: string[] = []
          on('state.get', { plugin: 'model-router', key: 'route' }, async (_$: unknown, e: any, next: any) => {
            if (completing) later.push('route')
            return next(e)
          })
          const event = boundary === 'enabled get' ? 'state.get' : boundary === 'enabled set' ? 'state.set' : 'store.set'
          on(event as never, (event === 'store.set' ? { key: 'enabled' } : { plugin: 'model-router', key: 'enabled' }) as never, async (_$: unknown, e: any, next: any) => {
            if (active) {
              active = false
              hit = true
              await $.prompt.submit({ text: 'back' } as never)
              // A completion which starts while off is persisting sees the new epoch, but must still stand down.
              completing = true
              await $.turn.complete(done('t1'))
              completing = false
              await seen.clock.advance(kind === 'cap' ? 0 : 20 * MIN)
            }
            return next(e)
          })
          on('prompt.submit', { text: 'back' }, async () => ({ drop: 'held' }))
          on('clock.after', {}, async (_$: unknown, e: any, next: any) => {
            if (hit) delays.push(e.ms)
            return next(e)
          })
          const { seen, c } = compactWorld($, on)
          await mainTurn($, seen, 't1', kind === 'cap' ? 250_000 : 150_000)
          active = true
          await $.command.run({ command: 'model-router', args: 'off' } as never)
          expect(hit).toBe(true)
          expect(delays).toEqual([])
          expect(later).toEqual([])
          await $.command.run({ command: 'model-router', args: 'on' } as never)
          await seen.clock.advance(30 * MIN)
          expect(c.instructions).toEqual([])
          expect(c.toasts).toEqual(['Compaction skipped: router off'])
        })
      }
    }

  })

  describe('phase 1 compaction fixes', () => {
    test('precompute passes through without cancelling the idle timer', { options: { idleCompactMinutes: 20 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      await mainTurn($, seen, 't1', 250_000)
      await $.session.compact({ trigger: 'precompute', messages: [{ role: 'user', text: 'work', toolUses: [] }] } as never)
      expect(c.instructions).toHaveLength(1)
      expect(c.triggers).toEqual(['precompute'])
      await seen.clock.advance(20 * MIN)
      expect(c.instructions).toHaveLength(2)
      expect(await statsOf($)).toContain('Compactions at idle (cache warm): 1')
    })

    test('precompute preserves the warm main request for routing', async ($, on) => {
      const { seen } = compactWorld($, on)
      await mainTurn($, seen, 't1', 250_000)
      await $.session.compact({ trigger: 'precompute', messages: [{ role: 'user', text: 'work', toolUses: [] }] } as never)
      await $.prompt.submit({ text: 'next' } as never)
      expect(seen.asked).toEqual(['haiku'])
      await step($, 't2')
      expect(seen.steps.at(-1)!.model).toContain('opus')
    })

    test('less than a minute before the deadline leaves the idle timer unarmed', { options: { idleCompactMinutes: 55 } }, async ($, on) => {
      const delays: number[] = []
      on('clock.after', { ms: 55 * MIN }, async (_$: unknown, e: any, next: any) => {
        delays.push(e.ms)
        return next(e)
      })
      const { seen, c } = compactWorld($, on)
      seen.stepMs = 56.5 * MIN
      await mainTurn($, seen, 't1', 250_000)
      expect(delays).toEqual([])
      await seen.clock.advance(60 * MIN)
      expect(c.instructions).toEqual([])
    })

    test('exactly a minute before the scheduling cutoff still arms the idle timer', { options: { idleCompactMinutes: 55 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      seen.stepMs = 55.5 * MIN
      await mainTurn($, seen, 't1', 250_000)
      await seen.clock.advance(MIN - 1)
      expect(c.instructions).toEqual([])
      await seen.clock.advance(1)
      expect(c.instructions).toHaveLength(1)
    })

    for (const path of ['long response', 'busy re-check']) {
      test(`the ${path} leaves time for an agent lookup before the idle cutoff`, { options: { idleCompactMinutes: path === 'long response' ? 55 : 53 } }, async ($, on) => {
        const { seen, c } = compactWorld($, on)
        if (path === 'long response') seen.stepMs = 6 * MIN
        if (path === 'busy re-check') c.agents = ['running']
        let finishLookup: (() => void) | undefined
        const lookup = () => new Promise<void>(resolve => { finishLookup = resolve })
        if (path === 'long response') c.beforeAgents = lookup
        await mainTurn($, seen, 't1', 250_000)
        await seen.clock.advance(path === 'long response' ? 50.5 * MIN : 53 * MIN + 1000)
        if (path === 'busy re-check') {
          expect(c.instructions).toEqual([])
          c.agents = []
          c.beforeAgents = lookup
          await seen.clock.advance(3.5 * MIN - 1000)
        }
        expect(finishLookup).toBeDefined()
        await seen.clock.advance(1)
        finishLookup!()
        await seen.clock.advance(0)
        expect(c.instructions).toHaveLength(1)
        expect(await statsOf($)).toContain('Compactions at idle (cache warm): 1')
      })
    }

    test('an agent lookup that crosses the real idle cutoff still skips compaction', { options: { idleCompactMinutes: 55 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      let finishLookup: (() => void) | undefined
      c.beforeAgents = () => new Promise<void>(resolve => { finishLookup = resolve })
      await mainTurn($, seen, 't1', 250_000)
      await seen.clock.advance(55 * MIN)
      expect(finishLookup).toBeDefined()
      await seen.clock.advance(3 * MIN)
      finishLookup!()
      await seen.clock.advance(0)
      expect(c.instructions).toEqual([])
    })

    for (const status of ['pending', 'running', 'waiting']) {
      test(`a ${status} agent defers the cap to the idle guard`, { options: { compactAtContext: 200_000, idleCompactMinutes: 20 } }, async ($, on) => {
        const { seen, c } = compactWorld($, on)
        c.agents = [status]
        await mainTurn($, seen, 't1', 250_000)
        await seen.clock.advance(0)
        expect(c.instructions).toEqual([])
        c.agents = ['completed']
        await seen.clock.advance(20 * MIN)
        expect(c.instructions).toHaveLength(1)
        expect(await statsOf($)).toContain('Compactions at idle (cache warm): 1')
        expect(await statsOf($)).toContain('Compactions at the context cap: 0')
      })
    }

    test('an aborted turn arms only the idle guard', { options: { compactAtContext: 200_000, idleCompactMinutes: 20 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      await $.prompt.submit({ text: 'work' } as never)
      seen.usage.push(U(1000, 500, 249_000))
      await step($, 't1')
      await $.turn.complete({ ...done('t1') as any, isAborted: true, reason: 'aborted' } as never)
      await seen.clock.advance(0)
      expect(c.instructions).toEqual([])
      await seen.clock.advance(20 * MIN)
      expect(c.instructions).toHaveLength(1)
      expect(await statsOf($)).toContain('Compactions at idle (cache warm): 1')
      expect(await statsOf($)).toContain('Compactions at the context cap: 0')
    })

    test('a prompt during the cap agent lookup still cancels compaction', { options: { compactAtContext: 200_000 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      c.beforeAgents = async () => {
        await $.prompt.submit({ text: 'back' } as never)
      }
      await mainTurn($, seen, 't1', 250_000)
      await seen.clock.advance(0)
      expect(c.instructions).toEqual([])
    })

    for (const cancel of ['held prompt', 'router off']) {
      test(`${cancel} during the final idle clock read still cancels compaction`, { options: { idleCompactMinutes: 20 } }, async ($, on) => {
        on('clock.every', {}, async (_$: unknown, e: any, next: any) => next({ ...e, ms: 24 * 60 * MIN }))
        let reads = -1
        on('clock.now', {}, async (_$: unknown, e: any, next: any) => {
          // The second clock read is after the agent lookup, just before compacting.
          if (reads >= 0 && ++reads === 2) {
            if (cancel === 'held prompt') await $.prompt.submit({ text: 'back' } as never)
            else await $.command.run({ command: 'model-router', args: 'off' } as never)
          }
          return next(e)
        })
        const { seen, c } = compactWorld($, on, 'ok', true)
        await mainTurn($, seen, 't1', 250_000)
        reads = 0
        await seen.clock.advance(20 * MIN)
        expect(reads).toBeGreaterThanOrEqual(2)
        expect(c.instructions).toEqual([])
        expect(c.toasts).toEqual(cancel === 'router off' ? ['Compaction skipped: router off'] : [])
        expect(await statsOf($)).toContain('Compactions at idle (cache warm): 0')
      })
    }

    for (const kind of ['idle', 'cap']) {
      test(`the plugin's ${kind} compaction usage is metered once`, { options: { idleCompactMinutes: 20, compactAtContext: 200_000 } }, async ($, on) => {
        const { seen, c } = compactWorld($, on)
        const usage = U(1000, 500, 200_000, 0)
        c.sizes = { usage }
        if (kind === 'idle') c.agents = ['running']
        await mainTurn($, seen, 't1', 250_000)
        await seen.clock.advance(0)
        c.agents = []
        const before = seen.tally!
        await seen.clock.advance(kind === 'idle' ? 20 * MIN : 0)
        const after = seen.tally!
        // The cap has already run at the first tick; compare with the known main and classifier usage instead.
        const mainCost = costOf(U(1000, 500, 249_000), 'opus') + costOf(U(1, 1), 'haiku')
        expect(near(after.cost, mainCost + costOf(usage, 'opus'))).toBe(true)
        if (kind === 'idle') expect(after.tokens - before.tokens).toBe(201_500)
        expect(c.instructions).toHaveLength(1)
      })
    }
  })

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

  test('a compact that rejects (a turn is running) is swallowed: nothing counted, one skip toast', { options: { idleCompactMinutes: 20 } }, async ($, on) => {
    const { seen, c } = compactWorld($, on, 'reject')
    await mainTurn($, seen, 't1', 250_000)
    await seen.clock.advance(30 * MIN)
    expect(c.instructions).toHaveLength(1)
    expect(c.toasts).toEqual(['Compaction skipped: engine refused compaction'])
    expect(await statsOf($)).toContain('Compactions at idle (cache warm): 0')
  })

  test('a vetoed compact ({ skip }) is not a compaction', { options: { idleCompactMinutes: 20 } }, async ($, on) => {
    const { seen, c } = compactWorld($, on, 'skip')
    await mainTurn($, seen, 't1', 250_000)
    await seen.clock.advance(30 * MIN)
    expect(c.instructions).toHaveLength(1)
    expect(c.toasts).toEqual(['Compaction skipped: compaction skipped by hook'])
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
    for (const kind of ['idle', 'cap']) {
      for (const cancel of ['prompt', 'off']) {
        test(`${cancel} during the plugin's ${kind} compaction without a newer request: the next prompt within the TTL is classified`, { options: { idleCompactMinutes: 20, compactAtContext: kind === 'cap' ? 200_000 : 0 } }, async ($, on) => {
          let active = false
          let hit = false
          on('session.compact', {}, async (_$: unknown, e: any, next: any) => {
            if (active) {
              active = false
              hit = true
              if (cancel === 'off') await $.command.run({ command: 'model-router', args: 'off' } as never)
              else await $.prompt.submit({ text: 'back' } as never)
            }
            return next(e)
          })
          const { seen, c } = compactWorld($, on)
          c.sizes = { tokensBefore: 250_000, tokensAfter: 10_000 }
          await mainTurn($, seen, 't1', 250_000)
          active = true
          await seen.clock.advance(kind === 'idle' ? 20 * MIN : 0)
          expect(hit).toBe(true)
          expect(c.instructions).toHaveLength(1)
          if (cancel === 'off') await $.command.run({ command: 'model-router', args: 'on' } as never)
          await seen.clock.advance(MIN)
          await $.prompt.submit({ text: 'rename a variable' } as never)
          expect(seen.asked).toEqual(['haiku', 'haiku'])
          await step($, cancel === 'prompt' ? 't3' : 't2')
          expect(seen.steps.at(-1)!.model).toContain('sonnet')
          // Neither a prompt nor switching on revives the discarded context's timer.
          await seen.clock.advance(20 * MIN)
          expect(c.instructions).toHaveLength(1)
        })
      }
    }

    for (const off of ['before', 'during']) {
      test(`router disabled ${off} /compact: re-enabling within the TTL classifies the next prompt`, { options: { idleCompactMinutes: 20 } }, async ($, on) => {
        let active = false
        on('session.compact', {}, async (_$: unknown, e: any, next: any) => {
          if (active && off === 'during') await $.command.run({ command: 'model-router', args: 'off' } as never)
          return next(e)
        })
        const { seen, c } = compactWorld($, on)
        c.sizes = { tokensBefore: 250_000, tokensAfter: 10_000 }
        await mainTurn($, seen, 't1', 250_000)
        if (off === 'before') await $.command.run({ command: 'model-router', args: 'off' } as never)
        active = true
        await $.session.compact({ messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never)
        active = false
        await $.command.run({ command: 'model-router', args: 'on' } as never)
        await seen.clock.advance(20 * MIN)
        // Switching back on must not revive the old timer or keep the discarded Opus context warm.
        expect(c.instructions).toHaveLength(1)
        await $.prompt.submit({ text: 'rename a variable' } as never)
        expect(seen.asked).toEqual(['haiku', 'haiku'])
        await step($, 't2')
        expect(seen.steps.at(-1)!.model).toContain('sonnet')
      })
    }

    for (const path of ['session.compact observer', 'compactMain idle', 'compactMain cap']) {
      test(`${path}: a newer main request without a new prompt is not cleared`, { options: { idleCompactMinutes: 20, compactAtContext: path === 'compactMain cap' ? 200_000 : 0 } }, async ($, on) => {
        let active = false
        let hit = false
        on('session.compact', {}, async (_$: unknown, e: any, next: any) => {
          if (active) {
            active = false
            hit = true
            // Another step records fresh context without a prompt moving the timer epoch.
            seen.usage.push(U(1000, 500, 149_000, 0, 'claude-opus-5-5'))
            await step($, 't1')
            await $.turn.complete(done('t1'))
          }
          return next(e)
        })
        const { seen, c } = compactWorld($, on)
        await mainTurn($, seen, 't1', 250_000)
        active = true
        if (path.startsWith('compactMain')) await seen.clock.advance(path === 'compactMain cap' ? 0 : 20 * MIN)
        else await $.session.compact({ messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never)
        expect(hit).toBe(true)
        await $.prompt.submit({ text: 'next' } as never)
        expect(seen.asked).toEqual(['haiku'])
        await step($, 't2')
        expect(seen.steps.at(-1)!.model).toContain('opus')
        await $.turn.complete(done('t2'))
        await seen.clock.advance(20 * MIN)
        expect(c.instructions).toHaveLength(2)
        expect(c.toasts.at(-1)).toContain('150.0k')
      })
    }

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

    test('the single busy-agent re-check moves forward to the deadline', { options: { idleCompactMinutes: 53 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      c.agents = ['running']
      await mainTurn($, seen, 't1', 250_000)
      await seen.clock.advance(53 * MIN + 1000)
      c.agents = []
      await seen.clock.advance(3 * MIN)
      expect(c.instructions).toEqual([])
      await seen.clock.advance(MIN)
      expect(c.instructions).toHaveLength(1)
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
      expect(c.toasts).toEqual(['Compaction skipped: engine refused compaction'])
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
    test('a long response moves idle compaction forward to the send-time deadline', { options: { idleCompactMinutes: 55 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      seen.stepMs = 6 * MIN
      await mainTurn($, seen, 't1', 250_000)
      seen.stepMs = 0
      await seen.clock.advance(50 * MIN)
      expect(c.instructions).toEqual([])
      await seen.clock.advance(MIN)
      expect(c.instructions).toHaveLength(1)
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
      // Armed after the turn. The prompt lands during runIdle's enabled-state read.
      let reads = -1
      on('state.get', { plugin: 'model-router' }, async (_$: unknown, e: any, next: any) => {
        if (reads >= 0 && e.key === 'enabled' && ++reads === 1) {
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
    test('compacting a resumed session without an observed request keeps the session model as a fallback', async ($, on) => {
      const { c } = compactWorld($, on)
      let model = 'sonnet'
      on('session.model', async () => ({ value: model }))
      await $.session.measure({ context: { window: 1e6, tokens: 150_000 }, rateLimits: [], changed: ['context'] } as never)
      c.sizes = { tokensAfter: 31_000, usage: U(1000, 500) }
      await $.session.compact({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never)
      model = 'haiku'
      await $.session.measure({ context: { window: 1e6, tokens: 60_000 }, rateLimits: [], changed: ['context'] } as never)
      const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
      expect(await ui.find({ text: /Haiku · ctx 60.0k.*cold resume ≈\$0.01.*cache deadline unknown/ })).toBeDefined()
    })

    for (const kind of ['idle', 'cap']) {
      for (const grew of [true, false]) {
        test(`${kind} guard uses the measured size when the context ${grew ? 'grows' : 'shrinks'}`, { options: { idleCompactMinutes: 20, compactAtContext: 200_000 } }, async ($, on) => {
          const { seen, c } = compactWorld($, on)
          on('session.model', async () => ({ value: 'opus' }))
          await $.prompt.submit({ text: 'choose #opus' } as never)
          seen.usage.push(U(1000, 500, grew ? 9000 : 249_000))
          await step($, 't1')
          await $.session.measure({ context: { window: 1e6, tokens: grew ? (kind === 'cap' ? 250_000 : 150_000) : 0 }, rateLimits: [], changed: ['context'] } as never)
          await $.turn.complete(done('t1'))
          await seen.clock.advance(kind === 'cap' ? 0 : 20 * MIN)
          expect(c.instructions).toHaveLength(grew ? 1 : 0)
          if (grew) expect(c.toasts[0]).toContain(kind === 'cap' ? 'Context cap reached:' : 'Idle compact:')
        })
      }
    }

    for (const kind of ['idle', 'cap', 'manual']) {
      test(`${kind} compaction falls back to the latest measured size and observed request prices`, { options: { idleCompactMinutes: 20, compactAtContext: 200_000 } }, async ($, on) => {
        const { seen, c } = compactWorld($, on)
        on('session.model', async () => ({ value: 'opus' }))
        c.sizes = { tokensAfter: 31_000, usage: U(1000, 500) }
        await $.prompt.submit({ text: 'find #haiku' } as never)
        seen.usage.push(U(1000, 500, 220_000, 0, 'haiku'))
        await step($, 't1')
        await $.session.measure({ context: { window: 1e6, tokens: kind === 'cap' ? 250_000 : 150_000 }, rateLimits: [], changed: ['context'] } as never)
        if (kind === 'manual') await $.session.compact({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never)
        else {
          await $.turn.complete(done('t1'))
          await seen.clock.advance(kind === 'cap' ? 0 : 20 * MIN)
        }
        expect(c.instructions).toHaveLength(1)
        const size = kind === 'cap' ? '250.0k' : '150.0k'
        expect((await statsOf($)).split(`${size} → 31.0k`)).toHaveLength(3)
        if (kind !== 'manual') expect(c.toasts[0]).toContain(`${size} → 31.0k`)
        expect(seen.tally!.byRole!.compaction!.cost).toBe(costOf(c.sizes.usage!, 'haiku'))
        // Installing a summary forgets the timestamp, but keeps the request's price family.
        await $.session.measure({ context: { window: 1e6, tokens: 40_000 }, rateLimits: [], changed: ['context'] } as never)
        const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
        expect(await ui.find({ text: /Haiku · ctx 40.0k.*cold resume ≈<\$0.01.*cache deadline unknown/ })).toBeDefined()
      })
    }

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

  describe('guard UI (1.0)', () => {
    test('a delayed minute tick reads wall time for the guard and cache countdowns', { options: { idleCompactMinutes: 55 } }, async ($, on) => {
      let wallTime: number | undefined
      on('clock.now', {}, async (_$: unknown, e: any, next: any) => wallTime === undefined ? next(e) : { value: wallTime })
      const { seen, c } = compactWorld($, on)
      await mainTurn($, seen, 't1', 221_000)
      expect(seen.statuses.at(-1)).toBe('idle compact in 55m')
      // Only one timer tick has fired, but the process has been asleep for twenty minutes.
      wallTime = 20 * MIN
      await seen.clock.advance(MIN)
      expect(seen.statuses.at(-1)).toBe('idle compact in 35m')
      const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
      expect(await ui.find({ text: /cache warm ~40m/ })).toBeDefined()
      expect(c.instructions).toEqual([])
      wallTime = 61 * MIN
      await seen.clock.advance(MIN)
      expect(seen.statuses.at(-1)).toBe('idle compact in 0m')
      expect(await ui.find({ text: /cache expired: next prompt rewrites/ })).toBeDefined()
    })

    test('the idle countdown advances, lists its deadlines and clears on a held prompt', { options: { idleCompactMinutes: 20 } }, async ($, on) => {
      const { seen } = compactWorld($, on)
      on('prompt.submit', { text: 'back' }, async () => ({ drop: 'held' }))
      await mainTurn($, seen, 't1', 221_000)
      expect(seen.statuses.at(-1)).toBe('idle compact in 20m')
      await seen.clock.advance(12 * MIN)
      expect(seen.statuses.at(-1)).toBe('idle compact in 8m')
      const r = await $.command.run({ command: 'model-router', args: 'status' } as never)
      expect(r.text).toContain('Pending: idle compact in 8m')
      expect(r.text).toContain('Cache deadline: 1970-01-01T01:00:00.000Z')
      expect(r.text).toContain('Compaction safe deadline: 1970-01-01T00:57:00.000Z')
      await $.prompt.submit({ text: 'back' } as never)
      expect(seen.statuses.at(-1)).toBeUndefined()
    })

    test('weekly usage and the guard share a line; cancelling the guard preserves weekly usage', { options: { idleCompactMinutes: 20 } }, async ($, on) => {
      const { seen } = compactWorld($, on)
      on('session.model', async () => ({ value: 'opus' }))
      await $.session.measure({ context: { window: 1e6 }, rateLimits: [{ kind: 'seven_day', percentUsed: 76 }], changed: ['rateLimits'] } as never)
      await mainTurn($, seen, 't1', 221_000)
      expect(seen.statuses.at(-1)).toBe('Weekly 76% │ idle compact in 20m')
      await $.command.run({ command: 'model-router', args: 'off' } as never)
      expect(seen.statuses.at(-1)).toBe('Weekly 76%')
    })

    test('busy agents are counted and a terminal skip clears waiting with one toast', { options: { idleCompactMinutes: 20 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      c.agents = ['running', 'waiting', 'completed']
      await mainTurn($, seen, 't1', 221_000)
      await seen.clock.advance(20 * MIN)
      expect(seen.statuses.at(-1)).toBe('idle compact waiting for 2 agents')
      expect(c.toasts).toEqual([])
      await seen.clock.advance(5 * MIN)
      expect(seen.statuses.at(-1)).toBeUndefined()
      expect(c.toasts).toEqual(['Compaction skipped: agents still busy'])
      await seen.clock.advance(60 * MIN)
      expect(c.toasts).toHaveLength(1)
      const r = await $.command.run({ command: 'model-router', args: 'status' } as never)
      expect(r.text).toContain('Pending: none')
      expect(r.text).toContain('Last skipped action: Compaction skipped: agents still busy')
    })

    test('an agent completion updates a waiting count and returns to the re-check countdown', { options: { idleCompactMinutes: 20 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      c.agents = ['running', 'waiting']
      await mainTurn($, seen, 't1', 221_000)
      await seen.clock.advance(20 * MIN)
      c.agents = ['completed', 'waiting']
      await $.turn.complete(done('a1', 'agent-0'))
      expect(seen.statuses.at(-1)).toBe('idle compact waiting for 1 agent')
      c.agents = ['completed', 'completed']
      await $.turn.complete(done('a2', 'agent-1'))
      expect(seen.statuses.at(-1)).toBe('idle compact in 5m')
      await seen.clock.advance(5 * MIN)
      expect(c.instructions).toHaveLength(1)
      expect(seen.statuses.at(-1)).toBeUndefined()
    })

    test('a busy cap with no idle fallback explains the skip once', { options: { compactAtContext: 200_000 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      c.agents = ['running']
      await mainTurn($, seen, 't1', 221_000)
      await seen.clock.advance(0)
      expect(c.toasts).toEqual(['Compaction skipped: agents still busy'])
      expect(seen.statuses.at(-1)).toBeUndefined()
    })

    test('a failed agent lookup reports unavailable rather than claiming a busy count', { options: { compactAtContext: 200_000 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      c.beforeAgents = async () => { throw new Error('unavailable') }
      await mainTurn($, seen, 't1', 221_000)
      await seen.clock.advance(0)
      expect(c.toasts).toEqual(['Compaction skipped: agent status unavailable'])
      expect(c.instructions).toEqual([])
      expect(seen.statuses.at(-1)).toBeUndefined()
    })

    test('all summarizer usage is metered; only installed main compactions enter the size history', async ($, on) => {
      const { seen, c } = compactWorld($, on)
      await mainTurn($, seen, 't1', 221_000)
      c.sizes = { tokensBefore: 221_000, tokensAfter: 31_000, usage: U(1000, 500) }
      const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
      const messages = [{ role: 'user', text: 'summary', toolUses: [] }]
      await $.session.compact({ trigger: 'precompute', messages } as never)
      await $.session.compact({ agentId: 'agent-1', messages } as never)
      expect(await ui.find({ text: /Opus · ctx 221.0k/ })).toBeDefined()
      await $.session.compact({ messages } as never)
      const text = await statsOf($)
      expect(text.split('221.0k → 31.0k')).toHaveLength(3)
      expect(text.split('| Compaction | 4.5k |')).toHaveLength(3)
      expect(await ui.find({ text: /Opus · ctx 31.0k.*cold resume ≈\$0.25.*cache deadline unknown/ })).toBeDefined()
      const context = await $.command.run({ command: 'model-router', args: 'context' } as never)
      expect(context.text).toContain('ctx: 31.0k')
      expect(context.text).toContain('No local breakdown available.')
    })

    for (const source of ['inherited', 'pinned', 'resumed', 'observed']) {
      test(`subagent compaction uses the ${source} Fable family rather than its Opus policy tier`, { options: { blockFable: false } }, async ($, on) => {
        const { seen, c } = compactWorld($, on)
        await mainTurn($, seen, 't1', 221_000)
        const fable = 'claude-fable-5-5'
        const agentId = await spawnAgent($, {
          subagentType: 'Plan', parentModel: fable,
          ...(source === 'pinned' ? { model: fable } : {}),
          ...(source === 'resumed' ? { resume: { agentId: 'resumed-fable' } } : {}),
          ...(source === 'observed' ? { model: 'sonnet' } : {}),
        })
        if (source === 'observed') {
          seen.usage.push(U(1000, 500, 2000, 3000, fable))
          await step($, 'a1', 'claude-sonnet-5-5', agentId)
        }
        const usage = U(1000, 2000, 3000, 4000)
        c.sizes = { tokensBefore: 90_000, tokensAfter: 10_000, usage }
        const before = seen.tally!
        await $.session.compact({ agentId, messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never)
        const after = seen.tally!
        expect(after.byRole!.compaction!.cost).toBe(costOf(usage, 'fable'))
        for (const kind of ['read', 'write', 'input', 'output'] as const) {
          const tokens = { read: 3000, write: 4000, input: 1000, output: 2000 }[kind]
          expect(near(after.byUsage![kind]!.cost - before.byUsage![kind]!.cost, tokens * PRICES.fable[kind] / 1e6)).toBe(true)
        }
        expect(after.compactions ?? []).toEqual([])
        const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
        expect(await ui.find({ text: /Opus · ctx 221.0k/ })).toBeDefined()
      })
    }

    for (const kind of ['fork', 'workflow', 'untracked']) {
      for (const source of ['request', 'usage', 'no usage']) {
        test(`${kind} compaction uses its latest ${source} family without routing the agent`, { options: { blockFable: false } }, async ($, on) => {
          const { seen, c } = compactWorld($, on)
          await mainTurn($, seen, 't1', 221_000)
          const agentId = kind === 'untracked' ? 'outside-router' : await spawnAgent($, {
            model: 'sonnet', ...(kind === 'fork' ? { fork: true } : { workflow: { runId: 'wf_1', agentIndex: 1 } }),
          })
          // A later request replaces the first observation; usage takes precedence over the requested model.
          seen.usage.push(U(1000, 500, 2000, 3000, 'haiku'))
          await step($, 'a1', 'claude-haiku-5-5', agentId, 'xhigh')
          if (source !== 'no usage') seen.usage.push(U(1000, 500, 2000, 3000, source === 'usage' ? 'fable' : ''))
          await step($, 'a2', 'claude-sonnet-5-5', agentId, 'xhigh')
          expect(seen.steps.at(-1)).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'xhigh' })
          expect((await call($, { agent: agentId, effort: 'high', reason: 'x' })).result).toBe(`No tracked subagent ${agentId}.`)
          const model = source === 'usage' ? 'fable' : 'sonnet'
          const usage = U(1000, 2000, 3000, 4000)
          c.sizes = { tokensBefore: 90_000, tokensAfter: 10_000, usage }
          const before = seen.tally!
          await $.session.compact({ agentId, messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never)
          const after = seen.tally!
          expect(after.byRole!.compaction!.cost).toBe(costOf(usage, model))
          expect(near(after.cost - before.cost, costOf(usage, model))).toBe(true)
          for (const kind of ['read', 'write', 'input', 'output'] as const) {
            const tokens = { read: 3000, write: 4000, input: 1000, output: 2000 }[kind]
            expect(near(after.byUsage![kind]!.cost - before.byUsage![kind]!.cost, tokens * PRICES[model][kind] / 1e6)).toBe(true)
          }
          expect(after.compactions ?? []).toEqual([])
          const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
          expect(await ui.find({ text: /Opus · ctx 221.0k/ })).toBeDefined()
        })
      }
    }

    test('a cache deadline crossed during lookup skips once and clears pending status', { options: { idleCompactMinutes: 55 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      let release: (() => void) | undefined
      c.beforeAgents = () => new Promise<void>(resolve => { release = resolve })
      await mainTurn($, seen, 't1', 221_000)
      await seen.clock.advance(55 * MIN)
      expect(release).toBeDefined()
      await seen.clock.advance(3 * MIN)
      release!()
      await seen.clock.advance(0)
      expect(c.instructions).toEqual([])
      expect(seen.statuses.at(-1)).toBeUndefined()
      expect(c.toasts).toEqual(['Compaction skipped: cache deadline passed'])
      await seen.clock.advance(60 * MIN)
      expect(c.toasts).toHaveLength(1)
    })

    test('off reports one skip per armed timer, and a new timer can report another', { options: { idleCompactMinutes: 20 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      await mainTurn($, seen, 't1', 221_000)
      await $.command.run({ command: 'model-router', args: 'off' } as never)
      await $.command.run({ command: 'model-router', args: 'off' } as never)
      expect(c.toasts).toEqual(['Compaction skipped: router off'])
      expect(seen.statuses.at(-1)).toBeUndefined()
      await $.command.run({ command: 'model-router', args: 'on' } as never)
      await mainTurn($, seen, 't2', 221_000)
      await $.command.run({ command: 'model-router', args: 'off' } as never)
      expect(c.toasts).toEqual(['Compaction skipped: router off', 'Compaction skipped: router off'])
    })

    test('default settings retain subagent event statuses without per-agent toasts', async ($, on) => {
      const { seen, c } = compactWorld($, on)
      for (let i = 0; i < 3; i++) await spawnAgent($, { subagentType: 'Explore' })
      expect(c.toasts).toEqual([])
      expect(seen.statuses.at(-1)).toContain('subagent Explore start: haiku/medium')
    })

    test('compaction history, spend and peak survive in both session and daily stats', { options: { compactAtContext: 200_000 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      c.sizes = { tokensBefore: 412_000, tokensAfter: 31_000, usage: U(1000, 2000, 3000, 4000) }
      await mainTurn($, seen, 't1', 250_000)
      await seen.clock.advance(0)
      const text = await statsOf($)
      for (const section of [text.split('**Today**')[0]!, text.split('**Today**')[1]!]) {
        expect(section).toContain('| Compaction | 10.0k |')
        expect(section).toContain('412.0k → 31.0k')
        expect(section).toContain('Peak main context: 250.0k')
      }
      expect(seen.statuses.at(-1)).toBeUndefined()
      const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
      expect(await ui.find({ text: /Opus · ctx 31.0k.*cold resume ≈\$0.25.*cache deadline unknown/ })).toBeDefined()
    })

    test('cold rewrite counts appear in this session and today without changing the same-token comparison', async ($, on) => {
      const { seen } = compactWorld($, on)
      await $.prompt.submit({ text: 'resumed #opus' } as never)
      seen.usage.push(U(1000, 500, 0, 221_000))
      await step($, 't1')
      const text = await statsOf($)
      expect(text.split('Cold rewrites counted: 1')).toHaveLength(3)
      expect(text).toContain('same work tokens at Opus prices')
    })

    test('Chinese guard skips and status are translated', { options: { language: 'zh', idleCompactMinutes: 20 } }, async ($, on) => {
      const { seen, c } = compactWorld($, on)
      await mainTurn($, seen, 't1', 221_000)
      expect(seen.statuses.at(-1)).toBe('空闲压缩将在 20 分钟后执行')
      await $.command.run({ command: 'model-router', args: 'off' } as never)
      expect(c.toasts).toEqual(['已跳过压缩：路由已关闭'])
      const r = await $.command.run({ command: 'model-router', args: 'status' } as never)
      expect(r.text).toContain('上次跳过: 已跳过压缩：路由已关闭')
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
      expect(await statsOf($)).toContain('Compaction in this session: router on · idle off · cap off · min context 100.0k.')
    })

    test('stats show loaded idle minutes and cap', { options: { idleCompactMinutes: 50, compactAtContext: 300_000 } }, async ($, on) => {
      compactWorld($, on)
      const text = await statsOf($)
      expect(text).toContain('Compaction in this session: router on · idle after 50 min · cap at 300.0k · min context 100.0k.')
      expect(text).toContain('Changing plugin options reloads the plugin with the new values.')
      expect(text).not.toContain('restart the session')
    })

    // WHY: off stops both guards; a line that still lists thresholds reads as if compaction ran.
    test('with the router off the line says no compaction runs', { options: { compactAtContext: 300_000 } }, async ($, on) => {
      compactWorld($, on)
      await $.command.run({ command: 'model-router', args: 'off' } as never)
      expect(await statsOf($)).toContain('Compaction in this session: router off, so no automatic compaction runs · idle off · cap at 300.0k')
    })

    for (const command of ['stats', 'status']) {
      for (const enabled of [true, false]) {
        test(`${command} shows effective compaction settings and automatic options reload, router ${enabled ? 'on' : 'off'}`, { options: { idleCompactMinutes: 12, compactAtContext: 300_000, compactMinContext: 150_000 } }, async ($, on) => {
          compactWorld($, on)
          if (!enabled) await $.command.run({ command: 'model-router', args: 'off' } as never)
          const r = await $.command.run({ command: 'model-router', args: command } as never)
          const state = enabled ? 'router on' : 'router off, so no automatic compaction runs'
          expect(r.text).toContain(`Compaction in this session: ${state} · idle after 12 min · cap at 300.0k · min context 150.0k.`)
          expect(r.text).toContain('Changing plugin options reloads the plugin with the new values.')
          expect(r.text).not.toContain('restart the session')
          if (!enabled) expect(r.text).toContain('Explicit checkpoints remain available when the router is off.')
        })
      }

      test(`${command} shows disabled guards and follows the session router toggle`, async ($, on) => {
        compactWorld($, on)
        const text = async () => (await $.command.run({ command: 'model-router', args: command } as never)).text
        expect(await text()).toContain('router on · idle off · cap off · min context 100.0k.')
        await $.command.run({ command: 'model-router', args: 'off' } as never)
        expect(await text()).toContain('router off, so no automatic compaction runs · idle off · cap off')
        await $.command.run({ command: 'model-router', args: 'on' } as never)
        expect(await text()).toContain('router on · idle off · cap off')
      })
    }

    for (const kind of ['idle', 'cap', 'checkpoint']) {
      for (const how of ['ok', 'skip', 'reject'] as const) {
        test(`${kind} logs ${how === 'ok' ? 'done with engine sizes' : how === 'skip' ? 'skipped with veto' : 'rejected with engine error'}`, { options: { idleCompactMinutes: 20, compactAtContext: kind === 'cap' ? 200_000 : 0 } }, async ($, on) => {
          const { seen, c } = compactWorld($, on, how)
          c.sizes = { tokensBefore: 240_000, tokensAfter: 30_000 }
          await mainTurn($, seen, 't1', 250_000)
          if (kind === 'checkpoint') await $.command.run({ command: 'model-router', args: 'checkpoint task boundary' } as never)
          await seen.clock.advance(kind === 'idle' ? 20 * MIN : 0)
          const attempts = eventsOf(seen).filter(e => e.event === `compact ${kind}`)
          expect(attempts).toHaveLength(1)
          expect(attempts[0]).toMatchObject({
            agentId: 'main',
            to: how === 'ok' ? 'done' : how === 'skip' ? 'skipped' : 'rejected',
            // The test kit converts a thrown compact hook into this engine rejection. Keep its text,
            // rather than replacing it with the generic reason used for the user toast.
            reason: how === 'ok' ? '240.0k → 30.0k' : how === 'skip' ? 'vetoed' : 'test: next() passed an argument with messages that are not a list',
          })
        })
      }
    }

    test('a checkpoint without engine sizes logs the last measured context', async ($, on) => {
      const { seen } = compactWorld($, on)
      await mainTurn($, seen, 't1', 250_000)
      await $.command.run({ command: 'model-router', args: 'checkpoint' } as never)
      await seen.clock.advance(0)
      expect(eventsOf(seen)).toContainEqual(expect.objectContaining({ event: 'compact checkpoint', to: 'done', reason: '250.0k' }))
    })

    for (const how of ['ok', 'skip', 'reject'] as const) {
      test(`a ${how} compact result from an ended session cannot log into the replacement`, async ($, on) => {
        on('session.compact', {}, async (_$: unknown, e: any, next: any) => {
          try {
            return await next(e)
          } finally {
            await replaceSession($, seen, 'clear')
          }
        })
        const { seen, c } = compactWorld($, on, how)
        await mainTurn($, seen, 't1', 250_000)
        await $.command.run({ command: 'model-router', args: 'checkpoint' } as never)
        await seen.clock.advance(0)
        expect(c.instructions).toHaveLength(1)
        await $.command.run({ command: 'model-router', args: 'status' } as never)
        const attempts = eventsOf(seen).filter(e => e.event.startsWith('compact '))
        expect(attempts).toHaveLength(1)
        expect(attempts[0]!.to).toBe(how === 'ok' ? 'done' : how === 'skip' ? 'skipped' : 'rejected')
        expect(eventsOf(seen, 'sess-2').filter(e => e.event.startsWith('compact '))).toEqual([])
        expect(c.toasts.some(text => text.startsWith('Checkpoint: compacted'))).toBe(false)
      })
    }

    for (const kind of ['idle', 'cap', 'checkpoint']) {
      for (const how of ['ok', 'skip', 'reject'] as const) {
        for (const cancel of ['prompt', 'off']) {
          test(`${kind} ${how} outcome survives ${cancel} after issuance (merge review #4)`, { options: { idleCompactMinutes: 20, compactAtContext: kind === 'cap' ? 200_000 : 0 } }, async ($, on) => {
            on('prompt.submit', { text: 'back' }, async () => ({ drop: 'held' }))
            on('session.compact', {}, async (_$: unknown, e: any, next: any) => {
              try { return await next(e) } finally {
                if (cancel === 'prompt') await $.prompt.submit({ text: 'back' } as never)
                else await $.command.run({ command: 'model-router', args: 'off' } as never)
              }
            })
            const { seen, c } = compactWorld($, on, how)
            c.sizes = { tokensBefore: 250_000, tokensAfter: 30_000, usage: U(100, 50) }
            await mainTurn($, seen, 't1', 250_000)
            if (kind === 'checkpoint') await $.command.run({ command: 'model-router', args: 'checkpoint' } as never)
            const before = seen.tally!.tokens
            await seen.clock.advance(kind === 'idle' ? 20 * MIN : 0)
            const attempts = eventsOf(seen).filter(e => e.event === `compact ${kind}`)
            expect(attempts).toHaveLength(1)
            expect(attempts[0]!.to).toBe(how === 'ok' ? 'done' : how === 'skip' ? 'skipped' : 'rejected')
            expect(c.toasts.some(text => /^(?:Idle compact:|Context cap reached:|Checkpoint: compacted)/.test(text))).toBe(false)
            const tally = seen.store[`meter:${storeDay(0)}:sess-1`] as Tally
            expect(tally.compactions ?? []).toHaveLength(how === 'ok' ? 1 : 0)
            expect(seen.tally!.tokens - before).toBe(how === 'ok' ? 150 : 0)
            await seen.clock.advance(60 * MIN)
            expect(c.instructions).toHaveLength(1)
          })
        }
      }
    }

    for (const how of ['ok', 'skip', 'reject'] as const) {
      for (const ended of [false, true]) {
        test(`a ${how} outcome joins a same-id resume${ended ? ' that has ended' : ''} without overwriting its new events`, async ($, on) => {
          on('fs.read', {}, async (_$: unknown, e: any, next: any) => seen.files[e.path] === undefined ? next(e) : { value: seen.files[e.path] })
          on('session.start', async (_$: unknown, e: any) => ({ cwd: e.cwd }))
          on('command.register', async (_$: unknown, e: any) => ({ value: { command: e.name } }))
          on('tool.register', async () => ({ value: { tool: 'mcp__model-router__escalate' } }))
          on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 1e6 }, rateLimits: [] } }))
          on('session.model', async () => ({ value: 'opus' }))
          on('session.compact', {}, async (_$: unknown, e: any, next: any) => {
            try { return await next(e) } finally {
              await $.session.end({ reason: 'resume', sessionId: seen.sessionId, resume: { id: seen.sessionId } } as never)
              await $.session.start({ cwd: '/plugin', surface: 'terminal', isInteractive: true })
              await spawnAgent($, { subagentType: 'Explore' })
              if (ended) await $.session.end({ reason: 'resume', sessionId: seen.sessionId, resume: { id: seen.sessionId } } as never)
            }
          })
          const { seen, c } = compactWorld($, on, how)
          await mainTurn($, seen, 't1', 250_000)
          const history = eventsOf(seen)
          await $.command.run({ command: 'model-router', args: 'checkpoint' } as never)
          await seen.clock.advance(0)
          const events = eventsOf(seen)
          expect(events.slice(0, history.length)).toEqual(history)
          expect(events).toHaveLength(history.length + 2)
          expect(events).toContainEqual(expect.objectContaining({ event: 'Explore start' }))
          expect(events).toContainEqual(expect.objectContaining({ event: 'compact checkpoint', to: how === 'ok' ? 'done' : how === 'skip' ? 'skipped' : 'rejected' }))
          expect(c.toasts).toEqual([])
          expect((seen.store[`meter:${storeDay(0)}:sess-1`] as Tally).compactions ?? []).toEqual([])
        })
      }
    }

    test('a slow event-log write cannot delay the checkpoint result, the next route or subagent result', async ($, on) => {
      let release: (() => void) | undefined
      on('fs.write', { path: /\/model-router\/[^/]+\/[^/]+\.json$/ }, async (_$: unknown, e: any, next: any) => {
        if (JSON.parse(e.text).events.some((event: any) => event.event === 'compact checkpoint')) {
          await new Promise<void>(resolve => { release = resolve })
        }
        return next(e)
      })
      const { seen, c } = compactWorld($, on)
      await mainTurn($, seen, 't1', 250_000)
      await $.command.run({ command: 'model-router', args: 'checkpoint' } as never)
      await seen.clock.advance(0)
      try {
        expect(release).toBeDefined()
        expect(c.toasts).toContain('Checkpoint: compacted 250.0k')
        await $.prompt.submit({ text: 'next work #haiku' } as never)
        expect(seen.submits.at(-1)!.text).toBe('next work #haiku')
        const id = await spawnAgent($, { subagentType: 'Explore' })
        seen.usage.push(U(100, 50))
        await step($, 'a1', OPUS, id)
        expect(seen.steps.at(-1)).toMatchObject({ agentId: id, model: 'claude-haiku-5-5', effort: 'medium' })
      } finally {
        release?.()
      }
      await seen.clock.advance(0)
      expect(eventsOf(seen)).toContainEqual(expect.objectContaining({ event: 'compact checkpoint', to: 'done' }))
    })

    test('a failed event-log write does not change a successful checkpoint outcome', async ($, on) => {
      on('fs.write', { path: /\/model-router\/[^/]+\/[^/]+\.json$/ }, async (_$: unknown, e: any, next: any) => {
        if (JSON.parse(e.text).events.some((event: any) => event.event === 'compact checkpoint')) throw new Error('disk full')
        return next(e)
      })
      const { seen, c } = compactWorld($, on)
      await mainTurn($, seen, 't1', 250_000)
      await $.command.run({ command: 'model-router', args: 'checkpoint' } as never)
      await seen.clock.advance(0)
      expect(c.toasts).toContain('Checkpoint: compacted 250.0k')
      expect(await statsOf($)).toContain('Task-boundary checkpoints: 1')
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

  // WHY: medium is Opus's own self cap: an Opus pin at medium could never raise itself, and it used to run at the
  // session effort. Sonnet and Haiku at medium can still go to high by themselves, so they start at medium anywhere.
  test('an opus pin keeps the session effort; sonnet and haiku pins start at medium, even on the parent tier', async () => {
    expect(startOf(OPUS, OPUS, false, IDS_BY_KEY, true).effort).toBeUndefined()
    expect(startOf(OPUS, 'claude-fable-5-1', false, IDS_BY_KEY, true).effort).toBeUndefined()
    expect(startOf('claude-sonnet-5-5', 'claude-sonnet-5-5', false, IDS_BY_KEY, true).effort).toBe('medium')
    expect(startOf('claude-sonnet-5-5', OPUS, false, IDS_BY_KEY, true).effort).toBe('medium')
    expect(startOf('claude-haiku-5-5', 'claude-sonnet-5-5', false, IDS_BY_KEY, true).effort).toBe('medium')
  })

  test('an opus the caller named under an opus parent runs at the session effort, capped at high', async ($, on) => {
    const seen = world($, on, execute)
    const id = await spawnAgent($, { model: 'opus' })
    await step($, 'sub', OPUS, id, 'xhigh')
    expect(seen.steps.at(-1)).toMatchObject({ model: OPUS, effort: 'high' })
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
    expect(text).toContain('is execute when the context shows what to\n  change (an approved plan')
    expect(text).toContain('When what to change still has to be worked out, it is decide.')
    // An approved plan stays execute: the new rule must not contradict the old one.
    expect(text).toContain('is execute, because the plan settles what to do')
    expect(text).toContain('porting a change to a branch whose version of the code differs')
  })

  test('opus is told to hand settled multi-file work to an unpinned subagent and verify it; other models are not', async () => {
    expect(assignmentContext(routeFor('decide', ''))).toContain('delegate it to a general-purpose subagent without a model')
    expect(assignmentContext(routeFor('decide', ''))).toContain('make small changes directly')
    expect(assignmentContext(routeFor('execute', ''))).not.toContain('delegate it')
  })
})

describe('an effort the caller sets on the Agent tool is kept (v0.10.0, review P2)', () => {
  // WHY: Agent({ model: "sonnet", effort: "high" }) is an explicit request; starting it at medium silently overrode it.
  function agentWorld($: any, on: any) {
    const seen = world($, on, execute)
    const ids: string[] = []
    // As the engine does: the Agent tool call spawns the subagent while the call runs, under the same tool_use_id.
    on('tool.call', async (_$: unknown, e: any) => {
      if (e.tool === 'Agent') ids.push(await spawnAgent($, { tool_use_id: e.tool_use_id, model: e.model, subagentType: e.subagent_type ?? 'general-purpose' }))
      return { result: 'ok' } as never
    })
    return { seen, ids }
  }

  test('a caller pin with an explicit effort runs at that effort, not at medium', async ($, on) => {
    const { seen, ids } = agentWorld($, on)
    await $.tool.call({ tool: 'Agent', tool_use_id: 'call-1', model: 'sonnet', effort: 'high', prompt: 'p' } as never)
    await step($, 'sub', 'claude-sonnet-5-5', ids[0], 'high')
    expect(seen.steps.at(-1)).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' })
  })

  test('a router pin with an explicit effort keeps it too; the hard cap still holds', async ($, on) => {
    const { seen, ids } = agentWorld($, on)
    await $.tool.call({ tool: 'Agent', tool_use_id: 'call-2', effort: 'max', prompt: 'p', subagent_type: 'Explore' } as never)
    await step($, 'sub', OPUS, ids[0], 'max')
    expect(seen.steps.at(-1)).toMatchObject({ model: 'claude-haiku-5-5', effort: 'high' })
  })

  test('without an explicit effort the pin starts at medium; one call never leaks its effort into the next', async ($, on) => {
    const { seen, ids } = agentWorld($, on)
    await $.tool.call({ tool: 'Agent', tool_use_id: 'call-3', model: 'sonnet', effort: 'high', prompt: 'p' } as never)
    await $.tool.call({ tool: 'Agent', tool_use_id: 'call-4', model: 'sonnet', prompt: 'p' } as never)
    await step($, 'sub', 'claude-sonnet-5-5', ids[1], 'high')
    expect(seen.steps.at(-1)).toMatchObject({ effort: 'medium' })
  })
})

describe('large tool-output reduction (1.0)', () => {
  const limit = 20_000
  const fetchTool = 'mcp__model-router__fetch_output'
  const omitted = (n: number) => `[${n} lines omitted]`
  // A clear log-level token opts this fixture into truncation; distinct messages prevent collapsing.
  const longLog = Array.from({ length: 1500 }, (_, i) => `INFO ${String.fromCharCode(65 + i % 26)}${String.fromCharCode(65 + Math.floor(i / 26) % 26)} ${'detail '.repeat(8)}`).join('\n')
  const append = ($: any, text: unknown, tool = 'Bash', id = 'toolu_123', agentId?: string) => $.session.append({
    door: 'tool-result', origin: { kind: 'tool', tool }, uuid: `row-${id}`, agentId,
    message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: false }] },
  })
  const textOf = (r: any) => r.message.content[0].content
  function outputWorld($: any, on: any) {
    let seen: Seen
    on('fs.read', { path: /\/outputs\// }, async (_$: unknown, e: any) => {
      const text = seen.files[e.path]
      return text === undefined ? { deny: 'missing' } : { value: text }
    })
    seen = world($, on, null)
    return seen
  }

  test('thresholds default to off; sub-20000, non-finite and out-of-range values are off', async () => {
    for (const n of [undefined, 0, 1, 19_999, -1, NaN, Infinity, 1_000_001]) expect(outputLimit(n)).toBe(0)
    expect(outputLimit(20_000)).toBe(20_000)
    expect(outputLimit(1_000_000)).toBe(1_000_000)
  })

  test('cleaning strips ANSI and progress redraws, collapses recognised repeats, and preserves diagnostic lines', async () => {
    const text = '\x1b[31mINFO start\x1b[0m\nprogress 1\rprogress 2\rprogress 3\n' +
      'INFO same line\nINFO same line\nINFO same line\nINFO received 1 records\nINFO received 2 records\nERROR 1\nERROR 2\nwarning same\nwarning same'
    const reduced = reduceOutput(text, limit, omitted)
    expect(reduced).toBe('INFO start\nprogress 1 … progress 3 [×3]\nINFO same line [×3]\nINFO received 1 records\nINFO received 2 records\nERROR 1\nERROR 2\nwarning same\nwarning same')
    expect(reduceOutput('error before redraw\rprogress now', limit, omitted)).toContain('error before redraw')
  })

  for (const delimiter of ['\t', ',']) {
    test(`timestamp-first ${delimiter === '\t' ? 'TSV' : 'CSV'} stays byte for byte (third review #2)`, async () => {
      for (const level of ['', 'INFO ']) {
        for (const repeated of [false, true]) {
          const original = Array.from({ length: 1000 }, (_, i) =>
            [`2026-10-30T12:00:${String(i % 60).padStart(2, '0')}Z`, `${level}record ${repeated ? 'same' : i}`, 'detail '.repeat(10)].join(delimiter)).join('\r\n')
          expect(original.length).toBeGreaterThan(limit)
          expect(reduceOutput(original, limit, omitted) === original).toBe(true)
        }
      }
    })

    test(`consistent ${delimiter === '\t' ? 'TSV' : 'CSV'} wins over log levels across most lines (third review #2)`, async () => {
      for (const repeated of [false, true]) {
        const rows = Array.from({ length: 1000 }, (_, i) => ['INFO 2026-10-30T12:00:00Z', `record ${repeated ? 'same' : i}`, 'detail '.repeat(10)].join(delimiter))
        const original = ['export from job', ['timestamp', 'record', 'detail'].join(delimiter), ...rows, 'end of export'].join('\n')
        expect(reduceOutput(original, limit, omitted) === original).toBe(true)
        const mixed = `${original}\n${Array(600).fill('INFO export running').join('\n')}`
        expect(reduceOutput(mixed, limit, omitted) === mixed).toBe(true)
      }
    })
  }

  test('a bare timestamp is data; real timestamped logs still shrink (third review #2)', async () => {
    const data = Array.from({ length: 1000 }, (_, i) => `2026-10-30T12:00:00Z record ${i} ${'detail '.repeat(10)}`).join('\n')
    expect(reduceOutput(data, limit, omitted) === data).toBe(true)
    const log = data.replace(/Z record/g, 'Z INFO record')
    expect(reduceOutput(log, limit, omitted)).toContain('lines omitted]')
    expect(reduceOutput(log, limit, omitted).length).toBeLessThan(log.length)
  })

  test('CR diagnostic continuations and unclassified segments survive before progress cleanup (third review #3)', async () => {
    for (const block of [
      'ERROR connection lost\n    at checkout (/app/pool.js:42)\rINFO retry started',
      'ERROR connection lost\n    at checkout (/app/pool.js:42)\r    at handler (/app/api.js:9)\rINFO retry started',
      'ERROR connection lost\n    progress 1\r    progress 2\rINFO retry started',
    ]) {
      const reduced = reduceOutput(`${longLog}\n${block}\n${longLog}`, limit, omitted)
      expect(reduced).toContain(block.split('\rINFO')[0]!.replace(/\r/g, '\n'))
      expect(reduceOutput(`INFO begin\n${block}\nINFO end`, limit, omitted)).toBe(`INFO begin\n${block.replace(/\r/g, '\n')}\nINFO end`)
      expect(reduced.length).toBeLessThan(2 * longLog.length)
    }
    const text = 'INFO start\nraw continuation\rINFO next\nINFO before\rprogress 1\rprogress 2\runknown tail'
    expect(reduceOutput(text, limit, omitted)).toBe('INFO start\nraw continuation\nINFO next\nINFO before\nprogress 1 … progress 2 [×2]\nunknown tail')
    expect(reduceOutput('progress 1\rprogress 2\rprogress 3', limit, omitted)).toBe('progress 1 … progress 3 [×3]')
  })

  for (const level of ['fatal', 'error', 'critical', 'panic', 'emerg', 'alert']) {
    test(`${level} diagnostics survive truncation, repeats and redraws`, async () => {
      for (const label of [level.toUpperCase(), `[${level}]`, `${level}:`]) {
        const line = `${label} database connection terminated`
        const original = `${longLog}\n${line}\n${line}\n${longLog}`
        const reduced = reduceOutput(original, limit, omitted)
        expect(reduced).toContain('lines omitted]')
        expect(reduced.split(line)).toHaveLength(3)
        expect(reduced).toContain(`${line}\n${line}`)
        expect(reduceOutput(`${line}\rprogress now`, limit, omitted)).toContain(line)
        const timestamped = `12:00:01 ${line}\n12:00:02 ${line}`
        expect(reduceOutput(timestamped, limit, omitted)).toBe(timestamped)
        const oversized = `${line} ${'x'.repeat(limit)}`
        expect(reduceOutput(`${longLog}\n${oversized}\n${longLog}`, limit, omitted)).toContain(oversized)
        const log = Array.from({ length: 1000 }, (_, i) => `${label} message ${i}`).join('\n')
        expect(reduceOutput(log, 256, omitted)).toBe(log)
      }
    })
  }

  test('CR progress runs keep first and last states, and distinct ids, hashes and file names (merge review #2)', async () => {
    for (const [first, last] of [
      ['Downloading 10% artifact sha256:aaaa', 'Downloading 20% artifact sha256:bbbb'],
      ['Uploading [###-------] 30% id 123', 'Uploading [#####-----] 50% id 456'],
      ['Processing 10% file first.tar', 'Processing 20% file last.tar'],
      ['INFO progress 1/100', 'INFO progress 2/200'],
    ]) {
      const original = `${first}\r${last}`
      expect(reduceOutput(original, limit, omitted)).toBe(`${first}\n${last}`)
      const large = `${Array(1800).fill('INFO waiting for artifact').join('\n')}\n${original}`
      expect(large.length).toBeGreaterThan(45_000)
      const reduced = reduceOutput(large, limit, omitted)
      expect(reduced).toContain(`${first}\n${last}`)
      expect(reduced.length).toBeLessThan(limit)
    }
    for (const rows of [
      ['progress 1', 'progress 2', 'progress 3'],
      ['Downloading 10% same.tar', 'Downloading 20% same.tar', 'Downloading 30% same.tar'],
      ['[###-------] 30% same.tar', '[#####-----] 50% same.tar', '[########--] 80% same.tar'],
    ]) expect(reduceOutput(rows.join('\r'), limit, omitted)).toBe(`${rows[0]} … ${rows[2]} [×3]`)
    expect(reduceOutput('Downloading 10% a\rDownloading 20% b\rDownloading 30% a', limit, omitted))
      .toBe('Downloading 10% a\nDownloading 20% b\nDownloading 30% a')
  })

  test('only timestamps and explicit progress fields vary when collapsing recognised logs', async () => {
    for (const [first, second] of [
      ['2026-10-30T12:00:01Z INFO waiting for worker', '2026-10-30T12:00:02Z INFO waiting for worker'],
      ['[12:00:01.001] waiting for worker', '[12:00:02.002] waiting for worker'],
      ['INFO progress 1/100', 'INFO progress 2/100'],
      ['Downloading 10%', 'Downloading 20%'],
      ['[###-------] 30% download', '[#####-----] 50% download'],
    ]) expect(reduceOutput(`${first}\n${second}`, limit, omitted)).toBe(`${first} … ${second} [×2]`)
    for (const original of [
      'INFO received 1 records\nINFO received 2 records',
      '2026-10-30T12:00:01Z INFO id 123 hash 0xabc\n2026-10-30T12:00:02Z INFO id 456 hash 0xdef',
      'INFO task 1  ready\nINFO task 1 ready',
      'INFO progress 1/100\nINFO progress 2/200',
      '[###-------] 30% id 123\n[#####-----] 50% id 456',
      'INFO progress 1\nINFO progress <count>',
      'INFO Downloading 10%\nINFO Downloading <percent>',
      'INFO [###-------] 30% <percent>\nINFO [#####-----] <percent> <percent>',
      'same line \nsame line',
      'ERROR same\nERROR same',
    ]) expect(reduceOutput(original, limit, omitted)).toBe(original)
  })

  for (const line of ['SELECT 1;', 'echo hello', 'unclassified text']) {
    test(`unclassified repeats pass through byte for byte: ${line} (final review #3)`, async () => {
      for (const newline of ['\n', '\r\n']) {
        const original = Array(2500).fill(line).join(newline)
        expect(reduceOutput(original, limit, omitted) === original).toBe(true)
      }
      const original = `${longLog}\n${Array(100).fill(line).join('\n')}\n${longLog}`
      // Even inside a recognised log, an unclassified run must not be collapsed.
      const reduced = reduceOutput(original, limit, omitted)
      expect(reduced).toContain(Array(100).fill(line).join('\n'))
    })
  }

  for (const [language, block] of [
    ['JavaScript', 'Error: database disconnected\n    at checkout (/app/pool.js:42:7)\n    at handler (/app/api.js:9:2)\n    connection details\nCaused by: Error: socket closed\n    at read (/app/socket.js:5:3)'],
    ['Python', 'Traceback (most recent call last):\n  File "/app/pool.py", line 42, in checkout\n    connect()\n  File "/app/socket.py", line 5, in connect\n    open_socket()\nConnectionError: database disconnected'],
    ['Java/Kotlin', 'Exception in thread "main" java.lang.IllegalStateException: disconnected\n    at app.Pool.checkout(Pool.kt:42)\n    at app.Main.main(Main.java:9)\nCaused by: java.io.IOException: socket closed\n    at app.Socket.read(Socket.java:5)\n    ... 2 more'],
    ['Go', 'panic: database disconnected\n\ngoroutine 1 [running]:\nmain.checkout(0x1)\n    /app/pool.go:42 +0x12\nmain.main()\n    /app/main.go:9 +0x34'],
    ['Rust', "thread 'main' panicked at src/pool.rs:42:7:\ndatabase connection failed\nstack backtrace:\n   0: rust_begin_unwind\n             at /rustc/library/std/src/panicking.rs:1:1\n   1: app::checkout\n             at ./src/pool.rs:42:7"],
  ]) {
    test(`${language} diagnostic blocks survive whole (final review #4)`, async () => {
      const original = `${longLog}\n${block}\n${longLog}`
      const reduced = reduceOutput(original, limit, omitted)
      expect(reduced.length < original.length).toBe(true)
      expect(reduced).toContain(block!)
      const oversized = `${block}\n    ${'frame detail '.repeat(limit)}`
      expect(reduceOutput(`${longLog}\n${oversized}\n${longLog}`, limit, omitted)).toContain(oversized)
    })
  }

  test('a collapsed download shows completion and its run count (final review #5)', async () => {
    const original = Array.from({ length: 1001 }, (_, i) => `Downloading ${i / 10}%`).join('\n')
    expect(reduceOutput(original, limit, omitted)).toBe('Downloading 0% … Downloading 100% [×1001]')
  })

  for (const prefix of ['2026-10-30T12:00:00Z ', '[INFO] ', '2026-10-30T12:00:00Z [INFO] ', '[INFO] 2026-10-30T12:00:00Z ']) {
    test(`prefixed diagnostic blocks survive whole: ${prefix} (second review #2)`, async () => {
      const block = ['Error: database disconnected', '    at checkout (/app/pool.js:42:7)', '    at handler (/app/api.js:9:2)', '', 'Caused by: socket closed', '    at read (/app/socket.js:5:3)']
        .map(line => `${prefix}${line}`).join('\n')
      const reduced = reduceOutput(`${longLog}\n${block}\n${longLog}`, limit, omitted)
      expect(reduced).toContain(block)
      expect(reduced.length).toBeLessThan(2 * longLog.length)
      // A level prefix must not make unrelated messages diagnostic continuations.
      const ordinary = Array.from({ length: 1000 }, (_, i) => `${prefix}${prefix === '2026-10-30T12:00:00Z ' ? 'INFO ' : ''}request ${i}: ${'ok '.repeat(20)}`).join('\n')
      const truncated = reduceOutput(`${longLog}\n${block}\n${ordinary}\n${longLog}`, limit, omitted)
      expect(truncated).toContain(block)
      expect(truncated.length).toBeLessThan(ordinary.length)
    })
  }

  test('truncation needs at least two thirds recognised log/progress lines', async () => {
    const prose = Array.from({ length: 1500 }, (_, i) => `Record ${i} contains distinct data and is not a log.`).join('\n')
    const mixed = `${longLog}\n${prose}`
    expect(reduceOutput(prose, limit, omitted) === prose).toBe(true)
    expect(reduceOutput(mixed, limit, omitted) === mixed).toBe(true)
    expect(reduceOutput(`${longLog}\n${longLog}\n${prose}`, limit, omitted)).toContain('lines omitted]')
  })

  test('head and tail survive with every diagnostic, even when diagnostics alone exceed the target', async () => {
    const diagnostics = ['ERROR middle', 'Warning: important', 'FAIL result', 'Exception thrown', 'Traceback (most recent call last)']
    const original = `FIRST\n${longLog}\n${diagnostics.join('\n')}\n${longLog}\nLAST`
    const reduced = reduceOutput(original, limit, omitted)
    expect(reduced.startsWith('FIRST')).toBe(true)
    expect(reduced.endsWith('LAST')).toBe(true)
    expect(reduced).toContain('lines omitted]')
    for (const line of diagnostics) expect(reduced).toContain(line)
    const errors = Array.from({ length: 600 }, (_, i) => `ERROR ${i}: ${'x'.repeat(60)}`).join('\n')
    const all = reduceOutput(`FIRST\n${longLog}\n${errors}\n${longLog}\nLAST`, limit, omitted)
    expect(all.startsWith('FIRST')).toBe(true)
    expect(all.endsWith('LAST')).toBe(true)
    for (const line of errors.split('\n')) expect(all).toContain(line)
  })

  test('a single oversized log line keeps both ends; unclassified text is left alone', async () => {
    const original = `FIRST${'x'.repeat(80_000)}LAST`
    expect(reduceOutput(original, limit, omitted) === original).toBe(true)
    const reduced = reduceOutput(`INFO ${original}`, limit, omitted)
    expect(reduced.startsWith('INFO FIRST')).toBe(true)
    expect(reduced.endsWith('LAST')).toBe(true)
    expect(reduced).toContain('0 lines omitted')
  })

  for (const options of [{}, { shrinkToolOutput: 0 }, { shrinkToolOutput: 1 }, { shrinkToolOutput: 19_999 }]) {
    test(`does nothing when ${JSON.stringify(options)}`, { options }, async ($, on) => {
      const seen = outputWorld($, on)
      expect(textOf(await append($, longLog))).toBe(longLog)
      expect(Object.keys(seen.files)).toHaveLength(0)
      expect(await statsOf($)).toContain('Tool outputs reduced: 0; characters removed: 0')
    })
  }

  for (const tool of ['Bash', 'mcp__logs__query']) {
    test(`${tool}: timestamp repeats and progress-bar redraws shrink with diagnostics intact`, { options: { shrinkToolOutput: limit } }, async ($, on) => {
      const seen = outputWorld($, on)
      const repeats = Array.from({ length: 1000 }, (_, i) => `2026-10-30T12:00:00.${String(i).padStart(3, '0')}Z INFO waiting for worker`).join('\n')
      const redraws = Array.from({ length: 1000 }, (_, i) => `Downloading [${'#'.repeat(i % 10 + 1)}${'-'.repeat(10 - i % 10)}] ${i % 101}%`).join('\r')
      const original = `${repeats}\nERROR important\n${redraws}\nwarning same\nwarning same`
      const reduced = textOf(await append($, original, tool))
      expect(reduced.length < original.length / 2).toBe(true)
      expect(reduced).toContain('[×1000]')
      expect(reduced).toContain(redraws.split('\r').pop()!)
      expect(reduced).toContain('ERROR important\n')
      expect(reduced).toContain('warning same\nwarning same')
      expect(Object.values(seen.files)).toContain(original)
    })

    for (const [kind, original] of [
      ['SQL', Array.from({ length: 1000 }, (_, i) => `INSERT INTO events (id, name) VALUES (${String(i).padStart(4, '0')}, 'synthetic-event');`).join('\n')],
      ['CSV', 'id,name,amount\n' + Array.from({ length: 1000 }, (_, i) => `${i},synthetic-record,${1000 + i}`).join('\n')],
      ['JSON array', JSON.stringify(Array.from({ length: 1000 }, (_, i) => ({ id: i, name: 'synthetic-record', amount: 1000 + i })))],
      ['file listing', Array.from({ length: 1000 }, (_, i) => `-rw-r--r-- 1 user staff 4096 Oct 30 12:00 report-${String(i).padStart(4, '0')}.txt`).join('\n')],
    ]) {
      test(`${tool}: distinct ${kind} passes through unchanged`, { options: { shrinkToolOutput: limit } }, async ($, on) => {
        const seen = outputWorld($, on)
        expect(original!.length > limit).toBe(true)
        for (const text of [original!, original!.replace(/\n/g, '\r\n')]) {
          expect(textOf(await append($, text, tool)) === text).toBe(true)
          expect(reduceOutput(text, limit, omitted) === text).toBe(true)
        }
        expect(Object.keys(seen.files)).toHaveLength(0)
        expect(await statsOf($)).toContain('Tool outputs reduced: 0; characters removed: 0')
      })
    }

    test(`${tool}: archives exact original before rewriting, preserves ids and counts characters removed`, { options: { shrinkToolOutput: limit } }, async ($, on) => {
      let stored = false
      on('session.append', { door: 'tool-result' }, async (_$: unknown, e: any, next: any) => {
        stored = true
        expect(Object.values(seen.files)).toContain(original)
        return next(e)
      })
      const seen = outputWorld($, on)
      const original = `\x1b[32mFIRST\x1b[0m\n${longLog}\nERROR middle\n${longLog}\nLAST`
      const result = await append($, original, tool)
      const reduced = textOf(result)
      expect(stored).toBe(true)
      const path = Object.keys(seen.files).find(p => p.endsWith('/outputs/sess-1/toolu_123.txt'))!
      expect(seen.files[path]).toBe(original)
      expect(reduced).toContain('ERROR middle')
      expect(reduced).toContain(path)
      expect(reduced).toContain(fetchTool)
      expect(reduced).toContain('id "toolu_123"')
      expect(reduced).toContain('lines omitted]')
      expect(result.message.content[0].tool_use_id).toBe('toolu_123')
      expect(result.message.content[0].is_error).toBe(false)
      expect(await statsOf($)).toContain(`Tool outputs reduced: 1; characters removed: ${original.length - reduced.length}`)
      expect((await $.tool.call({ tool: fetchTool, id: 'toolu_123', startLine: 1, endLine: 1 } as never)).result).toBe('\x1b[32mFIRST\x1b[0m\n')
    })
  }

  for (const tool of ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Agent', fetchTool]) {
    test(`never rewrites ${tool}`, { options: { shrinkToolOutput: limit } }, async ($, on) => {
      const seen = outputWorld($, on)
      expect(textOf(await append($, longLog, tool))).toBe(longLog)
      expect(Object.keys(seen.files)).toHaveLength(0)
    })
  }

  for (const snippet of ['diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new', 'const value = 42;', 'def hello():\n    return 42', '```typescript\ncode\n```', '{\n  "source": true\n}', '12→export function hello() {}', '\x1b[32mconst value = 42;\x1b[0m', '-old\n+new', 'package main\nfunc main() {}', 'fn main() {}', 'value = 42', '#!/bin/sh\necho hello']) {
    test(`never rewrites code/diff: ${snippet.split('\n')[0]}`, { options: { shrinkToolOutput: limit } }, async ($, on) => {
      const seen = outputWorld($, on)
      const original = `${longLog}\n${snippet}\n${longLog}`
      expect(looksLikeCode(original)).toBe(true)
      expect(textOf(await append($, original))).toBe(original)
      expect(Object.keys(seen.files)).toHaveLength(0)
    })
  }

  test('archive failure passes the entire original through and counts nothing', { options: { shrinkToolOutput: limit } }, async ($, on) => {
    on('fs.write', { path: /\/outputs\// }, async () => { throw new Error('disk full') })
    outputWorld($, on)
    expect(textOf(await append($, longLog))).toBe(longLog)
    expect(await statsOf($)).toContain('Tool outputs reduced: 0; characters removed: 0')
  })

  for (const operation of ['get', 'set']) {
    test(`session.append keeps the reduced result when its counter store.${operation} throws`, { options: { shrinkToolOutput: limit } }, async ($, on) => {
      let failures = 0
      on(`store.${operation}` as never, { key: /^counts:/ }, async () => { failures++; return { deny: 'counters unavailable' } })
      const seen = outputWorld($, on)
      const result = await append($, longLog)
      expect(failures).toBe(1)
      expect(textOf(result).length).toBeLessThan(longLog.length)
      expect(textOf(result)).toContain('lines omitted]')
      expect(Object.values(seen.files)).toContain(longLog)
      expect(result.message.content[0].tool_use_id).toBe('toolu_123')
    })
  }

  test('off during an archive write passes the original through without counting a reduction', { options: { shrinkToolOutput: limit } }, async ($, on) => {
    on('fs.write', { path: /\/outputs\// }, async (_$: unknown, e: any, next: any) => {
      const r = await next(e)
      await $.command.run({ command: 'model-router', args: 'off' } as never)
      return r
    })
    outputWorld($, on)
    expect(textOf(await append($, longLog))).toBe(longLog)
    expect(await statsOf($)).toContain('Tool outputs reduced: 0; characters removed: 0')
  })

  test('router off leaves output alone; small text, mixed media, unknown origins and non-result doors pass through', { options: { shrinkToolOutput: limit } }, async ($, on) => {
    const seen = outputWorld($, on)
    expect(textOf(await append($, 'x'.repeat(limit)))).toBe('x'.repeat(limit))
    const media = [{ type: 'text', text: longLog }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }]
    expect(textOf(await append($, media))).toEqual(media)
    for (const [door, origin] of [['response', { kind: 'model', model: 'opus' }], ['tool-result', { kind: 'tool', tool: 'unknown' }]] as const) {
      const r = await $.session.append({ door, origin, uuid: 'other', message: { type: 'user', role: 'user', content: [{ type: 'text', text: longLog }] } } as never)
      expect(r.message!.content[0]!.text).toBe(longLog)
    }
    await $.command.run({ command: 'model-router', args: 'off' } as never)
    expect(textOf(await append($, longLog))).toBe(longLog)
    expect(Object.keys(seen.files)).toHaveLength(0)
  })

  test('text-block and subagent results reduce without changing their identity', { options: { shrinkToolOutput: limit } }, async ($, on) => {
    outputWorld($, on)
    const r = await append($, [{ type: 'text', text: longLog }], 'Bash', 'toolu_agent', 'agent-1')
    expect(r.message.content[0].tool_use_id).toBe('toolu_agent')
    expect(textOf(r)[0].text).toContain('lines omitted')
    expect((await $.tool.call({ tool: fetchTool, id: 'toolu_agent', startLine: 5, endLine: 7 } as never)).result).toBe(outputSlice(longLog, 5, 7))
  })

  test('fetch returns exact CRLF slices and literal case-insensitive matches without cleaning or collapsing them', { options: { shrinkToolOutput: limit } }, async ($, on) => {
    const seen = outputWorld($, on)
    const original = `\x1b[31mfirst\x1b[0m\r\nprogress 1\rprogress 2\r\nERROR [x]\r\nERROR [x]\r\nlast`
    await append($, longLog)
    const path = Object.keys(seen.files)[0]!
    seen.files[path] = original
    const fetch = async (input: Record<string, unknown>) => (await $.tool.call({ tool: fetchTool, id: 'toolu_123', ...input } as never)).result
    expect(await fetch({})).toBe(original)
    expect(await fetch({ startLine: 2, endLine: 4 })).toBe('progress 1\rprogress 2\r\nERROR [x]\r\nERROR [x]\r\n')
    expect(await fetch({ pattern: 'error [X]' })).toBe('ERROR [x]\r\nERROR [x]\r\n')
    expect(await fetch({ startLine: 4, pattern: 'error' })).toBe('ERROR [x]\r\n')
    expect(await fetch({ pattern: 'missing' })).toBe('')
  })

  test('fetch pages an enormous line exactly, with every response including instructions within the cap', { options: { shrinkToolOutput: limit } }, async ($, on) => {
    const seen = outputWorld($, on)
    await append($, longLog)
    const original = `FIRST${'0123456789'.repeat(7000)}LAST`
    seen.files[Object.keys(seen.files)[0]!] = original
    let offset = 0
    let combined = ''
    for (let i = 0; i < 10; i++) {
      const r = await $.tool.call({ tool: fetchTool, id: 'toolu_123', offset } as never)
      const text = r.result as string
      expect(text.length).toBeLessThanOrEqual(limit)
      const marker = /\n\[Output capped; fetch the same selection with offset (\d+) to continue\.\]$/.exec(text)
      combined += marker ? text.slice(0, marker.index) : text
      if (!marker) break
      offset = Number(marker[1])
    }
    expect(combined).toBe(original)
  })

  test('fetch rejects path traversal, invalid ranges and missing archives', { options: { shrinkToolOutput: limit } }, async ($, on) => {
    const seen = outputWorld($, on)
    for (const input of [{ id: '../secret' }, { id: 'sess-2/toolu_123' }, { id: 'x', startLine: 0 }, { id: 'x', startLine: 3, endLine: 2 }, { id: 'x', offset: -1 }, { id: 'x', pattern: 123 }]) {
      expect((await $.tool.call({ tool: fetchTool, ...input } as never)).result).toBe('Invalid archive id, line range, pattern or offset.')
    }
    expect((await $.tool.call({ tool: fetchTool, id: 'missing' } as never)).result).toBe('Archived output could not be read.')
    expect(outputPath('/logs', '../session', 'x')).toBe(undefined)
    expect(Object.keys(seen.files)).toHaveLength(0)
  })

  for (const shrink of [0, limit]) {
    test(`startup registers fetch_output only when enabled (${shrink}), with its documented model name`, { options: { shrinkToolOutput: shrink } }, async ($, on) => {
      const seen = outputWorld($, on)
      const tools: any[] = []
      on('command.register', async (_$: unknown, e: any) => ({ value: { command: e.name } }))
      on('tool.register', async (_$: unknown, e: any) => { tools.push(e); return { value: { tool: `mcp__model-router__${e.name}` } } })
      on('session.start', async (_$: unknown, e: any) => ({ cwd: e.cwd }))
      on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 1e6 }, rateLimits: [] } }))
      on('session.model', async () => ({ value: 'opus' }))
      await $.session.start({ cwd: '/plugin', surface: 'terminal', isInteractive: true })
      expect(tools.map(t => t.name)).toEqual(shrink ? ['escalate', 'fetch_output'] : ['escalate'])
      if (shrink) {
        expect(tools[1].inputSchema.required).toEqual(['id'])
        expect(tools[1].inputSchema.properties.startLine.minimum).toBe(1)
      }
      const status = await $.command.run({ command: 'model-router', args: 'status' } as never)
      expect(status.text).toContain(`shrinkToolOutput: ${shrink}`)
      expect(status.text).toContain('checkpointHints: false')
      expect(seen.asked).toHaveLength(0)
    })
  }
})

describe('append-only event logs', () => {
  const event = (reason: string, at = '1970-01-01T00:00:00Z') => ({ at, agentId: 'main', event: 'turn route', to: 'haiku/medium', reason })
  const ioOf = (seen: Seen, root = '/plugin') => ({
    root,
    now: () => 0,
    read: async (path: string) => {
      if (seen.files[path] === undefined) throw new Error(`no file ${path}`)
      return seen.files[path]!
    },
    write: async (path: string, text: string) => { seen.files[path] = text },
    list: async (path: string) => {
      const entries = new Map<string, FsEntry['kind']>()
      for (const file of Object.keys(seen.files)) {
        if (!file.startsWith(`${path}/`)) continue
        const tail = file.slice(path.length + 1)
        entries.set(tail.split('/')[0]!, tail.includes('/') ? 'dir' : 'file')
      }
      return [...entries].map(([name, kind]): FsEntry => ({ name, kind, size: 0, mtimeMs: 0, isLink: false }))
    },
    stat: async (_path: string): Promise<FsStat> => ({ kind: 'dir', size: 0, mtimeMs: 0, isLink: false }),
    run: async (_argv: string[]) => ({ exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }),
    log: (_text: string) => {},
  })

  test('100 events and 101 queued flushes make at most 100 failed writes before backoff, then recover without loss', async ($, on) => {
    const seen = world($, on, null)
    const io = ioOf(seen)
    let now = 0
    let failing = true
    let attempts = 0
    let failures = 0
    const write = io.write
    io.now = () => now
    io.write = async (path, text) => {
      attempts++
      if (failing) throw new Error('disk unavailable')
      await write(path, text)
    }
    io.log = () => { failures++ }
    const writer = new EventLogs()
    const flushes: Promise<void>[] = []
    for (let i = 0; i < 100; i++) {
      writer.event('sess-1', event(`event ${i}`))
      flushes.push(writer.flush(io))
    }
    flushes.push(writer.flush(io))
    await Promise.all(flushes)
    expect(attempts).toBeLessThanOrEqual(100)
    expect(attempts).toBe(100) // Each new batch still gets its first attempt.
    for (let i = 0; i < 100; i++) await writer.flush(io)
    expect(attempts).toBe(100)
    expect(failures).toBe(1)
    const pending = await writer.read(io, 'sess-1')
    expect(pending.events).toHaveLength(100)
    failing = false
    now = 1000
    await writer.flush(io)
    expect(attempts).toBe(200)
    expect(failures).toBe(1)
    expect((writer as any).pending.size).toBe(0)
    expect((writer as any).retries.size).toBe(0)
    expect(await new EventLogs().read(io, 'sess-1')).toEqual(pending)
  })

  test('flush requests share one queued pass while a write is held, and pick up later events', async ($, on) => {
    const seen = world($, on, null)
    const io = ioOf(seen)
    const write = io.write
    let release!: () => void
    let started!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const entered = new Promise<void>(resolve => { started = resolve })
    let active = 0
    let maximum = 0
    let attempts = 0
    io.write = async (path, text) => {
      attempts++
      maximum = Math.max(maximum, ++active)
      started()
      await held
      await write(path, text)
      active--
    }
    const writer = new EventLogs()
    writer.event('sess-1', event('first'))
    const first = writer.flush(io)
    await entered
    writer.event('sess-1', event('while writing'))
    const queued = writer.flush(io)
    let shared = true
    for (let i = 0; i < 100; i++) shared &&= writer.flush(io) === queued
    release()
    await Promise.all([first, queued])
    expect(shared).toBe(true)
    expect(maximum).toBe(1)
    expect(attempts).toBe(2)
    expect((await new EventLogs().read(io, 'sess-1')).events.map(e => e.reason)).toEqual(['first', 'while writing'])
    writer.event('sess-1', event('after draining'))
    await writer.flush(io)
    expect((writer as any).pending.size).toBe(0)
  })

  test('failed batches double their retry delay to five minutes without delaying a new session', async ($, on) => {
    const seen = world($, on, null)
    const io = ioOf(seen)
    let now = 0
    let attempts = 0
    let failures = 0
    const write = io.write
    io.now = () => now
    io.write = async (path, text) => {
      attempts++
      if (path.includes('/failed/')) throw new Error('disk unavailable')
      await write(path, text)
    }
    io.log = () => { failures++; throw new Error('logging unavailable too') }
    const writer = new EventLogs()
    writer.event('failed', event('retry later'))
    await writer.flush(io)
    expect(attempts).toBe(1)
    writer.event('new-session', event('first attempt'))
    writer.usage('new-session', 'agent-1', 'haiku', 'medium', U(100, 50))
    await writer.flush(io)
    expect(attempts).toBe(3)
    expect((await new EventLogs().read(io, 'new-session')).stats['agent-1']).toEqual(addUsage(undefined, 'haiku', 'medium', U(100, 50)))
    for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000, 300000]) {
      const before = attempts
      now += delay - 1
      await Promise.all(Array.from({ length: 20 }, () => writer.flush(io)))
      expect(attempts).toBe(before)
      now++
      await Promise.all(Array.from({ length: 20 }, () => writer.flush(io)))
      expect(attempts).toBe(before + 1)
    }
    expect(failures).toBe(12)
    expect((writer as any).pending.size).toBe(1)
  })

  test('two writers recording the same session concurrently keep every event and usage delta', async ($, on) => {
    let entered = 0
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const seen = world($, on, null)
    const io = ioOf(seen)
    const write = io.write
    io.write = async (path, text) => {
      if (++entered === 2) release()
      await held
      expect(seen.files[path]).toBeUndefined()
      return write(path, text)
    }
    const a = new EventLogs()
    const b = new EventLogs()
    a.event('sess-1', event('A', '1970-01-01T00:00:02Z'))
    b.event('sess-1', event('B', '1970-01-01T00:00:01Z'))
    a.usage('sess-1', 'agent-1', 'haiku', 'medium', U(100, 50))
    b.usage('sess-1', 'agent-1', 'haiku', 'medium', U(200, 60))
    await Promise.all([a.flush(io), b.flush(io)])
    const reader = new EventLogs()
    const log = await reader.read(io, 'sess-1')
    expect(log.events.map(e => e.reason)).toEqual(['B', 'A'])
    expect(new Set(log.events.map(e => e.id)).size).toBe(2)
    expect(log.stats['agent-1']).toEqual(addUsage(addUsage(undefined, 'haiku', 'medium', U(100, 50)), 'haiku', 'medium', U(200, 60)))
    expect(Object.keys(seen.files)).toHaveLength(4)
    expect(await reader.read(io, 'sess-1')).toEqual(log)
  })

  for (const acknowledged of [false, true]) {
    test(`a failed ${acknowledged ? 'acknowledgement' : 'write'} retries the same batches and never counts events or stats twice`, async ($, on) => {
      let failing = true
      const attempts: { path: string; text: string }[] = []
      const seen = world($, on, null)
      const io = ioOf(seen)
      const write = io.write
      io.write = async (path, text) => {
        attempts.push({ path, text })
        if (acknowledged) await write(path, text)
        if (failing) throw new Error('disk unavailable')
        if (!acknowledged) await write(path, text)
      }
      const writer = new EventLogs()
      writer.event('sess-1', event('retry'))
      writer.usage('sess-1', 'agent-1', 'haiku', 'medium', U(100, 50))
      await writer.flush(io)
      const before = await writer.read(io, 'sess-1')
      expect(before.events).toHaveLength(1)
      expect(before.stats['agent-1']!.byEffort).toEqual({ medium: 1 })
      failing = false
      io.now = () => 1000
      await writer.flush(io)
      expect(attempts.slice(2).map(a => a.text)).toEqual(attempts.slice(0, 2).map(a => a.text))
      expect(new Set(attempts.map(a => a.path)).size).toBe(4)
      const reader = new EventLogs()
      expect(await reader.read(io, 'sess-1')).toEqual(before)
      expect(await writer.read(io, 'sess-1')).toEqual(before)
    })
  }

  test('legacy events and stats join new batches without rewriting the legacy file', async ($, on) => {
    const seen = world($, on, null)
    const io = ioOf(seen)
    const path = `${logDir('/plugin')}/events-sess-1.json`
    const legacy = JSON.stringify({ sessionId: 'sess-1', events: [event('legacy', '1969-12-31T00:00:00Z')], stats: { old: addUsage(undefined, 'haiku', 'medium', U(100, 50)) } })
    seen.files[path] = legacy
    const writer = new EventLogs()
    writer.event('sess-1', event('new'))
    writer.usage('sess-1', 'old', 'haiku', 'high', U(200, 60))
    await writer.flush(io)
    const log = await writer.read(io, 'sess-1')
    expect(log.events.map(e => e.reason)).toEqual(['legacy', 'new'])
    expect(log.stats.old).toEqual(addUsage(addUsage(undefined, 'haiku', 'medium', U(100, 50)), 'haiku', 'high', U(200, 60)))
    expect(seen.files[path]).toBe(legacy)
  })

  test('a same-id resume rereads the batches another process wrote while this one was away', async ($, on) => {
    let externalRead = false
    let externalPath = ''
    on('fs.read', {}, async (_$: unknown, e: any, next: any) => {
      if (e.path === externalPath) externalRead = true
      return next(e)
    })
    const seen = world($, on, null)
    await $.prompt.submit({ text: 'first #haiku' } as never)
    await $.session.end({ reason: 'resume', sessionId: 'sess-1', resume: { id: 'sess-2' } } as never)
    seen.sessionId = 'sess-2'
    await statsOf($)
    const io = ioOf(seen, Object.keys(seen.files)[0]!.split('/model-router/')[0])
    const other = new EventLogs()
    other.event('sess-1', event('other process'))
    await other.flush(io)
    externalPath = Object.keys(seen.files).find(path => JSON.parse(seen.files[path]!).events.some((e: any) => e.reason === 'other process'))!
    await $.session.end({ reason: 'resume', sessionId: 'sess-2', resume: { id: 'sess-1' } } as never)
    seen.sessionId = 'sess-1'
    await statsOf($)
    expect(externalRead).toBe(true)
    await $.prompt.submit({ text: 'continued #sonnet' } as never)
    expect((await other.read(io, 'sess-1')).events).toHaveLength(3)
    expect(seen.files[externalPath]).toBeDefined()
  })

  test('completed sessions leave no events or stats in memory; only failed batches remain', async ($, on) => {
    const seen = world($, on, null)
    const io = ioOf(seen)
    const writer = new EventLogs()
    for (let i = 0; i < 40; i++) {
      writer.event(`sess-${i}`, event(`work ${i}`))
      writer.usage(`sess-${i}`, 'agent-1', 'haiku', 'medium', U(100, 50))
      await writer.flush(io)
      await writer.read(io, `sess-${i}`)
    }
    expect((writer as any).pending.size).toBe(0)
    expect(Object.keys(seen.files)).toHaveLength(80)
    const broken = { ...io, write: async () => { throw new Error('disk full') } }
    writer.event('unsaved', event('keep me'))
    await writer.flush(broken)
    expect((writer as any).pending.size).toBe(1)
    io.now = () => 1000
    await writer.flush(io)
    expect((writer as any).pending.size).toBe(0)
  })

  test('retention uses file timestamps in their names, even with fresh directory stats or misleading mtimes', async ($, on) => {
    const seen = world($, on, null)
    const io = ioOf(seen)
    const root = logDir('/plugin')
    const writer = new EventLogs()
    const now = 31 * 24 * 3600_000
    for (const id of ['old', 'recent', 'edge']) {
      io.now = () => id === 'recent' ? now : id === 'edge' ? 24 * 3600_000 : 0
      writer.event(id, event(id))
      await writer.flush(io)
    }
    seen.files[`${root}/events-legacy.json`] = '{}'
    seen.files[`${root}/old/untimestamped.json`] = '{}'
    seen.files[`${root}/outputs/old/tool.txt`] = 'original output'
    const removed: string[][] = []
    await writer.prune({ ...io,
      stat: async (): Promise<FsStat> => ({ kind: 'dir', size: 0, mtimeMs: now, isLink: false }),
      list: async path => (await io.list(path)).map(file => ({ ...file, mtimeMs: path.endsWith('/old') ? now : 0 })),
      run: async argv => { removed.push(argv); return { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } },
    }, now, 30)
    const path = Object.keys(seen.files).find(path => path.startsWith(`${root}/old/`) && !path.endsWith('untimestamped.json'))!
    expect(removed.filter(argv => argv[0] === 'rm')).toEqual([['rm', '-f', '--', path]])
    expect(removed.every(argv => argv[0] === 'rm' || argv[0] === 'rmdir')).toBe(true)
  })

  test('retention never deletes a pending batch id, but can expire another batch in the same session', async ($, on) => {
    const seen = world($, on, null)
    const io = ioOf(seen)
    const writer = new EventLogs()
    writer.event('old', event('expired'))
    await writer.flush(io)
    const expired = Object.keys(seen.files)[0]!
    writer.event('old', event('pending'))
    await writer.flush({ ...io, write: async (path, text) => { await io.write(path, text); throw new Error('ack lost') } })
    const removed: string[] = []
    await writer.prune({ ...io, run: async argv => {
      if (argv[0] === 'rm') {
        removed.push(...argv.slice(3))
        for (const path of argv.slice(3)) delete seen.files[path]
      }
      return { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    } }, 31 * 24 * 3600_000, 30)
    expect(removed).toEqual([expired])
    expect((writer as any).pending.size).toBe(1)
    expect((await new EventLogs().read(io, 'old')).events.map(e => e.reason)).toEqual(['pending'])
  })

  test('retention preserves batches written after its file listing', async ($, on) => {
    const seen = world($, on, null)
    const io = ioOf(seen)
    const writer = new EventLogs()
    const other = new EventLogs()
    writer.event('old', event('expired'))
    await writer.flush(io)
    const expired = Object.keys(seen.files)[0]!
    const dir = expired.slice(0, expired.lastIndexOf('/'))
    const now = 31 * 24 * 3600_000
    io.now = () => now
    await writer.prune({ ...io,
      list: async path => {
        const files = await io.list(path)
        if (path === dir) {
          other.event('old', event('during list'))
          await other.flush(io)
        }
        return files
      },
      run: async argv => {
        if (argv[0] === 'rm') {
          other.event('old', event('after list'))
          await other.flush(io)
          for (const path of argv.slice(3)) delete seen.files[path]
        }
        // rmdir refuses a directory which now contains either of the fresh batches.
        return { exitCode: argv[0] === 'rmdir' ? 1 : 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
      },
    }, now, 30)
    expect(seen.files[expired]).toBeUndefined()
    expect(Object.keys(seen.files).every(path => path.startsWith(`${dir}/`))).toBe(true)
    expect((await other.read(io, 'old')).events.map(e => e.reason).sort()).toEqual(['after list', 'during list'])
    expect((other as any).pending.size).toBe(0)
  })

  for (const stillExpired of [false, true]) {
    test(`a retry after an expired listing survives deletion of that stale listing (${stillExpired ? 'still-expired' : 'fresh'} clock)`, async ($, on) => {
      const seen = world($, on, null)
      const io = ioOf(seen)
      const owner = new EventLogs()
      owner.event('old', event('retried event'))
      owner.usage('old', 'agent-1', 'haiku', 'medium', U(100, 50))
      await owner.flush({ ...io, write: async (path, text) => { await io.write(path, text); throw new Error('ack lost') } })
      const expired = Object.keys(seen.files)
      const now = 31 * 24 * 3600_000
      io.now = () => stillExpired ? 1000 : now
      await new EventLogs().prune({ ...io,
        list: async path => {
          const files = await io.list(path)
          if (path.endsWith('/old')) await owner.flush(io)
          return files
        },
        run: async argv => {
          if (argv[0] === 'rm') for (const path of argv.slice(3)) delete seen.files[path]
          return { exitCode: argv[0] === 'rmdir' ? 1 : 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
        },
      }, now, 30)
      expect(expired.every(path => seen.files[path] === undefined)).toBe(true)
      expect((owner as any).pending.size).toBe(0)
      const log = await new EventLogs().read(io, 'old')
      expect(log.events.map(e => e.reason)).toEqual(['retried event'])
      expect(log.stats['agent-1']).toEqual(addUsage(undefined, 'haiku', 'medium', U(100, 50)))
    })
  }

  test('malformed, truncated and incomplete batches cannot hide valid batches, pending work or legacy data', async ($, on) => {
    const seen = world($, on, null)
    const io = ioOf(seen)
    const writer = new EventLogs()
    writer.event('sess-1', event('valid'))
    writer.usage('sess-1', 'agent-1', 'haiku', 'medium', U(100, 50))
    await writer.flush(io)
    const path = Object.keys(seen.files)[0]!
    const batch = JSON.parse(seen.files[path]!)
    const dir = path.slice(0, path.lastIndexOf('/'))
    seen.files[`${dir}/malformed.json`] = '{invalid'
    seen.files[`${dir}/truncated.json`] = seen.files[path]!.slice(0, -5)
    // A parseable prefix is still incomplete without the final end marker.
    delete batch.end
    seen.files[path] = JSON.stringify(batch)
    writer.event('sess-1', event('pending'))
    seen.files[`${logDir('/plugin')}/events-sess-1.json`] = JSON.stringify({ sessionId: 'sess-1', events: [event('legacy')], stats: {} })
    const log = await writer.read(io, 'sess-1')
    expect(log.events.map(e => e.reason)).toEqual(['legacy', 'pending'])
    expect(log.stats['agent-1']).toEqual(addUsage(undefined, 'haiku', 'medium', U(100, 50)))
    expect(writer.diagnostics.skippedBatches).toBe(3)
    // A new process sees the same corrupt files and still loads the usable history.
    const reader = new EventLogs()
    expect((await reader.read(io, 'sess-1')).events.map(e => e.reason)).toEqual(['legacy'])
    expect(reader.diagnostics.skippedBatches).toBe(3)
  })

  test('an interrupted attempt is skipped while pending data survives and its retry publishes a complete fresh attempt', async ($, on) => {
    const seen = world($, on, null)
    const io = ioOf(seen)
    const writer = new EventLogs()
    writer.event('sess-1', event('survives'))
    await writer.flush({ ...io, write: async (path, text) => {
      seen.files[path] = text.slice(0, -5)
      throw new Error('interrupted write')
    } })
    const broken = Object.keys(seen.files)[0]!
    expect((await writer.read(io, 'sess-1')).events.map(e => e.reason)).toEqual(['survives'])
    expect((await new EventLogs().read(io, 'sess-1')).events).toEqual([])
    io.now = () => 1000
    await writer.flush(io)
    expect(Object.keys(seen.files)).toHaveLength(2)
    expect(seen.files[broken]!.endsWith('}')).toBe(false)
    const reader = new EventLogs()
    expect((await reader.read(io, 'sess-1')).events.map(e => e.reason)).toEqual(['survives'])
    expect(reader.diagnostics.skippedBatches).toBe(1)
  })

  for (const source of ['legacy', 'batch']) {
    for (const text of ['{"sessionId":', 'null', '{}',
      JSON.stringify({ sessionId: 'sess-1', events: [null], stats: {} }),
      JSON.stringify({ sessionId: 'sess-1', events: [], stats: { main: null } }),
      JSON.stringify({ sessionId: 'sess-1', events: [], stats: { main: { byEffort: {}, byModel: { haiku: { steps: 'bad' } } } } }),
    ]) {
      test(`${source} source ${text} is skipped and counted without hiding usable data`, async ($, on) => {
        const seen = world($, on, null)
        const io = ioOf(seen)
        const writer = new EventLogs()
        writer.event('sess-1', event('saved'))
        writer.usage('sess-1', 'agent-1', 'haiku', 'medium', U(100, 50))
        await writer.flush(io)
        const path = source === 'legacy' ? `${logDir('/plugin')}/events-sess-1.json` : `${logDir('/plugin')}/sess-1/broken.json`
        seen.files[path] = text
        writer.event('sess-1', event('pending'))
        writer.usage('sess-1', 'agent-1', 'haiku', 'high', U(200, 60))
        const log = await writer.read(io, 'sess-1')
        expect(log.events.map(e => e.reason)).toEqual(['saved', 'pending'])
        expect(log.stats['agent-1']).toEqual(addUsage(addUsage(undefined, 'haiku', 'medium', U(100, 50)), 'haiku', 'high', U(200, 60)))
        expect(writer.diagnostics.skippedBatches).toBe(1)
        const reader = new EventLogs()
        expect((await reader.read(io, 'sess-1')).events.map(e => e.reason)).toEqual(['saved'])
        expect(reader.diagnostics.skippedBatches).toBe(1)
        expect(seen.files[path]).toBe(text)
      })
    }
  }

  for (const text of ['{truncated', JSON.stringify({ sessionId: 'sess-1', events: [null], stats: {} })]) {
    test(`a malformed legacy source ${text} does not leave session initialization retrying`, async ($, on) => {
      let reads = 0
      on('fs.read', { path: /events-sess-1\.json$/ }, async () => { reads++; return { value: text } })
      const seen = world($, on, null)
      await $.prompt.submit({ text: 'first #haiku' } as never)
      await step($, 't1')
      await statsOf($)
      await $.prompt.submit({ text: 'again #haiku' } as never)
      expect(reads).toBe(1)
      expect(seen.steps[0]).toMatchObject({ model: 'claude-haiku-5-5[1m]', effort: 'medium' })
      expect(seen.submits).toHaveLength(2)
    })
  }

  test('a malformed batch does not leave session initialization retrying on every request', async ($, on) => {
    let reads = 0
    on('fs.read', { path: /broken\.json$/ }, async () => { reads++; return { value: '{truncated' } })
    on('fs.list', { path: /\/model-router\/sess-1$/ }, async (_$: unknown, e: any, next: any) => {
      seen.files[`${e.path}/broken.json`] = '{truncated'
      return next(e)
    })
    const seen = world($, on, null)
    await $.prompt.submit({ text: 'first #haiku' } as never)
    await step($, 't1')
    await statsOf($)
    await $.prompt.submit({ text: 'again #haiku' } as never)
    expect(reads).toBe(1)
    expect(seen.steps[0]).toMatchObject({ model: 'claude-haiku-5-5[1m]', effort: 'medium' })
    expect(seen.submits).toHaveLength(2)
  })

  test('parseable malformed batch shapes are isolated before merging', async ($, on) => {
    const seen = world($, on, null)
    const io = ioOf(seen)
    const dir = `${logDir('/plugin')}/sess-1`
    for (const [i, batch] of [null, {}, { sessionId: 'sess-1', events: [null], stats: {} },
      { sessionId: 'sess-1', events: [], stats: { main: null } }].entries()) {
      seen.files[`${dir}/bad-${i}.json`] = JSON.stringify(batch)
    }
    const reader = new EventLogs()
    expect(await reader.read(io, 'sess-1')).toEqual({ sessionId: 'sess-1', events: [], stats: {} })
    expect(reader.diagnostics.skippedBatches).toBe(4)
  })

  test('valid batch and event ids both dedupe, and old batches still load', async ($, on) => {
    const seen = world($, on, null)
    const io = ioOf(seen)
    const writer = new EventLogs()
    writer.event('sess-1', event('once'))
    await writer.flush(io)
    const path = Object.keys(seen.files)[0]!
    const batch = JSON.parse(seen.files[path]!)
    seen.files[`${path.slice(0, path.lastIndexOf('/'))}/copy.json`] = seen.files[path]!
    // Pre-marker batches have their original batch id as the filename.
    delete batch.end
    seen.files[`${path.slice(0, path.lastIndexOf('/'))}/${batch.id}-other.json`] = JSON.stringify({
      ...batch, id: `${batch.id}-other`, events: [...batch.events, { ...event('old batch'), id: 'old-event' }],
      stats: { old: addUsage(undefined, 'haiku', 'medium', U(100, 50)) },
    })
    const log = await new EventLogs().read(io, 'sess-1')
    expect(log.events.map(e => e.reason)).toEqual(['once', 'old batch'])
    expect(log.stats.old).toEqual(addUsage(undefined, 'haiku', 'medium', U(100, 50)))
  })

})
