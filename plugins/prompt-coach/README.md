# prompt-coach

Checks each prompt before Claude starts working on it.

1. You press Enter. The prompt is held while a model grades it (up to 8 seconds; **Send now** skips the wait).
2. **A** (clear enough that Claude won't guess wrong) goes straight through.
3. **B / C** does not reach Claude. Your prompt comes back to the prompt box, unchanged, and the band shows:

```
💡 [ B ]  No success criteria: Claude can't tell when it's done   [More] [Use mine] [Use rewrite] [Disable]
   Your prompt is back in the box: edit it, then press Enter to send
```

- **More** shows up to three tips: what is missing and why it would make Claude guess or redo work. Tips may
  also cover how well the prompt leads Claude (no "why", micromanaging, unclear authority, no checkpoint).
- **Use rewrite** puts the improved prompt in the box; **Use mine** puts yours back. Edit either, then press
  Enter: the send after a hold is never checked again.

The grade measures one thing only: the risk that Claude misreads the prompt or has to redo work. Prompt length
and token cost are not criteria. One-line confirmations of 5 characters or fewer ("yes", "做吧") are never held.
If grading fails or times out, the prompt goes through: the coach never blocks you.

## Commands

- `/prompt-coach` — open the history pane (off by default, so it never takes your side panel).
- `/prompt-coach review` — summarize your recurring prompt habits over the last 7 days.
- `/prompt-coach off` / `on` — same as the Disable / Enable button; kept across sessions.

## Options

| Option     | Values           | Default  | Meaning                                          |
|------------|------------------|----------|--------------------------------------------------|
| `language` | `zh`, `en`       | `zh`     | Language of verdicts, tips and the weekly review |
| `model`    | `sonnet`, `opus` | `sonnet` | Model that grades each prompt                    |

## Cost and privacy

- **Every prompt you send costs one extra model call on your own account** (plus one per `/prompt-coach review`).
- B/C prompts add a few seconds before Claude starts; A prompts add the grading time (usually 2–6 s).
- Prompts and advice are logged locally to `~/.claude/prompt-coach/log/YYYYMMDD.jsonl`; files older than 90 days
  are deleted at session start.
- Before anything is logged or sent for grading, likely secrets are masked: API keys (Anthropic, OpenAI, GitHub,
  Slack, AWS, Google), Telegram bot tokens, JWTs, private-key blocks, `TOKEN=...`-style assignments, and any
  64-character hex string (this also masks transaction hashes, on purpose).
- Only prompts you type are checked; task notifications, scheduled prompts, peer sessions and other plugins are skipped.
