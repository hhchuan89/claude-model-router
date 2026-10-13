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
      // id of the entry the person closed in the band
      hidden: string
      isExpanded: boolean
    }
  }
}
