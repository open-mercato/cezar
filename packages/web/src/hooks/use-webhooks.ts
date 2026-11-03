import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { API_PREFIX, getApiBaseUrl, decodeWebhookInvalidation } from '@open-mercato/cezar-api-client'
import { webhookApi } from '@/api/client'
export const webhookKey = (projectId: string) => [projectId, 'webhooks'] as const
export function useWebhookList(projectId: string, enabled: boolean) {
  return useQuery({ queryKey: webhookKey(projectId), queryFn: ({ signal }) => webhookApi.list(projectId, signal), enabled, retry: false })
}
export function useWebhookSubscription(projectId: string, enabled: boolean) {
  const client = useQueryClient()
  useEffect(() => {
    if (!enabled || !globalThis.EventSource) return
    let disposed = false
    const source = new EventSource(`${getApiBaseUrl()}${API_PREFIX}/p/${encodeURIComponent(projectId)}/webhooks/events`, { withCredentials: true })
    const onEvent = (event: MessageEvent<string>) => {
      if (disposed) return
      if (decodeWebhookInvalidation(event.type, event.data)) void client.invalidateQueries({ queryKey: webhookKey(projectId) })
    }
    source.addEventListener('change', onEvent)
    source.addEventListener('resync', onEvent)
    return () => { disposed = true; source.removeEventListener('change', onEvent); source.removeEventListener('resync', onEvent); source.close() }
  }, [client, projectId, enabled])
}
