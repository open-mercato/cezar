import type { UiToolItem } from '@open-mercato/cezar-api-client'

import { stripControlMarkers } from '@/lib/cards'
import { askAnswerLines } from '../task-thread/ask-answer-summary'
import type { ThreadAsk, ThreadState } from '../task-thread/thread-state'

/**
 * The card wizard's chat (mockup 3) as flat rows: the task view's reduced thread, minus what a
 * stage conversation does not need — reasoning, sub-agent items, the run's opening prompt — with
 * tool calls folded into one line and an ask's structured answer read back on the ask itself.
 */
export type ChatRow =
  | { kind: 'me'; id: string; text: string; ts?: string }
  | { kind: 'ai'; id: string; text: string; ts?: string }
  | { kind: 'tools'; id: string; tools: UiToolItem[]; ts?: string }
  | { kind: 'ask'; id: string; ask: ThreadAsk; ts?: string }
  | { kind: 'note'; id: string; text: string; tone: 'dim' | 'danger' | 'info' }

export function chatRows(thread: ThreadState): ChatRow[] {
  // A form answer ("Header: choice" per line) is shown on its ask, so its user turn is not repeated.
  const formAnswers = new Set<string>()
  for (const turn of thread.turns) {
    for (const item of turn.items) {
      if (item.kind === 'ask' && item.answer && askAnswerLines(item, item.answer)) formAnswers.add(item.answer.trim())
    }
  }
  const rows: ChatRow[] = []
  for (const turn of thread.turns) {
    const ts = turn.startedAt
    const user = turn.userMessage?.text.trim()
    if (user && !formAnswers.has(user)) rows.push({ kind: 'me', id: `${turn.id}:me`, text: user, ts: turn.userMessage?.ts ?? ts })
    for (const item of turn.items) {
      if ('parentItemId' in item && item.parentItemId) continue
      switch (item.kind) {
        case 'message': {
          const text = item.role === 'assistant' ? stripControlMarkers(item.text).trim() : item.text.trim()
          if (!text || (item.role === 'user' && formAnswers.has(text))) break
          rows.push({ kind: item.role === 'assistant' ? 'ai' : 'me', id: item.id, text, ts })
          break
        }
        case 'tool': {
          const last = rows[rows.length - 1]
          if (last?.kind === 'tools') last.tools.push(item)
          else rows.push({ kind: 'tools', id: item.id, tools: [item], ts })
          break
        }
        case 'ask':
          rows.push({ kind: 'ask', id: item.id, ask: item, ts })
          break
        case 'note':
          if (item.text.trim()) rows.push({ kind: 'note', id: item.id, text: item.text, tone: item.tone })
          break
        case 'provider-auth-required':
          rows.push({ kind: 'note', id: item.id, text: 'The agent’s account needs to reconnect — open the task view.', tone: 'danger' })
          break
        case 'agent-update-required':
          rows.push({ kind: 'note', id: item.id, text: 'The agent’s CLI needs an update — open the task view.', tone: 'danger' })
          break
        default:
          break
      }
    }
  }
  return rows
}
