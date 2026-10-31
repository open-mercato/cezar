import { useEffect, useRef } from 'react'
import type { WebhookList } from '@open-mercato/cezar-api-client'
import { useHealth } from '@/api/queries'
import { useWebhookList, useWebhookSubscription } from './use-webhooks'
import { toast } from '@/components/ui/toaster'

/** One observer for the visible project, using its authenticated SSE invalidation stream.
 * No workspace-wide WebSocket or background-project subscription carries receiver data.
 */
export function ProjectWebhookNotifications({ projectId }: { projectId: string }) {
  const health = useHealth()
  const enabled = !health.isError && health.data?.capabilities?.webhooks === true
  const list = useWebhookList(projectId, enabled)
  useWebhookSubscription(projectId, enabled)
  useWebhookToasts(projectId, enabled ? list.data : undefined)
  return null
}

/** Observe the project's existing query, never open another subscription or poll.
 * Keep only one live snapshot and a counter: no accumulating event/revision/receiver IDs.
 * Initial data (including a remount or a different project) is a silent baseline.
 */
export function useWebhookToasts(projectId: string, data: WebhookList | undefined) {
  const previous = useRef<{ projectId: string; data: WebhookList } | undefined>(undefined)
  useEffect(() => {
    if (!data) { previous.current = undefined; return }
    const before = previous.current
    previous.current = { projectId, data }
    if (!before || before.projectId !== projectId) return
    const states = new Map(before.data.receivers.map(row => [row.id, row.state]))
    for (const row of data.receivers) {
      if (!states.has(row.id) || states.get(row.id) === row.state) continue
      if (row.state === 'active' || row.state === 'disabled') {
        if (row.state === 'active') toast(`${row.name} is now active`)
        else toast(`${row.name} was disabled — open it to repair and test`, { tone: 'danger' })
      }
    }
    const dropped = data.webhookHealth.saturation?.dropped ?? 0
    const oldDropped = before.data.webhookHealth.saturation?.dropped ?? 0
    // The observer is keyed by project, so these toasts only ever describe the project on screen.
    if (dropped > oldDropped) toast(`${dropped - oldDropped === 1 ? '1 webhook delivery was' : `${dropped - oldDropped} webhook deliveries were`} dropped — webhook storage capacity was exceeded`, { tone: 'danger' })
  }, [projectId, data])
}
