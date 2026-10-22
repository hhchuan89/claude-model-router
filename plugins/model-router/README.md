# model-router

Picks the Claude model and effort for every turn you start, and lets the running model move itself up before it works.

| Tier | Model · effort | What lands here |
|------|----------------|-----------------|
| lookup | Haiku · low | Retrieval and mechanical work with nothing to judge: find/grep/list, read a value or status, run a named command, rename, typo, format, short translation |
| execute | Sonnet · medium | Work whose "what" is settled: a specified change, a bug with a known cause, tests, refactor to a stated target, docs from known material, explaining code, carrying out an agreed plan |
| decide | Opus · high | Anything that needs judgment first: design, choosing between approaches, trade-offs, plans, unexplained failures, reviews, recommendations, ambiguous requests, anything irreversible or outward-facing |

How a turn is routed:

1. When you send a prompt, Haiku (low effort, 4 s cap) classifies it with the last two messages as context. A short
   continuation ("yes", "继续") keeps the previous tier; a mix of tiers takes the highest; when unsure it picks the
   higher tier. If classification fails, the turn runs on Sonnet · medium. `#haiku`, `#sonnet` or `#opus` in a
   message pins the model and skips the classifier.
2. The model reads its assignment beside your prompt and must judge **before doing any work** whether the task fits.
   If it does not, it calls the `escalate` tool first: Haiku may move to Sonnet or Opus or raise its effort, Sonnet
   may move to Opus or raise its effort, Opus may set any effort. Escalation only goes up within a turn.
3. Every model request of the turn runs on the route (`turn.step`), keeping a context-window suffix such as `[1m]`.
   Subagents keep the model they were given.
4. **Fable 5.1 never runs**, in the main thread or in a subagent: such a request goes to Opus instead.
5. If **Fable 5.5** exists on your account (checked once a day), each Opus turn's decision is reviewed by it and the
   review is added to the conversation as a notice. Fable 5.1 is never used as a reviewer.

The band shows the route and any escalation, e.g. `⚙ Haiku · low → opus · high (要做设计决策) — 找文件`.
**Disable router** (or `/model-router off`) leaves every request on the session's model; the choice is kept.

## Options

`language` (zh/en) for the reason line; `haikuModel`, `sonnetModel`, `opusModel` model ids (defaults
`claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`); `reviewModel` (default `claude-fable-5-5`).

## Costs to know

- One Haiku call per prompt you send.
- Switching models between turns loses the prompt cache for that turn: on a long conversation the new model reads
  the whole context at its uncached price. Within a turn the route only moves up.
