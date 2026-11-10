import type { ManagerMessage, ManagerSummary } from '@open-mercato/cezar-api-client'
import type { MascotActivity } from './mascot-motion'

export function managerMascotActivity(manager: ManagerSummary, messages: readonly ManagerMessage[]): MascotActivity {
  if (manager.status === 'error') return 'error'
  if (manager.pendingActions > 0 || manager.pendingQuestions > 0) return 'waiting'
  if (manager.status !== 'working') return 'idle'
  const latest = [...messages].reverse().find((message) => message.kind === 'assistant')
  if (latest?.kind !== 'assistant' || !latest.streaming) return 'thinking'
  if (latest.commands.length > 0) return 'working'
  return latest.text.trim() ? 'present' : 'thinking'
}

/** Only newly observed explicit outcomes celebrate; completing a turn alone says nothing. */
export function mascotReaction(previous: ManagerMessage | undefined, next: ManagerMessage): 'success' | 'alert' | undefined {
  if (next.kind === 'action' && next.status === 'done' && (previous?.kind !== 'action' || previous.status !== 'done')) return 'success'
  if (next.kind === 'assistant' && next.important && (previous?.kind !== 'assistant' || !previous.important)) return 'alert'
  return undefined
}
