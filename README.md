# prompt-coach

A Claude Code mod that grades every prompt you send and coaches you on writing better ones.

After each prompt, a band above the prompt box shows:

```
💡 [ B ]  No success criteria: Claude can't tell when it's done   [More] [Use rewrite] [×]
```

- **Grade** — A / B / C, measuring one thing only: the risk that Claude misreads the prompt or has to redo work.
  Prompt length and token cost are not criteria.
- **More** — up to three concrete tips: what is missing and why it would make Claude guess. Tips may also cover
  how well the prompt *leads* Claude (no "why", micromanaging steps, unclear authority, no checkpoint on a big task).
- **Use rewrite** — puts an improved prompt in the prompt box (or on the clipboard if the box can't be filled).
- A-grade prompts and pending analysis show as a single dim line. One-line confirmations of 5 characters or fewer
  ("yes", "做吧") are logged but not analyzed.

The prompt is sent to Claude right away; grading runs in the background and never delays your turn.

## Commands

- `/prompt-coach` — open the history pane (off by default, so it never takes your side panel).
- `/prompt-coach review` — summarize your recurring prompt habits over the last 7 days.

## Install

Requires Claude Code with function-hook mods (early access; built and tested on **2.1.295**). In a terminal session:

```
/plugin install prompt-coach --marketplace hhchuan89/prompt-coach
```

Answer `y` to add the marketplace, pick a scope, and set the options. Once installed at user scope it also loads
in Claude Code Desktop sessions.

## Options

| Option     | Values          | Default  | Meaning                                              |
|------------|-----------------|----------|------------------------------------------------------|
| `language` | `zh`, `en`      | `zh`     | Language of verdicts, tips and the weekly review     |
| `model`    | `sonnet`, `opus`| `sonnet` | Model that grades each prompt                        |

## Cost and privacy

- **Every prompt you send costs one extra model call on your own account** (plus one per `/prompt-coach review`).
- Prompts and advice are logged locally to `~/.claude/prompt-coach/log/YYYYMMDD.jsonl`; files older than 90 days
  are deleted at session start.
- Before anything is logged or sent for grading, likely secrets are masked: API keys (Anthropic, OpenAI, GitHub,
  Slack, AWS, Google), Telegram bot tokens, JWTs, private-key blocks, `TOKEN=...`-style assignments, and any
  64-character hex string (this also masks transaction hashes, on purpose).
- Only prompts you type are graded; task notifications, scheduled prompts, peer sessions and other plugins are skipped.

## Development

```
claude plugin validate .
claude plugin test .
```
