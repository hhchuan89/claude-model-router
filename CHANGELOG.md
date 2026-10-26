# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

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
