import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ModelKey, Route } from '../types'
import { isPersonOrigin } from './origin'
import { redact } from './redact'
import type { Lang } from './route'
import {
  applyEscalation,
  assignmentContext,
  classifierSystem,
  EFFORTS,
  forcedModel,
  isFable,
  MODELS,
  parseDecision,
  reviewSystem,
  routeFor,
  TIER_ROUTE,
  withSuffixOf,
} from './route'

const TOOL = 'escalate'
const CLASSIFY_MS = 4000
const PROBE_EVERY_MS = 24 * 3600 * 1000

const route = atom({ plugin: 'model-router', key: 'route' } as const, null)
const enabled = atom({ plugin: 'model-router', key: 'enabled' } as const, true)

// The route chosen for a submitted prompt, waiting for its turn to start.
let pending: Route | null = null
// The person's prompt for the running turn, kept for the decision review.
let pendingPrompt = ''

const STR = {
  zh: { fallback: '分类失败，默认 Sonnet', forced: '你在消息里指定了模型', off: 'Model router 已关闭', review: 'Fable 5.5 审查' },
  en: { fallback: 'classifier failed, defaulted to Sonnet', forced: 'model pinned in your message', off: 'Model router is off', review: 'Fable 5.5 review' },
} as const

const LABEL: Record<ModelKey, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' }

async function setEnabled($: EngineInterface, isOn: boolean) {
  await update($, enabled, () => isOn)
  await $.store.set('enabled', isOn)
}

async function recentContext($: EngineInterface): Promise<string> {
  const rows = (await $.session.messages()).filter(m => m.text.trim() !== '').slice(-2)
  return rows.map(m => `[${m.role}] ${m.text.length > 1200 ? `${m.text.slice(0, 200)}\n…\n${m.text.slice(-1000)}` : m.text}`).join('\n\n')
}

async function classify($: EngineInterface, lang: Lang, text: string, previous: Route | null): Promise<Route> {
  const forced = forcedModel(text)
  if (forced) {
    const tier = forced === 'haiku' ? 'lookup' : forced === 'sonnet' ? 'execute' : 'decide'
    return routeFor(tier, STR[lang].forced)
  }
  try {
    const context = await recentContext($)
    const r = await $.model.complete({
      model: 'haiku',
      system: classifierSystem(lang),
      prompt:
        `<previous_tier>${previous?.tier ?? 'none'}</previous_tier>\n` +
        `<context>\n${context || '(new session)'}\n</context>\n\n<message>\n${text.slice(0, 6000)}\n</message>`,
      maxTokens: 120,
      effort: 'low',
      timeoutMs: CLASSIFY_MS,
    })
    const d = r.isAnswered ? parseDecision(r.text) : null
    return d ? routeFor(d.tier, d.reason) : routeFor('execute', STR[lang].fallback)
  } catch {
    return routeFor('execute', STR[lang].fallback)
  }
}

// Whether the reviewer model exists on this account; asked at most once a day.
async function reviewerAvailable($: EngineInterface, reviewModel: string): Promise<boolean> {
  if (isFable(reviewModel) && /fable-5-1\b/i.test(reviewModel)) return false
  const now = await $.clock.now()
  const seen = (await $.store.get('reviewer')) as { model: string; ok: boolean; at: number } | undefined
  if (seen && seen.model === reviewModel && now - seen.at < PROBE_EVERY_MS) return seen.ok
  let ok = false
  try {
    const r = await $.model.complete({ model: reviewModel, prompt: 'Reply with OK.', maxTokens: 5, timeoutMs: 15000 })
    ok = r.isAnswered
  } catch {
    ok = false
  }
  await $.store.set('reviewer', { model: reviewModel, ok, at: now })
  return ok
}

async function reviewDecision($: EngineInterface, lang: Lang, reviewModel: string, prompt: string, answer: string) {
  const r = await $.model.complete({
    model: reviewModel,
    system: reviewSystem(lang),
    prompt: `<request>\n${prompt.slice(0, 6000)}\n</request>\n\n<opus_decision>\n${answer.slice(-12000)}\n</opus_decision>`,
    maxTokens: 600,
    timeoutMs: 120000,
  })
  if (!r.isAnswered) return
  await $.session.append({ message: { type: 'system', content: [{ type: 'text', text: `${STR[lang].review}：\n${r.text.trim()}` }] } })
}

// Runs after the turn, unawaited: an Opus decision goes to the reviewer only when that model exists.
async function maybeReview($: EngineInterface, lang: Lang, reviewModel: string, prompt: string, answer: string) {
  try {
    if (await reviewerAvailable($, reviewModel)) await reviewDecision($, lang, reviewModel, prompt, answer)
  } catch (err) {
    $.ui.log(`model-router: review failed: ${String(err)}`)
  }
}

export const register: Register = (on, options) => {
  const lang: Lang = options.language === 'en' ? 'en' : 'zh'
  const ids: Record<ModelKey, string> = {
    haiku: String(options.haikuModel ?? 'claude-haiku-5-5'),
    sonnet: String(options.sonnetModel ?? 'claude-sonnet-5-5'),
    opus: String(options.opusModel ?? 'claude-opus-5-5'),
  }
  const reviewModel = String(options.reviewModel ?? 'claude-fable-5-5')
  const str = STR[lang]

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'model-router', description: 'Model router: "on" or "off"', argumentHint: '[on|off]' })
    await $.tool.register({
      name: TOOL,
      isDeferred: false,
      description:
        'Raise the model or effort for the rest of the current turn, before you start the work. ' +
        'Call it first when the task is beyond the model you were assigned (decisions must be made on opus) or needs more effort. ' +
        'Only goes up; opus may set any effort. The change applies from your next step.',
      inputSchema: {
        type: 'object',
        properties: {
          model: { type: 'string', enum: MODELS, description: 'Model to move up to; omit to change only the effort' },
          effort: { type: 'string', enum: EFFORTS, description: 'Effort for the rest of the turn' },
          reason: { type: 'string', description: 'One short line: why the assignment does not fit' },
        },
        required: ['reason'],
      },
    })
    const stored = await $.store.get('enabled')
    await update($, enabled, () => stored !== false)
    return next(e)
  })

  on('command.run', { command: 'model-router' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg !== 'on' && arg !== 'off') return { text: 'Usage: /model-router on | off' }
    await setEnabled($, arg === 'on')
    return { text: `Model router ${arg === 'on' ? 'enabled' : 'disabled'}.` }
  })

  on('prompt.submit', async ($, e, next) => {
    const origin = e.origin as typeof e.origin | undefined
    // A prompt typed into a running turn joins that turn's route.
    if (!(await read($, enabled)) || !isPersonOrigin(origin) || e.turnId !== undefined || e.text.trim() === '') {
      return next(e)
    }
    const r = await classify($, lang, redact(e.text), await read($, route))
    // Set before next: next resolves only after the turn has started, and turn.start binds this route.
    pending = r
    pendingPrompt = e.text
    const entered = await next({ ...e, context: [...(e.context ?? []), assignmentContext(r)] })
    if (entered.drop !== undefined) {
      // Held back (prompt-coach): no turn starts, so the route must not bind to the next one.
      pending = null
      pendingPrompt = ''
    }
    return entered
  })

  on('turn.start', async ($, e, next) => {
    if (pending) {
      const r = { ...pending, turnId: e.turnId }
      pending = null
      await update($, route, () => r)
    }
    return next(e)
  })

  // Every model request: the turn's route on the main thread, and never Fable 5.1 anywhere.
  on('turn.step', async function* ($, e, next) {
    if (!(await read($, enabled))) return yield* next(e)
    let model = e.model
    let effort = e.effort
    const r = await read($, route)
    if (e.agentId === undefined && r && r.turnId === e.turnId) {
      model = withSuffixOf(ids[r.model], e.model)
      effort = r.effort
    }
    if (isFable(model)) model = withSuffixOf(ids.opus, e.model)
    if (model === e.model && effort === e.effort) return yield* next(e)
    return yield* next({ ...e, model, effort })
  })

  on('tool.call', { tool: 'mcp__model-router__escalate' }, async ($, e) => {
    const input = e as unknown as { agentId?: string; model?: string; effort?: string; reason?: string }
    const r = await read($, route)
    if (input.agentId !== undefined || !r || r.turnId === null) {
      return { result: 'No routed turn here: escalate only applies to the main conversation of a routed turn. Carry on.' }
    }
    const out = applyEscalation(r, input)
    if (!out.ok) return { result: `Not changed: ${out.why}. Carry on with the current route.` }
    await update($, route, () => out.route)
    return {
      result: `Route updated: from your next step this turn runs on ${out.route.model} at ${out.route.effort} effort. Now do the work.`,
    }
  })

  on('turn.complete', async ($, e, next) => {
    const r = await read($, route)
    const done = await next(e)
    if (e.agentId === undefined && !e.isAborted && r && r.turnId === e.turnId && r.model === 'opus' && (await read($, enabled))) {
      void maybeReview($, lang, reviewModel, pendingPrompt, e.answer)
    }
    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const { Box, Text, Button } = $.ui.resolve(e)

    if (!(await read($, enabled))) {
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1} alignItems="center">
            <Text dimColor>⚙ {str.off}</Text>
            <Button key="router-enable" label="Enable" onPress={() => setEnabled($, true)} />
          </Box>
          {below}
        </Box>
      )
    }

    const r = await read($, route)
    if (!r) return below
    const first = `${LABEL[TIER_ROUTE[r.tier].model]} · ${TIER_ROUTE[r.tier].effort}`
    const now = r.trail.length > 0 ? ` → ${r.trail.join(' → ')}` : ''

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} alignItems="center">
          <Box flexShrink={0}>
            <Text dimColor>⚙</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1} width={0}>
            <Text dimColor wrap="truncate-end">
              {first}
              {now}
              {r.reason ? ` — ${r.reason}` : ''}
            </Text>
          </Box>
          <Button key="router-disable" label="Disable router" onPress={() => setEnabled($, false)} />
        </Box>
        {below}
      </Box>
    )
  })
}
