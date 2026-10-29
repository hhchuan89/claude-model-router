# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

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
