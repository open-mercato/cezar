import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { UpdateWebhook, WebhookReceiver } from '@open-mercato/cezar-api-client'
import { webhookApi } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Pill } from '@/components/pill'
import { toast } from '@/components/ui/toaster'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { webhookKey } from '@/hooks/use-webhooks'
import { telegramKey } from '@/hooks/use-telegram'
import { endpointHealthTone, graceLabels, lastTestLabels, receiverStateLabels } from './webhook-presentation'
import { WebhookTestFeedback, type PendingWebhookTest } from './webhook-test-feedback'

const selectStyle = 'h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'
const hintStyle = 'text-ui text-muted-foreground'
/** One note under the permissions: answering costs too, so no single option carries it. */
export const taskControlCostNote = 'Answering, starting and continuing tasks runs the agent and may incur provider costs.'
export const isGroupChat = (receiver?: WebhookReceiver) => receiver?.telegramChatId?.startsWith('-') === true

/**
 * Receivers that send to a chat another receiver already serves, mapped to that receiver. The one kept is the one
 * with task control, else the one bound to a bot, else the oldest — every other copy doubles each notification.
 */
export function duplicateChats(receivers: WebhookReceiver[], controlled: (id: string) => boolean, bound: (id: string) => boolean): Map<string, WebhookReceiver> {
  const byChat = new Map<string, WebhookReceiver[]>()
  for (const receiver of receivers) if (receiver.telegramChatId) byChat.set(receiver.telegramChatId, [...byChat.get(receiver.telegramChatId) ?? [], receiver])
  const duplicates = new Map<string, WebhookReceiver>()
  for (const same of byChat.values()) {
    if (same.length < 2) continue
    const rank = (receiver: WebhookReceiver) => (controlled(receiver.id) ? 0 : 2) + (bound(receiver.id) ? 0 : 1)
    const [kept] = [...same].sort((a, b) => rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt))
    for (const receiver of same) if (receiver !== kept && !controlled(receiver.id)) duplicates.set(receiver.id, kept!)
  }
  return duplicates
}

type Options = { profile: WebhookReceiver['profile']; excerpt: boolean; graceSeconds: WebhookReceiver['graceSeconds'] }
/** The receiver's full settings with the three per-chat options swapped in; the URL is omitted so the saved token stays. */
export function optionsUpdate(receiver: WebhookReceiver, options: Options): UpdateWebhook {
  return { expectedRevision: receiver.revision, format: 'telegram.v1', name: receiver.name, profile: options.profile, preset: receiver.preset, events: receiver.events,
    includeScheduledFailures: receiver.includeScheduledFailures, scope: receiver.scope, graceSeconds: options.graceSeconds, allowLocalNetwork: false,
    ...(receiver.telegramChatId ? { telegramChatId: receiver.telegramChatId } : {}), ...(options.profile === 'standard' && options.excerpt ? { includeAgentExcerpt: true } : {}) }
}

type Removal = { receiver: WebhookReceiver; duplicateOf?: WebhookReceiver }
/** One row per Telegram chat: what it sends, whether it is on, and the actions to test, pause, tune and remove it. */
export function TelegramChats({ projectId, receivers, controlled, bound }: { projectId: string; receivers: WebhookReceiver[]; controlled: (id: string) => boolean; bound: (id: string) => boolean }) {
  const client = useQueryClient()
  const [busy, setBusy] = useState(''), [error, setError] = useState<{ id: string; text: string; conflict?: boolean }>()
  const [editing, setEditing] = useState<{ id: string; source: WebhookReceiver; options: Options }>()
  const [removal, setRemoval] = useState<Removal>()
  // Each chat keeps its own latest test, so its result and fix show in that chat's row.
  const [tests, setTests] = useState<Record<string, PendingWebhookTest>>({})
  const duplicates = duplicateChats(receivers, controlled, bound)
  const run = async (id: string, work: () => Promise<unknown>, done?: string) => {
    if (busy) return false
    setBusy(id); setError(undefined)
    try { await work(); if (done) toast(done); return true } catch (cause) {
      const conflict = cause instanceof Error && ('status' in cause && cause.status === 409 || /conflict/i.test(cause.message))
      setError({ id, conflict, text: conflict ? 'This chat changed in the meantime, so nothing was applied. Review the latest settings and try again.' : cause instanceof Error && cause.message ? cause.message : 'Telegram could not complete that action. Refresh and try again.' })
      return false
    }
    finally { await Promise.all([client.invalidateQueries({ queryKey: webhookKey(projectId) }), client.invalidateQueries({ queryKey: telegramKey(projectId) })]); setBusy('') }
  }
  const sendTest = (receiver: WebhookReceiver) => run(receiver.id, async () => {
    const { deliveryId } = await webhookApi.test(projectId, receiver.id, { expectedRevision: receiver.revision, deliveryRevision: receiver.deliveryRevision, operationId: crypto.randomUUID() })
    setTests(current => ({ ...current, [receiver.id]: { deliveryId, receiverId: receiver.id, receiverName: receiver.name, initialState: receiver.state, deliveryRevision: receiver.deliveryRevision, format: receiver.format } }))
  })
  if (!receivers.length) return null
  return <section className="flex flex-col gap-3" data-slot="telegram-chats">
    <div><h3 className="font-medium">Chats</h3><p className="text-muted-foreground">Each chat gets the task notifications set here. Pausing a chat also pauses replies from it; removing it removes its approved people too.</p></div>
    {receivers.map(receiver => {
      const group = isGroupChat(receiver), kept = duplicates.get(receiver.id), off = ['inactive', 'paused', 'disabled'].includes(receiver.state)
      const options = editing?.id === receiver.id ? editing.options : undefined
      const summary = [receiver.profile === 'standard' ? `Standard content${receiver.includeAgentExcerpt ? ' with agent excerpts' : ''}` : 'Minimal content',
        `Delay: ${(graceLabels[receiver.graceSeconds] ?? 'unknown').toLowerCase()}`, `Last test: ${(lastTestLabels[receiver.lastTest] ?? 'unknown').toLowerCase()}`].join(' · ')
      return <article key={receiver.id} aria-label={receiver.name} className="flex flex-col gap-2 rounded border p-3" data-slot="telegram-chat">
        <div className="flex flex-wrap items-center gap-2"><strong className="[overflow-wrap:anywhere]">{receiver.name}</strong>
          <Pill>{group ? 'Group' : 'Private chat'}</Pill><Pill dot={endpointHealthTone[receiver.state]}>Notifications: {receiverStateLabels[receiver.state]}</Pill>{kept && <Pill dot="danger">Duplicate</Pill>}</div>
        <p className="text-muted-foreground">{summary}</p>
        {kept && <p className="text-warning">Same chat as {kept.name}, so this chat gets every notification twice. Remove this one.</p>}
        {receiver.state === 'paused' && <p className="text-muted-foreground">Paused. New notifications are not sent until you resume.{receiver.lastTest !== 'success' ? ' Send a passing test, then resume.' : ''}</p>}
        {off && receiver.state !== 'paused' && <p className="text-muted-foreground">{receiver.lastTest === 'success' ? 'Notifications are off. Activate to send them again.' : 'Notifications are off. Send a test, then activate.'}</p>}
        {receiver.state === 'suspended' && <p className="text-warning">Recent notifications could not reach Telegram. Cezar retries every 15 minutes; use Send test to check now.</p>}
        {error?.id === receiver.id && <p role="alert" className="text-danger">{error.text}</p>}
        {tests[receiver.id] && <WebhookTestFeedback key={tests[receiver.id]!.deliveryId} projectId={projectId} test={tests[receiver.id]!} />}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void sendTest(receiver)}>Send test</Button>
          {off ? <Button size="sm" variant="outline" title={receiver.lastTest !== 'success' ? 'Send a passing test first' : undefined} disabled={!!busy || receiver.lastTest !== 'success' || receiver.activationBlocked}
              onClick={() => void run(receiver.id, () => receiver.state === 'paused' ? webhookApi.resume(projectId, receiver.id, receiver.revision) : webhookApi.activate(projectId, receiver.id, receiver.revision), `Notifications on for ${receiver.name}.`)}>{receiver.state === 'paused' ? 'Resume' : 'Activate'}</Button>
            : <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void run(receiver.id, () => webhookApi.pause(projectId, receiver.id, receiver.revision), `Notifications paused for ${receiver.name}.`)}>Pause</Button>}
          <Button size="sm" variant="outline" aria-expanded={!!options} disabled={!!busy} onClick={() => setEditing(options ? undefined : { id: receiver.id, source: receiver, options: { profile: receiver.profile, excerpt: receiver.includeAgentExcerpt === true, graceSeconds: receiver.graceSeconds } })}>Options</Button>
          <Button size="sm" variant="danger-ghost" disabled={!!busy} onClick={() => setRemoval({ receiver, ...(kept ? { duplicateOf: kept } : {}) })}>Remove</Button>
        </div>
        {options && editing && <ChatOptions receiver={editing.source} options={options} controlled={controlled(receiver.id)} busy={!!busy} onChange={next => setEditing({ ...editing, options: next })} onCancel={() => setEditing(undefined)}
          stale={receiver.revision !== editing.source.revision || error?.id === receiver.id && error.conflict === true}
          onReload={() => { setError(undefined); setEditing({ id: receiver.id, source: receiver, options: { profile: receiver.profile, excerpt: receiver.includeAgentExcerpt === true, graceSeconds: receiver.graceSeconds } }) }}
          onSave={() => void run(receiver.id, () => webhookApi.update(projectId, receiver.id, optionsUpdate(editing.source, options)), `Options saved for ${receiver.name}.`).then(saved => { if (saved) setEditing(undefined) })} />}
      </article>
    })}
    <Dialog open={!!removal} onOpenChange={open => { if (!open && !busy) setRemoval(undefined) }}>
      <DialogContent><DialogHeader><DialogTitle>Remove {removal?.receiver.name}?</DialogTitle>
        <DialogDescription>{removal?.duplicateOf ? `${removal.duplicateOf.name} keeps sending to this chat. ` : 'This chat stops getting notifications. '}{controlled(removal?.receiver.id ?? '') ? 'People approved in this chat lose task control. ' : ''}Pending notifications are cancelled; delivery history stays for up to 30 days.</DialogDescription>
      </DialogHeader>{error && error.id === removal?.receiver.id && <p role="alert" className="text-danger">{error.text}</p>}
      <DialogFooter><Button variant="outline" disabled={!!busy} onClick={() => setRemoval(undefined)}>Keep chat</Button>
        <Button variant="danger-ghost" disabled={!!busy} onClick={() => { if (!removal) return; const { receiver } = removal; void run(receiver.id, () => webhookApi.remove(projectId, receiver.id, receiver.revision), `${receiver.name} removed.`).then(removed => { if (removed) setRemoval(undefined) }) }}>Remove chat</Button></DialogFooter></DialogContent>
    </Dialog>
  </section>
}

function ChatOptions({ receiver, options, controlled, busy, stale, onReload, onChange, onCancel, onSave }: { receiver: WebhookReceiver; options: Options; controlled: boolean; busy: boolean; stale: boolean; onReload: () => void; onChange: (options: Options) => void; onCancel: () => void; onSave: () => void }) {
  const id = `telegram-options-${receiver.id}`
  const changed = options.profile !== receiver.profile || options.graceSeconds !== receiver.graceSeconds || (options.profile === 'standard' && options.excerpt) !== (receiver.includeAgentExcerpt === true)
  return <fieldset className="flex flex-col gap-3 rounded border border-dashed p-3"><legend className="px-1 font-medium">Options for {receiver.name}</legend>
    <label className="flex flex-col gap-1" htmlFor={`${id}-profile`}>Message content
      <select id={`${id}-profile`} className={selectStyle} value={options.profile} onChange={event => onChange({ ...options, profile: event.target.value as Options['profile'], excerpt: false })}>
        <option value="minimal">Minimal — IDs, status and your own title</option><option value="standard">Standard — task titles, questions and errors</option></select></label>
    {controlled && options.profile === 'minimal' && <p className="text-warning">Task control needs Standard content. Replies in this chat stop working with Minimal.</p>}
    {options.profile === 'standard' && <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5" checked={options.excerpt} onChange={event => onChange({ ...options, excerpt: event.target.checked })} />Include an excerpt of the agent’s last message</label>}
    {options.profile === 'standard' && options.excerpt && <p role="note" className="text-ui text-warning">Up to 600 characters of what the agent wrote are sent to this chat. Agent text can quote code, logs or data from this machine; known secrets and file paths are removed on a best-effort basis.</p>}
    <label className="flex flex-col gap-1" htmlFor={`${id}-grace`}>Notification delay
      <select id={`${id}-grace`} className={selectStyle} value={options.graceSeconds} onChange={event => onChange({ ...options, graceSeconds: Number(event.target.value) as Options['graceSeconds'] })}>
        {([0, 60, 180, 600] as const).map(value => <option key={value} value={value}>{graceLabels[value]}</option>)}</select>
      <span className={hintStyle}>Waiting and review notices wait this long, and are skipped if you answer in the cockpit first.</span></label>
    {stale && <p className="text-warning">This chat changed while you were editing. Your draft is kept; saving it may conflict. Reload the latest settings before making further changes. <Button size="sm" variant="outline" disabled={busy} onClick={onReload}>Reload latest settings</Button></p>}
    <div className="flex gap-2"><Button size="sm" disabled={busy || !changed} onClick={onSave}>Save options</Button><Button size="sm" variant="outline" disabled={busy} onClick={onCancel}>Cancel</Button></div>
  </fieldset>
}
