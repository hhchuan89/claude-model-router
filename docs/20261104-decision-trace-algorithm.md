# Decision traces, measured confidence and offline learning (proposal)

Status: proposal for discussion, not implemented. Date: 2026-11-04.

## 1. The problem this solves

Today a routed turn leaves three things behind: the tier, a reason of at most 15 characters, and (if someone
corrects it) a 200-character masked snippet. When a turn is misrouted we cannot answer the two questions that matter:

1. **Why did the classifier choose this?** We do not keep what it actually saw (the selected context, cut and masked)
   or what it actually replied. A wrong verdict caused by a bad prompt looks the same as one caused by missing context.
2. **How often is a verdict like this one wrong?** The classifier says `sure: true/false`, but nobody has measured how
   often a *sure lookup* or an *unsure decide* turns out wrong. "Sure" is the classifier's opinion of itself, not a
   measured rate.

`jev-router` answers question 1 by saving each routing exchange per session and rendering it locally on request. This
proposal does that, and then uses the saved traces to answer question 2 and to improve the classifier, while avoiding
the two failures this project has already measured:

- **Self-reported probabilities are not calibrated.** The 1.2.0 draft asked the classifier for a probability per tier.
  On 102 labelled prompts it did not beat the 1.1.0 classifier. A model's stated confidence is not a frequency.
- **Feeding corrections back as examples makes routing worse.** As few-shot examples, corrections lowered accuracy from
  69.6% to 65.7%. Escalations only ever say "should have been higher", so the router drifted upward over time.

So the design rule is: **confidence is measured from outcomes, never asked for; and learning happens offline, behind a
replay gate and a person's approval, never inside a live classification.**

## 2. Overview

```
 classify ──> trace record ──> outcome signals ──> calibration table ──> (a) explain   (b) safety raise   (c) offline learn
 (live)       (zero tokens)    (zero tokens)        (zero tokens)          local cmd     behind option      user-triggered,
                                                                                                             replay-gated
```

Every stage up to the calibration table costs no model call. Only stage (c) spends tokens, and only when the person
runs it.

## 3. Stage 1: the trace record

One record per classified main turn and per classified `general-purpose` subagent:

| Field | Content |
|-------|---------|
| `id`, `at`, `session`, `turnId` / `agentId` | identity and time |
| `promptVersion` | hash of `classifierSystem(lang)`: traces from different prompts are never mixed |
| `message` | the masked message as sent (already capped at 6,000 characters) |
| `context` | the masked, trimmed context exactly as sent (from the new selection rule in 1.3.0) |
| `previous` | previous tier passed to the classifier |
| `raw` | the classifier's reply, masked, first 400 characters |
| `verdict` | `{ tier, sure }` as parsed, or the failure reason |
| `adjustments` | ordered list of what changed the verdict: `settle (unsure, no downgrade)`, `risk floor`, `pacing steer`, `warm keep`, `pin`, `#model` |
| `final` | model and effort actually sent, and the model that answered |
| `latencyMs` | classifier call time (from 1.3.0) |
| `features` | the calibration key (section 5), computed once |

**Storage.** In memory by default, a ring of the last 50 records per session, gone when the session ends. An option
`keepDecisionTraces` (off by default) also writes them to `<logDir>/traces/<sessionId>.json`, file mode 600, pruned
after 7 days, like `jev-router`'s explanation files. Size is about 2-8 KB per record.

**Cost.** No extra tokens: the record holds what the classifier call already sent and received. The only costs are
local disk (when enabled) and the privacy of keeping masked prompt text, which is why disk is opt-in.

## 4. Stage 2: outcome signals (labels without asking anyone)

When a turn ends, attach what happened after the routing. Each signal has a direction and a strength:

| Signal | Direction | Strength | Why |
|--------|-----------|----------|-----|
| `/model-router wrong <tier>` or the band's button | up or down | strong (1.0) | a person said so |
| model escalated itself to a higher model | up | medium (0.6) | the model judged the tier too low, but models over-escalate |
| `#model` or `pin` on the very next prompt, higher than this turn | up | medium (0.5) | the person overrode the router |
| same, lower than this turn | down | medium (0.5) | the person chose cheaper |
| effort-only escalation | none | 0 | not a tier error |
| turn aborted by the person | none | 0 | too many unrelated causes |
| turn completed, no signal | "accepted" | weak | absence of complaint, not proof of fit |

**The bias we must not ignore.** Under-routing is visible (the model escalates, the person complains). Over-routing is
almost invisible: nobody says "Opus was too much for this". If raw signals were used as training labels, the system
would only ever learn to route higher. That is exactly the 1.1.0 ratchet. So:

- Escalations and next-turn overrides are used **only to measure the under-route rate**, never as labels for training.
- Only **two-sided** sources become labels: manual corrections (which can say lower) and an offline judged sample
  (section 7).

## 5. Stage 3: measured confidence (the "probability" part)

Instead of trusting `sure`, estimate from traces how often each kind of verdict is under-routed.

**Cell key.** A small number of coarse features, so each cell fills up:

```
cell = (verdict.tier, verdict.sure, riskFlag, hasContext, lengthBucket[<40, 40-400, >400 chars], promptVersion)
```

That is at most 3 × 2 × 2 × 2 × 3 = 72 cells per prompt version; in practice a handful hold most turns.

**Estimate with shrinkage.** For each cell, with `u` weighted up-signals out of `n` turns, and the global under-route
rate `p0` over all cells of this prompt version:

```
p_under(cell) = (u + α · p0) / (n + α),   α = 20
```

A cell with 3 turns stays close to the global rate; a cell with 300 turns speaks for itself. Report the interval too
(Beta(u + α·p0, n − u + α·(1 − p0)), 90%), so "12% ± 9%" is not read as "12%".

**What it is used for, in order of risk.**

1. **Reporting only (always on).** `/model-router stats` and `explain` show the measured under-route rate of the cell
   a turn fell into. This changes no routing and is the first thing to ship.
2. **A raise rule (option, off by default).** Moving down is only worth it when the expected cost of being wrong is
   smaller than the saving. For a candidate cheaper tier `c` instead of the next tier up `e`:

   ```
   route to c only if   p_under(cell) · C_redo  <  C_e − C_c
   i.e.                 p_under(cell)  <  τ = (C_e − C_c) / C_redo
   ```

   `C_c`, `C_e` are the median measured spend of a turn on each tier, and `C_redo` the median spend of a turn that
   started on `c` and escalated. All three come from the meter, which already records spend per turn and tier. When a
   cell has `n ≥ 30` and its interval lies wholly above `τ`, the router raises the tier and says why ("this kind of
   lookup escalates 31% of the time: running on Sonnet"). It never lowers a tier on this evidence. Lowering would
   need over-route labels, which only stage 4 provides.

## 6. Stage 4: explain (zero tokens)

`/model-router explain [n]` prints the trace of the last (or n-th last) turn as plain text from memory or disk, with
no model call (`jev-router` uses a skill, which spends a turn of tokens on every explanation):

```
Turn 14:32 · decide → Opus · medium
Classifier saw:  [user] 把 risk floor 的规则也加到 subagent …   [assistant] 已经改好 …   (context: 2 rows, 1,140 chars)
Classifier said: {"tier":"execute","sure":false,"reason":"按计划修改"}   in 0.9 s
Adjustments:     unsure execute after decide → kept decide (no downgrade)
Measured:        unsure execute after decide escalates 18% (± 7%, n=61)
Sent:            claude-opus-5-5 · medium   Answered: claude-opus-5-5
```

## 7. Stage 5: offline learning, gated by replay

Run by the person, never automatically: `/model-router learn`.

1. **Build the evaluation set** from traces of the current prompt version: every manually corrected turn (label = the
   correction), plus a random sample of uncorrected turns labelled by two judges (Opus, run twice with different
   orderings; keep only items where both agree, as the 1.2.0 measurement did). The random sample is what makes
   over-routing visible.
2. **Diagnose.** Confusion matrix by tier, the cells with the highest measured under- and over-route rates, and the
   10 worst traces with their full context.
3. **Propose.** One Opus call reads the worst traces and the current prompt and proposes at most three edits, each as a
   rule or a "Not for" line, never as a stored example.
4. **Gate.** Replay current vs candidate on the evaluation set, 2 runs each, with the existing `/model-router replay`
   machinery. Adopt only if all hold: accuracy up, under-route rate not up, cost proxy not up, exact McNemar p < 0.05.
5. **Hand over.** Write the candidate prompt, the replay numbers and a diff to a local file. A person decides whether
   to ship it in a release. The live prompt is never changed by the router itself.

Cost of one run: replay calls on Haiku (about 2 × the set size), two judge passes on the sample and one Opus proposal.
At a 200-item set that is roughly $1-3. It runs only on request.

## 8. Privacy

- Masked text only (the same `redact` as the classifier). Traces are local and never sent anywhere, except to the
  person's own Anthropic account during an explicit `learn` run.
- In-memory by default; disk only with `keepDecisionTraces`, mode 600, 7-day prune, `/model-router traces clear`.
- The calibration table holds counts per cell, no text, so it can be kept indefinitely.

## 9. Failure modes and what guards them

| Risk | Guard |
|------|-------|
| Upward ratchet from one-sided signals | escalations never become labels; only two-sided sources train |
| Sparse cells give noisy rates | shrinkage to the global rate, interval shown, `n ≥ 30` before any routing effect |
| Old traces judged against a new prompt | every trace carries `promptVersion`; tables are per version |
| Feedback loop: the raise rule changes which turns can escalate | the raise rule only adds caution; its own effect is visible as a drop in that cell's traffic, reported in stats |
| A learned edit that looks good on a small set | McNemar gate, two runs, under-route and cost must not get worse, a person approves |
| Text kept on disk | opt-in, masked, mode 600, 7-day prune |

## 10. Suggested order

1. Trace record in memory and `/model-router explain`: useful on its own, no routing change, no tokens.
2. Outcome signals and the calibration table, shown in stats: still no routing change. Collect a few weeks of data.
3. The raise rule behind an option, once some cells have `n ≥ 30`.
4. `/model-router learn`, once there are enough corrected and judged traces to replay (about 200).

Each step is useful without the next, and steps 1-2 cannot make routing worse.
