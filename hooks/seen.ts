// What the engine has handed this router in the current session lifetime. Each figure is counted at the top of its
// hook, once the session is known and before any other check (router paused, origin, routing mode), so it says what
// was delivered, not what the router did with it.
// WHY: measured 2026-11-10 (engines 2.1.317 to 2.1.321): in five sessions, 163 main-thread requests ran on Fable with
// blockFable and mainRouting at their defaults. Four of those sessions show no router activity at all; in the fifth
// the router routed other turns. In each, Fable had been picked with /model inside the session. Sessions that
// started with Fable already the default were routed as usual. Nothing on screen told the two apart, and whether
// the router was paused in the silent ones cannot be read back afterwards. The cause is not known; these counts
// are what tells "the router chose to leave it" from "the router never saw it".
export type Seen = { prompts: number; turns: number; steps: number; spawns: number }

export function nothingSeen(): Seen {
  return { prompts: 0, turns: 0, steps: 0, spawns: 0 }
}

// The status line: `Seen this session: prompts 3 · main turns 3 · main requests 41 · subagent starts 2 · session model fable`.
export function seenLine(label: string, s: Seen, sessionModel: string | undefined): string {
  return `${label}: prompts ${s.prompts} · main turns ${s.turns} · main requests ${s.steps} · subagent starts ${s.spawns} · session model ${sessionModel || 'unknown'}`
}

// A Fable session with a conversation in it (context measured above zero) none of whose main requests has reached
// the router: nothing in it is routed or counted. Keyed on what was observed, not on the model alone: a new Fable
// session has nothing to have missed, and once one request arrives the router is working on this session.
export function isUnseenFable(sessionModel: string | undefined, s: Seen, context: number | undefined): boolean {
  return /fable/i.test(sessionModel ?? '') && s.steps === 0 && (context ?? 0) > 0
}
