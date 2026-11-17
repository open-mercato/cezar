import type { ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { WebhookList, WebhookReceiver } from '@open-mercato/cezar-api-client'
import { webhookApi } from '@/api/client'
import { webhookKey } from '@/hooks/use-webhooks'
import { Button } from '@/components/ui/button'
import { activityLabel, sourceLabels, webhookTime } from './webhook-presentation'

export function noticeForFormat(list: WebhookList | undefined, format?: WebhookReceiver['format']) {
  const notice = list?.notice
  if (!notice) return undefined
  const owner = notice.format ?? list?.receivers.find(row => row.id === notice.receiverId)?.format
    ?? list?.history?.find(row => row.id === notice.receiverId)?.format ?? 'cezar.json.v1'
  // The generic Webhooks page owns every non-chat notice. Provider-specific
  // pages still filter to their exact format, while Telegram notices stay in
  // Integrations → Telegram and must not appear here.
  if (format) return owner === format ? notice : undefined
  return notice
}

export function WebhookNotice({ projectId, notice, changeSequence, children }: {
  projectId: string; notice: NonNullable<WebhookList['notice']>; changeSequence: number; children?: ReactNode
}) {
  const client = useQueryClient()
  const review = useMutation({
    mutationFn: () => webhookApi.acknowledge(projectId, changeSequence),
    onSuccess: () => client.invalidateQueries({ queryKey: webhookKey(projectId) }),
  })
  return <section role="status" className="flex min-w-0 flex-col gap-2 rounded-md border border-warning/50 bg-warning/10 p-3 text-sm [overflow-wrap:anywhere]">
    <p><span className="font-medium">{activityLabel(notice.action)}</span>{notice.receiverName ? ` — ${notice.receiverName}` : ''}<span className="text-muted-foreground">{notice.destination ? ` · ${notice.destination}` : ''} · {webhookTime(notice.at)}{notice.source ? ` · via ${sourceLabels[notice.source]}` : ''}</span></p>
    <p className="text-ui text-muted-foreground">Any local process, including agents, can change receivers and read signing keys. If this wasn’t you, review it.</p>
    {review.isError && <p role="alert">Could not mark this change as reviewed. Refresh and try again.</p>}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={review.isPending} onClick={() => review.mutate()}>Mark as reviewed</Button>
      {children}
    </div>
  </section>
}
