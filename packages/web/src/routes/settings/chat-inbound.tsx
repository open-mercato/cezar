import { chatErrorCode, chatErrorMessage } from '@/lib/chat-providers/messages'
import type { ChatProviderDescriptor } from '@/lib/chat-providers/types'
import { ChatDiscoveryCommand } from './chat-discovery-command'
import { ChevronDownIcon } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  ChatInboundGrant,
  ChatInboundStateResponse,
  ChatSetupBegin,
  ChatSetupBegun,
  ChatSetupStatus,
  WebhookReceiver,
} from '@open-mercato/cezar-api-client'
import { webhookApi } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { toast } from '@/components/ui/toaster'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { chatKey, useChatSubscription } from '@/hooks/use-chat'
import { webhookKey } from '@/hooks/use-webhooks'
import { cn } from '@/lib/utils'
import { ChatList, duplicateChats, taskControlCostNote } from './chat-list'
import { plural } from './webhook-presentation'
import { beginChatSetup, setupGone } from './chat-pairing'
import { LoadingState, RowsSkeleton } from '@/components/loading-state'

const chatHealthLabels: Record<string, string> = {
  stopped: 'Not running',
  polling: 'Connected and listening',
  backoff: 'Temporarily retrying',
  blocked: 'Blocked — check the bot settings',
  conflict: 'Another cockpit owns this bot',
  'credentials-unavailable': 'Bot credentials unavailable',
}
const receiverStateLabels: Record<string, string> = {
  disabled: 'Task control off',
  pairing: 'Pairing in progress',
  active: 'Task control on',
  suspended: 'Task control suspended',
  'credentials-unavailable': 'Bot credentials unavailable',
  conflict: 'Another cockpit owns this bot',
  blocked: 'Blocked — check the bot settings',
  stopped: 'Not running',
}
const activityReasonLabels: Record<string, string> = {
  delivered: 'delivered',
  queued: 'queued for delivery',
  deferred: 'saved until the session starts',
  read: 'answered',
  preview: 'confirmation sent',
  executed: 'carried out',
  unauthorized: 'not paired',
  permission_denied: 'no permission for this action',
  rate_limited: 'too many messages',
  expired: 'message too old',
  unsupported: 'unsupported command',
  context_unavailable: 'project unavailable',
  unknown_task: 'task not found',
  unknown_reply: 'reply did not match a task',
  empty_text: 'no answer text',
  too_long: 'message too long',
  confirmation_limit: 'too many pending confirmations',
  configuration_unknown: 'task state does not allow this',
  account_unknown: 'saved account unknown',
  action_changed: 'task changed before confirmation',
  delivery_refused: 'delivery refused',
  delivery_uncertain: 'delivery outcome unknown',
  action_refused: 'action refused',
  action_uncertain: 'action outcome unknown',
  stale_reply: 'reply no longer current',
  not_waiting: 'task no longer waiting',
  grant_changed: 'access changed',
  interrupted: 'interrupted by a restart',
  pending: 'in progress',
  bot_not_group_member: 'bot is not in the group',
  candidate_not_group_member: 'person is not in the group',
  task_created: 'task started',
  declined: 'cancelled before starting',
  provider_unavailable: 'provider unavailable',
  account_unavailable: 'saved account unavailable',
  project_unavailable: 'project unavailable',
  creation_failed: 'task could not be created',
}
const activityKindLabels: Record<string, string> = {
  answer: 'Answered a task',
  status: 'Checked status',
  tasks: 'Listed tasks',
  task: 'Task request',
  help: 'Asked for help',
  cancel: 'Cancel',
  continue: 'Continue',
  unknown_command: 'Unknown command',
}
const activityStateLabels: Record<string, string> = {
  accepted: 'Done',
  queued: 'Queued',
  deferred: 'Deferred',
  rejected: 'Refused',
  uncertain: 'Outcome unknown',
}
function activityReason(reason: string, state?: string): string {
  return (
    activityReasonLabels[reason] ??
    (state === 'accepted' || state === 'queued' || state === 'deferred' ? 'completed' : 'not completed')
  )
}

function pollTime(value?: number): string {
  return value ? new Date(value).toLocaleString() : 'not yet'
}

const sendTestBlocker = 'Send a test and make sure it arrives.'
/** Only what blocks task control on this receiver, each with its fix (mirrors the server's receiverEligible). */
export function setupBlockers(receiver: WebhookReceiver, provider: ChatProviderDescriptor): string[] {
  return [
    ...(receiver.state !== 'active' && receiver.state !== 'suspended'
      ? [`${receiver.state === 'paused' ? 'Resume' : 'Activate'} this chat’s notifications in Chats above.`]
      : []),
    ...(receiver.lastTest !== 'success' ? [sendTestBlocker] : []),
    ...(receiver.profile !== 'standard' ? ['Choose Standard message content in this chat’s Options above.'] : []),
    ...(receiver.preset !== 'attention' &&
    receiver.preset !== 'all' &&
    !receiver.events.includes('task.attention_required')
      ? ['Remove this chat and connect it again with Add a chat to include the Needs your input event.']
      : []),
    ...(!provider.bot.validChatId(receiver.chatId)
      ? ['Remove this chat and connect it again with Add a chat to verify the chat.']
      : []),
  ]
}

/** Every chat of this bot has replies disabled by the operator, so the bot is deliberately not listening. */
export function repliesDisabled(
  state: ChatInboundStateResponse,
  botId: string,
  receivers: readonly Pick<WebhookReceiver, 'id' | 'state'>[] = [],
): boolean {
  const rows = state.receivers.filter(row => row.botId === botId)
  // A paused chat suspends its replies on purpose too; only an unexplained suspension is a fault.
  return (
    rows.length > 0 &&
    rows.every(
      row =>
        row.state === 'disabled' ||
        (row.state === 'suspended' &&
          !row.suspendedReason &&
          receivers.find(item => item.id === row.receiverId)?.state === 'paused'),
    )
  )
}

const taskControlRisk = 'Task control lets a person instruct agents that run shell commands on this machine.'
const permissionLabels = { start: 'Start tasks', cancel: 'Cancel tasks', continue: 'Continue tasks' } as const
// New tasks start only from a private chat, so a group never offers `start`.
const optionalPermissions = (group: boolean) =>
  group ? (['cancel', 'continue'] as const) : (['start', 'cancel', 'continue'] as const)
type InboundRow = ChatInboundStateResponse['receivers'][number]
type Availability = { available: boolean; reason?: string }
type WizardStep = 'choose' | 'waiting' | 'confirm' | 'replace' | 'activating' | 'complete' | 'recovery'
export function ChatSettings({
  provider,
  projectId,
  receivers,
}: {
  provider: ChatProviderDescriptor
  projectId: string
  receivers: WebhookReceiver[]
}) {
  const api = provider.bot.api
  const setupApi = provider.bot.setupApi
  const providerMessage = (cause: unknown) => chatErrorMessage(provider, cause)
  const errorCode = (cause: unknown) => chatErrorCode(provider.id, cause)
  const copy = provider.bot.approval
  const commands = provider.bot.commands
  const isGroup = (receiver?: WebhookReceiver) => provider.bot.isGroup(receiver?.chatId)
  const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id)
  const client = useQueryClient(),
    key = chatKey(projectId, provider.id)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('')
  const [confirmation, setConfirmation] = useState<{
    botId: string
    revision: string
    disconnect: boolean
    orphan?: boolean
  }>()
  const [revokeConfirmation, setRevokeConfirmation] = useState<{ grantId: string; revision: string; label: string }>()
  const [enableVisibility, setEnableVisibility] = useState<Record<string, boolean>>({})
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const [wizard, setWizard] = useState<WizardStep>('choose')
  // Approval opens only when the user asks for it on one chat; a notifications-only chat never shows a form.
  const [wizardReceiver, setWizardReceiver] = useState('')
  const [dedicatedBot, setDedicatedBot] = useState(false),
    [groupVisibility, setGroupVisibility] = useState(false),
    [comparisonVerified, setComparisonVerified] = useState(false)
  const [setup, setSetup] = useState<ChatSetupBegun>()
  // Unmounting mid-setup (collapsing the panel, leaving the page) cancels the session too.
  const openSetup = useRef<string | undefined>(undefined)
  openSetup.current = setup?.setupId
  useEffect(
    () => () => {
      if (openSetup.current) void setupApi.cancel(projectId, openSetup.current).catch(() => undefined)
    },
    [projectId, setupApi],
  )
  const [setupStatus, setSetupStatus] = useState<ChatSetupStatus>()
  const [approved, setApproved] = useState<{ label: string; group: boolean }>()
  const [wizardPermissions, setWizardPermissions] = useState<ChatInboundGrant['permissions']>(['respond'])
  const [wizardError, setWizardError] = useState('')
  const [pollError, setPollError] = useState('')
  const wizardRequest = useRef(0)
  const replaceNoteId = useId(),
    controlOffNoteId = useId()
  const recoveryAction = useRef<HTMLButtonElement>(null),
    completeAction = useRef<HTMLButtonElement>(null),
    replaceAction = useRef<HTMLButtonElement>(null)
  const chooseTarget = useRef<HTMLHeadingElement>(null),
    waitingTarget = useRef<HTMLHeadingElement>(null),
    confirmTarget = useRef<HTMLHeadingElement>(null),
    activatingTarget = useRef<HTMLHeadingElement>(null)
  const bindings = useQuery({
    queryKey: [...key, 'bindings'],
    queryFn: ({ signal }) => api.bindings(signal),
    enabled: showDiagnostics,
    retry: false,
  })
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const list = useQuery({ queryKey: key, queryFn: ({ signal }) => api.list(projectId, signal), retry: false })
  const taskControl: Availability | undefined = list.data?.taskControl
  useChatSubscription(projectId, taskControl?.available === true, provider)
  // Webhook rows stay live through the project's one stream (ProjectWebhookNotifications, routes.tsx).
  const setupPoll = useQuery({
    queryKey: [...key, 'setup', setup?.setupId],
    queryFn: ({ signal }) => setupApi.status(projectId, setup!.setupId, signal),
    enabled: !!setup && wizard === 'waiting',
    retry: false,
    refetchInterval: 2_000,
  })
  const activity = useInfiniteQuery({
    queryKey: [...key, 'activity'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) => api.activity(projectId, signal, pageParam),
    getNextPageParam: page => page.nextCursor,
    enabled: showDiagnostics && taskControl?.available === true,
    retry: false,
  })
  useEffect(() => {
    if (!setupPoll.data || wizard !== 'waiting') return
    setSetupStatus(setupPoll.data)
    if (setupPoll.data.status === 'candidate') setWizard('confirm')
    else if (setupPoll.data.status === 'expired') {
      setSetup(undefined)
      setWizardError('This setup link expired. Create a new link and try again.')
      setWizard('recovery')
    }
  }, [setupPoll.data, wizard])
  useEffect(() => {
    if (!setupPoll.error || wizard !== 'waiting') return setPollError('')
    if (!setupGone(errorCode(setupPoll.error))) return setPollError(providerMessage(setupPoll.error))
    setSetup(undefined)
    setWizardError(providerMessage(setupPoll.error))
    setWizard('recovery')
  }, [setupPoll.error, wizard])
  // Focus at commit, so the moved-to step is focused before anything else can react to it.
  useLayoutEffect(() => {
    const target = {
      waiting: waitingTarget,
      confirm: confirmTarget,
      activating: activatingTarget,
      recovery: recoveryAction,
      complete: completeAction,
      replace: replaceAction,
      choose: wizardReceiver ? chooseTarget : undefined,
    }[wizard]?.current
    target?.focus()
  }, [wizard, wizardReceiver])
  const act = async (work: () => Promise<unknown>, success: string | false = false) => {
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await work()
      if (mounted.current && success) toast(success)
    } catch (cause) {
      if (mounted.current) setError(providerMessage(cause))
    } finally {
      await Promise.all([
        client.invalidateQueries({ queryKey: key }),
        client.invalidateQueries({ queryKey: webhookKey(projectId) }),
      ])
      if (mounted.current) setBusy(false)
    }
  }
  if (list.isPending) return <LoadingState label={`Loading ${provider.name} settings…`}><RowsSkeleton rows={2} /></LoadingState>
  const data = list.data
  const inboundRows: InboundRow[] = data?.receivers ?? [],
    grants = data?.grants ?? []
  const controlled = (id: string) => grants.some(grant => grant.receiverId === id)
  const bound = (id: string) => inboundRows.some(row => row.receiverId === id && !!row.botId)
  const duplicates = duplicateChats(receivers, controlled, bound)
  const chats = (
    <ChatList provider={provider} projectId={projectId} receivers={receivers} controlled={controlled} bound={bound} />
  )
  if (!data)
    return (
      <div className="flex flex-col gap-4 text-sm">
        {chats}
        <div>
          <p role="alert">{providerMessage(list.error)}</p>
          <Button variant="outline" onClick={() => void list.refetch()}>
            Retry loading settings
          </Button>
        </div>
      </div>
    )
  const knownReceivers = inboundRows.flatMap(row => {
    const receiver = receivers.find(item => item.id === row.receiverId)
    return receiver ? [{ row, receiver }] : []
  })
  const connectedBot = inboundRows.some(row => row.botId)
  const botChats = (botId: string) => inboundRows.filter(row => row.botId === botId).length
  // A private receiver binds exactly one person (its chat owner); a group can pair each member in turn.
  // A suspended private receiver whose person can no longer be re-enabled is paired again through replacement.
  const stalePairing = (row: { receiverId: string; state: string }, receiver: WebhookReceiver) =>
    !isGroup(receiver) && row.state === 'suspended' && controlled(receiver.id)
  // A private chat binds one receiver; another receiver of the same chat only sends notifications (server: chat_conflict).
  const controlledBy = (receiver: WebhookReceiver) => {
    if (isGroup(receiver)) return undefined
    const holders = knownReceivers.filter(
      other => other.receiver.id !== receiver.id && !!other.row.botId && other.receiver.chatId === receiver.chatId,
    )
    return (holders.find(other => controlled(other.receiver.id)) ?? holders[0])?.receiver
  }
  const approvable = ({ row, receiver }: { row: InboundRow; receiver: WebhookReceiver }) =>
    !controlledBy(receiver) &&
    row.suspendedReason !== 'group_migrated' &&
    (isGroup(receiver) || stalePairing(row, receiver) || !controlled(receiver.id))
  const setupReceivers = knownReceivers.filter(
    item => !setupBlockers(item.receiver, provider).length && approvable(item),
  )
  const selected = setupReceivers.find(item => item.row.receiverId === wizardReceiver)
  const group = isGroup(receivers.find(item => item.id === wizardReceiver))
  const resetWizard = () => {
    wizardRequest.current += 1
    if (setup) void setupApi.cancel(projectId, setup.setupId).catch(() => undefined)
    setSetup(undefined)
    setSetupStatus(undefined)
    setApproved(undefined)
    setWizardReceiver('')
    setDedicatedBot(false)
    setGroupVisibility(false)
    setComparisonVerified(false)
    setWizardPermissions(['respond'])
    setWizardError('')
    setPollError('')
    setWizard('choose')
  }
  // The bot-dedication consent was given when the bot was connected; only a chat with no bot yet asks for it here.
  const needsDedication = !!selected && !selected.row.botId
  const beginWizard = async (replaceExisting = false) => {
    if (!selected || (needsDedication && !dedicatedBot) || (group && !groupVisibility)) return
    const request = ++wizardRequest.current,
      { receiverId, inboundRevision: expectedRevision } = selected.row
    setWizardReceiver(receiverId)
    setWizardError('')
    setWizard('waiting')
    const begin: ChatSetupBegin = {
      receiverId,
      expectedRevision,
      dedicatedBot: true,
      ...(replaceExisting ? { replaceExisting: true as const } : {}),
      ...(group ? { groupVisibilityAccepted: true as const } : {}),
    }
    try {
      const begun = await beginChatSetup(setupApi, api.list, projectId, begin, errorCode, () => request === wizardRequest.current && mounted.current)
      if (!begun) return
      if (request !== wizardRequest.current || !mounted.current) {
        void setupApi.cancel(projectId, begun.setupId).catch(() => undefined)
        return
      }
      setSetup(begun)
    } catch (cause) {
      if (request !== wizardRequest.current || !mounted.current) return
      if (errorCode(cause) === 'replacement_required' && !replaceExisting) {
        setWizard('replace')
        return
      }
      setWizardError(providerMessage(cause))
      setWizard('recovery')
    }
  }
  const activateWizard = async () => {
    const candidate = setupStatus?.candidate
    if (!setup || !candidate || (candidate.comparisonCode && !comparisonVerified)) return
    setWizardError('')
    setWizard('activating')
    try {
      await setupApi.activate(projectId, setup.setupId, {
        expectedRevision: setupStatus.inboundRevision,
        candidateUserId: candidate.userId,
        permissions: wizardPermissions,
        ...(candidate.comparisonCode ? { comparisonVerified: true as const } : {}),
      })
      // Activation consumed the session; nothing is left to cancel.
      setSetup(undefined)
      setApproved({ label: candidate.label, group: !!candidate.comparisonCode })
      await client.invalidateQueries({ queryKey: key })
      setWizard('complete')
    } catch (cause) {
      setWizardError(providerMessage(cause))
      setWizard('recovery')
    }
  }
  const openApproval = (item: { row: InboundRow; receiver: WebhookReceiver }) => {
    resetWizard()
    setWizardReceiver(item.row.receiverId)
    if (stalePairing(item.row, item.receiver)) setWizard('replace')
  }
  const sendTest = (receiver: WebhookReceiver) =>
    act(async () => {
      await webhookApi.test(projectId, receiver.id, {
        expectedRevision: receiver.revision,
        deliveryRevision: receiver.deliveryRevision,
        operationId: crypto.randomUUID(),
      })
      if (mounted.current) setNotice(`Test sent to ${receiver.name}. Check the chat.`)
    }, false)
  const candidate = setupStatus?.candidate
  // A stopped bot that is not meant to listen reads as notifications only, without a poll time.
  const notificationsOnly = (bot: { botId: string; health: { state: string } }) =>
    bot.health.state !== 'stopped'
      ? undefined
      : botChats(bot.botId) === 0
        ? 'No chats in this project — bot still assigned'
        : !grants.length || !taskControl?.available
          ? 'Notifications only — task control off'
          : repliesDisabled(data, bot.botId, receivers)
            ? 'Notifications only — task control paused or off'
            : undefined
  const controlOn = taskControl?.available === true
  // Removing authority works at the notifications gate (server: revoke, narrowing, Turn off), so approved
  // people stay visible and revocable while task control is off; otherwise a flag flip silently restores them.
  const managed =
    (controlOn && (connectedBot || grants.length > 0)) || (data.notifications?.available === true && grants.length > 0)
  // A duplicate chat cannot hold task control of its own; it is removed from Chats instead.
  const peopleRows = knownReceivers.filter(
    ({ receiver }) => !duplicates.has(receiver.id) && (controlOn || controlled(receiver.id)),
  )
  const widening = controlOn ? {} : { 'aria-describedby': controlOffNoteId }
  const botGrants = (botId: string) =>
    grants.some(grant => inboundRows.some(row => row.botId === botId && row.receiverId === grant.receiverId))
  const approval = (item: { row: InboundRow; receiver: WebhookReceiver }) => (
    <div className="flex flex-col gap-3 rounded border border-dashed p-3" data-slot="chat-approve">
      <div>
        <h4 ref={chooseTarget} tabIndex={-1} className="font-medium">
          Approve a person
        </h4>
        <p className="text-muted-foreground">
          {group
            ? 'Approve a member of this group to answer and manage tasks there.'
            : 'Approve the person who owns this private chat.'}
        </p>
      </div>
      {wizard === 'choose' && !selected && (
        <>
          <p>Before task control can work, fix this chat:</p>
          <ul className="list-disc pl-5">
            {setupBlockers(item.receiver, provider).map(blocker => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
          <div className="flex gap-2">
            {setupBlockers(item.receiver, provider).includes(sendTestBlocker) && (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void sendTest(item.receiver)}>
                Send test
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={resetWizard}>
              Close
            </Button>
          </div>
        </>
      )}
      {wizard === 'choose' && selected && (
        <>
          {group && (
            <>
              <p className="rounded border border-warning/50 bg-warning/10 p-2">
                Every member of this group can read project messages.{' '}
                {`Approved members can answer questions and use ${commands.respond} there; new tasks start only from a private chat.`}{' '}
                {provider.bot.groupRestriction}
              </p>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={groupVisibility}
                  onChange={event => setGroupVisibility(event.target.checked)}
                />
                I understand that all group members can read project messages, including people without permission to
                control tasks.
              </label>
            </>
          )}
          {needsDedication && (
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={dedicatedBot}
                onChange={event => setDedicatedBot(event.target.checked)}
              />
              I confirm this bot is used only by this Cezar project. Use a separate bot for another app or project so
              commands reach the right place.
            </label>
          )}
          <p className="text-muted-foreground">{copy.savedCredentials}</p>
          <div className="flex gap-2">
            <Button
              disabled={(needsDedication && !dedicatedBot) || (group && !groupVisibility)}
              onClick={() => void beginWizard()}
            >{`Create ${provider.name} link`}</Button>
            <Button variant="outline" onClick={resetWizard}>
              Cancel
            </Button>
          </div>
        </>
      )}
      {wizard === 'waiting' && (
        <>
          <h4 ref={waitingTarget} tabIndex={-1} className="font-medium">
            {copy.waitingTitle}
          </h4>
          <p role="status" aria-live="polite">
            {setup ? copy.waiting(setup.bot.username, group) : copy.checkingCredentials}
          </p>
          {setup && (
            <a
              className="underline"
              href={setup.deepLink}
              target="_blank"
              rel="noopener noreferrer"
            >{`Open ${provider.name}`}</a>
          )}
          {setup && <ChatDiscoveryCommand provider={provider} link={setup.deepLink} />}
          {pollError && (
            <p role="alert" className="text-danger">
              {pollError}
            </p>
          )}
          <div>
            <Button variant="outline" onClick={resetWizard}>
              Cancel setup
            </Button>
          </div>
        </>
      )}
      {wizard === 'replace' && (
        <>
          <p role="note" id={`${replaceNoteId}-${item.row.receiverId}`}>
            {stalePairing(item.row, item.receiver)
              ? 'This chat changed since its person was approved.'
              : 'This chat’s bot or chat changed.'}{' '}
            Replacing the pairing removes every approved person and reply link for this chat; other chats keep their
            access.
          </p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={resetWizard}>
              Keep current access
            </Button>
            <Button
              ref={replaceAction}
              aria-describedby={`${replaceNoteId}-${item.row.receiverId}`}
              variant="danger-ghost"
              onClick={() => void beginWizard(true)}
            >
              Replace pairing and create link
            </Button>
          </div>
        </>
      )}
      {wizard === 'confirm' && setupStatus && candidate && (
        <>
          <h4 ref={confirmTarget} tabIndex={-1} className="font-medium">
            Confirm task control
          </h4>
          <p role="status">
            <strong>{candidate.label || `${provider.name} user`}</strong>
            {candidate.username ? ` (@${candidate.username})` : ''} · {provider.name} ID {shortId(candidate.userId)}{' '}
            {copy.candidate(setupStatus.bot.username)}
          </p>
          {candidate.comparisonCode && (
            <>
              <p>
                Comparison code: <strong>{candidate.comparisonCode}</strong>
              </p>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={comparisonVerified}
                  onChange={event => setComparisonVerified(event.target.checked)}
                />
                I compared this code with the code the bot sent to this person privately.
              </label>
            </>
          )}
          <fieldset className="flex flex-col gap-2">
            <legend className="font-medium">Permissions</legend>
            <p className="text-muted-foreground">Always allowed: answer questions and check task status.</p>
            {optionalPermissions(group).map(permission => (
              <label className="flex gap-2" key={permission}>
                <input
                  type="checkbox"
                  checked={wizardPermissions.includes(permission)}
                  onChange={event =>
                    setWizardPermissions(current =>
                      event.target.checked ? [...current, permission] : current.filter(value => value !== permission),
                    )
                  }
                />
                {permissionLabels[permission]}
              </label>
            ))}
            <p className="text-muted-foreground">{taskControlCostNote}</p>
          </fieldset>
          <p role="note" className="rounded border border-warning/50 bg-warning/10 p-2">
            {taskControlRisk}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={resetWizard}>
              Not this person
            </Button>
            <Button disabled={!!candidate.comparisonCode && !comparisonVerified} onClick={() => void activateWizard()}>
              Activate task control
            </Button>
          </div>
        </>
      )}
      {wizard === 'activating' && (
        <>
          <h4 ref={activatingTarget} tabIndex={-1} className="font-medium">
            Activating task control
          </h4>
          <p role="status" aria-live="polite">
            Activating task control…
          </p>
        </>
      )}
      {wizard === 'complete' && (
        <>
          <p role="status" aria-live="polite" className="rounded border border-success/50 bg-success/10 p-2">
            {approved?.group
              ? `Task control is active for ${approved.label} in this group. They can answer questions and use ${commands.respond} there.${commands.guidance ? ` ${commands.guidance}` : ''}`
              : `Task control is active for ${approved?.label ?? 'this person'} in their private ${provider.name} chat.`}
          </p>
          <p className="text-muted-foreground">
            {approved?.group
              ? 'To approve another member of this group, use Approve another member.'
              : 'A private chat serves exactly one person. To give another person task control, connect their private chat with Add a chat above.'}
          </p>
          <div>
            <Button ref={completeAction} variant="outline" onClick={resetWizard}>
              Done
            </Button>
          </div>
        </>
      )}
      {wizard === 'recovery' && (
        <>
          <p role="alert" className="text-danger">
            {wizardError || `${provider.name} setup could not continue.`}
          </p>
          <p className="text-muted-foreground">
            Check the chat and the bot diagnostics below. You can reset damaged access or release an orphaned assignment
            without a chat.
          </p>
          <div className="flex gap-2">
            <Button
              ref={recoveryAction}
              onClick={async () => {
                const keep = { receiver: wizardReceiver, dedicated: dedicatedBot, visibility: groupVisibility }
                await client.invalidateQueries({ queryKey: key })
                if (!mounted.current) return
                resetWizard()
                setWizardReceiver(keep.receiver)
                setDedicatedBot(keep.dedicated)
                setGroupVisibility(keep.visibility)
              }}
            >
              Try again
            </Button>
            <Button variant="outline" onClick={resetWizard}>
              Exit setup
            </Button>
          </div>
        </>
      )}
    </div>
  )
  return (
    <div className="flex flex-col gap-4 text-sm">
      {notice && (
        <p role="status" aria-live="polite" className="rounded border border-success/50 bg-success/10 p-2">
          {notice}
        </p>
      )}
      {error && !confirmation && !revokeConfirmation && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      {!receivers.length && !inboundRows.length && (
        <div className="rounded border border-dashed p-4">
          <p className="font-medium">{`No ${provider.name} receivers yet`}</p>
          <p className="text-muted-foreground">{`Use Connect ${provider.name} above. You choose whether a chat only gets notifications or also lets a trusted person control tasks.`}</p>
        </div>
      )}
      {chats}
      {managed && !!peopleRows.length && (
        <section className="flex flex-col gap-3" data-slot="chat-people">
          <div>
            <h3 className="font-medium">People and permissions</h3>
            <p className="text-muted-foreground">{`Approved people can answer questions and use ${commands.respond}. Starting tasks (private chats only), ${commands.cancel} and ${commands.continue} each need their own permission; cancel and continue ask for confirmation in ${provider.name}. Access applies to all tasks in this project.`}</p>
            {commands.guidance && (
              <details className="text-muted-foreground">
                <summary className="cursor-pointer">How to send commands</summary>
                <p className="mt-1">{commands.guidance}</p>
              </details>
            )}
          </div>
          {!controlOn && (
            <p role="note" id={controlOffNoteId} className="rounded border border-border bg-muted/50 p-2">
              Task control is off on this server. You can still revoke access, remove permissions and turn task control
              off. Approving people, adding permissions and turning task control on are unavailable until task control
              is on again.
            </p>
          )}
          {!!grants.length && (
            <p className="rounded border border-warning/50 bg-warning/10 p-2">
              Task-control access lets approved people instruct an agent that may run shell commands on this machine.
              Approve only people you trust.
            </p>
          )}
          {peopleRows.map(item => {
            const { row, receiver } = item,
              rowGrants = grants.filter(grant => grant.receiverId === row.receiverId)
            const blockers = setupBlockers(receiver, provider),
              groupChat = isGroup(receiver),
              enabling = row.state !== 'active',
              migrated = row.suspendedReason === 'group_migrated'
            const visibility = !groupChat || enableVisibility[row.receiverId] === true,
              open = wizardReceiver === row.receiverId
            const approveLabel = stalePairing(row, receiver)
              ? 'Replace pairing'
              : groupChat && rowGrants.length
                ? 'Approve another member'
                : 'Enable task control'
            return (
              <div
                role="group"
                aria-label={`Task control in ${receiver.name}`}
                key={row.receiverId}
                className="flex flex-col gap-2 rounded border p-3"
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <strong>{receiver.name}</strong>
                  <span className="text-muted-foreground">
                    {rowGrants.length ? (receiverStateLabels[row.state] ?? 'Status unavailable') : 'Notifications only'}
                  </span>
                </div>
                {row.suspendedReason === 'bot_removed' && (
                  <p>
                    {groupChat
                      ? 'Task control is suspended because the bot was removed from this group. Add the bot back to the group, then use Turn on task control.'
                      : `Task control is suspended because the person blocked the bot. After they unblock it in ${provider.name}, use Turn on task control.`}
                  </p>
                )}
                {migrated && (
                  <p>{`Task control is suspended because ${provider.name} upgraded this group and gave it a new chat ID. Remove this chat in Chats above and connect the group again with Add a chat.`}</p>
                )}
                {row.state === 'suspended' && !row.suspendedReason && !!rowGrants.length && (
                  <p>
                    {receiver.state === 'paused'
                      ? 'Task control is paused with this chat’s notifications. Resume it in Chats above.'
                      : stalePairing(row, receiver)
                        ? 'Task control is suspended because this chat changed. Use Turn on task control once its notifications are active again; if that fails, use Replace pairing to approve the person again.'
                        : 'Task control is suspended because this chat changed. Use Turn on task control once its notifications are active again.'}
                  </p>
                )}
                {!!rowGrants.length && !!blockers.length && (
                  <div>
                    <p>Before task control can work, fix this chat:</p>
                    <ul className="list-disc pl-5">
                      {blockers.map(blocker => (
                        <li key={blocker}>{blocker}</li>
                      ))}
                    </ul>
                    {blockers.includes(sendTestBlocker) && (
                      <Button
                        className="mt-2"
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => void sendTest(receiver)}
                      >
                        Send test
                      </Button>
                    )}
                  </div>
                )}
                {!!rowGrants.length && !migrated && (
                  <div className="flex flex-wrap items-center gap-2">
                    {groupChat && enabling && controlOn && (
                      <label className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={visibility}
                          onChange={event =>
                            setEnableVisibility(current => ({ ...current, [row.receiverId]: event.target.checked }))
                          }
                        />
                        I understand that all group members can read project messages.
                      </label>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      {...(enabling ? widening : {})}
                      disabled={busy || (enabling && (!controlOn || !!blockers.length || !visibility))}
                      onClick={() =>
                        void act(async () => {
                          await api.enable(
                            projectId,
                            row.receiverId,
                            row.inboundRevision,
                            enabling,
                            enabling && groupChat,
                          )
                          if (mounted.current)
                            setNotice(
                              enabling
                                ? `Task control on for ${receiver.name}.`
                                : `Task control off for ${receiver.name}.`,
                            )
                        })
                      }
                    >
                      {enabling ? 'Turn on task control' : 'Turn off task control'}
                    </Button>
                  </div>
                )}
                {rowGrants.map(grant => (
                  <div key={grant.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span>
                      {grant.label} · {provider.name} ID {shortId(grant.userId)}
                    </span>
                    {optionalPermissions(groupChat).map(permission => (
                      <label key={permission} className="flex items-center gap-1">
                        <input
                          type="checkbox"
                          aria-label={`${permissionLabels[permission]} for ${grant.label}`}
                          {...(grant.permissions.includes(permission) ? {} : widening)}
                          checked={grant.permissions.includes(permission)}
                          disabled={busy || (!controlOn && !grant.permissions.includes(permission))}
                          onChange={event => {
                            const permissions = event.target.checked
                              ? [...grant.permissions, permission]
                              : grant.permissions.filter(value => value !== permission)
                            void act(() => api.permissions(projectId, grant.id, row.inboundRevision, permissions))
                          }}
                        />
                        {permissionLabels[permission]}
                      </label>
                    ))}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        setRevokeConfirmation({ grantId: grant.id, revision: row.inboundRevision, label: grant.label })
                      }
                    >
                      Revoke access
                    </Button>
                  </div>
                ))}
                {!open && approvable(item) && (
                  <div>
                    <Button
                      variant="outline"
                      size="sm"
                      {...widening}
                      disabled={busy || !controlOn || (wizard !== 'choose' && !!wizardReceiver)}
                      onClick={() => openApproval(item)}
                    >
                      {approveLabel}
                    </Button>
                  </div>
                )}
                {open && approval(item)}
              </div>
            )
          })}
          {!!grants.length && <p className="text-muted-foreground">{taskControlCostNote}</p>}
        </section>
      )}
      {data.bots.map(bot => (
        <div key={bot.botId} className="flex flex-col gap-2 rounded border p-3" data-slot="chat-bot">
          <div className="flex flex-wrap items-center justify-between gap-2">
            {/* Only the health label is live, so a fresh poll time never re-announces the line. */}
            <span>
              {`${provider.name} bot `}
              {bot.username ? `@${bot.username}` : shortId(bot.botId)}:{' '}
              <span role="status">
                {bot.health.connecting
                  ? 'Connecting…'
                  : (notificationsOnly(bot) ?? chatHealthLabels[bot.health.state] ?? 'Status unavailable')}
              </span>
              {(bot.health.connecting || !notificationsOnly(bot)) && (
                <>
                  {' '}
                  · {provider.bot.lastContactLabel ?? 'Last connected'}: {pollTime(bot.health.lastSuccessfulPollAt)}
                </>
              )}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void client.invalidateQueries({ queryKey: key })}
            >
              Refresh status
            </Button>
          </div>
          {!!bot.health.droppedReplies && (
            <p role="status">
              {plural(bot.health.droppedReplies, 'bot reply was', 'bot replies were')} dropped since this bot started.
              Task actions are not retried.
            </p>
          )}
          {!bot.inboundRevision && (
            <p>State cannot be safely read. Reset is unavailable until its integrity can be checked.</p>
          )}
          <div className="flex flex-wrap gap-2">
            {(botGrants(bot.botId) || bot.health.state === 'blocked') && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy || !bot.inboundRevision}
                onClick={() => {
                  if (bot.inboundRevision)
                    setConfirmation({ botId: bot.botId, revision: bot.inboundRevision, disconnect: false })
                }}
              >
                Reset access
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !bot.inboundRevision}
              onClick={() => {
                if (bot.inboundRevision)
                  setConfirmation({ botId: bot.botId, revision: bot.inboundRevision, disconnect: true })
              }}
            >
              Disconnect bot
            </Button>
          </div>
          <p className="text-muted-foreground">Use one dedicated bot per project.</p>
        </div>
      ))}
      <Dialog
        open={!!confirmation}
        onOpenChange={open => {
          if (!open && !busy) setConfirmation(undefined)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmation?.orphan
                ? 'Release orphaned bot?'
                : confirmation?.disconnect
                  ? `Disconnect ${provider.name} bot?`
                  : `Reset ${provider.name} access?`}
            </DialogTitle>
            <DialogDescription>
              {confirmation?.orphan
                ? 'This releases the bot from a missing project. Old approvals cannot be restored by bringing that project back. The bot will also be released for another project.'
                : confirmation?.disconnect && botChats(confirmation.botId) === 0
                  ? 'This bot has no chats in this project. Releasing it removes its approved people and lets another project use it.'
                  : confirmation?.disconnect
                    ? `This deletes this bot’s ${plural(botChats(confirmation.botId), 'chat', 'chats')} from this project (with ${botChats(confirmation.botId) === 1 ? 'its' : 'their'} notification options), all approved people, and releases the bot for another project. To use it again, connect each chat again.`
                    : 'This removes all approved people and their task control for this bot. Notifications keep arriving, and the bot stays assigned to this project. Use Enable task control on a chat to approve someone again.'}
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-danger">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirmation(undefined)}>
              {confirmation?.orphan ? 'Keep assignment' : confirmation?.disconnect ? 'Keep bot' : 'Keep access'}
            </Button>
            <Button
              variant="danger-ghost"
              disabled={busy}
              onClick={() => {
                if (confirmation) {
                  const action = confirmation
                  void act(async () => {
                    if (action.orphan) await api.releaseBinding(action.botId, action.revision)
                    else
                      await (action.disconnect ? api.disconnect : api.reset)(projectId, action.botId, action.revision)
                    if (mounted.current) setConfirmation(undefined)
                  })
                }
              }}
            >
              {confirmation?.orphan || (confirmation?.disconnect && botChats(confirmation.botId) === 0)
                ? 'Release bot'
                : confirmation?.disconnect
                  ? 'Disconnect and remove chats'
                  : 'Reset access'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!revokeConfirmation}
        onOpenChange={open => {
          if (!open && !busy) setRevokeConfirmation(undefined)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke access for {revokeConfirmation?.label}?</DialogTitle>
            <DialogDescription>{`This immediately removes this person’s ${provider.name} task control. Notifications keep arriving. Use Enable task control on the chat to approve them again.`}</DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-danger">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setRevokeConfirmation(undefined)}>
              Keep access
            </Button>
            <Button
              variant="danger-ghost"
              disabled={busy}
              onClick={() => {
                if (revokeConfirmation) {
                  const action = revokeConfirmation
                  void act(async () => {
                    await api.revoke(projectId, action.grantId, action.revision)
                    if (mounted.current) setRevokeConfirmation(undefined)
                  })
                }
              }}
            >
              Revoke access
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Disclosure label="Diagnostics" open={showDiagnostics} onOpenChange={setShowDiagnostics}>
        <section className="flex flex-col gap-2" aria-label={`Recent ${provider.name} actions`}>
          <h4 className="font-medium">{`Recent ${provider.name} actions`}</h4>
          {activity.error && <p role="alert">{providerMessage(activity.error)}</p>}
          {activity.data?.pages
            .flatMap(page => page.entries)
            .map(entry => (
              <p key={entry.id} className={entry.state === 'uncertain' ? 'text-warning' : ''}>
                {new Date(entry.at).toLocaleString()} ·{' '}
                {entry.kind === 'rejection_summary'
                  ? `Bot-wide · ${entry.count} rejected messages · ${activityReason(entry.reason)}`
                  : [
                      grants.find(
                        grant => grant.userId === entry.userId && (!entry.chatId || grant.chatId === entry.chatId),
                      )?.label ?? `${provider.name} ID ${shortId(entry.userId ?? '')}`,
                      (entry.kind === 'reply' ? `Answered with ${commands.reply}` : activityKindLabels[entry.kind]) ??
                        'Unknown command',
                      ...(entry.runId ? [`task ${entry.runId.slice(0, 8)}`] : []),
                      `${activityStateLabels[entry.state] ?? 'Outcome unknown'}: ${activityReason(entry.reason, entry.state)}`,
                    ].join(' · ')}
              </p>
            ))}
          {activity.hasNextPage && (
            <Button
              variant="outline"
              disabled={activity.isFetchingNextPage}
              onClick={() => void activity.fetchNextPage()}
            >
              Load older actions
            </Button>
          )}
          {activity.data?.pages[0]?.entries.length === 0 && <p>No recorded actions.</p>}
        </section>
        <section className="flex flex-col gap-2 pt-2" aria-label="Bot assignments">
          <h4 className="font-medium">Bot assignments</h4>
          {bindings.isPending && <p role="status">Loading assignments…</p>}
          {bindings.error && <p role="alert">{providerMessage(bindings.error)}</p>}
          {bindings.data?.truncated && (
            <p role="alert">Some assignments could not be listed. This view is incomplete.</p>
          )}
          {bindings.data?.bindings.length === 0 && <p>No bot assignments.</p>}
          {bindings.data?.bindings.map(binding => (
            <div key={binding.botId} className="flex flex-wrap items-center gap-2">
              <span>
                {`${provider.name} bot `}
                {shortId(binding.botId)} · project {binding.projectName ?? binding.projectId} ·{' '}
                {binding.orphaned ? 'project unavailable' : 'assigned'}
              </span>
              {binding.orphaned && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    setConfirmation({
                      botId: binding.botId,
                      revision: binding.inboundRevision,
                      disconnect: true,
                      orphan: true,
                    })
                  }
                >
                  Release orphaned bot
                </Button>
              )}
            </div>
          ))}
        </section>
      </Disclosure>
    </div>
  )
}

/** The cockpit's collapsible pattern (automation filters): a quiet chevron trigger, content on demand. */
function Disclosure({
  label,
  open,
  onOpenChange,
  children,
}: {
  label: string
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="inline-flex h-6 items-center gap-1 rounded-sm text-ui text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <ChevronDownIcon aria-hidden="true" className={cn('size-3 transition-transform', open ? '' : '-rotate-90')} />
          {label}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-3 pt-2">{children}</CollapsibleContent>
    </Collapsible>
  )
}
