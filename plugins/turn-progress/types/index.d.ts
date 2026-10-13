export type TaskState = 'pending' | 'in_progress' | 'completed'

export type Run = {
  startedAt: number
  endedAt: number | null
  isAborted: boolean
  // task id → status; only tasks created or updated during this turn
  tasks: Record<string, TaskState>
  order: string[]
  // task id → what to show while it runs (activeForm, else subject)
  labels: Record<string, string>
  active: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'turn-progress': {
      run: Run | null
      now: number
      enabled: boolean
    }
  }
}
