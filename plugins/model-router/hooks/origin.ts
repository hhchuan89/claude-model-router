import type { PromptOrigin } from 'claude-code'

// Prompts from these origins (and a plugin relaying with asUser) are the person's;
// task notifications, schedulers, peers and other plugins are not theirs to coach.
const PERSON = new Set(['composer', 'bridge', 'sdk', 'unclassified'])

// An origin left unstamped is the person's own, as the engine reads it.
export function isPersonOrigin(origin: PromptOrigin | undefined): boolean {
  if (origin === undefined) return true
  if (origin.kind === 'plugin') return origin.asUser === true
  return PERSON.has(origin.kind)
}
