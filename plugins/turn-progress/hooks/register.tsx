import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Run, TaskState } from '../types'
import { isPersonOrigin } from './origin'
import {
  blocks,
  estimateSvg,
  etaMs,
  fmtClock,
  fmtDuration,
  fmtElapsed,
  median,
  SVG_H,
  taskStats,
  taskSvg,
  timeFraction,
} from './progress'

const DURATIONS = 'durations'
const KEEP_DURATIONS = 30
const DEFAULT_TAU_MS = 60_000
// A long task label is cut here rather than squeezed by the bar.
const LABEL_MAX = 24

const run = atom({ plugin: 'turn-progress', key: 'run' } as const, null)
const now = atom({ plugin: 'turn-progress', key: 'now' } as const, 0)
const enabled = atom({ plugin: 'turn-progress', key: 'enabled' } as const, true)

type Timer = { cancel: () => void }
let ticker: Timer | null = null

function startTicker($: EngineInterface) {
  ticker?.cancel()
  ticker = $.clock.every(1000, () => {
    void $.clock.now().then(t => update($, now, () => t))
  })
}

function stopTicker() {
  ticker?.cancel()
  ticker = null
}

async function tauMs($: EngineInterface): Promise<number> {
  const past = (await $.store.get(DURATIONS)) as number[] | undefined
  return median(past ?? []) ?? DEFAULT_TAU_MS
}

// Kept across sessions, so a pause lasts until the person turns it back on.
async function setEnabled($: EngineInterface, isOn: boolean) {
  await update($, enabled, () => isOn)
  await $.store.set('enabled', isOn)
  if (!isOn) {
    stopTicker()
    await update($, run, () => null)
  }
}

function withTask(r: Run, id: string, state: TaskState | 'deleted', label?: string): Run {
  const tasks = { ...r.tasks }
  const labels = { ...r.labels }
  let order = r.order.includes(id) ? r.order : [...r.order, id]
  if (label) labels[id] = label
  if (state === 'deleted') {
    delete tasks[id]
    order = order.filter(x => x !== id)
  } else {
    tasks[id] = state
  }
  const running = order.find(x => tasks[x] === 'in_progress')
  return { ...r, tasks, labels, order, active: running ? (labels[running] ?? null) : null }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'turn-progress',
      description: 'Turn progress bar: "on" or "off"',
      argumentHint: '[on|off]',
    })
    const stored = await $.store.get('enabled')
    await update($, enabled, () => stored !== false)
    // A reload drops the module's timer; pick the tick back up for a turn still running.
    const r = await read($, run)
    if (r && r.endedAt === null) startTicker($)
    return next(e)
  })

  on('command.run', { command: 'turn-progress' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg !== 'on' && arg !== 'off') return { text: 'Usage: /turn-progress on | off' }
    await setEnabled($, arg === 'on')
    return { text: `Turn progress ${arg === 'on' ? 'enabled' : 'disabled'}.` }
  })

  on('prompt.submit', async ($, e, next) => {
    const origin = e.origin as typeof e.origin | undefined
    if (!isPersonOrigin(origin) || e.text.trim() === '' || !(await read($, enabled))) return next(e)
    // Another mod (prompt-coach) may hold the prompt back; only a prompt that entered starts a bar.
    const entered = await next(e)
    if (entered.drop !== undefined) return entered
    const t = await $.clock.now()
    await update($, now, () => t)
    // A prompt typed into a running turn keeps that turn's bar going.
    const current = await read($, run)
    if (!current || current.endedAt !== null) {
      await update($, run, () => ({
        startedAt: t,
        endedAt: null,
        isAborted: false,
        tasks: {},
        order: [],
        labels: {},
        active: null,
      }))
      startTicker($)
    }
    return entered
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const r = await read($, run)
    if (!r || r.endedAt !== null || ran.deny !== undefined || ran.isError) return ran

    if (e.tool === 'TodoWrite') {
      const todos = e.todos
      const ids = todos.map((_, i) => `todo-${i}`)
      await update($, run, cur =>
        cur
          ? todos.reduce<Run>(
              (acc, todo, i) => withTask(acc, ids[i]!, todo.status, todo.activeForm || todo.content),
              { ...cur, tasks: {}, order: [], labels: {} },
            )
          : cur,
      )
    } else if (e.tool === 'TaskCreate') {
      const id = (ran.result as { task?: { id?: string } } | undefined)?.task?.id
      if (id) await update($, run, cur => (cur ? withTask(cur, id, 'pending', e.activeForm || e.subject) : cur))
    } else if (e.tool === 'TaskUpdate') {
      const { taskId, status, activeForm, subject } = e
      await update($, run, cur => {
        if (!cur) return cur
        const known = cur.tasks[taskId]
        const state = status ?? known ?? 'pending'
        return withTask(cur, taskId, state, activeForm || subject)
      })
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const r = await read($, run)
    if (e.agentId === undefined && r && r.endedAt === null) {
      stopTicker()
      const t = await $.clock.now()
      await update($, run, cur => (cur ? { ...cur, endedAt: t, isAborted: e.isAborted } : cur))
      if (!e.isAborted) {
        const past = ((await $.store.get(DURATIONS)) as number[] | undefined) ?? []
        await $.store.set(DURATIONS, [...past, t - r.startedAt].slice(-KEEP_DURATIONS))
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const { Box, Text, Button } = $.ui.resolve(e)

    if (!(await read($, enabled))) {
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1} alignItems="center">
            <Text dimColor>▸ Progress bar is off</Text>
            <Button key="progress-enable" label="Enable" onPress={() => setEnabled($, true)} />
          </Box>
          {below}
        </Box>
      )
    }

    const r = await read($, run)
    if (!r) return below
    const disable = <Button key="progress-disable" label="Disable bar" onPress={() => setEnabled($, false)} />
    const t = Math.max((await read($, now)) ?? r.startedAt, r.startedAt)

    if (r.endedAt !== null) {
      const took = fmtDuration(r.endedAt - r.startedAt)
      const span = `${fmtClock(r.startedAt)} → ${fmtClock(r.endedAt)}`
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text color={r.isAborted ? 'warning' : 'success'}>{r.isAborted ? '■' : '✓'}</Text>
            <Box flexGrow={1}>
              <Text dimColor>
                {took} · {span}
              </Text>
            </Box>
            {disable}
          </Box>
          {below}
        </Box>
      )
    }

    const stats = taskStats(r)
    const isTaskMode = stats.total > 0
    const elapsed = fmtElapsed(t - r.startedAt)
    const eta = isTaskMode ? etaMs(stats, r.startedAt, t) : null
    const right = isTaskMode
      ? `${stats.done}/${stats.total} · ${elapsed}${eta ? ` · ≈${fmtClock(eta)}` : ''}`
      : elapsed
    const label = r.active ?? fmtClock(r.startedAt)
    const shortLabel = label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX - 1)}…` : label
    const p = isTaskMode ? (stats.done + 0.5 * stats.active) / stats.total : timeFraction(t - r.startedAt, await tauMs($))

    let bar
    if (e.surface === 'desktop') {
      const { Svg } = $.ui.resolve(e)
      const source = isTaskMode ? taskSvg(r.order.map(id => r.tasks[id] ?? 'pending')) : estimateSvg(p)
      // Drawn as an image: it fills the slot, and Chromium still runs the SVG's own animation.
      // (isInteractive puts it in a 300px frame that does not stretch.)
      bar = <Svg source={source} alt={`${Math.round(p * 100)}%`} height={SVG_H} />
    } else {
      const width = Math.max(10, e.props.bodyColumns - shortLabel.length - right.length - 16)
      const { filled, rest } = blocks(p, width)
      bar = (
        <Text>
          <Text color="claude">{filled}</Text>
          <Text dimColor>{rest}</Text>
        </Text>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} alignItems="center">
          {/* The texts keep their width; the bar gets only what is left (an SVG would otherwise claim its own 1000px). */}
          <Box flexShrink={0}>
            <Text dimColor>{shortLabel}</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1} width={0} minWidth={0}>
            {bar}
          </Box>
          <Box flexShrink={0}>
            <Text dimColor>{right}</Text>
          </Box>
          {disable}
        </Box>
        {below}
      </Box>
    )
  })
}
