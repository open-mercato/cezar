import { useSyncExternalStore } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import type { WebhookList } from '@open-mercato/cezar-api-client'
import { webhookApi } from '@/api/client'
import { webhookKey } from '@/hooks/use-webhooks'

type Notice = NonNullable<WebhookList['notice']>
type ProjectChanges = { claimed: number; pending: Map<number, { baseline: number; receiverIds: Set<string> }> }

// Per tab: the change notice surfaces changes made ELSEWHERE, so this tab's own receiver changes never raise it.
const projects = new Map<string, ProjectChanges>()
const listeners = new Set<() => void>()
let version = 0, nextId = 0
const changed = () => { version++; for (const listener of listeners) listener() }
const changesFor = (projectId: string) => {
  let entry = projects.get(projectId)
  if (!entry) projects.set(projectId, entry = { claimed: 0, pending: new Map() })
  return entry
}

/** Whether `notice` reports a change this tab made (or is making right now) to one of its receivers. */
export function isOwnWebhookNotice(projectId: string, notice: Notice): boolean {
  const entry = projects.get(projectId)
  if (!entry || notice.source !== 'cockpit/api') return false
  if (notice.changeSequence <= entry.claimed) return true
  return [...entry.pending.values()].some(change => notice.changeSequence > change.baseline && (!notice.receiverId || change.receiverIds.has(notice.receiverId)))
}

/** Re-renders a reader when this tab claims or starts a change. */
export function useOwnWebhookChanges(): number {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => version)
}

/**
 * Runs `action`, which changes `receiverIds` on the server, and claims the notice it opens as this tab's own.
 * `action` may name more receivers (e.g. a setup's final receiver id) through its result.
 */
export async function withOwnWebhookChange<T>(client: QueryClient | undefined, projectId: string, receiverIds: readonly string[], action: () => Promise<T>, resultIds: (result: T) => readonly (string | undefined)[] = () => []): Promise<T> {
  const entry = changesFor(projectId), id = ++nextId
  const change = { baseline: client?.getQueryData<WebhookList>(webhookKey(projectId))?.changeSequence ?? entry.claimed, receiverIds: new Set(receiverIds) }
  const settle = () => { entry.pending.delete(id); changed() }
  entry.pending.set(id, change); changed()
  let result: T
  try { result = await action() } catch (error) { settle(); throw error }
  for (const receiverId of resultIds(result)) if (receiverId) change.receiverIds.add(receiverId)
  // The caller moves on at once; the change stays pending (hidden) until the notice it opened is claimed.
  void (client
    ? client.fetchQuery({ queryKey: webhookKey(projectId), queryFn: ({ signal }) => webhookApi.list(projectId, signal), staleTime: 0 })
    : Promise.resolve().then(() => webhookApi.list(projectId)))
    .then(list => {
      const notice = list?.notice
      if (notice && notice.source === 'cockpit/api' && notice.receiverId && change.receiverIds.has(notice.receiverId) && notice.changeSequence > change.baseline)
        entry.claimed = Math.max(entry.claimed, notice.changeSequence)
    }, () => undefined)
    .finally(settle)
  return result
}
