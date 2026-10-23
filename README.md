# claude-model-router

A local, private model router for [Claude Code](https://claude.com/claude-code). Every turn you start runs on the
cheapest Claude model that can do it well, and a meter shows roughly how much that saved compared with running
everything on Opus.

It does what [Jev](https://www.pulumi.com/blog/route-every-claude-code-message-to-the-right-model-with-jev/) and
`jev-router` do, with one difference that matters at work: **nothing leaves your Anthropic account.** Jev classifies
your messages on a third-party service (TypeSafe AI or OpenRouter); this router classifies them with Claude Haiku on
the same account Claude Code already uses. No proxy, no background service, no extra API key.
This is an independent project and is not affiliated with TypeSafe AI or Jev.

```
⚙ Sonnet · medium — implement the agreed plan                         [Disable router]
  turn 21.2k · $0.04   today $1.20, saved ≈$3.10 (72%) vs all on Opus
```

## How a turn is routed

| Tier | Model · effort | What lands here |
|------|----------------|-----------------|
| lookup | Haiku · low | Retrieval and mechanical work with nothing to judge: find/grep/list, read a value or status, run a named command, rename, typo, format, short translation |
| execute | Sonnet · medium | Work whose "what" is settled: a specified change, a bug with a known cause, tests, refactor to a stated target, docs from known material, explaining code, carrying out an agreed plan |
| decide | Opus · high | Anything that needs judgment first: design, choosing between approaches, trade-offs, plans, unexplained failures, reviews, recommendations, ambiguous requests, anything irreversible or outward-facing |

1. **Classify.** When you send a prompt, Haiku (low effort, 4 s cap) sorts it with the last two messages as context.
   A short continuation ("yes", "继续") keeps the previous tier, a mix of tiers takes the highest, and when unsure it
   picks the higher tier. Likely secrets are masked before classification. If classification fails, the turn runs on
   Sonnet · medium. `#haiku`, `#sonnet` or `#opus` in a message pins the model.
2. **Decide before working.** The model reads its assignment beside your prompt and must judge whether the task fits
   *before* doing any work. If not, it calls the `escalate` tool first: Haiku may move to Sonnet or Opus or raise its
   effort, Sonnet may move to Opus or raise its effort, Opus may set any effort. Escalation only goes up within a turn.
3. **Route every request.** Each model request of the turn runs on the route, keeping a context-window suffix such as `[1m]`.
4. **Keep a warm cache when it is cheaper.** Switching to a smaller model makes it read the whole context uncached. When
   the context is large and the bigger model's cache is still warm, the router compares the two costs over the turn's
   expected steps and stays on the warm model if switching would cost more (shown as `→ Opus (cache kept)`).
5. **Route subagents.** A subagent spawned without a model gets one by its job: `Explore` on Haiku, `Plan` on Opus,
   others by the same classifier (lookup → Haiku, execute → Sonnet, decide → Opus). A model the caller names is kept.
6. **No Fable 5.1.** Any request or subagent asking for Fable runs on Opus instead. If **Fable 5.5** exists on your
   account (checked once a day), each Opus decision is reviewed by it and the review is added as a notice.

## How much you saved

Every model request (the router's own Haiku calls included) is priced at Anthropic API rates and added to the turn,
the day and the all-time totals. The baseline prices the same tokens on Opus 5.5. The band shows this turn and today;
`/model-router stats` shows today and all time by model, plus how many turns went to each tier, escalations, warm-cache
keeps and routed subagents.

This is an estimate: another model would not use exactly the same tokens, and on a subscription plan you pay in usage
limits rather than dollars. The percentage is the useful number either way.

## Install

Requires Claude Code with function-hook plugins (early access; tested on 2.1.295–2.1.308). In a terminal session:

```
/plugin install model-router --marketplace hhchuan89/claude-model-router
```

Answer `y` to add the marketplace and pick a scope. Installed at user scope it also loads in Claude Code Desktop.
**Disable router** in the band, or `/model-router off`, leaves every request on the session's model.

## Options

| Option | Default | Meaning |
|--------|---------|---------|
| `language` | `en` | Language of the reason line and the savings line (`en` or `zh`) |
| `haikuModel` / `sonnetModel` / `opusModel` | `claude-haiku-5-5` / `claude-sonnet-5-5` / `claude-opus-5-5` | Model ids per tier |
| `reviewModel` | `claude-fable-5-5` | Reviews Opus decisions only if it exists on your account; Fable 5.1 is never used |

## Assumptions in the meter

Prices per million tokens (Anthropic first-party, as of 2026-10): Opus 5.5 $4 in / $20 out, Sonnet 5.5 $2 / $10,
Haiku 5.5 $0.10 / $0.50; cache reads $0.20 (Haiku assumed at 10% of input); cache writes at 2× input (Claude Code's
1-hour cache TTL). Change `hooks/meter.ts` if your rates differ.

## Development

```
claude plugin validate .
claude plugin test .
```

## License

MIT
