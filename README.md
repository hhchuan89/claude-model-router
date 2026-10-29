# claude-model-router

A local, private model router for [Claude Code](https://claude.com/claude-code). Every turn you start runs on the
cheapest Claude model that can do it well, and a meter shows roughly how much that saved compared with running
everything on Opus.

It does what [Jev](https://www.pulumi.com/blog/route-every-claude-code-message-to-the-right-model-with-jev/) and
`jev-router` do, with one difference that matters at work: **nothing leaves your Anthropic account.** Jev classifies
your messages on a third-party service (TypeSafe AI or OpenRouter); this router classifies them with Claude Haiku on
the same account Claude Code already uses. No proxy, no background service, no extra API key.
This is an independent project and is not affiliated with TypeSafe AI or Jev.

> **Requirements**
> Claude Code with function-hook plugins (the `register.tsx` hooks API), an early-access feature at the time of
> writing. Tested on Claude Code 2.1.295–2.1.308 on Windows. If your Claude Code does not support function hooks, the
> plugin installs but does nothing.

![The router's band above the Claude Code prompt](docs/band.png)

The band above the prompt, from a real session: the route for this turn and why (here an ambiguous follow-up, so the
router would not start it on Haiku), then this turn's and today's tokens with an estimated saving against running
everything on Opus. The numbers are one person's working day, not a typical result.

## How a turn is routed

| Tier | Model · effort | What lands here |
|------|----------------|-----------------|
| lookup | Haiku · medium | Retrieval and mechanical work with nothing to judge: find/grep/list, read a value or status, run a named command, rename, typo, format, short translation |
| execute | Sonnet · medium | Work whose "what" is settled: a specified change, a bug with a known cause, tests, refactor to a stated target, docs from known material, explaining code, carrying out an agreed plan |
| decide | Opus · medium | Anything that needs judgment first: design, choosing between approaches, trade-offs, plans, unexplained failures, reviews, recommendations, ambiguous requests, anything irreversible or outward-facing |

1. **Classify.** When you send a prompt, Haiku (low effort, 8 s cap) sorts it with the last two messages as context.
   A short continuation ("yes", "继续") keeps the previous tier, a mix of tiers takes the highest, and when unsure it
   picks the higher tier. The classifier also says whether it is sure; **an unsure verdict never downgrades**: after a
   higher-tier turn the previous tier stays (shown as "unsure: not downgrading"), a first turn never starts on lookup
   (it runs on Sonnet), and an unsure `general-purpose` subagent lookup runs on Sonnet instead of Haiku. Likely secrets
   are masked before classification. **A failed classification never downgrades**: the turn keeps the previous turn's
   tier ("classifier failed (timeout): kept previous tier"), or, on a first turn with nothing to keep, is left unrouted
   on your own session model and effort ("classifier failed (...): session model"). The reason is one of `timeout`,
   `api-error <status>`, `empty-reply`, `unparseable` or `exception`, and `/model-router stats` counts them. In
   earlier versions a failure ran on Sonnet, and 24% of those turns later escalated to Opus (6% of classified turns did).
   `#haiku`, `#sonnet` or `#opus` in a message pins the model.
2. **Decide before working.** The model reads its assignment beside your prompt and must judge whether the task fits
   *before* doing any work. If not, it calls the `escalate` tool first: Haiku may move to Sonnet or Opus or raise its
   effort, Sonnet may move to Opus or raise its effort, Opus may set any effort. A move to a higher model lands at that
   tier's effort in the table (Sonnet medium, Opus medium) unless a higher effort is asked. Escalation only goes up within a turn.
   Effort-only escalation (same model, more effort) exists for the main thread and for subagents alike.
   **Opus picks its own effort.** Its assignment starts it at medium and says when to ask for more: medium for most
   work; high for multi-step design, plans or reviews; xhigh for hard debugging or architecture; max only for an
   irreversible, production-affecting decision or after an attempt at xhigh has failed. Max is the most expensive
   setting, so it is meant to be rare, and `/model-router stats` counts every escalation to max.
3. **Route every request.** Each model request of the turn runs on the route, keeping a context-window suffix such as `[1m]`.
4. **Never leave a warm cache for a cheaper model (the round-trip guard).** Switching to a smaller model makes it read
   the whole context uncached, and coming back to the bigger one rewrites that cache again. Real use showed this
   costing far more than the cheaper model saved: 19 times in four days a turn returned to Opus within the hour and
   rewrote 200k-800k tokens. So while the main thread's last request is within the cache TTL (1 hour) and its context
   is **50,000 tokens or more** (`WARM_CONTEXT_KEEP` in `hooks/meter.ts`), the router never moves the main thread to
   a lower model: it keeps the model that is warm (shown as `→ Opus (cache kept)`). Below 50,000 tokens the router
   still compares the two costs over the turn's expected steps and stays only if switching would cost more. Moving
   *up* is never blocked, and after the TTL the cache is cold, so a downgrade is allowed.
   Turns that start without a person prompt (a background task's notification, an agent message, a scheduled prompt)
   are never classified; while the previous route's cache is warm they **continue that route** ("continues previous
   route") instead of running on the session model. After the TTL, or with no previous route, they stay unrouted.
5. **Route subagents.** A subagent spawned without a model gets one by its job, decided when it starts:
   `Explore` runs on Haiku · medium; `general-purpose` is sorted by the same classifier (lookup → Haiku · medium,
   execute → Sonnet · medium, decide → inherits the parent's model, never a pinned Opus; if classification fails,
   Sonnet). Pinned subagents start at medium on every model, because effort can be raised later, by the agent or by
   the automatic ladder below. `Plan` and named or custom agents declare or inherit their own model and are left alone, as are forks and
   workflow agents. A subagent never runs above its parent's tier. A model the caller names is kept, except that it is
   capped at the parent's tier.
6. **Subagents can escalate, and are escalated.** The same `escalate` tool works inside a subagent: it may raise its own
   model or effort from its next step, up to the parent's tier. A model change starts the new tier at medium, or at the asked effort if higher,
   whatever effort the old model had (a Haiku at xhigh raised to Sonnet runs Sonnet · medium: a bigger model at medium
   beats a smaller one at max). Effort-only escalation on the same model only goes up. The router also escalates a failing subagent by itself, in two stages. After three tool errors in a row it
   first raises the effort one step on the same model (Haiku · medium → Haiku · high; cheaper than a model switch, and
   often enough). If three more errors follow at that tier, it moves to the next model at medium (Haiku · high →
   Sonnet · medium), and the new model gets its own same-model retry. At the parent's tier only effort rises, and the automatic ladder stops at xhigh: it never sets max
   (`AUTO_EFFORT_CAP` in `hooks/subagent.ts`), so an agent that merely keeps failing cannot run up the most expensive
   setting. An agent that inherits the session's effort counts as `high`. A manual `escalate` from the subagent may
   still set max. Escalation only goes up.
7. **No Fable 5.1.** Any request or subagent asking for Fable runs on Opus instead, and a Fable parent never passes
   Fable down. Optionally, set `reviewModel` (for example `claude-fable-5-5`) and, if that model exists on your account
   (checked once a day), each Opus decision is reviewed by it and the review is added as a notice. The reviewer is off
   by default: with `reviewModel` empty the router makes no review call and no availability probe.
8. **Check the routing took effect.** After each request the router compares the model family that answered with the
   family it asked for; any difference is counted as a model mismatch in `/model-router stats`.

## Events log

The router writes one JSON file per session to `~/.claude/model-router/events-<sessionId>.json` (the `.claude`
directory is the one the plugin is installed under). It stays on your machine and is there for your own analysis;
nothing reads it back except the router itself, to keep a session's log across a reload. Writing is best effort and
never affects a turn.

```
{
  "sessionId": "...",
  "events": [{ "at": "<ISO time>", "agentId": "...", "event": "...", "to": "...", "reason": "..." }],
  "stats": {
    "<agentId>": {
      "byModel": { "<modelId>": { "steps": 0, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } },
      "byEffort": { "<effort>": 0 }
    }
  }
}
```

`event` is one of: `turn route` (agent `main`, the route chosen for a turn), `turn inherit` (agent `main`, a turn without
a person prompt that continued the previous route), `<subagentType> start` (a subagent
started, for example `Explore start`), `escalated` (a subagent raised its own model or effort) and `auto-escalated`
(the router raised it after repeated tool errors). `byEffort` counts steps per effort; `default` means the session's
own effort. `stats` covers routed subagents only.

## Privacy

- **Where classification runs.** On Claude Haiku, through the same Anthropic account Claude Code already uses: no third
  party, no proxy, no extra key.
- **What the classifier receives.** The new message, capped at 6,000 characters, plus the last two non-empty messages of
  the conversation (each trimmed to its first 200 and last 1,000 characters when longer than 1,200). All three are
  masked by `hooks/redact.ts` before they are sent (context messages before trimming): private-key blocks, Anthropic and OpenAI-style keys, GitHub, Slack and
  Telegram tokens, AWS and Google API keys, JSON web tokens, `Bearer` tokens, 64-character hex strings, and values
  assigned to names containing `api_key`, `secret`, `token`, `password` or `pwd`. This is pattern matching and will not
  catch every secret.
- **Subagents.** When a `general-purpose` subagent is started without a model, its prompt (masked and capped the same
  way, without the conversation context) goes to the classifier.
- **Nothing else is collected.** No telemetry and no analytics. The router makes no network call of its own: the only
  traffic is the Anthropic API calls Claude Code makes, now including the router's Haiku calls. The meter totals and
  the events log are written to local files only.
- **Optional reviewer (off by default).** If you set `reviewModel`, each Opus decision is sent to that model after the
  turn: your request (first 6,000 characters) and the last 12,000 characters of Opus's answer, not masked. Once a day it
  also sends a one-word probe to check the model exists. With `reviewModel` empty, none of this happens.

## How much you saved

Every model request (the router's own Haiku calls included) is priced at Anthropic API rates and added to the turn,
the day and the all-time totals. The baseline prices the same tokens on Opus 5.5. The band shows this turn and today;
`/model-router stats` shows today and all time by model, plus how many turns went to each tier, escalations, warm-cache
keeps, routed subagents, Fable requests moved to Opus, model mismatches (routed model not the one that answered),
classifier failures by reason and escalations to max effort (main thread and subagents, counted when effort moves to
max from below).

This is an estimate; see "Assumptions in the meter" below.

## Install

Requires Claude Code with function-hook plugins (early access; tested on 2.1.295–2.1.308). In a terminal session:

```
/plugin install model-router --marketplace hhchuan89/claude-model-router
```

Answer `y` to add the marketplace and pick a scope. Installed at user scope it also loads in Claude Code Desktop.
**Disable router** in the band, or `/model-router off`, leaves every request on the session's model. To keep subagent routing
but leave your own conversation alone, turn `mainRouting` off instead (see Options).

## Options

| Option | Default | Meaning |
|--------|---------|---------|
| `language` | `en` | Language of the reason line and the savings line (`en` or `zh`) |
| `mainRouting` | on | On: every turn you start is classified and routed. Off: **subagent-only mode, the low-risk way to start.** The main thread is never classified or rewritten (your session model and effort stay as they are, and no assignment text is added to your prompts), while subagent routing, subagent escalation and automatic escalation, Fable blocking and the savings meter keep working |
| `haikuModel` / `sonnetModel` / `opusModel` | `claude-haiku-5-5` / `claude-sonnet-5-5` / `claude-opus-5-5` | Model ids per tier |
| `reviewModel` | empty (off) | Model that reviews Opus decisions, e.g. `claude-fable-5-5`, only if it exists on your account; Fable 5.1 is never used |

## Assumptions in the meter

The dollar figures are **estimates**, computed from the price table in `hooks/meter.ts` (Anthropic first-party API
rates, as of 2026-10). They may differ from your actual pricing or plan: on a subscription you pay in usage limits, not
dollars, and another model would not have used exactly the same tokens. **The percentage is the more useful number.**

Prices per million tokens in the table: Opus 5.5 $4 in / $20 out, Sonnet 5.5 $2 / $10, Haiku 5.5 $0.10 / $0.50; cache
reads $0.20 (Haiku assumed at 10% of input); cache writes at 2× input (Claude Code's 1-hour cache TTL). Change
`hooks/meter.ts` if your rates differ.

**The baseline is switch-aware.** When a main-thread request changes model family within the cache TTL (down to a
cheaper model, or back up to Opus), its cache writes exist only because of the switch: staying on Opus all along would
have read that context from a warm cache. The baseline therefore prices those cache-write tokens at Opus's cache-read
rate, not its write rate, so a round trip no longer shows a saving that was not there. The actual cost is unchanged.

## Development

```
claude plugin validate .
claude plugin test .
```

## License

MIT
