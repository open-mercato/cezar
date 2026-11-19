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
    let source: EventSource | undefined
    const url = `${getApiBaseUrl()}${API_PREFIX}/p/${encodeURIComponent(projectId)}/webhooks/events`
    const onEvent = (event: MessageEvent<string>) => {
      if (disposed) return
      if (decodeWebhookInvalidation(event.type, event.data)) void client.invalidateQueries({ queryKey: webhookKey(projectId) })
    }
    const open = () => {
      if (disposed || source) return
      source = new EventSource(url, { withCredentials: true })
      source.addEventListener('change', onEvent)
      source.addEventListener('resync', onEvent)
    }
    const close = () => {
      source?.removeEventListener('change', onEvent)
      source?.removeEventListener('resync', onEvent)
      source?.close()
      source = undefined
    }
    // Full document navigation does not unmount React. Cached pages must release their
    // SSE sockets too, or repeated visits exhaust the browser's per-origin connection pool.
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted || disposed || source) return
      void client.invalidateQueries({ queryKey: webhookKey(projectId) })
      open()
    }
    window.addEventListener('pagehide', close)
    window.addEventListener('pageshow', onPageShow)
    open()
    return () => {
      disposed = true
      window.removeEventListener('pagehide', close)
      window.removeEventListener('pageshow', onPageShow)
      close()
    }
  }, [client, projectId, enabled])
}
