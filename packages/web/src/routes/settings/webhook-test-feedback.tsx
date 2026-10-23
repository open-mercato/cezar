import { useEffect, useRef } from 'react'
import { toast } from '@/components/ui/toaster'
import { useQuery } from '@tanstack/react-query'
import type { WebhookReceiver } from '@open-mercato/cezar-api-client'
import { webhookApi } from '@/api/client'
import { webhookKey } from '@/hooks/use-webhooks'
import { Button } from '@/components/ui/button'
import { reasonLabel } from './webhook-presentation'
// Destination-policy refusals (destination.ts codes): nothing was sent, and the same configuration is refused again.
const policyHints: Record<string, string> = {
  local_consent_required: 'This address is on this computer or a private network. Edit the receiver and turn on “Allow a receiver on this computer or private network”.',
  server_port: 'This address points at the cezar server itself. Use your receiver\'s own port.',
  https_required: 'This server only sends to HTTPS receivers. Use an https:// URL.',
  public_destination_required: 'This server only sends to public receivers. Use a publicly reachable HTTPS URL.',
  metadata_hostname: 'Cloud metadata hostnames are never allowed as receivers.',
  denied_address: 'The receiver resolves to an address that is never allowed.',
  mixed_dns: 'The receiver hostname resolves to both public and private addresses. Use a hostname with one kind of address.',
  invalid_dns: 'The receiver hostname did not resolve to a usable address.',
  dns_not_found: 'The receiver hostname does not resolve. Check the URL.',
  invalid_url: 'The receiver URL is not allowed. Use a plain http(s) URL without credentials or a fragment.',
}
export type PendingWebhookTest = { deliveryId: string; receiverId: string; receiverName: string; initialState: WebhookReceiver['state']; deliveryRevision: number; format?: WebhookReceiver['format'] }
export function WebhookTestFeedback({ projectId, test, openHistory }: { projectId: string; test: PendingWebhookTest; openHistory: (receiverId: string) => void }) {
  const result = useQuery({ queryKey: [...webhookKey(projectId), 'test-result', test.receiverId, test.deliveryId], queryFn: () => webhookApi.deliveries(projectId, test.receiverId), retry: false })
  const row = result.data?.items.find(item => item.deliveryId === test.deliveryId)
  const receiver = result.data?.receiver
  // Retain the tested format even if history now describes a deleted receiver.
  const format = test.format ?? (receiver?.kind === 'live' ? receiver.format : undefined)
  const finished = row && ['delivered', 'failed', 'cancelled', 'superseded', 'dropped'].includes(row.status)
  // Only the current explicit test is retained; query refreshes cannot repeat its toast.
  const announced = useRef<string | undefined>(undefined)
  const terminal = finished ? row.status : undefined
  const unknown = row?.reason === 'outcome_unknown'
  useEffect(() => {
    const key = `${projectId}:${test.deliveryId}`
    if (!terminal || announced.current === key) return
    announced.current = key
    // No server reason, response, URL or signing material enters the toast.
    if (terminal === 'delivered' && !unknown) toast(`Test delivered to ${test.receiverName}`)
    else toast(unknown ? `Test result for ${test.receiverName} is unknown` : `Test to ${test.receiverName} failed`, { tone: 'danger' })
  }, [projectId, test.deliveryId, test.receiverName, terminal, unknown])
  const delivered = finished && row.status === 'delivered' && !unknown
  const message = result.error ? 'Test result is unavailable. Check the history.' : result.data && !row ? 'Test sent. Its result is in the history.' : !finished ? 'Test sent — waiting for the result…'
    : unknown ? 'Test result unknown — it may have arrived. Check your receiver before testing again.'
    : delivered ? `Test delivered.${receiver?.kind === 'live' && ['inactive', 'paused'].includes(receiver.state) ? ` ${receiver.state === 'paused' ? 'Resume' : 'Activate'} the receiver to start sending task updates.` : ''}`
    : `Test ${row.status === 'failed' ? 'failed' : row.status}${row.reason ? `: ${reasonLabel(row.reason)}` : ''}.`
  const hint = !finished || delivered || unknown ? undefined
    : row.reason === 'timeout' || row.reason === 'connection_failed' ? 'Check that your receiver is reachable and responds within 10 seconds.'
    : /^http_(401|403)$/.test(row.reason ?? '') ? format === 'slack.v1' || format === 'discord.v1'
      ? 'Check the webhook URL in Slack or Discord. If it was revoked or replaced, edit this receiver with the current URL and send a new test.'
      : 'Check the receiver’s authentication and the signing key in its verifier.'
    : row.reason === 'http_404' || row.reason === 'http_410' ? 'Check the URL and that the endpoint still exists.'
    : policyHints[row.reason ?? ''] ? `${policyHints[row.reason!]} Activation stays blocked until a test passes.`
    : 'Fix the receiver, then send a new test. Tests are not retried automatically.'
  const tone = delivered ? 'border-success/40' : finished ? 'border-danger/30 bg-danger/5' : 'border-border'
  return <div role="status" data-test-delivery={test.deliveryId} className={`flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-[13px] ${tone}`}>
    <div className="min-w-0"><p>{message}</p>{hint && <p className="text-muted-foreground">{hint}</p>}</div>
    <Button size="sm" variant="ghost" onClick={() => openHistory(test.receiverId)}>View in history</Button>
  </div>
}
