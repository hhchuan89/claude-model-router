# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

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
