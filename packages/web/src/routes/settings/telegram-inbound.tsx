import { ChevronDownIcon } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import type { TelegramInboundGrant, TelegramInboundStateResponse, TelegramSetupActivate, TelegramSetupActivated, TelegramSetupBegin, TelegramSetupBegun, TelegramSetupStatus, WebhookReceiver } from '@open-mercato/cezar-api-client'
import { cez, telegramApi, unwrap, webhookApi } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { toast } from '@/components/ui/toaster'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { telegramKey, useTelegramSubscription } from '@/hooks/use-telegram'
import { webhookKey, useWebhookSubscription } from '@/hooks/use-webhooks'
import { cn } from '@/lib/utils'
import { TelegramChats, duplicateChats, isGroupChat as isGroup, taskControlCostNote } from './telegram-chats'
import { plural } from './webhook-presentation'

const telegramSetupErrorMessages: Record<string, string> = {
  invalid_token: 'Telegram rejected the saved bot token. Get a new token from @BotFather and use Add a chat with it.',
  blocked: 'Telegram blocked this bot. Unblock or recreate it, then try again.',
  conflict: 'Telegram settings changed. Refresh the receiver and start setup again.',
  damaged_state: 'Telegram access is damaged. Reset access below, then start setup again.',
  vault_unavailable: 'The bot token store is unavailable. Restore it, then retry setup.',
}

const telegramHealthLabels: Record<string, string> = { stopped: 'Not running', polling: 'Connected and listening', backoff: 'Temporarily retrying', blocked: 'Blocked — check the bot settings', conflict: 'Another cockpit owns this bot', 'credentials-unavailable': 'Bot credentials unavailable' }
const receiverStateLabels: Record<string, string> = { disabled: 'Replies disabled', pairing: 'Pairing in progress', active: 'Replies enabled', suspended: 'Replies suspended', 'credentials-unavailable': 'Bot credentials unavailable', conflict: 'Another cockpit owns this bot', blocked: 'Blocked — check the bot settings', stopped: 'Not running' }
const telegramErrorMessages: Record<string, string> = { flag_off: 'Telegram task control is turned off in this cockpit.', webhooks_off: 'Webhooks are turned off, so Telegram replies cannot run.', hosted: 'Telegram task control is available only in a local cockpit.', unavailable: 'Telegram is temporarily unavailable. Try again in a moment.', receiver_ineligible: 'This receiver is not ready. Test and activate it with Standard content and waiting notifications enabled.', group_ineligible: 'This group cannot receive replies. Choose a private or non-forum group chat.', group_visibility_required: 'Confirm that group members may see project messages before continuing.', chat_conflict: 'This chat already has task control through another Telegram receiver. A private chat serves one person, so use that receiver.', pairing_required: 'Approve a person with Enable task control before enabling replies.', pairing_changed: 'The pairing changed before it was approved. Start Telegram setup again.', chat_changed: 'The Telegram chat changed. Refresh the receiver and try again.', revision_required: 'The settings changed. Review the refreshed settings, then try again.', revision_conflict: 'Settings changed. Review the refreshed settings and try again.', receiver_changed: 'The receiver changed. Refresh it and try again.', credentials_unavailable: 'The bot token is unavailable or no longer works. Use Add a chat with the bot’s current token.', reset_unavailable: 'Access cannot be reset until the bot state can be verified.', reset_required: 'The bot state needs a reset before this action can continue.', owner_conflict: 'Another cockpit owns this bot. Stop it there or choose another bot.', foreign_state: 'This bot belongs to another project. Choose another bot.', state_missing: 'The bot state is missing. Refresh the page and try again.', bot_busy: 'The bot is busy finishing another operation. Try again shortly.', replacement_required: 'This receiver’s bot or chat changed. Replace the pairing to continue.', already_paired: 'This person is already approved for this receiver, so no further approval is needed.', pairing_limit: 'Too many setup links are waiting. Wait five minutes or cancel one, then try again.', grant_limit: 'This project has reached its Telegram access limit.', comparison_required: 'Compare the code sent privately by Telegram before approving.', pairing_expired: 'This setup link expired. Create a new link and try again.', binding_missing: 'This bot is no longer assigned to this receiver. Refresh the page.', grant_missing: 'This approved person no longer exists. Refresh the page.', invalid_cursor: 'The activity history cursor is no longer valid. Refresh the history.', noncanonical_root: 'Telegram inbound access cannot run until the project path is canonical.', expired: 'This setup link expired. Create a new link and try again.', not_found: 'That Telegram pairing or receiver no longer exists. Refresh and try again.' }
const activityReasonLabels: Record<string, string> = { delivered: 'delivered', queued: 'queued for delivery', deferred: 'saved until the session starts', read: 'answered', preview: 'confirmation sent', executed: 'carried out', unauthorized: 'not paired', permission_denied: 'no permission for this action', rate_limited: 'too many messages', expired: 'message too old', unsupported: 'unsupported command', context_unavailable: 'project unavailable', unknown_task: 'task not found', unknown_reply: 'reply did not match a task', empty_text: 'no answer text', too_long: 'message too long', confirmation_limit: 'too many pending confirmations', configuration_unknown: 'task state does not allow this', account_unknown: 'saved account unknown', action_changed: 'task changed before confirmation', delivery_refused: 'delivery refused', delivery_uncertain: 'delivery outcome unknown', action_refused: 'action refused', action_uncertain: 'action outcome unknown', stale_reply: 'reply no longer current', not_waiting: 'task no longer waiting', grant_changed: 'access changed', interrupted: 'interrupted by a restart', pending: 'in progress', bot_not_group_member: 'bot is not in the group', candidate_not_group_member: 'person is not in the group', task_created: 'task started', declined: 'cancelled before starting', provider_unavailable: 'provider unavailable', account_unavailable: 'saved account unavailable', project_unavailable: 'project unavailable', creation_failed: 'task could not be created' }
const activityKindLabels: Record<string, string> = { reply: 'Answered with /reply', answer: 'Answered a task', status: 'Checked status', tasks: 'Listed tasks', task: 'Task request', help: 'Asked for help', cancel: 'Cancel', continue: 'Continue', unknown_command: 'Unknown command' }
const activityStateLabels: Record<string, string> = { accepted: 'Done', queued: 'Queued', deferred: 'Deferred', rejected: 'Refused', uncertain: 'Outcome unknown' }
function telegramMessage(error: unknown): string { const raw = error instanceof Error ? error.message : String(error ?? ''), code = raw.toLowerCase().replace(/^telegram[_ -]?/, ''); return telegramSetupErrorMessages[code] ?? telegramErrorMessages[code] ?? (raw.includes('_') ? 'Telegram could not complete that action. Refresh and try again.' : raw || 'Telegram could not complete that action. Refresh and try again.') }
function activityReason(reason: string, state?: string): string { return activityReasonLabels[reason] ?? (state === 'accepted' || state === 'queued' || state === 'deferred' ? 'completed' : 'not completed') }
const errorCode = (error: unknown) => (error instanceof Error ? error.message : String(error ?? '')).toLowerCase().replace(/^telegram[_ -]?/, '')
function pollTime(value?: number): string { return value ? new Date(value).toLocaleString() : 'not yet' }

export type TelegramSetupApi = {
  begin: (projectId: string, input: TelegramSetupBegin) => Promise<TelegramSetupBegun>
  status: (projectId: string, id: string, signal?: AbortSignal) => Promise<TelegramSetupStatus>
  activate: (projectId: string, id: string, input: Omit<TelegramSetupActivate, 'activate'>) => Promise<TelegramSetupActivated>
  /** An abandoned setup must free its pairing slot (three pending sessions is the server limit). */
  cancel: (projectId: string, id: string) => Promise<unknown>
}
export const defaultSetupApi: TelegramSetupApi = {
  begin: async (projectId, json) => unwrap(await cez.api.v1.p[':projectId'].telegram.setup.$post({ param: { projectId }, json }), '/telegram/setup'),
  status: async (projectId, id, signal) => unwrap(await cez.api.v1.p[':projectId'].telegram.setup[':id'].$get({ param: { projectId, id } }, { init: { signal } }), '/telegram/setup'),
  activate: async (projectId, id, input) => unwrap(await cez.api.v1.p[':projectId'].telegram.setup[':id'].activate.$post({ param: { projectId, id }, json: { ...input, activate: true } }), '/telegram/setup/activate'),
  cancel: async (projectId, id) => unwrap(await cez.api.v1.p[':projectId'].telegram.setup[':id'].$delete({ param: { projectId, id } }), '/telegram/setup'),
}

const addReceiverHelp = 'Use Connect Telegram above to connect a bot and chat. You can then optionally enable task control for a trusted person.'
export const sendTestBlocker = 'Send a test and make sure it arrives.'
/** Only what blocks task control on this receiver, each with its fix (mirrors the server's receiverEligible). */
export function setupBlockers(receiver: WebhookReceiver): string[] {
  return [
    ...(receiver.state !== 'active' && receiver.state !== 'suspended' ? [`${receiver.state === 'paused' ? 'Resume' : 'Activate'} this chat’s notifications in Chats above.`] : []),
    ...(receiver.lastTest !== 'success' ? [sendTestBlocker] : []),
    ...(receiver.profile !== 'standard' ? ['Choose Standard message content in this chat’s Options above.'] : []),
    ...(receiver.preset !== 'attention' && receiver.preset !== 'all' && !receiver.events.includes('task.attention_required') ? ['Remove this chat and connect it again with Add a chat to include the Needs your input event.'] : []),
    ...(!/^-?[1-9][0-9]*$/.test(receiver.telegramChatId ?? '') ? ['Remove this chat and connect it again with Add a chat to verify the chat.'] : []),
  ]
}

/** Every chat of this bot has replies disabled by the operator, so the bot is deliberately not listening. */
export function repliesDisabled(state: TelegramInboundStateResponse, botId: string, receivers: readonly Pick<WebhookReceiver, 'id' | 'state'>[] = []): boolean {
  const rows = state.receivers.filter(row => row.botId === botId)
  // A paused chat suspends its replies on purpose too; only an unexplained suspension is a fault.
  return rows.length > 0 && rows.every(row => row.state === 'disabled'
    || (row.state === 'suspended' && !row.suspendedReason && receivers.find(item => item.id === row.receiverId)?.state === 'paused'))
}

const taskControlRisk = 'Task control lets a person instruct agents that run shell commands on this machine.'
const permissionLabels = { start: 'Start tasks', cancel: 'Cancel tasks', continue: 'Continue tasks' } as const
// New tasks start only from a private chat, so a group never offers `start`.
const optionalPermissions = (group: boolean) => (group ? ['cancel', 'continue'] as const : ['start', 'cancel', 'continue'] as const)
type InboundRow = TelegramInboundStateResponse['receivers'][number]
type Availability = { available: boolean; reason?: string }
type WizardStep = 'choose' | 'waiting' | 'confirm' | 'replace' | 'activating' | 'complete' | 'recovery'
export function TelegramSettings({ projectId, receivers, setupApi = defaultSetupApi }: { projectId: string; receivers: WebhookReceiver[]; setupApi?: TelegramSetupApi }) {
  const shortId = (id: string) => id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id
  const client = useQueryClient(), key = telegramKey(projectId)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [confirmation, setConfirmation] = useState<{ botId: string; revision: string; disconnect: boolean; orphan?: boolean }>()
  const [revokeConfirmation, setRevokeConfirmation] = useState<{ grantId: string; revision: string; label: string }>()
  const [enableVisibility, setEnableVisibility] = useState<Record<string, boolean>>({})
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const [wizard, setWizard] = useState<WizardStep>('choose')
  // Approval opens only when the user asks for it on one chat; a notifications-only chat never shows a form.
  const [wizardReceiver, setWizardReceiver] = useState('')
  const [dedicatedBot, setDedicatedBot] = useState(false), [groupVisibility, setGroupVisibility] = useState(false), [comparisonVerified, setComparisonVerified] = useState(false)
  const [setup, setSetup] = useState<TelegramSetupBegun>()
  // Unmounting mid-setup (collapsing the panel, leaving the page) cancels the session too.
  const openSetup = useRef<string | undefined>(undefined)
  openSetup.current = setup?.setupId
  useEffect(() => () => { if (openSetup.current) void setupApi.cancel(projectId, openSetup.current).catch(() => undefined) }, [projectId, setupApi])
  const [setupStatus, setSetupStatus] = useState<TelegramSetupStatus>()
  const [approved, setApproved] = useState<{ label: string; group: boolean }>()
  const [wizardPermissions, setWizardPermissions] = useState<TelegramInboundGrant['permissions']>(['respond'])
  const [wizardError, setWizardError] = useState('')
  const wizardRequest = useRef(0)
  const recoveryAction = useRef<HTMLButtonElement>(null), completeAction = useRef<HTMLButtonElement>(null), replaceAction = useRef<HTMLButtonElement>(null)
  const chooseTarget = useRef<HTMLHeadingElement>(null), waitingTarget = useRef<HTMLHeadingElement>(null), confirmTarget = useRef<HTMLHeadingElement>(null), activatingTarget = useRef<HTMLHeadingElement>(null)
  const bindings = useQuery({ queryKey: [...key, 'bindings'], queryFn: ({ signal }) => telegramApi.bindings(signal), enabled: showDiagnostics, retry: false })
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const list = useQuery({ queryKey: key, queryFn: ({ signal }) => telegramApi.list(projectId, signal), retry: false })
  const taskControl: Availability | undefined = list.data?.taskControl
  useTelegramSubscription(projectId, taskControl?.available === true)
  // Test results and pause/resume land on the webhook list; keep the chat rows live.
  useWebhookSubscription(projectId, true)
  const setupPoll = useQuery({ queryKey: [...key, 'setup', setup?.setupId], queryFn: ({ signal }) => setupApi.status(projectId, setup!.setupId, signal), enabled: !!setup && wizard === 'waiting', retry: false, refetchInterval: 2_000 })
  const activity = useInfiniteQuery({ queryKey: [...key, 'activity'], initialPageParam: undefined as string | undefined, queryFn: ({ signal, pageParam }) => telegramApi.activity(projectId, signal, pageParam), getNextPageParam: page => page.nextCursor, enabled: showDiagnostics && taskControl?.available === true, retry: false })
  useEffect(() => {
    if (!setupPoll.data || wizard !== 'waiting') return
    setSetupStatus(setupPoll.data)
    if (setupPoll.data.status === 'candidate') setWizard('confirm')
    else if (setupPoll.data.status === 'expired') { setSetup(undefined); setWizardError('This setup link expired. Create a new link and try again.'); setWizard('recovery') }
  }, [setupPoll.data, wizard])
  useEffect(() => { if (setupPoll.error && wizard === 'waiting') { setWizardError(telegramMessage(setupPoll.error)); setWizard('recovery') } }, [setupPoll.error, wizard])
  // Focus at commit, so the moved-to step is focused before anything else can react to it.
  useLayoutEffect(() => {
    const target = { waiting: waitingTarget, confirm: confirmTarget, activating: activatingTarget, recovery: recoveryAction, complete: completeAction, replace: replaceAction, choose: wizardReceiver ? chooseTarget : undefined }[wizard]?.current
    target?.focus()
  }, [wizard, wizardReceiver])
  const act = async (work: () => Promise<unknown>, success: string | false = 'Telegram settings updated') => {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await work(); if (mounted.current && success) toast(success) } catch (cause) { if (mounted.current) setError(telegramMessage(cause)) }
    finally { await Promise.all([client.invalidateQueries({ queryKey: key }), client.invalidateQueries({ queryKey: webhookKey(projectId) })]); if (mounted.current) setBusy(false) }
  }
  if (list.isPending) return <p role="status">Loading Telegram settings…</p>
  const data = list.data
  const inboundRows: InboundRow[] = data?.receivers ?? [], grants = data?.grants ?? []
  const controlled = (id: string) => grants.some(grant => grant.receiverId === id)
  const bound = (id: string) => inboundRows.some(row => row.receiverId === id && !!row.botId)
  const duplicates = duplicateChats(receivers, controlled, bound)
  const chats = <TelegramChats projectId={projectId} receivers={receivers} controlled={controlled} bound={bound} />
  if (!data) return <div className="flex flex-col gap-4 text-sm">{chats}<div><p role="alert">{telegramMessage(list.error)}</p><Button variant="outline" onClick={() => void list.refetch()}>Retry loading settings</Button></div></div>
  const knownReceivers = inboundRows.flatMap(row => { const receiver = receivers.find(item => item.id === row.receiverId); return receiver ? [{ row, receiver }] : [] })
  const connectedBot = inboundRows.some(row => row.botId)
  const botChats = (botId: string) => inboundRows.filter(row => row.botId === botId).length
  // A private receiver binds exactly one person (its chat owner); a group can pair each member in turn.
  // A suspended private receiver whose person can no longer be re-enabled is paired again through replacement.
  const stalePairing = (row: { receiverId: string; state: string }, receiver: WebhookReceiver) => !isGroup(receiver) && row.state === 'suspended' && controlled(receiver.id)
  // A private chat binds one receiver; another receiver of the same chat only sends notifications (server: chat_conflict).
  const controlledBy = (receiver: WebhookReceiver) => {
    if (isGroup(receiver)) return undefined
    const holders = knownReceivers.filter(other => other.receiver.id !== receiver.id && !!other.row.botId && other.receiver.telegramChatId === receiver.telegramChatId)
    return (holders.find(other => controlled(other.receiver.id)) ?? holders[0])?.receiver
  }
  const approvable = ({ row, receiver }: { row: InboundRow; receiver: WebhookReceiver }) => !controlledBy(receiver) && row.suspendedReason !== 'group_migrated' && (isGroup(receiver) || stalePairing(row, receiver) || !controlled(receiver.id))
  const setupReceivers = knownReceivers.filter(item => !setupBlockers(item.receiver).length && approvable(item))
  const selected = setupReceivers.find(item => item.row.receiverId === wizardReceiver)
  const group = isGroup(receivers.find(item => item.id === wizardReceiver))
  const resetWizard = () => {
    wizardRequest.current += 1
    if (setup) void setupApi.cancel(projectId, setup.setupId).catch(() => undefined)
    setSetup(undefined); setSetupStatus(undefined); setApproved(undefined); setWizardReceiver(''); setDedicatedBot(false); setGroupVisibility(false); setComparisonVerified(false); setWizardPermissions(['respond']); setWizardError(''); setWizard('choose')
  }
  // The bot-dedication consent was given when the bot was connected; only a chat with no bot yet asks for it here.
  const needsDedication = !!selected && !selected.row.botId
  const beginWizard = async (replaceExisting = false) => {
    if (!selected || (needsDedication && !dedicatedBot) || (group && !groupVisibility)) return
    const request = ++wizardRequest.current, { receiverId, inboundRevision: expectedRevision } = selected.row
    setWizardReceiver(receiverId); setWizardError(''); setWizard('waiting')
    const begin = (revision: string) => setupApi.begin(projectId, { receiverId, expectedRevision: revision, dedicatedBot: true,
      ...(replaceExisting ? { replaceExisting: true as const } : {}), ...(group ? { groupVisibilityAccepted: true as const } : {}) })
    try {
      let begun: TelegramSetupBegun
      // A shared bot or a replacement answers conflict on its normal path; retry once with the fresh revision.
      try { begun = await begin(expectedRevision) } catch (cause) {
        if (errorCode(cause) !== 'conflict' || request !== wizardRequest.current || !mounted.current) throw cause
        const fresh = (await telegramApi.list(projectId)).receivers.find(row => row.receiverId === receiverId)?.inboundRevision ?? ''
        if (request !== wizardRequest.current || !mounted.current) return
        begun = await begin(fresh)
      }
      if (request !== wizardRequest.current || !mounted.current) { void setupApi.cancel(projectId, begun.setupId).catch(() => undefined); return }
      setSetup(begun)
    } catch (cause) {
      if (request !== wizardRequest.current || !mounted.current) return
      if (errorCode(cause) === 'replacement_required' && !replaceExisting) { setWizard('replace'); return }
      setWizardError(telegramMessage(cause)); setWizard('recovery')
    }
  }
  const activateWizard = async () => {
    const candidate = setupStatus?.candidate
    if (!setup || !candidate || (candidate.comparisonCode && !comparisonVerified)) return
    setWizardError(''); setWizard('activating')
    try {
      await setupApi.activate(projectId, setup.setupId, { expectedRevision: setupStatus.inboundRevision, candidateUserId: candidate.userId, permissions: wizardPermissions, ...(candidate.comparisonCode ? { comparisonVerified: true as const } : {}) })
      // Activation consumed the session; nothing is left to cancel.
      setSetup(undefined); setApproved({ label: candidate.label, group: !!candidate.comparisonCode }); await client.invalidateQueries({ queryKey: key }); setWizard('complete')
    } catch (cause) { setWizardError(telegramMessage(cause)); setWizard('recovery') }
  }
  const openApproval = (item: { row: InboundRow; receiver: WebhookReceiver }) => {
    resetWizard(); setWizardReceiver(item.row.receiverId)
    if (stalePairing(item.row, item.receiver)) setWizard('replace')
  }
  const sendTest = (receiver: WebhookReceiver) => act(async () => { await webhookApi.test(projectId, receiver.id, { expectedRevision: receiver.revision, deliveryRevision: receiver.deliveryRevision, operationId: crypto.randomUUID() }); if (mounted.current) setNotice(`Test sent to ${receiver.name}. Check the chat.`) }, false)
  const candidate = setupStatus?.candidate
  // A stopped bot that is not meant to listen reads as notifications only, without a poll time.
  const notificationsOnly = (bot: { botId: string; health: { state: string } }) => bot.health.state !== 'stopped' ? undefined
    : botChats(bot.botId) === 0 ? 'No chats in this project — bot still assigned'
    : !grants.length || !taskControl?.available ? 'Notifications only — not listening for replies'
      : repliesDisabled(data, bot.botId, receivers) ? 'Notifications only — replies paused or disabled' : undefined
  // Access management exists only once a bot is connected and task control is available.
  const managed = taskControl?.available === true && (connectedBot || grants.length > 0)
  // A duplicate chat cannot hold task control of its own; it is removed from Chats instead.
  const peopleRows = knownReceivers.filter(({ receiver }) => !duplicates.has(receiver.id))
  const approval = (item: { row: InboundRow; receiver: WebhookReceiver }) => <div className="flex flex-col gap-3 rounded border border-dashed p-3" data-slot="telegram-approve">
    <div><h4 ref={chooseTarget} tabIndex={-1} className="font-medium">Approve a person</h4><p className="text-muted-foreground">{group ? 'Approve a member of this group to answer and manage tasks there.' : 'Approve the person who owns this private chat.'}</p></div>
    {wizard === 'choose' && !selected && <>
      <p>Before task control can work, fix this chat:</p>
      <ul className="list-disc pl-5">{setupBlockers(item.receiver).map(blocker => <li key={blocker}>{blocker}</li>)}</ul>
      <div className="flex gap-2">{setupBlockers(item.receiver).includes(sendTestBlocker) && <Button variant="outline" size="sm" disabled={busy} onClick={() => void sendTest(item.receiver)}>Send test</Button>}<Button variant="outline" size="sm" onClick={resetWizard}>Close</Button></div>
    </>}
    {wizard === 'choose' && selected && <>
      {group && <>
        <p className="rounded border border-warning/50 bg-warning/10 p-2">Every member of this group can read project messages. Approved members can answer questions and use /tasks, /status and /reply there; new tasks start only from a private chat. Forum groups are not supported.</p>
        <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5" checked={groupVisibility} onChange={event => setGroupVisibility(event.target.checked)} />I understand that all group members can read project messages, including people without permission to control tasks.</label>
      </>}
      {needsDedication && <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5" checked={dedicatedBot} onChange={event => setDedicatedBot(event.target.checked)} />This bot is dedicated to this project: no other application receives its messages.</label>}
      <p className="text-muted-foreground">Cezar checks the chat’s saved bot token and creates a one-time link that expires in five minutes. The token is never shown here.</p>
      <div className="flex gap-2"><Button disabled={(needsDedication && !dedicatedBot) || (group && !groupVisibility)} onClick={() => void beginWizard()}>Create Telegram link</Button><Button variant="outline" onClick={resetWizard}>Cancel</Button></div>
    </>}
    {wizard === 'waiting' && <>
      <h4 ref={waitingTarget} tabIndex={-1} className="font-medium">Open Telegram and press Start</h4>
      <p role="status" aria-live="polite">{setup ? `Waiting for Telegram… ${group ? 'The person to approve opens this link in their own private chat with' : 'Open this link in your private chat with'} @${setup.bot.username} and ${group ? 'presses' : 'press'} Start.` : 'Checking the saved bot token…'}</p>
      {setup && <a className="underline" href={setup.deepLink} target="_blank" rel="noopener noreferrer">Open Telegram</a>}
      <div><Button variant="outline" onClick={resetWizard}>Cancel setup</Button></div>
    </>}
    {wizard === 'replace' && <>
      <p role="alert">{stalePairing(item.row, item.receiver) ? 'This chat changed since its person was approved.' : 'This chat’s bot or chat changed.'} Replacing the pairing removes every approved person and reply link for this chat; other chats keep their access.</p>
      <div className="flex gap-2"><Button variant="outline" onClick={resetWizard}>Keep current access</Button><Button ref={replaceAction} variant="danger-ghost" onClick={() => void beginWizard(true)}>Replace pairing and create link</Button></div>
    </>}
    {wizard === 'confirm' && setupStatus && candidate && <>
      <h4 ref={confirmTarget} tabIndex={-1} className="font-medium">Confirm task control</h4>
      <p role="status"><strong>{candidate.label || 'Telegram user'}</strong>{candidate.username ? ` (@${candidate.username})` : ''} · Telegram ID {shortId(candidate.userId)} pressed Start in @{setupStatus.bot.username}.</p>
      {candidate.comparisonCode && <><p>Comparison code: <strong>{candidate.comparisonCode}</strong></p>
        <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5" checked={comparisonVerified} onChange={event => setComparisonVerified(event.target.checked)} />I compared this code with the code the bot sent to this person privately.</label></>}
      <fieldset className="flex flex-col gap-2"><legend className="font-medium">Permissions</legend>
        <p className="text-muted-foreground">Always allowed: answer questions and check task status.</p>
        {optionalPermissions(group).map(permission => <label className="flex gap-2" key={permission}><input type="checkbox" checked={wizardPermissions.includes(permission)} onChange={event => setWizardPermissions(current => event.target.checked ? [...current, permission] : current.filter(value => value !== permission))} />{permissionLabels[permission]}</label>)}
        <p className="text-muted-foreground">{taskControlCostNote}</p>
      </fieldset>
      <p role="alert" className="rounded border border-warning/50 bg-warning/10 p-2">{taskControlRisk}</p>
      <div className="flex gap-2"><Button variant="outline" onClick={resetWizard}>Not this person</Button><Button disabled={!!candidate.comparisonCode && !comparisonVerified} onClick={() => void activateWizard()}>Activate task control</Button></div>
    </>}
    {wizard === 'activating' && <><h4 ref={activatingTarget} tabIndex={-1} className="font-medium">Activating task control</h4><p role="status" aria-live="polite">Activating task control…</p></>}
    {wizard === 'complete' && <>
      <p role="status" aria-live="polite" className="rounded border border-success/50 bg-success/10 p-2">{approved?.group
        ? `Task control is active for ${approved.label} in this group. They can answer questions and use /tasks, /status and /reply there.`
        : `Task control is active for ${approved?.label ?? 'this person'} in their private Telegram chat.`}</p>
      <p className="text-muted-foreground">{approved?.group
        ? 'To approve another member of this group, use Approve another member.'
        : 'A private chat serves exactly one person. To give another person task control, connect their private chat with Add a chat above.'}</p>
      <div><Button ref={completeAction} variant="outline" onClick={resetWizard}>Done</Button></div>
    </>}
    {wizard === 'recovery' && <><p role="alert" className="text-danger">{wizardError || 'Telegram setup could not continue.'}</p><p className="text-muted-foreground">Check the chat and the bot diagnostics below. You can reset damaged access or release an orphaned assignment without a chat.</p><div className="flex gap-2"><Button ref={recoveryAction} onClick={async () => { const keep = { receiver: wizardReceiver, dedicated: dedicatedBot, visibility: groupVisibility }; await client.invalidateQueries({ queryKey: key }); if (!mounted.current) return; resetWizard(); setWizardReceiver(keep.receiver); setDedicatedBot(keep.dedicated); setGroupVisibility(keep.visibility) }}>Try again</Button><Button variant="outline" onClick={resetWizard}>Exit setup</Button></div></>}
  </div>
  return <div className="flex flex-col gap-4 text-sm">
    {notice && <p role="status" aria-live="polite" className="rounded border border-success/50 bg-success/10 p-2">{notice}</p>}
    {error && !confirmation && !revokeConfirmation && <p role="alert" className="text-danger">{error}</p>}
    {!receivers.length && !inboundRows.length && <div className="rounded border border-dashed p-4"><p className="font-medium">No Telegram receivers yet</p><p className="text-muted-foreground">{addReceiverHelp}</p></div>}
    {chats}
    {managed && !!peopleRows.length && <section className="flex flex-col gap-3" data-slot="telegram-people">
      <div><h3 className="font-medium">People and permissions</h3><p className="text-muted-foreground">Approved people can answer questions and use /tasks, /status and /reply. Starting tasks (private chats only), /cancel and /continue each need their own permission; cancel and continue ask for confirmation in Telegram. Access applies to all tasks in this project.</p></div>
      {!!grants.length && <p className="rounded border border-warning/50 bg-warning/10 p-2">Task-control access lets approved people instruct an agent that may run shell commands on this machine. Approve only people you trust.</p>}
      {peopleRows.map(item => {
        const { row, receiver } = item, rowGrants = grants.filter(grant => grant.receiverId === row.receiverId)
        const blockers = setupBlockers(receiver), groupChat = isGroup(receiver), enabling = row.state !== 'active', migrated = row.suspendedReason === 'group_migrated'
        const visibility = !groupChat || enableVisibility[row.receiverId] === true, open = wizardReceiver === row.receiverId
        const approveLabel = stalePairing(row, receiver) ? 'Replace pairing' : groupChat && rowGrants.length ? 'Approve another member' : 'Enable task control'
        return <div role="group" aria-label={`Task control in ${receiver.name}`} key={row.receiverId} className="flex flex-col gap-2 rounded border p-3">
          <div className="flex flex-wrap items-baseline gap-2"><strong>{receiver.name}</strong><span className="text-muted-foreground">{rowGrants.length ? receiverStateLabels[row.state] ?? 'Status unavailable' : 'Notifications only'}</span></div>
          {row.suspendedReason === 'bot_removed' && <p>{groupChat ? 'Replies are suspended because the bot was removed from this group. Add the bot back to the group, then use Enable replies.' : 'Replies are suspended because the person blocked the bot. After they unblock it in Telegram, use Enable replies.'}</p>}
          {migrated && <p>Replies are suspended because Telegram upgraded this group and gave it a new chat ID. Remove this chat in Chats above and connect the group again with Add a chat.</p>}
          {row.state === 'suspended' && !row.suspendedReason && !!rowGrants.length && <p>{receiver.state === 'paused' ? 'Replies are paused with this chat’s notifications. Resume it in Chats above.' : stalePairing(row, receiver) ? 'Replies are suspended because this chat changed. Use Enable replies once its notifications are active again; if that fails, use Replace pairing to approve the person again.' : 'Replies are suspended because this chat changed. Use Enable replies once its notifications are active again.'}</p>}
          {!!rowGrants.length && !!blockers.length && <div><p>Before task control can work, fix this chat:</p><ul className="list-disc pl-5">{blockers.map(blocker => <li key={blocker}>{blocker}</li>)}</ul>
            {blockers.includes(sendTestBlocker) && <Button className="mt-2" variant="outline" size="sm" disabled={busy} onClick={() => void sendTest(receiver)}>Send test</Button>}</div>}
          {!!rowGrants.length && !migrated && <div className="flex flex-wrap items-center gap-2">
            {groupChat && enabling && <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5" checked={visibility} onChange={event => setEnableVisibility(current => ({ ...current, [row.receiverId]: event.target.checked }))} />I understand that all group members can read project messages.</label>}
            <Button variant="outline" size="sm" disabled={busy || (enabling && (!!blockers.length || !visibility))} onClick={() => void act(async () => { await telegramApi.enable(projectId, row.receiverId, row.inboundRevision, enabling, enabling && groupChat); if (mounted.current) setNotice(enabling ? `Replies enabled for ${receiver.name}.` : `Replies disabled for ${receiver.name}.`) })}>{enabling ? 'Enable replies' : 'Disable replies'}</Button>
          </div>}
          {rowGrants.map(grant => <div key={grant.id} className="flex flex-wrap items-center gap-x-3 gap-y-1"><span>{grant.label} · Telegram ID {shortId(grant.userId)}</span>
            {optionalPermissions(groupChat).map(permission => <label key={permission} className="flex items-center gap-1"><input type="checkbox" aria-label={`${permissionLabels[permission]} for ${grant.label}`} checked={grant.permissions.includes(permission)} disabled={busy} onChange={event => {
              const permissions = event.target.checked ? [...grant.permissions, permission] : grant.permissions.filter(value => value !== permission)
              void act(() => telegramApi.permissions(projectId, grant.id, row.inboundRevision, permissions))
            }} />{permissionLabels[permission]}</label>)}<Button variant="outline" size="sm" disabled={busy} onClick={() => setRevokeConfirmation({ grantId: grant.id, revision: row.inboundRevision, label: grant.label })}>Revoke access</Button></div>)}
          {!open && approvable(item) && <div><Button variant="outline" size="sm" disabled={busy || (wizard !== 'choose' && !!wizardReceiver)} onClick={() => openApproval(item)}>{approveLabel}</Button></div>}
          {open && approval(item)}
        </div>
      })}
      {!!grants.length && <p className="text-muted-foreground">{taskControlCostNote}</p>}
    </section>}
    {data.bots.map(bot => <div key={bot.botId} className="flex flex-col gap-2 rounded border p-3" data-slot="telegram-bot">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* Only the health label is live, so a fresh poll time never re-announces the line. */}
        <span>Telegram bot {bot.username ? `@${bot.username}` : shortId(bot.botId)}: <span role="status">{notificationsOnly(bot) ?? telegramHealthLabels[bot.health.state] ?? 'Status unavailable'}</span>
          {!notificationsOnly(bot) && <> · Last successful poll: {pollTime(bot.health.lastSuccessfulPollAt)}</>}</span>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void client.invalidateQueries({ queryKey: key })}>Refresh status</Button>
      </div>
      {!!bot.health.droppedReplies && <p role="status">{plural(bot.health.droppedReplies, 'bot reply was', 'bot replies were')} dropped since this bot started. Task actions are not retried.</p>}
      {!bot.inboundRevision && <p>State cannot be safely read. Reset is unavailable until its integrity can be checked.</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={busy || !bot.inboundRevision} onClick={() => { if (bot.inboundRevision) setConfirmation({ botId: bot.botId, revision: bot.inboundRevision, disconnect: false }) }}>Reset access</Button>
        <Button variant="outline" size="sm" disabled={busy || !bot.inboundRevision} onClick={() => { if (bot.inboundRevision) setConfirmation({ botId: bot.botId, revision: bot.inboundRevision, disconnect: true }) }}>Disconnect bot</Button>
      </div>
      <p className="text-muted-foreground">Use one dedicated bot per project.</p>
    </div>)}
    <Dialog open={!!confirmation} onOpenChange={open => { if (!open && !busy) setConfirmation(undefined) }}>
      <DialogContent><DialogHeader><DialogTitle>{confirmation?.orphan ? 'Release orphaned bot?' : confirmation?.disconnect ? 'Disconnect Telegram bot?' : 'Reset Telegram access?'}</DialogTitle>
        <DialogDescription>{confirmation?.orphan ? 'This releases the bot from a missing project. Old approvals cannot be restored by bringing that project back. The bot will also be released for another project.'
          : confirmation?.disconnect && botChats(confirmation.botId) === 0 ? 'This bot has no chats in this project. Releasing it removes its approved people and reply links and lets another project use it.'
          : confirmation?.disconnect ? `This deletes this bot’s ${plural(botChats(confirmation.botId), 'chat', 'chats')} from this project (with ${botChats(confirmation.botId) === 1 ? 'its' : 'their'} notification options), all approved people and reply links, and releases the bot for another project. To use it again, connect each chat again.`
            : 'This removes all approved people and reply links for this bot. Notifications keep arriving, and the bot stays assigned to this project. Use Enable task control on a chat to approve someone again.'}</DialogDescription>
      </DialogHeader>{error && <p role="alert" className="text-danger">{error}</p>}<DialogFooter><Button variant="outline" disabled={busy} onClick={() => setConfirmation(undefined)}>{confirmation?.orphan ? 'Keep assignment' : confirmation?.disconnect ? 'Keep bot' : 'Keep access'}</Button>
        <Button variant="danger-ghost" disabled={busy} onClick={() => { if (confirmation) { const action = confirmation; void act(async () => {
          if (action.orphan) await telegramApi.releaseBinding(action.botId, action.revision)
          else await (action.disconnect ? telegramApi.disconnect : telegramApi.reset)(projectId, action.botId, action.revision)
          if (mounted.current) setConfirmation(undefined)
        }) } }}>{confirmation?.orphan || confirmation?.disconnect && botChats(confirmation.botId) === 0 ? 'Release bot' : confirmation?.disconnect ? 'Disconnect and remove chats' : 'Reset access'}</Button></DialogFooter></DialogContent>
    </Dialog>
    <Dialog open={!!revokeConfirmation} onOpenChange={open => { if (!open && !busy) setRevokeConfirmation(undefined) }}>
      <DialogContent><DialogHeader><DialogTitle>Revoke access for {revokeConfirmation?.label}?</DialogTitle>
        <DialogDescription>This immediately removes this person’s Telegram permissions and reply links. Notifications keep arriving. Use Enable task control on the chat to approve them again.</DialogDescription>
      </DialogHeader>{error && <p role="alert" className="text-danger">{error}</p>}<DialogFooter><Button variant="outline" disabled={busy} onClick={() => setRevokeConfirmation(undefined)}>Keep access</Button>
        <Button variant="danger-ghost" disabled={busy} onClick={() => { if (revokeConfirmation) { const action = revokeConfirmation; void act(async () => { await telegramApi.revoke(projectId, action.grantId, action.revision); if (mounted.current) setRevokeConfirmation(undefined) }) } }}>Revoke access</Button></DialogFooter></DialogContent>
    </Dialog>
    <Disclosure label="Diagnostics" open={showDiagnostics} onOpenChange={setShowDiagnostics}>
      <section className="flex flex-col gap-2" aria-label="Recent Telegram actions">
        <h4 className="font-medium">Recent Telegram actions</h4>
          {activity.error && <p role="alert">{telegramMessage(activity.error)}</p>}
          {activity.data?.pages.flatMap(page => page.entries).map(entry => <p key={entry.id} className={entry.state === 'uncertain' ? 'text-warning' : ''}>{new Date(entry.at).toLocaleString()} · {entry.kind === 'rejection_summary' ? `Bot-wide · ${entry.count} rejected messages · ${activityReason(entry.reason)}` : [
            grants.find(grant => grant.userId === entry.userId && (!entry.chatId || grant.chatId === entry.chatId))?.label ?? `Telegram ID ${shortId(entry.userId ?? '')}`,
            activityKindLabels[entry.kind] ?? 'Unknown command', ...(entry.runId ? [`task ${entry.runId.slice(0, 8)}`] : []),
            `${activityStateLabels[entry.state] ?? 'Outcome unknown'}: ${activityReason(entry.reason, entry.state)}`].join(' · ')}</p>)}
          {activity.hasNextPage && <Button variant="outline" disabled={activity.isFetchingNextPage} onClick={() => void activity.fetchNextPage()}>Load older actions</Button>}
          {activity.data?.pages[0]?.entries.length === 0 && <p>No recorded actions.</p>}
      </section>
      <section className="flex flex-col gap-2 pt-2" aria-label="Bot assignments">
        <h4 className="font-medium">Bot assignments</h4>
          {bindings.isPending && <p role="status">Loading assignments…</p>}
          {bindings.error && <p role="alert">{telegramMessage(bindings.error)}</p>}
          {bindings.data?.truncated && <p role="alert">Some assignments could not be listed. This view is incomplete.</p>}
          {bindings.data?.bindings.length === 0 && <p>No bot assignments.</p>}
          {bindings.data?.bindings.map(binding => <div key={binding.botId} className="flex flex-wrap items-center gap-2">
            <span>Telegram bot {shortId(binding.botId)} · project {binding.projectName ?? binding.projectId} · {binding.orphaned ? 'project unavailable' : 'assigned'}</span>
            {binding.orphaned && <Button variant="outline" disabled={busy} onClick={() => setConfirmation({ botId: binding.botId, revision: binding.inboundRevision, disconnect: true, orphan: true })}>Release orphaned bot</Button>}
          </div>)}
      </section>
    </Disclosure>
  </div>
}

/** The cockpit's collapsible pattern (automation filters): a quiet chevron trigger, content on demand. */
function Disclosure({ label, open, onOpenChange, children }: { label: string; open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) {
  return <Collapsible open={open} onOpenChange={onOpenChange}>
    <CollapsibleTrigger asChild>
      <button type="button" className="inline-flex h-6 items-center gap-1 rounded-sm text-ui text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
        <ChevronDownIcon aria-hidden="true" className={cn('size-3 transition-transform', open ? '' : '-rotate-90')} />{label}
      </button>
    </CollapsibleTrigger>
    <CollapsibleContent className="flex flex-col gap-3 pt-2">{children}</CollapsibleContent>
  </Collapsible>
}
