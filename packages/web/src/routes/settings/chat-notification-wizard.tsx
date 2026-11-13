import { useRef, useState, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { CreateWebhook, WebhookReceiver } from '@open-mercato/cezar-api-client'
import { webhookApi } from '@/api/client'
import { webhookKey } from '@/hooks/use-webhooks'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { WebhookForm, webhookDraft, type WebhookDraft } from './webhook-form'
import { WebhookTestFeedback, type PendingWebhookTest } from './webhook-test-feedback'
import { webhookGuide } from './webhook-presentation'
import type { ChatProviderDescriptor } from '@/lib/chat-providers'

/** Mounted only for one setup attempt; closing never creates or activates another receiver. */
export function ChatNotificationWizard({ projectId, provider, onClose, initialName }: {
  projectId: string; provider: Pick<ChatProviderDescriptor, 'name' | 'format'> & Required<Pick<ChatProviderDescriptor, 'webhookNotifications'>>; initialName?: string; onClose: () => void
}) {
  const { name, format } = provider
  const client = useQueryClient()
  const [draft, setDraft] = useState<WebhookDraft>(() => ({ ...webhookDraft(), format, name: initialName ?? `${name} notifications` }))
  const [receiver, setReceiver] = useState<WebhookReceiver>()
  const [test, setTest] = useState<PendingWebhookTest>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [consent, setConsent] = useState(false)
  const live = useRef(true)
  const inFlight = useRef(false)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const result = useQuery({ queryKey: [...webhookKey(projectId), 'test-result', receiver?.id, test?.deliveryId], queryFn: () => webhookApi.deliveries(projectId, receiver!.id), enabled: !!test && !done, retry: false })
  const delivery = result.data?.items.find(row => row.deliveryId === test?.deliveryId)
  const tested = delivery?.status === 'delivered' && delivery.reason !== 'outcome_unknown'
  const current = result.data?.receiver
  const unchanged = current?.kind === 'live' && current.deliveryRevision === test?.deliveryRevision && current.state === 'inactive' && current.lastTest === 'success' && !current.activationBlocked
  const run = async (action: () => Promise<void>) => {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setError('')
    try { await action() } catch (cause) {
      if (!live.current) return
      // `changed` is this wizard's own stale-receiver signal; anything else is the server's reason.
      const reason = !(cause instanceof Error) || !cause.message ? 'Could not complete this step.' : cause.message === 'changed' ? 'This connection changed since it was created.' : cause.message
      setError(`${reason} The connection is saved if it was created. Check the URL or retry the test; check its status before retrying activation.`)
    }
    finally { inFlight.current = false; if (live.current) setBusy(false); void client.invalidateQueries({ queryKey: webhookKey(projectId) }) }
  }
  const sendTest = async (row: WebhookReceiver) => {
    const sent = await webhookApi.test(projectId, row.id, { expectedRevision: row.revision, deliveryRevision: row.deliveryRevision, operationId: crypto.randomUUID() })
    if (live.current) setTest({ receiverId: row.id, receiverName: row.name, deliveryId: sent.deliveryId, deliveryRevision: row.deliveryRevision, initialState: row.state, format })
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}><DialogContent className="max-h-[90dvh] overflow-y-auto"><DialogHeader>
    <DialogTitle>{done ? `${name} is ready` : `Connect ${name} notifications`}</DialogTitle>
    <DialogDescription>{done ? 'Notifications are active. You can add task control to this connection later.' : 'Cezar sends a test before you activate notifications. No bot or permission to read messages is required.'}</DialogDescription>
  </DialogHeader>
    {!receiver && <>
      <p className="text-sm">{provider.webhookNotifications.instructions} <a className="underline" href={webhookGuide(undefined, format).href} target="_blank" rel="noreferrer">{name} guide</a></p>
      <WebhookForm draft={draft} setDraft={setDraft} format={format} compact guideHref={webhookGuide(undefined, format).href} pending={busy} submitLabel="Send test and continue" save={value => void run(async () => {
        const created = await webhookApi.create(projectId, value as CreateWebhook)
        if (!live.current) return
        setReceiver(created.receiver); setDraft(previous => ({ ...previous, url: '' }))
        await sendTest(created.receiver)
      })} />
    </>}
    {receiver && !done && <>
      {test && <WebhookTestFeedback projectId={projectId} test={test} />}
      <p className="text-ui text-muted-foreground">Task control: off. Closing now keeps this connection inactive; you can finish from its settings.</p>
      {receiver.profile === 'standard' && <label className="flex gap-2 text-sm"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />I understand task titles and selected content will be sent to this channel.</label>}
      {tested && !unchanged && <p role="alert" className="text-sm">Connection settings changed. Close setup and review the connection before activating it.</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy} onClick={() => void run(async () => { const latest = (await webhookApi.list(projectId)).receivers.find(row => row.id === receiver.id); if (!latest || latest.deliveryRevision !== receiver.deliveryRevision) throw new Error('changed'); await sendTest(latest) })}>Send another test</Button>
        <Button disabled={busy || !tested || !unchanged || (receiver.profile === 'standard' && !consent)} onClick={() => void run(async () => { if (current?.kind !== 'live' || !tested || !unchanged) return; await webhookApi.activate(projectId, receiver.id, current.revision); if (live.current) setDone(true) })}>{busy ? 'Checking…' : 'Activate notifications'}</Button>
      </div>
      {result.isError && <Button variant="outline" onClick={() => void result.refetch()}>Check test result again</Button>}
    </>}
    {done && <><p role="status">Sending: verified by a delivered test. Task control: off.</p><Button onClick={onClose}>Done</Button></>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
  </DialogContent></Dialog>
}
