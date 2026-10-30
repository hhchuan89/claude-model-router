import type { EngineInterface } from 'claude-code'

import type { EventLog } from './subagent'
import { addUsage, logDir } from './subagent'

export type LogIO = {
  root: string
  now: () => number
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  list: (path: string) => ReturnType<EngineInterface['fs']['list']>
  stat: (path: string) => ReturnType<EngineInterface['fs']['stat']>
  run: (argv: string[]) => ReturnType<EngineInterface['process']['run']>
  log: (text: string) => void
}

type Batch = EventLog & { id: string }

// Failed bookkeeping waits one second, doubling to five minutes. No timer holds up a hook.
export class Backoff {
  at = -Infinity
  delay = 0

  waiting(now: number) { return now < this.at }
  fail(now: number) {
    this.delay = Math.min((this.delay || 500) * 2, 5 * 60_000)
    this.at = now + this.delay
  }
  reset() { this.at = -Infinity; this.delay = 0 }
}

const missing = (err: unknown) => /ENOENT|ENOTDIR|no file|not found/i.test(String(err))
const safeName = (name: string) => /^[a-zA-Z0-9_-]+$/.test(name)
const attemptOf = (name: string) => /^([a-zA-Z0-9-]+)_(\d+)_(\d+)\.json$/.exec(name)
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value)

// JSON can parse and still be an incomplete log. Check its shape before it reaches the merge.
function validLog(value: unknown): value is EventLog & { id?: string; end?: string } {
  return record(value) && typeof value.sessionId === 'string' &&
    (value.id === undefined || (typeof value.id === 'string' && safeName(value.id))) &&
    Array.isArray(value.events) && value.events.every(event => record(event) &&
      ['at', 'agentId', 'event', 'to', 'reason'].every(key => typeof event[key] === 'string') &&
      (event.id === undefined || typeof event.id === 'string')) &&
    record(value.stats) && Object.values(value.stats).every(stats => record(stats) &&
      record(stats.byEffort) && Object.values(stats.byEffort).every(finite) &&
      record(stats.byModel) && Object.values(stats.byModel).every(usage => record(usage) &&
        ['steps', 'input', 'output', 'cacheRead', 'cacheWrite'].every(key => finite(usage[key]))))
}

// A copied batch, or a write whose acknowledgement was lost, counts only once. Legacy logs have no batch id.
export function mergeLogs(sessionId: string, batches: (EventLog & { id?: string })[]): EventLog {
  const log: EventLog = { sessionId, events: [], stats: {} }
  const seen = new Set<string>()
  const events = new Set<string>()
  for (const batch of batches) {
    if (batch.sessionId !== sessionId || (batch.id && seen.has(batch.id))) continue
    if (batch.id) seen.add(batch.id)
    for (const event of batch.events ?? []) {
      if (event.id && events.has(event.id)) continue
      if (event.id) events.add(event.id)
      log.events.push(event)
    }
    for (const [agentId, stats] of Object.entries(batch.stats ?? {})) {
      const current = log.stats[agentId] ?? { byModel: {}, byEffort: {} }
      for (const [model, usage] of Object.entries(stats.byModel)) {
        const sum = { ...usage }
        for (const key of Object.keys(sum) as (keyof typeof sum)[]) sum[key] += current.byModel[model]?.[key] ?? 0
        current.byModel[model] = sum
      }
      for (const [effort, n] of Object.entries(stats.byEffort)) current.byEffort[effort] = (current.byEffort[effort] ?? 0) + n
      log.stats[agentId] = current
    }
  }
  log.events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  return log
}

// Each activation owns its filenames. Only unsaved deltas stay in memory, including late outcomes from ended sessions.
// There is no disk compaction: another process may still be using any of the files we read.
export class EventLogs {
  private writer = crypto.randomUUID()
  private sequence = 0
  private attempt = 0
  readonly diagnostics = { skippedBatches: 0 }
  private pending = new Map<string, Batch>()
  private retries = new Map<string, Backoff>()
  private failureLogAt = -Infinity
  private writes?: Promise<void>
  private queued?: LogIO

  event(sessionId: string, event: EventLog['events'][number]) {
    const id = `${this.writer}-${++this.sequence}`
    this.pending.set(id, { id, sessionId, events: [{ ...event, id }], stats: {} })
  }

  usage(sessionId: string, agentId: string, model: string, effort: string | undefined, u: Parameters<typeof addUsage>[3]) {
    const id = `${this.writer}-${++this.sequence}`
    this.pending.set(id, { id, sessionId, events: [], stats: { [agentId]: addUsage(undefined, model, effort, u) } })
  }

  flush(io: LogIO): Promise<void> {
    // Requests made during a write share one queued pass, using the latest caller's IO.
    this.queued = io
    this.writes ??= Promise.resolve().then(async () => {
      try {
        while (this.queued) {
          const next = this.queued
          this.queued = undefined
          await this.writePending(next)
        }
      } finally {
        this.writes = undefined
      }
    })
    return this.writes
  }

  private async writePending(io: LogIO) {
    // A failed batch keeps its id and contents, but backs off without delaying new batches.
    for (const [id, batch] of [...this.pending]) {
      const retry = this.retries.get(id)
      if (retry?.waiting(io.now())) continue
      try {
        if (!safeName(batch.sessionId)) throw new Error('invalid event-log session id')
        // The fs interface has no rename. Never overwrite an attempt, even after a lost acknowledgement.
        const name = `${id}_${io.now()}_${++this.attempt}.json`
        await io.write(`${logDir(io.root)}/${batch.sessionId}/${name}`, JSON.stringify({ ...batch, end: id }, null, 1))
        this.pending.delete(id)
        this.retries.delete(id)
      } catch (err) {
        const now = io.now()
        const backoff = retry ?? new Backoff()
        backoff.fail(now)
        this.retries.set(id, backoff)
        // Many new batches may fail together. Report at most once during this backoff step.
        if (now >= this.failureLogAt) {
          this.failureLogAt = backoff.at
          try { io.log(`model-router: bookkeeping failed: ${String(err)}`) } catch { /* Logging is best effort too. */ }
        }
      }
    }
  }

  private parse(text: string, name?: string): (EventLog & { id?: string }) | undefined {
    try {
      const batch: unknown = JSON.parse(text)
      const attempt = name && attemptOf(name)
      // Legacy logs and old batches predate the marker. New attempt filenames require it, written last.
      if (!validLog(batch) || (attempt && (batch.id !== attempt[1] || batch.end !== batch.id))) {
        throw new Error('incomplete event-log batch')
      }
      return batch
    } catch {
      this.diagnostics.skippedBatches++
      return undefined
    }
  }

  async read(io: LogIO, sessionId: string): Promise<EventLog> {
    if (!safeName(sessionId)) throw new Error('invalid event-log session id')
    const root = logDir(io.root)
    const pending = [...this.pending.values()]
    const batches: (EventLog & { id?: string })[] = []
    try {
      const batch = this.parse(await io.read(`${root}/events-${sessionId}.json`))
      if (batch) batches.push(batch)
    } catch (err) { if (!missing(err)) throw err }
    const files = await io.list(`${root}/${sessionId}`).catch(err => {
      if (!missing(err)) throw err
      return []
    })
    for (const file of files) {
      if (file.kind !== 'file' || !/^[a-zA-Z0-9_-]+\.json$/.test(file.name)) continue
      let text: string
      try { text = await io.read(`${root}/${sessionId}/${file.name}`) }
      catch (err) { if (missing(err)) continue; throw err }
      const batch = this.parse(text, file.name)
      if (batch) batches.push(batch)
    }
    return mergeLogs(sessionId, [...batches, ...pending, ...this.pending.values()])
  }

  async prune(io: LogIO, now: number, days: number) {
    const root = logDir(io.root)
    const dirs = await io.list(root).catch(err => {
      if (!missing(err)) throw err
      return []
    })
    const cutoff = now - days * 24 * 3600_000
    for (const dir of dirs) {
      if (dir.kind !== 'dir' || dir.isLink || dir.name === 'outputs' || !safeName(dir.name)) continue
      const path = `${root}/${dir.name}`
      const files = (await io.list(path)).filter(file => {
        const attempt = attemptOf(file.name)
        // Untimestamped files predate this format; their age cannot be established from their names.
        return file.kind === 'file' && !file.isLink && attempt && Number(attempt[2]) < cutoff && !this.pending.has(attempt[1]!)
      })
      // The fs interface has no remove. Pass exact filenames as argv entries, never shell text.
      for (let i = 0; i < files.length; i += 128) {
        const paths = files.slice(i, i + 128).filter(file => !this.pending.has(attemptOf(file.name)![1]!))
          .map(file => `${path}/${file.name}`)
        if (paths.length === 0) continue
        const result = await io.run(['rm', '-f', '--', ...paths])
        if (result.exitCode !== 0) throw new Error('event-log retention failed')
      }
      // A writer may have added a fresh file after list. Never recursively remove the directory.
      if (files.length > 0) await io.run(['rmdir', '--', path])
    }
  }
}
