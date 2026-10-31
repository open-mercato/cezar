import type { ManagerMessage, ManagerSummary } from '@open-mercato/cezar-api-client'

/** Test fixtures only: nothing in the shipped bundle imports this. */
export function managerFixture(overrides: Partial<ManagerSummary> = {}): ManagerSummary {
  return {
    id: 'global',
    name: 'Global Manager',
    instructions: 'Watch everything',
    avatar: 0,
    projects: 'all',
    cronMinutes: 15,
    jobs: [],
    createdAt: '2026-10-30T10:00:00.000Z',
    updatedAt: '2026-10-30T10:00:00.000Z',
    status: 'idle',
    connectedProjectIds: ['alpha', 'beta'],
    unread: 0,
    important: 0,
    pendingActions: 0,
    costUsd: 0,
    ...overrides,
  }
}

export const userMessage = (seq: number, text = 'jak progres prac'): ManagerMessage => ({
  id: `m${seq}`, seq, at: '2026-10-31T09:18:00.000Z', kind: 'user', text,
})

export const assistantMessage = (
  seq: number,
  overrides: Partial<Extract<ManagerMessage, { kind: 'assistant' }>> = {},
): ManagerMessage => ({
  id: `m${seq}`,
  seq,
  at: '2026-10-31T09:18:10.000Z',
  kind: 'assistant',
  text: 'All good.',
  turn: 'chat',
  streaming: false,
  commands: [],
  ...overrides,
})

export const actionMessage = (
  seq: number,
  overrides: Partial<Extract<ManagerMessage, { kind: 'action' }>> = {},
): Extract<ManagerMessage, { kind: 'action' }> => ({
  id: `a${seq}`,
  seq,
  at: '2026-10-31T09:19:00.000Z',
  kind: 'action',
  action: { type: 'merge-pr', projectId: 'alpha', number: 12, title: 'Fix the thing', method: 'squash' },
  reason: 'Checks are green.',
  status: 'pending',
  ...overrides,
})
