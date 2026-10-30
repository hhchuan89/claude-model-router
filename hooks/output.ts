// Only large logs are candidates. Code and diffs are context the model needs verbatim.
export const OUTPUT_MIN_CHARS = 20_000
export const OUTPUT_MAX_CHARS = 1_000_000
const CONTINUATION = /^(?:[ \t]+\S|at\s|File "[^"]+", line \d+|Caused by:|\s*\.\.\.\s*\d+ more|goroutine \d+ \[|stack backtrace:|[^ \t]+\([^\n]*\)$)/
const IMPORTANT = /fatal|error|critical|panic|emerg|alert|warn|fail|exception|traceback/i

export function outputLimit(value: unknown): number {
  const n = Number(value ?? 0)
  return Number.isFinite(n) && n >= OUTPUT_MIN_CHARS && n <= OUTPUT_MAX_CHARS ? Math.floor(n) : 0
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
}

export function looksLikeCode(text: string): boolean {
  const clean = stripAnsi(text)
  if (/^\s*(?:```|diff --git |@@ |--- |\+\+\+ |Index:)/m.test(clean)) return true
  // A pasted fragment can have no diff header. Prefer leaving a bullet list alone to cutting a patch.
  if (/(?:^|\n)[+-][^\n]*\n[+-][^\n]*(?:\n|$)/.test(clean)) return true
  return /^\s*(?:\d+\s*[→|:]\s*)?(?:(?:export\s+)?(?:import\s|from\s+\S+\s+import|const\s|let\s|var\s|function\s|class\s|def\s|async\s+(?:def|function)\s|interface\s|type\s+\w+\s*=)|(?:if|for|while|switch)\s*\(|(?:public|private|protected)\s|(?:package|func|fn|use|struct|enum|impl|return)\s|(?:int|void|char|bool)\s+\w+\s*\(|#include\s|#!|<\/?[A-Za-z][^>]*>|[{}\[\]]\s*$|["']\w+["']\s*:|[A-Za-z_]\w*\s*=(?!=)|(?:fi|done|esac)\s*$)/m.test(clean)
}

const TIMESTAMP = /^([ \t]*\[?)(?:\d{4}-\d{2}-\d{2}[T ])?\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?(\]?(?:[ \t]+|$))/
const LEVEL = /^[ \t]*(?:\[(?:trace|debug|info|notice|warn|warning|error|fatal|critical|panic|emerg|alert)\]|(?:trace|debug|info|notice|warn|warning|error|fatal|critical|panic|emerg|alert):?)(?:[ \t]+|$)/i
const PROGRESS_BAR = /^([ \t]*(?:(?:progress|downloading|uploading|building|processing)[ :]+)?)\[(?=[#=> .█░▓-]*[#=>█▓])[#=> .█░▓-]{3,}\](?:([ \t]+)\d+(?:\.\d+)?%)?(?=[ \t]|$)/i
const PROGRESS_PERCENT = /^([ \t]*(?:progress|downloading|uploading|building|processing)[ :]+)\d+(?:\.\d+)?%(?=[ \t]|$)/i
const PROGRESS_COUNT = /^([ \t]*progress[ :]+)\d+(?=(?:\/\d+)?[ \t]*$)/i

// Classify the message, retaining indentation after the prefix's one separator. Docker timestamps
// and logger levels can appear in either order; the original line is still what we emit.
function diagnosticLine(line: string): { message: string; important: boolean } {
  let message = line
  let timestamp = false
  let level = false
  let important = false
  for (let i = 0; i < 2; i++) {
    const time = timestamp ? null : TIMESTAMP.exec(message)
    const severity = !time && !level ? LEVEL.exec(message) : null
    const prefix = time ?? severity
    if (!prefix) break
    if (time) timestamp = true
    else {
      level = true
      important = IMPORTANT.test(prefix[0])
    }
    const spaces = /[ \t]+$/.exec(prefix[0])?.[0].length ?? 0
    message = message.slice(prefix[0].length - Math.max(0, spaces - 1))
  }
  return { message, important: important || IMPORTANT.test(message) }
}

// Only recognised log/progress fields may vary. Message numbers, ids, hashes and whitespace are data.
function lineKey(line: string): string | undefined {
  const timestamp = TIMESTAMP.exec(line)
  const start = timestamp?.[0].length ?? 0
  const level = LEVEL.exec(line.slice(start))
  const end = start + (level?.[0].length ?? 0)
  const message = line.slice(end)
  let progress: string | undefined
  let kind = ''
  const bar = PROGRESS_BAR.exec(message)
  if (bar) { kind = bar[2] === undefined ? 'bar' : 'bar-percent'; progress = message.replace(PROGRESS_BAR, '$1<bar>$2<percent>') }
  else if (PROGRESS_PERCENT.test(message)) { kind = 'percent'; progress = message.replace(PROGRESS_PERCENT, '$1<percent>') }
  else if (PROGRESS_COUNT.test(message)) { kind = 'count'; progress = message.replace(PROGRESS_COUNT, '$1<count>') }
  // A bare timestamp is data. Bracketed timestamps are a logger format; otherwise require a level or progress.
  if (!level && !timestamp?.[0].trim().startsWith('[') && progress === undefined) return undefined
  // Keep field kinds separate so literal message text cannot collide with a comparison marker.
  return JSON.stringify([!!timestamp, kind, line.slice(0, end).replace(TIMESTAMP, '$1<timestamp>$2'), progress ?? message])
}

function tabular(lines: string[]): boolean {
  const rows = lines.filter(line => line.trim())
  if (rows.length < 2) return false
  return ['\t', ','].some(delimiter => {
    const widths = new Map<number, number>()
    for (const row of rows) {
      const width = row.split(delimiter).length
      if (width > 1) widths.set(width, (widths.get(width) ?? 0) + 1)
    }
    return [...widths.values()].some(count => count * 2 > rows.length)
  })
}

export function reduceOutput(original: string, limit: number, omitted: (n: number) => string): string {
  const clean = stripAnsi(original)
  const rows = clean.split(/\r\n|\n/)
  // Delimited exports stay exact, including their separators, line endings and repeated records.
  if (tabular(rows)) return original
  let diagnostic = false
  // Redraws use the same payload comparisons below, keeping the first and last states.
  const entries = rows.flatMap(line => {
    return line.split('\r').map(part => {
      const { message, important } = diagnosticLine(part)
      diagnostic = important || (diagnostic && (!message.trim() || CONTINUATION.test(message)))
      return { line: part, diagnostic }
    })
  })
  const lines = entries.map(part => part.line)
  const keys = lines.map(lineKey)
  const nonblank = lines.filter(line => line.trim()).length
  // Measure before collapsing: a long run of repeats must not change whether this is a log.
  const logLike = nonblank > 0 && keys.filter(key => key !== undefined).length * 3 >= nonblank * 2
  // Unclassified output is data, even when every line is identical.
  if (!logLike) return original
  const diagnostics = new Set<number>()
  entries.forEach((part, i) => { if (part.diagnostic) diagnostics.add(i) })
  const collapsed: string[] = []
  const protectedLines = new Set<number>()
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    let n = 1
    if (keys[i] !== undefined && !diagnostics.has(i)) {
      while (i + n < lines.length && !diagnostics.has(i + n) && keys[i + n] === keys[i]) n++
    }
    if (diagnostics.has(i) || keys[i] === undefined) protectedLines.add(collapsed.length)
    const last = lines[i + n - 1]!
    collapsed.push(n === 1 ? line : `${line}${last === line ? '' : ` … ${last}`} [×${n}]`)
    i += n - 1
  }
  const text = collapsed.join('\n')
  if (text.length <= limit) return text
  // The threshold is a target for reductions: diagnostics and unclassified lines win if they alone exceed it.
  const keep = new Map<number, string>()
  let diagnosticChars = 0
  collapsed.forEach((line, i) => {
    if (protectedLines.has(i)) { keep.set(i, line); diagnosticChars += line.length + 1 }
  })
  // Always leave a little head and tail, even when diagnostics alone exceed the target.
  const budget = Math.max(256, Math.floor((limit - diagnosticChars - 200) / 2))
  for (const reverse of [false, true]) {
    let remaining = budget
    for (let j = 0; j < collapsed.length && remaining > 0; j++) {
      const i = reverse ? collapsed.length - 1 - j : j
      if (keep.has(i)) {
        if (reverse && keep.get(i) !== collapsed[i] && !protectedLines.has(i)) {
          keep.set(i, `${keep.get(i)}\n${omitted(0)}\n…${collapsed[i]!.slice(-remaining)}`)
          remaining = 0
        }
        continue
      }
      const line = collapsed[i]!
      keep.set(i, line.length <= remaining ? line : reverse ? `…${line.slice(-remaining)}` : `${line.slice(0, remaining)}…`)
      remaining -= line.length + 1
    }
  }
  const out: string[] = []
  let skipped = 0
  collapsed.forEach((_, i) => {
    if (!keep.has(i)) { skipped++; return }
    if (skipped) { out.push(omitted(skipped)); skipped = 0 }
    out.push(keep.get(i)!)
  })
  if (skipped) out.push(omitted(skipped))
  return out.join('\n')
}

// Restrict both components so a model-supplied id can never read outside this session's archive directory.
export function outputPath(dir: string, session: string, id: string): string | undefined {
  return /^[\w-]{1,200}$/.test(session) && /^[\w-]{1,200}$/.test(id) ? `${dir}/outputs/${session}/${id}.txt` : undefined
}

// Retain each newline (and CR) so a range is an exact slice of the archived original. Grep is a literal,
// case-insensitive substring, rather than an unbounded regular expression over a potentially huge log.
export function outputSlice(text: string, startLine = 1, endLine = Infinity, pattern?: string): string {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? []
  return lines.slice(startLine - 1, endLine).filter(line => pattern === undefined || line.toLowerCase().includes(pattern.toLowerCase())).join('')
}
