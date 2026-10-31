# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-10-31

1.1.0 adds a router pane, a way to pin a model and teach the classifier from your corrections, and weekly usage pacing.
Each has an off switch, and with `autoOpenPane` off, `learnFromCorrections` off and `weeklyPacing` off the router
routes, prompts and draws exactly as 1.0.1 does.

### Added

- `/model-router pane` opens (or closes) a pane with this session's turns (time, model, effort, cost, tokens, cold-cache,
  kept-cache, escalation, pinned and correction markers, reason), the session and today totals, a seven-day spend chart
  (SVG on Desktop, a text sparkline on the terminal) and, with learning on, correction buttons. Option `autoOpenPane`
  (off by default) also opens it once per session where it would be a sidebar.
- `/model-router pin <haiku|sonnet|opus> [turns]` and `/model-router unpin`: hold the main conversation on a model like a
  `#model` in every message, counted down when the turn starts. `📌` shows in the band and pane.
- Learning from corrections: `/model-router wrong <tier>`, the pane buttons, or the model escalating itself above the
  classified tier's model store the masked prompt snippet (up to 40, 200 characters each); the newest 8 are added to the
  classifier prompt for the main thread and subagents. `/model-router corrections [clear]` lists or deletes them; stats
  count them. Option `learnFromCorrections` (on by default); see Privacy.
- Weekly pacing: option `weeklyPacing` (`off`, `warn` by default, `steer`) and `/model-router pacing [mode|default]`. `warn`
  adds the pace to the status line and toasts once per weekly window; `steer` also routes an unsure decide to Sonnet
  while ahead, never against a warm Opus cache, `#model`, a pin or a sure decision. Steer deliberately overrides the
  classifier's "an unsure verdict never downgrades" rule, and the model may escalate a steered turn back to Opus, which is
  the safety valve. `/model-router status` shows the mode and figures; stats count steered turns.

### Changed

- The command hint and usage line list the new subcommands (the old ones come first, unchanged).

## [1.0.1] - 2026-10-31

### Fixed
- Event-log retention is skipped on Windows. It deletes old batches with `rm` and `rmdir`, which the engine cannot start
  there (Git's `usr\bin` is not on the system PATH), so every daily attempt failed and printed
  `model-router: bookkeeping failed: … Command 'rm' not found` in the chat. Old batches now stay on disk on Windows.
  A Windows install is recognised by its plugin path (a drive letter or a UNC share).

## [1.0.0] - 2026-10-30

1.0.0 builds on 0.10.0, hardens compaction guards against races and the cache deadline, makes the meter honest about
its estimates, and puts context cost first in the UI. Task-boundary checkpoints and log/progress output reduction give you more
control over token use; the new token-saving features, `checkpointHints` and `shrinkToolOutput`, are off by default.

Implemented with Codex (gpt-6.1-sol), adversarially reviewed by Codex (gpt-6-astra)

### Added

- `/model-router checkpoint [note]` compacts at task boundaries, preserving continuation details and counting
  checkpoints separately. Active turns or busy agents are refused; a new prompt cancels the immediate clock tick.
- Optional `checkpointHints` (off by default): cost-based suggestions with a 50% growth / 30-minute cooldown.
- Optional `shrinkToolOutput` (0 by default; active at 20,000–1,000,000 characters): deterministic reduction of Bash/MCP logs and
  progress output only, with whole diagnostic blocks preserved, exact local archives, capped `fetch_output` retrieval
  and reduction counters. Collapse and truncation require at least two thirds recognised log/progress lines;
  unclassified repeats pass through unchanged. Collapsed progress shows its first and last state, and diagnostic
  blocks retain stack frames and continuation lines.
- `/model-router status` lists settings, pending work, deadlines, weekly usage and the last skip. `/model-router context`
  reads the engine's local summary breakdown without token-count requests. New UI text supports English and Chinese.
- Pending guard countdowns and busy-agent counts temporarily replace subagent event statuses. The latest event
  returns when the guard ends or is cancelled. Terminal skips explain why in one toast per timer.

### Changed

Upgrading users see these changes without changing settings:

- The prompt band leads with main context size, estimated cache-read cost per step, cold-resume write cost and time
  to the send-time cache deadline. Expired caches show the estimated next rewrite; narrow bands keep context and
  cold cost ahead of routing detail.
- The status line adds weekly subscription usage and its local reset time when the engine supplies a weekly window,
  alongside the existing subagent event statuses.
- The band and stats say "difference" against the same work tokens at Opus prices, replacing "saved" claims.
  Stats show session and daily spend by role and token category, compaction sizes, cold rewrites and peak main context.
  Older unattributed spend stays visible; totals are labelled as the retained 30-day total plus legacy totals.
- Reported compaction usage now contributes to estimated spend. Classifiers add cost without Opus baseline credit,
  so the comparison can be less favourable than in earlier versions.
- Event logs now use append-only batches at `<sessionId>/<writerId>-<sequence>_<timestamp>_<attempt>.json`,
  with a Unix-millisecond timestamp and a new attempt number on every write. Individual timestamped batches older
  than 30 days are pruned, including those in active sessions; empty batch directories are then removed. Legacy
  `events-<sessionId>.json` files and untimestamped batches are still read and kept unchanged.
- Explicit model pins win over the warm-cache guard; leaving a large Opus cache shows the estimated round-trip
  rewrite cost. Resumed agents keep their escalation and error state without another classification or routed-agent count.

Existing defaults are unchanged: main routing and Fable blocking remain on, the reviewer remains off, and idle and
context-cap compaction remain off. Checkpoint hints and output reduction require opt-in; an explicit checkpoint
command works without enabling either option.

### Fixed

- Session end, /clear and resume cancel pending guards, checkpoints and countdown ticks and reset routing and
  context readings. Async results and accounting writes from the old session are discarded.
- Plugin-started compactions have one accounting owner, whether or not the compaction observer is re-entered.
- Reviewer availability probes contribute to estimated spend as overhead when a reviewer is configured.
- Precomputed summaries no longer clear routing context or cancel pending compaction timers. A new prompt, turn,
  or router-off action cancels pending work even across asynchronous checks; older completions cannot clear newer context.
- Idle compaction and its single busy-agent recheck move forward to the cache deadline when needed, leaving at least
  a minute idle after completion. A deadline too close to allow that minute leaves the timer unarmed.
- Context-cap compaction defers to the idle guard while agents are busy and is not armed after an aborted turn.
- Concurrent sessions no longer overwrite each other's daily totals and counters: each writes its own records,
  aggregated on read and pruned after 30 calendar days. Legacy totals are still read unchanged.

## [0.10.0] - 2026-10-30

From a look at real use (2026-10-24 to 10-30): one session ran all day at 765k-949k tokens with compaction configured
but never loaded, caller-pinned Sonnet subagents ran at high, and 9 of 37 Sonnet main turns handed themselves to Opus at
their first step.

### Added
- `/model-router stats` starts with the compaction settings this session loaded ("Compaction in this session: router
  on · idle after 50 min · cap at 300.0k · min context 100.0k"). With the router off it says no compaction runs. A
  session whose plugin has not reloaded since a settings change keeps the old values; the line makes that visible.
- Every compaction attempt the router makes is written to the events log as `compact idle` or `compact cap`, with the
  outcome (`done`, `skipped` with the veto, `rejected` with the engine error) and, when done, the size before and after.
- The Opus assignment now says: once the plan is settled and carrying it out spans several files or many steps,
  delegate it to a general-purpose subagent without a model (the router puts settled work on Sonnet) and verify the
  result; make small changes directly.

### Changed
- A subagent the caller pinned to Haiku or Sonnet now starts at medium, like the agents the router pins. It used to run at the session's effort, capped at high: 30 such agents ran 1,649 steps at
  high. The model stays the caller's; the ladder and `escalate` still raise it. An Opus pin keeps the session's effort:
  medium is Opus's own self cap, so it could never raise itself. `inherit`, unknown ids and Fable are unchanged.
- An effort the caller sets on the Agent tool (`Agent({ model: "sonnet", effort: "high" })`) is kept, for router and
  caller pins alike, instead of being replaced by the starting medium; the hard cap (high) still applies. Router pins
  had overridden it since 0.5.0. Found by Muhafiz Madzlan's review of this release.
- The classifier calls work `execute` only when what to change is settled in the message or the visible context.
  "Implement it", "add it to the PR", "cherry-pick it" with the change still to be worked out is `decide`, as is
  working out how a change to business rules, production data or stored procedures should behave, and porting to a
  branch whose code differs. An approved plan in the context still makes "implement it" execute. All 9 Sonnet turns that escalated were of this kind (3 were older
  classifier-failure fallbacks, gone since 0.7.0).

## [0.9.2] - 2026-10-30

### Fixed
- Routing now measures the Opus cache from when a main request was sent, like the idle guard since 0.9.1. It used the
  time the reply ended, so after a long reply it could treat an expired cache as warm and skip the classifier or keep
  a turn on Opus for nothing.

## [0.9.1] - 2026-10-29

Three fixes to the 0.9.0 compaction guards, found by a second adversarial review (Codex, `codex exec review`).

### Fixed
- The idle guard measured the cache TTL from when a main request's response finished, not from when it was sent. A
  response that streamed for 6 minutes let a 55-minute timer compact about 61 minutes after the cache was last
  touched, paying the cold rewrite the guard exists to avoid. The guard now records the send time.
- A new prompt that arrived while a pending idle or cap timer was reading the router's on/off state could not cancel
  it: the cancellation check ran before that read. It now runs after the read as well.
- The cache-rewrite counter counted any 100k+ write after an hour-long gap, even when the same request read a large
  warm prefix (kept warm by a background fork, say), so new input was reported as expiry. After a gap the write must
  now outweigh the read.

## [0.9.0] - 2026-10-29

Compaction guards against the 1-hour cache TTL, and a counter that shows what the expiry costs. Everything new is off
by default (the counter only observes).

### Added
- `idleCompactMinutes` (default 0 = off; 1 to 55, anything else counts as off): after that many idle minutes at the
  prompt, compact the main conversation while the cache is still warm, if the last main request's context is at least
  `compactMinContext` (new, default 100,000) and was at least 3 minutes inside the cache TTL. A new prompt or turn, or
  switching the router off, cancels the timer. It never runs while a subagent or teammate is pending, running or
  waiting: one re-check 5 minutes later while still inside the safe window, then it skips.
- `compactAtContext` (default 0 = off; below 100,000 also counts as off): compact between turns when the main context
  reaches this many tokens. A refused compaction is retried up to 3 times, 2 seconds apart, then falls back to the
  idle guard.
- Every compaction (the plugin's, a manual `/compact`, the engine's auto-compact) resets the router's cached context
  figures and cancels a pending compaction, so a summarised context is no longer kept on Opus as if it were warm.
- A compaction that is vetoed, or refused while a turn runs, is swallowed and not counted; a successful one shows a
  toast with the engine's before and after sizes when it reports them.
- The main thread's context is now tracked for every model family in its own variable, Fable included (`last` still
  skips Fable, which `keepWarm` never routes).
- `/model-router stats` counts idle compactions, cap compactions, and cache rewrites after the TTL (a main request after
  a gap over an hour, or the first request of a resumed process, that wrote 100k or more tokens and read almost none)
  with their write cost. A resume after the 1-hour TTL rewrites the whole context at 2x input: a 400k Opus context
  costs about $3.20 to rewrite against about $0.08 to read warm. Older stored counts read as 0.

## [0.8.2] - 2026-10-29

Fable blocking is now optional and counted honestly, the classifier fails less often, and it is skipped when its
verdict cannot change anything. Items 1 to 4 below were found in a review by Muhafiz Madzlan.

### Fixed
- Fable blocking was unconditional: the rewrite ran even with `mainRouting` off, so a user who runs Fable as the main
  model could not use subagent-only mode. New option `blockFable` (default on). Off: Fable is left alone on the main
  thread and on subagents (a subagent still never runs above its parent; its own cap stays Opus at medium, main can
  raise it to Opus at high). On with `mainRouting` off: the main thread's Fable is left alone, subagents are still kept
  off Fable. Reported by Muhafiz Madzlan.
- `Fable requests moved to Opus` counted every request; it now counts once per turn on the main thread and once per
  subagent. Reported by Muhafiz Madzlan.
- The `reviewModel` example `claude-fable-5-5` is not a real model id. README and the plugin description now say "a
  model id available on your account". Reported by Muhafiz Madzlan.
- The README now says next to the `reviewModel` option, not only under Privacy, that the reviewer is sent your request
  and Opus's answer unmasked. Reported by Muhafiz Madzlan.
- Classifier `unparseable` failures: the verdict is cut off at 120 tokens before its closing brace. The classifier's
  `maxTokens` is now 300, and a reply cut off after a valid tier parses as an unsure verdict (never a downgrade).
  The failure reason now carries the first 120 characters of the reply (single line, masked), for example
  `classifier failed (unparseable: ...)`, so the cause shows in the events log; `/model-router stats` still counts
  plain `unparseable`.

### Changed
- A main prompt whose last main request was Opus, within the cache TTL and with a context of 50,000 tokens or more,
  skips the classifier: the turn would stay on Opus whatever the tier. It routes as decide on Opus at medium ("warm
  large context: classifier skipped") with no Haiku call, and `/model-router stats` shows `Classifier skipped`. A
  `#model` pin still wins.

## [0.8.1] - 2026-10-29

Subagents no longer think longer on their own past a modest ceiling: hard judgement belongs to the main conversation,
which verifies what subagents return, and a subagent that keeps failing should report back.

### Changed
- A subagent's own cap is Opus at medium. The automatic ladder is now haiku/medium, haiku/high, sonnet/medium,
  sonnet/high, opus/medium, then stop (still capped by the parent's tier). A subagent's own `escalate` is capped the
  same way: haiku and sonnet may reach high, Opus stays at medium, and xhigh or max are cut down. `AUTO_EFFORT_CAP`
  (xhigh) is replaced by `SUBAGENT_SELF_CAP` and a per-model `SELF_EFFORT_CAP`.
- Hard ceiling for every tracked subagent, including ones that inherit the session's model and effort (decision work,
  Plan, named agents): a request is never sent above effort high, so an xhigh or max session sends them at high. xhigh
  and max are main-thread only. Forks and workflow agents are untouched.
- Escalations to max effort can now only come from the main thread, so the stats counter no longer includes subagents.

### Added
- The main conversation can raise a subagent: `escalate` takes an optional `agent` (the id the Agent tool returned).
  It is up-only and capped at Opus (never above the parent's tier, never Fable) at high. Unknown ids reply "No tracked
  subagent <id>."; a subagent passing `agent` is refused. Logged as `raised by main`.
- Ceiling guidance: when a subagent already at its cap hits three tool errors in a row again, the failing call's result
  gets a `[model-router] You are at the subagent ceiling (...)` note telling it to stop retrying and report to the main
  conversation. Logged as `ceiling reached`.

## [0.8.0] - 2026-10-29

Opus now decides how much effort it needs instead of starting every decision at high, and the router no longer walks
a failing subagent up to the most expensive effort on its own.

### Changed
- A decide turn starts Opus at medium effort (was high). A main-thread escalation to Opus lands at Opus · medium unless
  a higher effort is asked.
- The automatic subagent ladder is capped at xhigh (`AUTO_EFFORT_CAP`): at the ceiling it raises effort up to xhigh and
  then stops, and never sets max. A manual `escalate` may still set max.

### Added
- The Opus assignment now guides effort: medium for most work; high for multi-step design, plans or reviews; xhigh for
  hard debugging or architecture; max only for an irreversible, production-affecting decision or after an attempt at
  xhigh has failed.
- A max-effort counter: escalations (main thread or subagent) that move effort to max from below are shown in
  `/model-router stats` as "Escalations to max effort".

## [0.7.0] - 2026-10-29

Four days of real use showed main-turn routing losing money overall: 19 times a turn returned to Opus within the hour
and rewrote 200k-800k tokens of Opus cache, which cost far more than Sonnet or Haiku saved. This release stops that,
and makes the meter say so honestly.

### Fixed
- **Round trips.** While the main thread's last request is within the cache TTL (1 hour) and its context is 50,000
  tokens or more, the router never moves the main thread to a lower model; it keeps the warm one (`→ Opus (cache
  kept)`). Below 50,000 tokens the earlier cost comparison still applies. Upgrades are never blocked.
- **Notification turns.** A turn that starts without a person prompt (a task notification, an agent message, a
  scheduled prompt) used to run unrouted on the session model, adding a round trip away from the routed model. It now
  continues the previous main route while that route's cache is warm, and is logged as `turn inherit` rather than
  `turn route`. Without a previous route, or after the TTL, it stays unrouted.
- **Classifier fallback.** A failed classification no longer falls back to Sonnet (24% of those turns later escalated to
  Opus, against 6% of classified turns). It keeps the previous turn's tier; on a first turn with nothing to keep, the
  turn is left unrouted on the session model. A subagent's failed classification still runs on Sonnet.
- **Meter baseline.** The "all on Opus" baseline ignored the cache writes a model switch causes, so the saving shown was
  overstated. A main-thread step that changes model family within the TTL, going down or coming back up to Opus, now
  has its cache writes priced at Opus's cache-read rate in the baseline. Actual cost is unchanged.
- A subagent's or teammate's `turn.start` no longer takes the pending main route.

### Added
- `mainRouting` option (default on). Off is subagent-only mode, the low-risk way to start: no main-turn
  classification and no main model or effort rewrite, while subagent routing, escalation, Fable blocking and the meter
  keep working.
- The classifier failure reason (`timeout`, `api-error <status>`, `empty-reply`, `unparseable`, `exception`) is shown in
  the band, counted in `/model-router stats` ("Classifier failures"), and recorded in a subagent's start event.

### Changed
- The classifier timeout is 8 s (was 4 s).
- With no route (a new session, or `mainRouting` off) the band no longer draws an empty route row with a lone gear: the
  meter line takes that row, with the Disable or Enable button beside it. A fresh session now shows that row too.
- The `turn route` event for an unrouted first-turn failure has `to: "session model"`.

## [0.6.1] - 2026-10-26

### Fixed
- A long routing reason in the band is now cut at a word boundary and ends with an ellipsis. It used to be cut at 60
  characters wherever that fell, which could leave half a word (for example "scope of repo changes u"). The same
  applies to the reason shown after an escalation.

## [0.6.0] - 2026-10-26

First public release.

### Changed
- The events log directory is now `~/.claude/model-router/` (was `~/.claude/model-tiering/`). The file name
  (`events-<sessionId>.json`) and the JSON schema are unchanged; logs written by earlier versions are not moved.
- The assignment text the model reads beside your prompt now starts with `[model-router]`.

### Added
- README: a Requirements note, a Privacy section (what is sent to the classifier and the optional reviewer, what is
  masked, what is not collected), an Events log section with the file format, and a clearer statement that the
  meter's dollar figures are estimates.
- This changelog.

## [0.5.0] - 2026-10-26

### Changed
- Every tier starts at medium effort, subagents included, because effort can be raised later by the agent or by the
  automatic ladder.
- The main thread's decide tier stays Opus at high effort.
- A model change (manual or automatic) restarts the new model at medium, or at the effort asked for if that is
  higher, whatever effort the old model had.

## [0.4.0] - 2026-10-26

### Added
- Two-stage automatic escalation for subagents: after three tool errors in a row the effort goes up one step on the
  same model; after three more the next model is used at medium effort, and that model gets its own same-model retry.
  At the parent's tier only effort rises, up to max.
- The classifier reports whether it is sure.

### Changed
- An unsure verdict never downgrades: after a higher-tier turn the previous tier stays, a first turn never starts on
  lookup, and an unsure `general-purpose` subagent lookup runs on Sonnet instead of Haiku.

## [0.3.0] - 2026-10-26

### Added
- Subagent routing in `agent.spawn`: `Explore` runs on Haiku, `general-purpose` is sorted by the classifier, and
  `Plan`, named agents, forks and workflow agents are left alone. A subagent never runs above its parent's tier.
- Per-subagent effort.
- The `escalate` tool works inside a subagent (up only, capped at the parent's tier).
- Automatic escalation of a subagent after three tool errors in a row.
- A model-mismatch counter in `/model-router stats`: the model family that answered compared with the one asked for.
- An events log of main-turn routes and subagent events, with per-subagent usage by model and effort.

### Changed
- The decision reviewer (`reviewModel`) is off by default: with it empty the router makes no review call and no
  availability probe.

## [0.2.1] - 2026-10-23

### Changed
- The band language defaults to English.
- The band says "token" beside the token count and shows today's tokens as well as the turn's.

### Fixed
- Meter store writes are serialised, and the classifier's own call is counted in the turn.

## [0.2.0] - 2026-10-23

### Added
- The plugin became `claude-model-router`: routing only (Haiku for lookups, Sonnet for execution, Opus for
  decisions), with the model able to escalate itself and a savings meter.
- Likely secrets are masked before a message is sent to the classifier, and the route is bound before the turn starts.
