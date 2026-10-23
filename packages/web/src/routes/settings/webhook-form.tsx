import { useId, useState, type ReactNode } from 'react'
import { createWebhookSchema, updateWebhookSchema, type CreateWebhook, type UpdateWebhook, type WebhookReceiver, type WebhookTaskEventType } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { graceLabels, presetLabels, scopeLabels } from './webhook-presentation'
export const eventLabels: Record<WebhookTaskEventType | 'webhook.test', string> = {
  'task.attention_required': 'Needs your input', 'task.review_ready': 'Ready for review', 'task.finished': 'Task finished', 'task.failed': 'Task failed', 'task.cancelled': 'Task cancelled', 'webhook.test': 'Test message',
}
// Same chrome as the other Settings selects (resources-section).
const selectStyle = 'h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'
const hintStyle = 'text-[13px] text-muted-foreground'
export type WebhookDraft = { format: CreateWebhook['format']; name: string; url: string; profile: CreateWebhook['profile']; preset: CreateWebhook['preset']; events: WebhookTaskEventType[]; scope: CreateWebhook['scope']; graceSeconds: CreateWebhook['graceSeconds']; local: boolean; scheduled: boolean }
export function webhookDraft(receiver?: WebhookReceiver): WebhookDraft {
  return { format: receiver?.format ?? 'cezar.json.v1', name: receiver?.name ?? '', url: '', profile: receiver?.profile ?? 'minimal', preset: receiver?.preset ?? 'attention', events: receiver?.events ?? [], scope: receiver?.scope ?? 'main_and_questions', graceSeconds: receiver?.graceSeconds ?? 180, local: receiver?.allowLocalNetwork ?? false, scheduled: receiver?.includeScheduledFailures ?? false }
}
function Field({ id, label, children }: { id?: string; label: string; children: ReactNode }) {
  return <div className="flex flex-col gap-1.5">{id ? <label htmlFor={id} className="text-sm font-medium">{label}</label> : <span className="text-sm font-medium">{label}</span>}{children}</div>
}
export function WebhookForm({ receiver, draft, setDraft, pending, blocked = false, guideHref, save }: { receiver?: WebhookReceiver; draft: WebhookDraft; setDraft: (draft: WebhookDraft) => void; pending: boolean; blocked?: boolean; guideHref: string; save: (value: CreateWebhook | UpdateWebhook) => void }) {
  const prefix = useId()
  const { format, name, url, profile, preset, events, scope, graceSeconds, local, scheduled } = draft
  const change = <K extends keyof WebhookDraft>(key: K, value: WebhookDraft[K]) => setDraft({ ...draft, [key]: value })
  const [error, setError] = useState('')
  const chat = format !== 'cezar.json.v1'
  const destinationName = format === 'slack.v1' ? 'Slack' : 'Discord'
  let suggestedFormat: WebhookDraft['format'] | undefined
  try {
    const host = new URL(url).hostname
    if (host === 'hooks.slack.com') suggestedFormat = 'slack.v1'
    if (['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com'].includes(host)) suggestedFormat = 'discord.v1'
  } catch { /* Incomplete input. */ }
  const changeFormat = (value: WebhookDraft['format']) => setDraft({ ...draft, format: value, local: value === 'cezar.json.v1' && local })
  return <form className="flex flex-col gap-4" onSubmit={event => {
    event.preventDefault()
    if (pending || blocked) return
    const settings = { format, name, ...(url || !receiver ? { url } : {}), profile, preset, events, scope, graceSeconds, allowLocalNetwork: chat ? false : local, includeScheduledFailures: scheduled }
    const parsed = receiver ? updateWebhookSchema.safeParse({ ...settings, expectedRevision: receiver.revision }) : createWebhookSchema.safeParse(settings)
    if (!parsed.success) { setError([...new Set(parsed.error.issues.map(issue => issue.message.replace(/\.?$/, '.')))].join(' ')); return }
    setError(''); save(parsed.data)
  }}>
    <Field id={`${prefix}-destination`} label="Destination">
      <select id={`${prefix}-destination`} className={selectStyle} value={format} onChange={event => changeFormat(event.target.value as WebhookDraft['format'])}>
        <option value="cezar.json.v1">Custom receiver (signed cezar JSON)</option>
        <option value="slack.v1">Slack channel (Incoming Webhook)</option>
        <option value="discord.v1">Discord channel (Webhook URL)</option>
      </select>
    </Field>
    <Field id={`${prefix}-name`} label="Name"><Input id={`${prefix}-name`} value={name} onChange={event => change('name', event.target.value)} maxLength={100} required autoComplete="off" /></Field>
    <Field id={`${prefix}-url`} label={chat ? 'Webhook URL' : 'Receiver URL'}>
      <Input id={`${prefix}-url`} type="url" value={url} onChange={event => change('url', event.target.value)} required={!receiver} autoComplete="off" placeholder={receiver ? 'Leave blank to keep the current URL' : format === 'slack.v1' ? 'https://hooks.slack.com/services/…' : format === 'discord.v1' ? 'https://discord.com/api/webhooks/…' : 'https://your-receiver.example/webhook'} />
      {receiver && <p className={hintStyle}>Current: {receiver.destination} (path hidden)</p>}
      {url.startsWith('http:') && <p className="text-[13px] text-warning">Plain HTTP is not encrypted. Use HTTPS outside a trusted local network.</p>}
      {!chat && suggestedFormat && <div role="status" className="flex flex-wrap items-center gap-2 text-[13px] text-warning">
        <span>This is a {suggestedFormat === 'slack.v1' ? 'Slack' : 'Discord'} webhook. Switch the destination to post channel messages.</span>
        <Button type="button" size="sm" variant="outline" className="text-foreground" onClick={() => changeFormat(suggestedFormat!)}>Use {suggestedFormat === 'slack.v1' ? 'Slack' : 'Discord'}</Button>
      </div>}
      {format === 'slack.v1' && <p className={hintStyle}>In Slack, create an app with an Incoming Webhook, install it in your channel and paste its URL. <a className="underline underline-offset-2 hover:text-foreground" href="https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/" target="_blank" rel="noreferrer">Slack setup guide</a></p>}
      {format === 'discord.v1' && <p className={hintStyle}>In Discord, open Server Settings → Integrations → Webhooks, create one and paste its URL. <a className="underline underline-offset-2 hover:text-foreground" href="https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks" target="_blank" rel="noreferrer">Discord setup guide</a></p>}
      {chat ? <p className={hintStyle}>Keep this URL secret — anyone who has it can post to the channel. {destinationName} receivers need no signing key.</p> : <>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5" checked={local} onChange={event => change('local', event.target.checked)} />Allow a receiver on this computer or private network</label>
        {local && <p className={hintStyle}>Tests will contact this private address. Hosted cezar sends to public HTTPS receivers only.</p>}
        <a className="text-[13px] text-muted-foreground underline underline-offset-2 hover:text-foreground" href={`${guideHref}#external-automation-receivers`} target="_blank" rel="noreferrer">How to build a receiver</a>
      </>}
    </Field>
    <Field id={`${prefix}-events`} label="Events"><select id={`${prefix}-events`} className={selectStyle} value={preset} onChange={event => change('preset', event.target.value as CreateWebhook['preset'])}>
      {(['attention', 'all', 'custom'] as const).map(value => <option key={value} value={value}>{presetLabels[value]}</option>)}</select></Field>
    {preset === 'custom' && <fieldset className="flex flex-col gap-2"><legend className="mb-1 text-sm font-medium">Choose events</legend>{Object.entries(eventLabels).filter(([type]) => type !== 'webhook.test').map(([type, label]) => <label key={type} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={events.includes(type as WebhookTaskEventType)} onChange={event => change('events', event.target.checked ? [...events, type as WebhookTaskEventType] : events.filter(value => value !== type))} />{label}</label>)}</fieldset>}
    <Field id={`${prefix}-profile`} label="Message content"><select id={`${prefix}-profile`} className={selectStyle} value={profile} onChange={event => change('profile', event.target.value as CreateWebhook['profile'])}><option value="minimal">Minimal — IDs, status and your own title</option><option value="standard">Standard — task titles, questions and errors</option></select>
      <p className={hintStyle}>Prompts and transcripts are never sent. Redaction of other text is best effort.</p>
      {chat && profile === 'standard' && <p className="text-[13px] text-warning">Standard posts task titles, questions and error text to your {destinationName} channel.</p>}
    </Field>
    {chat ? <ChatPreview format={format} profile={profile} /> : <details><summary className="cursor-pointer text-sm font-medium">Preview JSON · {profile === 'minimal' ? 'Minimal' : 'Standard'}</summary>
      <p className={`mt-2 ${hintStyle}`}>Example data only — nothing is sent.</p>
      <pre aria-label="Synthetic JSON sample" className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs">{JSON.stringify({
        id: 'evt_00000000-0000-4000-8000-000000000001', schemaVersion: 1, sequence: 1,
        occurredAt: '2026-01-01T12:00:00Z', type: 'task.attention_required',
        source: { instanceId: 'example-instance', projectId: 'example-project', mode: 'local' },
        task: { id: 'example-task', previousStatus: 'running', status: 'waiting', ...(profile === 'standard' ? { title: 'Example generated task title' } : {}) },
        data: { episodeId: 'example-episode', since: '2026-01-01T12:00:00Z', reason: 'question', requestId: 'example-request', ...(profile === 'standard' ? { questions: [{ question: 'Which example option should be used?', options: [{ label: 'Example A' }, { label: 'Example B' }] }] } : {}) },
      }, null, 2)}</pre>
    </details>}
    <details><summary className="cursor-pointer text-sm font-medium">Advanced</summary><div className="mt-3 flex flex-col gap-4">
      <Field id={`${prefix}-scope`} label="Tasks"><select id={`${prefix}-scope`} className={selectStyle} value={scope} onChange={event => change('scope', event.target.value as CreateWebhook['scope'])}>{(['main_and_questions', 'every_task'] as const).map(value => <option key={value} value={value}>{scopeLabels[value]}</option>)}</select></Field>
      <Field id={`${prefix}-grace`} label="Waiting and review delay"><select id={`${prefix}-grace`} className={selectStyle} value={graceSeconds} onChange={event => change('graceSeconds', Number(event.target.value) as CreateWebhook['graceSeconds'])}>{([0, 60, 180, 600] as const).map(value => <option key={value} value={value}>{graceLabels[value]}</option>)}</select><p className={hintStyle}>Skipped if you reply, or the task stops waiting or leaves review, before the delay ends.</p></Field>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5" checked={scheduled} onChange={event => change('scheduled', event.target.checked)} />Include failures that will resume automatically (always included in All results)</label>
    </div></details>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <div><Button type="submit" disabled={pending || blocked}>{pending ? 'Saving…' : receiver ? 'Review changes' : 'Save receiver'}</Button></div>
  </form>
}

function ChatPreview({ format, profile }: { format: WebhookDraft['format']; profile: WebhookDraft['profile'] }) {
  const service = format === 'slack.v1' ? 'Slack' : 'Discord'
  return <details>
    <summary className="cursor-pointer text-sm font-medium">Preview {service} message · {profile === 'minimal' ? 'Minimal' : 'Standard'}</summary>
    <p className={`mt-2 ${hintStyle}`}>Example data only — nothing is sent.</p>
    <div aria-label={`${service} message sample`} className={`mt-2 space-y-2 rounded-md border border-border bg-muted p-3 text-sm ${format === 'discord.v1' ? 'border-l-4 border-l-pending' : ''}`}>
      <p className="font-medium">Needs your input · {profile === 'standard' ? 'Example generated task title' : 'a1b2c3d4'}</p>
      <p>running → waiting</p>
      <p className="text-xs text-muted-foreground">example-project · a1b2c3d4 · Jan 1, 2026, 12:00 UTC</p>
      {profile === 'standard' && <div><p>Which example option should be used?</p><p>Example A · Example B</p></div>}
      <p className="text-xs text-muted-foreground">cezar</p>
    </div>
  </details>
}
