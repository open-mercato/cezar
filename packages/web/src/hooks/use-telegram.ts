import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { telegramInboundInvalidationSchema } from '@open-mercato/cezar-api-client'
import { subscribeTopic } from '@/api/ws'
export const telegramKey = (projectId: string) => [projectId, 'telegram-inbound'] as const
export function useTelegramSubscription(projectId: string, enabled: boolean) {
  const client = useQueryClient()
  useEffect(() => {
    if (!enabled) return
    return subscribeTopic('telegram-inbound', data => {
      if (telegramInboundInvalidationSchema.safeParse(data).success) void client.invalidateQueries({ queryKey: telegramKey(projectId) })
    })
  }, [client, projectId, enabled])
}
