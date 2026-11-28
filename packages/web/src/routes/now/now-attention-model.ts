import type { AttentionItem, AttentionKind } from '@open-mercato/cezar-api-client'

import { taskPath } from '@/routes/manager/manager-session-card'

/**
 * Now as the one list (spec 2026-11-20-phone-notifications-inbox, variant D): the server's attention
 * list, scoped. "This project" keeps Now's own task rows and adds the items of managers connected to
 * the project; "All" is the list itself, whose count is this computer's share of the icon badge.
 */

export type NowScope = 'project' | 'all'

export const NOW_SCOPE_KEY = 'cez.now.scope'

export function readNowScope(): NowScope {
  try {
    return globalThis.localStorage?.getItem(NOW_SCOPE_KEY) === 'all' ? 'all' : 'project'
  } catch {
    return 'project'
  }
}

export function saveNowScope(scope: NowScope): void {
  try {
    globalThis.localStorage?.setItem(NOW_SCOPE_KEY, scope)
  } catch {
    // private mode: the choice lasts this visit
  }
}

/** A manager's own items (its questions, approvals, messages), not a task's. */
export const fromManager = (item: AttentionItem): boolean => item.managerId !== undefined && item.projectId === undefined

/** This project's view adds the manager items of managers connected to it. */
export function projectManagerItems(items: readonly AttentionItem[], connected: (managerId: string) => boolean): AttentionItem[] {
  return items.filter((item) => fromManager(item) && connected(item.managerId!))
}

export interface AttentionGroup {
  key: string
  label: string
  items: AttentionItem[]
}

/** Managers first, then each project in the order its newest item came. */
export function attentionGroups(items: readonly AttentionItem[], projectName: (id: string) => string): AttentionGroup[] {
  const managers = items.filter(fromManager)
  const projects = new Map<string, AttentionItem[]>()
  for (const item of items) {
    if (fromManager(item) || !item.projectId) continue
    projects.set(item.projectId, [...(projects.get(item.projectId) ?? []), item])
  }
  return [
    ...(managers.length > 0 ? [{ key: 'managers', label: 'From managers', items: managers }] : []),
    ...[...projects].map(([id, rows]) => ({ key: `project:${id}`, label: projectName(id), items: rows })),
  ]
}

/** Marking read resolves these; a question, an approval or a waiting task needs a decision. */
export const READABLE: ReadonlySet<AttentionKind> = new Set(['message', 'review', 'failed'])

export const KIND_LABEL: Record<AttentionKind, string> = {
  question: 'Question',
  approval: 'Approval',
  task: 'Waiting for you',
  review: 'Ready for review',
  failed: 'Failed',
  message: 'Important',
}

/** Where the row's Open goes: the card in its chat, the task's own screen. */
export function itemHref(item: AttentionItem): string {
  if (item.projectId && item.runId) {
    const task = taskPath(item.projectId, item.runId)
    if (item.kind === 'review') return `${task}/changes`
    if (item.kind === 'question') return `${task}#ask`
    if (item.kind === 'task') return `${task}#reply`
    return task
  }
  if (item.kind === 'approval') return '/manager/approvals'
  const manager = `/manager/${encodeURIComponent(item.managerId ?? '')}`
  const messageId = item.questionKey?.startsWith('m:') ? item.questionKey.split(':').slice(2).join(':') : undefined
  return messageId ? `${manager}#decision-${encodeURIComponent(messageId)}` : manager
}

/** The text a one-question card's choice answers with, as the Questions page sends it. */
export const optionAnswer = (item: AttentionItem, label: string): string => (item.header ? `${item.header}: ${label}` : label)
