// How long live classifier calls take, kept as a small histogram so day counts from many sessions merge by addition.
// The edges follow the 8-second cap (CLASSIFY_MS): a call that runs out is its own bucket, not the slowest one.
export const CLASSIFY_MS = 8000
export const LATENCY_BUCKETS = ['<0.5s', '0.5-1s', '1-2s', '2-4s', '4s+', 'timeout'] as const
export type LatencyBucket = (typeof LATENCY_BUCKETS)[number]

// The upper edge of each timed bucket, in seconds, for the "95% within" figure. The open bucket's edge is the cap: a
// call still running at 8 s is cut off, so an answered call landing past it is rare and close to the cap.
const UPPER: Record<Exclude<LatencyBucket, 'timeout'>, string> = { '<0.5s': '0.5s', '0.5-1s': '1s', '1-2s': '2s', '2-4s': '4s', '4s+': '8s' }

// A call aborted well before the cap was cut off by the person (Escape), not by the clock, so it says nothing about
// the classifier's speed and lands in no bucket (null).
const ABORT_SLACK_MS = 50

// aborted: the call ended as aborted. A call that answered just past 8 s still lands in 4s+: it was not cut off.
export function latencyBucket(ms: number, aborted: boolean): LatencyBucket | null {
  if (aborted) return ms >= CLASSIFY_MS - ABORT_SLACK_MS ? 'timeout' : null
  if (ms < 500) return '<0.5s'
  if (ms < 1000) return '0.5-1s'
  if (ms < 2000) return '1-2s'
  if (ms < 4000) return '2-4s'
  return '4s+'
}

// The first bucket, in order, where the running share of calls reaches `share`.
function bucketAt(hist: Record<string, number>, total: number, share: number): LatencyBucket {
  let seen = 0
  for (const b of LATENCY_BUCKETS) {
    seen += hist[b] ?? 0
    if (seen / total >= share) return b
  }
  return 'timeout'
}

// One line for /model-router stats. The median is a bucket, not a number: only bucket counts are kept. The 95% figure is
// the upper edge of the bucket where the running share reaches 95%, so it is a bound, not an estimate.
export function latencySummary(hist: Record<string, number> | undefined, msTotal: number, n: number): string {
  const h = hist ?? {}
  const total = LATENCY_BUCKETS.reduce((sum, b) => sum + (h[b] ?? 0), 0)
  if (n <= 0 || total <= 0) return 'Classifier time: no calls yet'
  const median = bucketAt(h, total, 0.5)
  const p95 = bucketAt(h, total, 0.95)
  const within = p95 === 'timeout' ? '95th percentile: timeout' : `95% within ${UPPER[p95]}`
  return `Classifier time: median ${median}, ${within}, mean ${(msTotal / n / 1000).toFixed(1)}s (n=${n})`
}
