import type { ChatProviderDescriptor } from '@/lib/chat-providers'
import { useHealth } from '@/api/queries'
import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'

export const chatKey = (projectId: string, providerId: string) => [projectId, `${providerId}-inbound`] as const
export function useChatSubscription(projectId: string, enabled: boolean, provider: ChatProviderDescriptor) {
 const client = useQueryClient()
 // Reactive: health may arrive after mount; hosted cockpits open no WebSocket (spec 2026-11-12).
 const local = useHealth().data?.capabilities?.localHandoff === true
 useEffect(() => {
  if (!enabled || !local) return
  return provider.bot.subscribe(() => { void client.invalidateQueries({ queryKey: chatKey(projectId, provider.id) }) })
 }, [client, projectId, enabled, provider, local])
}

/** One subscription per bot provider for views that list several (the integrations gallery). Keyed by
 *  provider ids, so a re-render with the same providers keeps its subscriptions. */
export function useChatSubscriptions(projectId: string, providers: readonly ChatProviderDescriptor[]) {
 const client = useQueryClient()
 const local = useHealth().data?.capabilities?.localHandoff === true
 const ids = providers.map(provider => provider.id).join('\n')
 const latest = useRef(providers)
 useEffect(() => { latest.current = providers })
 useEffect(() => {
  const wanted = new Set(ids ? ids.split('\n') : [])
  if (!local) return
  const unsubscribes = latest.current.filter(provider => wanted.has(provider.id))
   .map(provider => provider.bot.subscribe(() => { void client.invalidateQueries({ queryKey: chatKey(projectId, provider.id) }) }))
  return () => { for (const unsubscribe of unsubscribes) unsubscribe() }
 }, [client, projectId, ids, local])
}
