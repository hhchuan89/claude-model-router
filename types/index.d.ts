export type Grade = 'A' | 'B' | 'C'

export type Advice = {
  id: string
  at: string
  prompt: string
  status: 'pending' | 'done' | 'error'
  grade: Grade | null
  verdict: string
  tips: string[]
  rewrite: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'prompt-coach': {
      entries: Advice[]
      // the prompt sent back to the composer for review; the next send goes straight through
      held: { id: string; original: string } | null
      enabled: boolean
      isExpanded: boolean
    }
  }
}
