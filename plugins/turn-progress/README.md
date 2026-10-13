# turn-progress

A progress bar above the prompt box for every turn you start.

- **Task mode** — when Claude keeps a task list (TaskCreate / TaskUpdate / TodoWrite), the bar has one segment per
  task, the label shows the step in progress, and the right side reads `done/total · elapsed · ≈finish time`.
  The finish time is projected from the pace of the tasks done so far.
- **Estimate mode** — without a task list there is no real progress to show, so the bar eases toward 90% based on
  the median of your last 30 turn durations, drawn striped so it never reads as measured progress. No finish time
  is shown in this mode.
- **Finish** — the bar collapses to one dim line, `✓ 4m12s · 21:46 → 21:50` (`■` if you interrupted it), and stays
  until your next prompt, so you can see when a long turn finished after stepping away.

Desktop draws an "aurora" bar in SVG: a clay-to-coral gradient with a light sweeping across it and a soft glow at
the front; the running task pulses. The terminal uses eighth-block characters. It redraws once a second while a turn runs.

**Disable / Enable** in the band (or `/turn-progress off|on`) pauses it; the choice is kept across sessions.
A prompt that another mod holds back (prompt-coach) starts no bar.
