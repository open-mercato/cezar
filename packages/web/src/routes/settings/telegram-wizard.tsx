import { useEffect, useMemo, useRef, useState } from 'react'
import type { TelegramInboundGrant, TelegramSetupBegin, TelegramSetupStatus } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { defaultSetupApi, type TelegramSetupApi } from './telegram-inbound'
import { taskControlCostNote } from './telegram-chats'

type Step = 'token' | 'connect' | 'activate' | 'control' | 'done'
type Permission = TelegramInboundGrant['permissions'][number]
const risk = 'Task control lets a person answer and instruct agents that run shell commands on this machine.'
type SetupCandidate = NonNullable<TelegramSetupStatus['candidate']>

const stepDescriptions: Record<Step, string> = {
  token: 'Paste the token of a bot created with @BotFather. Continue contacts Telegram, listens for setup messages and acknowledges Start. Project notifications and task control require activation.',
  connect: 'Choose the chat that receives notifications: your private chat or a group.',
  activate: 'Notifications are on. You can also let one trusted person control tasks from Telegram.',
  control: 'The trusted person opens the private link and presses Start to get task control.',
  done: 'People and permissions can be changed later in the Telegram tab.',
}

/** Why a Telegram capability is off, in the words the operator needs to fix it. */
export const telegramUnavailableMessages: Record<string, string> = {
  flag_off: 'Task control needs CEZ_CHAT_INBOUND=1. Restart cezar with it to enable task control.',
  webhooks_off: 'Telegram needs CEZ_WEBHOOKS=1. Restart cezar with it, then reload this page.',
  hosted: 'Telegram is not available on a hosted cockpit. Run cezar locally to connect a bot.',
  unavailable: 'Telegram is unavailable right now. Try again in a moment.',
}

/** Friendly copy for every setup failure the wizard's calls can surface; never the raw code. */
const wizardErrorMessages: Record<string, string> = {
  ...telegramUnavailableMessages,
  invalid_token: 'Telegram rejected this bot token. Copy it again from @BotFather and try again.',
  blocked: 'Telegram blocked this bot. Unblock or recreate it, then try again.',
  conflict: 'Telegram settings changed. Start setup again.',
  damaged_state: 'Telegram access is damaged. Reset access, then start setup again.',
  vault_unavailable: 'The bot token store is unavailable. Restore it, then retry setup.',
  already_paired: 'This person is already approved for this chat, so no further approval is needed.',
  pairing_expired: 'This setup link expired. Start again.',
  pairing_limit: 'Too many Telegram setups are open. Finish or cancel one, or wait five minutes, then try again.',
  comparison_required: 'Compare the code sent privately by Telegram before continuing.',
  pairing_required: 'Press Start in Telegram before continuing.',
  pairing_changed: 'The pairing changed before it was approved. Start setup again.',
  chat_changed: 'The Telegram chat changed. Refresh and try again.',
  chat_conflict: 'This chat is already connected to this bot. Manage it in the Telegram tab instead.',
  bot_conflict: 'This bot is connected to another project or cezar. Use a different bot, or disconnect it there first.',
  bot_busy: 'This bot is busy with another change. Try again in a moment.',
  group_ineligible: 'This group cannot be used. Forum groups (with topics) are not supported, and the bot must still be a member.',
  group_visibility_required: 'Confirm that every member of this group can read project messages.',
  receiver_ineligible: 'This chat is not ready. Check its diagnostics and try again.',
  receiver_creation_unavailable: 'Telegram setup is unavailable right now. Try again in a moment.',
  receiver_creation_failed: 'Telegram could not set up this chat. Try again.',
  binding_missing: 'This bot is no longer assigned to this chat. Refresh the page.',
  grant_limit: 'This project has reached its Telegram access limit.',
  candidate_not_group_member: 'That person is not a member of this group. Have them join and try again.',
}

/** Map a setup error to a friendly message; the raw server detail (which may carry the token) is never echoed. */
function wizardError(cause: unknown, fallback: string): string {
  if (!(cause instanceof Error)) return fallback
  // The ownership conflict answers with prose rather than its code.
  if (/owned elsewhere/i.test(cause.message)) return wizardErrorMessages.bot_conflict!
  const code = cause.message.toLowerCase().replace(/^telegram[_ -]?/, '')
  return wizardErrorMessages[code] ?? fallback
}

/** Telegram's own "add to a group" link for the same setup code (`?startgroup=` instead of `?start=`). */
export function groupDeepLink(deepLink: string): string | undefined {
  try {
    const url = new URL(deepLink), code = url.searchParams.get('start')
    if (!code) return undefined
    url.search = ''; url.searchParams.set('startgroup', code)
    return url.toString()
  } catch { return undefined }
}

/** The first free "Telegram notifications", "Telegram notifications 2", … among existing receiver names. */
export function uniqueNotificationName(existing: readonly string[]): string {
  const taken = new Set(existing.map(name => name.trim().toLowerCase()))
  const base = 'Telegram notifications'
  if (!taken.has(base.toLowerCase())) return base
  for (let index = 2; ; index++) if (!taken.has(`${base} ${index}`.toLowerCase())) return `${base} ${index}`
}

const optionalPermissions: { value: Exclude<Permission, 'respond'>; label: string }[] = [
  { value: 'start', label: 'Start tasks' },
  { value: 'cancel', label: 'Cancel tasks' },
  { value: 'continue', label: 'Continue tasks' },
]

function PermissionChoices({ permissions, onChange, allowStart = true }: { permissions: TelegramInboundGrant['permissions']; onChange: (next: TelegramInboundGrant['permissions']) => void; allowStart?: boolean }) {
  const toggle = (value: Permission, on: boolean) => {
    const set = new Set(permissions); if (on) set.add(value); else set.delete(value)
    onChange(['respond', ...optionalPermissions.map(option => option.value).filter(option => set.has(option))])
  }
  return <fieldset className="flex flex-col gap-2">
    <legend className="mb-1 text-sm font-medium">The person can always reply to tasks. Also allow:</legend>
    {optionalPermissions.filter(option => allowStart || option.value !== 'start').map(option => <label key={option.value} className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={permissions.includes(option.value)} onChange={event => toggle(option.value, event.target.checked)} />{option.label}
    </label>)}
    <p className="text-sm text-muted-foreground">{taskControlCostNote}</p>
  </fieldset>
}

const sameStatus = (left: TelegramSetupStatus | undefined, right: TelegramSetupStatus) => JSON.stringify(left) === JSON.stringify(right)

function candidateLine(candidate: SetupCandidate | undefined, withCode: boolean): string {
  if (!candidate) return 'Waiting for Telegram…'
  const person = `${candidate.label}${candidate.username ? ` (@${candidate.username})` : ''} · Telegram ID ${candidate.userId}`
  const code = withCode && candidate.comparisonCode ? ` · Comparison code: ${candidate.comparisonCode}` : ''
  if (candidate.chatType === 'group') return `Group ${candidate.chatTitle ? `“${candidate.chatTitle}”` : 'connected'} · started by ${person}${code}`
  return `Connected as ${person}${code}`
}

/**
 * One token-led setup for a Telegram chat, its notifications, and optional task control.
 * `taskControlUnavailable` is the server's reason task control is off (e.g. `flag_off`): notifications still work.
 */
export function TelegramWizard({ projectId, open, onOpenChange, onComplete, setupApi, addingChat = false, existingNames = [], taskControlUnavailable }: {
  projectId: string; open: boolean; onOpenChange: (open: boolean) => void; onComplete?: () => void; setupApi?: TelegramSetupApi
  addingChat?: boolean; existingNames?: readonly string[]; taskControlUnavailable?: string
}) {
  const [step, setStep] = useState<Step>('token')
  const [name, setName] = useState('Telegram notifications')
  const [token, setToken] = useState('')
  const [dedicated, setDedicated] = useState(false)
  const [visibility, setVisibility] = useState(false)
  const [comparisonVerified, setComparisonVerified] = useState(false)
  const [taskControl, setTaskControl] = useState(false)
  // Groups cannot start tasks, so their control step never offers Start tasks.
  const [groupChat, setGroupChat] = useState(false)
  const [controlEnabled, setControlEnabled] = useState(false)
  const [permissions, setPermissions] = useState<TelegramInboundGrant['permissions']>(['respond'])
  const [setup, setSetup] = useState<{ setupId: string; receiverId: string; deepLink: string; consumed?: boolean }>()
  const [status, setStatus] = useState<TelegramSetupStatus>()
  // The revision activation returned; the pre-activation status revision is stale once the chat exists.
  const [activatedRevision, setActivatedRevision] = useState<string>()
  const [error, setError] = useState('')
  const [pollError, setPollError] = useState('')
  const [busy, setBusy] = useState(false)
  // An activation in flight cannot be abandoned: the server may already have created the chat.
  const [activating, setActivating] = useState(false)
  const nameField = useRef<HTMLInputElement>(null)
  const connectTarget = useRef<HTMLParagraphElement>(null)
  const activateTarget = useRef<HTMLParagraphElement>(null)
  const controlTarget = useRef<HTMLParagraphElement>(null)
  const doneTarget = useRef<HTMLParagraphElement>(null)
  const api = setupApi ?? defaultSetupApi
  const candidate = status?.candidate
  const group = candidate?.chatType === 'group'
  const controlAvailable = !taskControlUnavailable
  const controlUnavailableText = taskControlUnavailable ? telegramUnavailableMessages[taskControlUnavailable] ?? telegramUnavailableMessages.unavailable : ''
  const comparisonRequired = step === 'control' && candidate?.chatType === 'private' && !!candidate.comparisonCode
  const trimmedToken = token.trim()
  const validToken = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/.test(trimmedToken)
  const groupLink = setup && step === 'connect' ? groupDeepLink(setup.deepLink) : undefined
  const suggestedNames = useRef(existingNames)
  suggestedNames.current = existingNames
  // Each open/project session owns its pending pairing and async responses.
  const controlAttempt = useRef(0)
  const session = useRef<{ active: boolean; projectId: string; api: TelegramSetupApi; setupId?: string; activating: boolean; activationGeneration: number }>(undefined)
  const abandon = (current: NonNullable<typeof session.current>) => {
    if (current.setupId) {
      void current.api.cancel(current.projectId, current.setupId).catch(() => undefined)
      current.setupId = undefined
    }
  }
  const isCurrent = (current: typeof session.current): current is NonNullable<typeof session.current> => !!current?.active && session.current === current

  useEffect(() => {
    if (!open) return
    const current = { active: true, projectId, api, activating: false, activationGeneration: 0 }
    session.current = current
    setStep('token'); setError(''); setPollError(''); setBusy(false); setActivating(false); setSetup(undefined); setStatus(undefined); setActivatedRevision(undefined); setGroupChat(false)
    setToken(''); setDedicated(false); setVisibility(false); setComparisonVerified(false); setTaskControl(false); setControlEnabled(false); setPermissions(['respond'])
    setName(uniqueNotificationName(suggestedNames.current))
    return () => { current.active = false; abandon(current) }
  }, [open, projectId, api])
  useEffect(() => {
    const target = { token: nameField, connect: connectTarget, activate: activateTarget, control: controlTarget, done: doneTarget }[step]?.current
    target?.focus()
  }, [step])
  useEffect(() => {
    if (!open || !setup || (step !== 'connect' && step !== 'control')) return
    const current = session.current
    let cancelled = false
    // On the control step the chat is already active, so only the task-control link is lost.
    const expire = () => {
      if (current) current.setupId = undefined
      setPollError(''); setSetup(undefined); setStatus(undefined)
      if (step === 'control') { setError('The task-control link expired. Notifications are on — use Enable task control on this chat in the Telegram tab to try again.'); finishWithoutControl() }
      else { setError('This setup link expired. Start again.'); setStep('token') }
    }
    const poll = async () => {
      if (cancelled || !isCurrent(current) || current?.setupId !== setup.setupId || current.activating) return
      const generation = current.activationGeneration
      try {
        const next = await api.status(projectId, setup.setupId)
        if (cancelled || !isCurrent(current) || current.setupId !== setup.setupId || current.activating || current.activationGeneration !== generation) return
        setPollError('')
        // An unchanged poll keeps the same object, so the live region is not re-rendered or re-announced.
        setStatus(previous => sameStatus(previous, next) ? previous : next)
        if (next.status === 'expired') expire()
      } catch (cause) {
        if (cancelled || !isCurrent(current) || current.setupId !== setup.setupId || current.activating || current.activationGeneration !== generation) return
        // A restarted cezar no longer knows the setup; the server answers 404 pairing_expired.
        if (cause instanceof Error && /^(telegram[_ -]?)?pairing_expired$/i.test(cause.message)) expire()
        else setPollError(wizardError(cause, 'Could not read Telegram setup status.'))
      }
    }
    void poll(); const timer = window.setInterval(() => void poll(), 2_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [api, projectId, open, setup, step])

  const begin = async (input: TelegramSetupBegin) => {
    const current = session.current
    if (!isCurrent(current)) return
    setBusy(true); setError('')
    try {
      const begun = await api.begin(projectId, input)
      if (!isCurrent(current)) { void api.cancel(projectId, begun.setupId).catch(() => undefined); return }
      current.setupId = begun.setupId
      setSetup({ setupId: begun.setupId, receiverId: begun.receiverId, deepLink: begun.deepLink }); setStatus(undefined); setStep('connect')
    } catch (cause) { if (isCurrent(current)) setError(wizardError(cause, 'Could not start Telegram setup.')) } finally { if (isCurrent(current)) setBusy(false) }
  }
  const start = () => { if (!validToken || !name.trim() || !dedicated) return; void begin({ token: trimmedToken, name: name.trim(), dedicatedBot: true }) }
  const activateNotifications = async () => {
    if (!setup || !candidate || (group && !visibility) || !status) return
    const current = session.current
    if (!isCurrent(current) || current.activating) return
    const withControl = !group && taskControl && controlAvailable
    setGroupChat(group)
    // Consumed setup status cannot decide the outcome of this activation.
    current.activating = true; current.activationGeneration++
    setBusy(true); setActivating(true); setError('')
    try {
      const result = await api.activate(projectId, setup.setupId, {
        expectedRevision: status.inboundRevision, candidateUserId: candidate.userId, taskControl: withControl,
        ...(withControl ? { permissions } : {}), ...(group ? { groupVisibilityAccepted: true as const } : {}),
      })
      if (!isCurrent(current)) return
      current.setupId = undefined
      setSetup({ ...setup, receiverId: result.receiverId ?? setup.receiverId, consumed: true }); setActivatedRevision(result.inboundRevision)
      setControlEnabled(withControl); if (!withControl) setTaskControl(false)
      setStep(withControl ? 'done' : 'activate'); onComplete?.()
    } catch (cause) { if (isCurrent(current)) setError(wizardError(cause, 'Could not activate Telegram notifications.')) } finally { current.activating = false; if (isCurrent(current)) { setBusy(false); setActivating(false) } }
  }
  const finishWithoutControl = () => {
    // Skipping/expiry ends this control attempt without invalidating the active notification session.
    controlAttempt.current++
    if (session.current) abandon(session.current)
    setBusy(false); setTaskControl(false); setControlEnabled(false); setStep('done'); onComplete?.()
  }
  const beginControl = async () => {
    if (!setup || !taskControl || !activatedRevision) { finishWithoutControl(); return }
    const current = session.current
    if (!isCurrent(current)) return
    const attempt = controlAttempt.current
    const isCurrentAttempt = () => isCurrent(current) && controlAttempt.current === attempt
    setBusy(true); setError('')
    try {
      const begun = await api.begin(projectId, { receiverId: setup.receiverId, expectedRevision: activatedRevision, dedicatedBot: true, ...(group ? { groupVisibilityAccepted: true as const } : {}) })
      if (!isCurrentAttempt()) { void api.cancel(projectId, begun.setupId).catch(() => undefined); return }
      current.setupId = begun.setupId
      setSetup({ setupId: begun.setupId, receiverId: begun.receiverId, deepLink: begun.deepLink }); setStatus(undefined); setComparisonVerified(false); setStep('control')
    } catch (cause) { if (isCurrentAttempt()) setError(wizardError(cause, 'Could not start task-control setup.')) } finally { if (isCurrentAttempt()) setBusy(false) }
  }
  const approve = async () => {
    if (!setup || !status?.candidate || (comparisonRequired && !comparisonVerified)) return
    const current = session.current
    if (!isCurrent(current) || current.activating) return
    const attempt = controlAttempt.current
    const isCurrentAttempt = () => isCurrent(current) && controlAttempt.current === attempt
    // Consumed setup status cannot decide the outcome of this activation.
    current.activating = true; current.activationGeneration++
    setBusy(true); setActivating(true); setError('')
    try {
      await api.activate(projectId, setup.setupId, { expectedRevision: status.inboundRevision, candidateUserId: status.candidate.userId, taskControl: true, permissions, ...(comparisonRequired ? { comparisonVerified: true as const } : {}) })
      if (!isCurrentAttempt()) return
      current.setupId = undefined
      setSetup({ ...setup, consumed: true })
      setControlEnabled(true); setStep('done'); onComplete?.()
    } catch (cause) { if (isCurrentAttempt()) setError(wizardError(cause, 'Could not activate task control.')) } finally { current.activating = false; if (isCurrent(current)) setActivating(false); if (isCurrentAttempt()) setBusy(false) }
  }
  const close = () => { const current = session.current; if (current) { current.active = false; abandon(current) }; onOpenChange(false) }
  const title = useMemo(() => ({ token: addingChat ? 'Add a Telegram chat' : 'Connect Telegram', connect: 'Connect your Telegram chat', activate: 'Telegram notifications are active', control: 'Optional task control', done: 'Telegram is ready' }[step]), [step, addingChat])
  const shownError = error || pollError

  return <Dialog open={open} onOpenChange={value => { if (!value && !activating) close() }}><DialogContent className="max-h-[90dvh] overflow-y-auto">
    <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{stepDescriptions[step]}</DialogDescription></DialogHeader>
    {step === 'token' && <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5 text-sm font-medium">Notification name<Input ref={nameField} value={name} onChange={event => setName(event.target.value)} autoComplete="off" /></label>
      <label className="flex flex-col gap-1.5 text-sm font-medium">Bot token<Input type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="off" placeholder="123456789:AA…"
        aria-invalid={trimmedToken !== '' && !validToken} aria-describedby={trimmedToken !== '' && !validToken ? 'telegram-token-format' : undefined} /></label>
      {trimmedToken !== '' && !validToken && <p id="telegram-token-format" className="text-ui text-danger">This does not look like a bot token. It has the form 123456789:AA… — copy it from @BotFather.</p>}
      <p className="text-ui text-muted-foreground">
        {addingChat ? 'Paste the token of the bot you already connected. Each person or group gets its own chat.' : <>Create a bot with <a className="underline" href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a>.</>} The token is saved only in this project’s secret store.
      </p>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5" aria-label="This bot is dedicated to this project: no other application receives its messages." checked={dedicated} onChange={event => setDedicated(event.target.checked)} />
        <span className="flex flex-col gap-0.5"><span>This bot is dedicated to this project</span><span className="text-ui text-muted-foreground">No other application receives its messages. You must check this to continue.</span></span></label>
      <DialogFooter><Button onClick={start} disabled={!validToken || !name.trim() || !dedicated || busy}>{busy ? 'Starting…' : 'Continue'}</Button></DialogFooter>
    </div>}
    {step === 'connect' && <div className="flex flex-col gap-4">
      <p ref={connectTarget} tabIndex={-1} className="text-sm">Open one of these links in Telegram:</p>
      {setup && <div className="flex flex-col gap-1"><a className="break-all underline" href={setup.deepLink} target="_blank" rel="noreferrer">Private chat with the bot</a>
        <span className="text-ui text-muted-foreground">Opens your own chat with the bot. Press Start there.</span></div>}
      {groupLink && <div className="flex flex-col gap-1"><a className="break-all underline" href={groupLink} target="_blank" rel="noreferrer">Add to a group</a>
        <span className="text-ui text-muted-foreground">Pick a group and add the bot; it starts there automatically. Forum groups (with topics) are not supported.</span></div>}
      <p role="status" className="text-sm">{candidateLine(candidate, false)}</p>
      {group && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={visibility} onChange={event => setVisibility(event.target.checked)} />I understand all members of this group can read project messages.</label>}
      {candidate && !group && <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5" aria-label="Enable task control for this private chat" checked={taskControl && controlAvailable} disabled={!controlAvailable} onChange={event => setTaskControl(event.target.checked)} />
        <span className="flex flex-col gap-0.5"><span>Enable task control for this private chat</span><span className="text-ui text-muted-foreground">{controlAvailable ? 'The first person who presses Start is approved to control tasks. No second link is needed.' : controlUnavailableText}</span></span></label>}
      {group && <p className="text-ui text-muted-foreground">{controlAvailable ? 'Task control requires a second private Start and code comparison after notifications are active.' : controlUnavailableText}</p>}
      {candidate && !group && taskControl && controlAvailable && <div className="flex flex-col gap-3"><p className="rounded-md border border-warning/50 bg-warning/10 p-3 text-ui">{risk}</p><PermissionChoices permissions={permissions} onChange={setPermissions} /></div>}
      <DialogFooter><Button variant="outline" disabled={activating} onClick={close}>Cancel setup</Button>
        <Button onClick={() => void activateNotifications()} disabled={!candidate || !status || (group && !visibility) || busy}>{busy ? 'Activating…' : taskControl && controlAvailable && !group ? 'Activate notifications and task control' : 'Activate notifications'}</Button></DialogFooter>
    </div>}
    {step === 'activate' && <div className="flex flex-col gap-4">
      <p ref={activateTarget} tabIndex={-1} role="status">Notifications are active. Choose whether a person may control tasks.</p>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5" aria-label="Enable optional task control for a Telegram person" checked={taskControl} disabled={!controlAvailable} onChange={event => setTaskControl(event.target.checked)} />
        <span className="flex flex-col gap-0.5"><span>Enable optional task control for a Telegram person</span>{!controlAvailable && <span className="text-ui text-muted-foreground">{controlUnavailableText}</span>}</span></label>
      {taskControl && <p className="rounded-md border border-warning/50 bg-warning/10 p-3 text-ui">{risk}</p>}
      <DialogFooter><Button variant="outline" onClick={finishWithoutControl}>Skip task control</Button>
        <Button onClick={() => void beginControl()} disabled={busy}>{busy ? 'Starting…' : 'Continue'}</Button></DialogFooter>
    </div>}
    {step === 'control' && <div className="flex flex-col gap-4">
      <p ref={controlTarget} tabIndex={-1} className="text-sm">Open the private setup link and press Start to approve the person who may control tasks.</p>
      {setup && <a className="break-all underline" href={setup.deepLink} target="_blank" rel="noreferrer">{setup.deepLink}</a>}
      <p role="status" className="text-sm">{candidateLine(candidate, true)}</p>
      {comparisonRequired && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={comparisonVerified} onChange={event => setComparisonVerified(event.target.checked)} />I compared the code sent privately by Telegram. Task control stays disabled until this comparison is verified.</label>}
      {comparisonRequired && <p className="text-ui text-muted-foreground">Task control requires the second private Start and code comparison.</p>}
      <PermissionChoices permissions={permissions} onChange={setPermissions} allowStart={!groupChat} />
      <DialogFooter><Button variant="outline" onClick={finishWithoutControl} disabled={busy}>Skip task control</Button>
        <Button onClick={() => void approve()} disabled={!candidate || busy || (comparisonRequired && !comparisonVerified)}>{busy ? 'Activating…' : 'Activate task control'}</Button></DialogFooter>
    </div>}
    {step === 'done' && <div className="flex flex-col gap-4">
      <p ref={doneTarget} tabIndex={-1} role="status">Telegram setup is complete. Notifications are active{controlEnabled ? ' and task control is enabled' : '; task control is off'}.</p>
      <DialogFooter><Button onClick={close}>Done</Button></DialogFooter>
    </div>}
    {shownError && <p role="alert" className="text-sm text-danger">{shownError}</p>}
  </DialogContent></Dialog>
}
