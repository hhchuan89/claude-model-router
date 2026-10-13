# prompt-cockpit

Instruments for the space above the Claude Code prompt box. Two mods, each installable on its own:

| Mod | What it does |
|-----|--------------|
| [`prompt-coach`](plugins/prompt-coach) | Checks each prompt **before** Claude starts. Clear prompts go straight through; unclear ones come back to the prompt box with a grade, tips and a rewrite you can use or edit. |
| [`turn-progress`](plugins/turn-progress) | A progress bar for every turn: real progress when Claude keeps a task list, an honest time estimate otherwise, then a one-line finish summary. |

```
▸ Running tests    ▰▰▰▱▱                         2/5 · 3:42 · ≈21:58  [Disable]
💡 [ B ] No success criteria: Claude can't tell when it's done   [More] [Use mine] [Use rewrite] [Disable]
```

## Install

Requires Claude Code with function-hook mods (early access; built and tested on **2.1.295**). In a terminal session:

```
/plugin install prompt-coach --marketplace hhchuan89/prompt-cockpit
```

```
/plugin install turn-progress --marketplace hhchuan89/prompt-cockpit
```

Answer `y` to add the marketplace and pick a scope. Installed at user scope, they also load in Claude Code Desktop.

Both mods have a **Disable / Enable** button in the band (also `/prompt-coach off|on`, `/turn-progress off|on`);
the choice is kept across sessions.

## Development

```
claude plugin validate plugins/prompt-coach
claude plugin test plugins/prompt-coach
```

## License

MIT
