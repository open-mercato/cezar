import { ChatSetupHelp } from './chat-setup-help'
import type { ChatProviderDescriptor, ChatSetupApi } from '@/lib/chat-providers/types'
import { ChatDiscoveryCommand } from './chat-discovery-command'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ChatInboundGrant, ChatSetupBegin, ChatSetupStatus } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { taskControlCostNote } from './chat-list'
import { beginChatSetup, setupGone } from './chat-pairing'

type Step = 'token' | 'connect' | 'activate' | 'control' | 'done'
type Permission = ChatInboundGrant['permissions'][number]
const risk = 'Task control lets a person answer and instruct agents that run shell commands on this machine.'
type SetupCandidate = NonNullable<ChatSetupStatus['candidate']>

/** Map a setup error to a friendly message; the raw server detail (which may carry the token) is never echoed. */
function setupErrorCode(message: string, providerId: string): string {
  const code = message.toLowerCase()
  return code.startsWith(providerId) ? code.slice(providerId.length).replace(/^[_ -]/, '') : code
}

function wizardError(provider: ChatProviderDescriptor, cause: unknown, fallback: string): string {
  if (!(cause instanceof Error)) return fallback
  const messages = provider.bot.setupErrorMessages
  // The ownership conflict answers with prose rather than its code.
  if (/owned elsewhere/i.test(cause.message)) return messages.bot_conflict ?? fallback
  const code = setupErrorCode(cause.message, provider.id)
  return Object.hasOwn(messages, code) ? messages[code] ?? fallback : fallback
}

/** The first free "Telegram notifications", "Telegram notifications 2", … among existing receiver names. */
export function uniqueNotificationName(existing: readonly string[], label = 'Telegram'): string {
  const taken = new Set(existing.map(name => name.trim().toLowerCase()))
  const base = `${label} notifications`
  if (!taken.has(base.toLowerCase())) return base
  for (let index = 2; ; index++) if (!taken.has(`${base} ${index}`.toLowerCase())) return `${base} ${index}`
}

const optionalPermissions: { value: Exclude<Permission, 'respond'>; label: string }[] = [
  { value: 'start', label: 'Start tasks' },
  { value: 'cancel', label: 'Cancel tasks' },
  { value: 'continue', label: 'Continue tasks' },
]

function PermissionChoices({ permissions, onChange, allowStart = true }: { permissions: ChatInboundGrant['permissions']; onChange: (next: ChatInboundGrant['permissions']) => void; allowStart?: boolean }) {
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

const sameStatus = (left: ChatSetupStatus | undefined, right: ChatSetupStatus) => JSON.stringify(left) === JSON.stringify(right)

type Bot = ChatProviderDescriptor['bot']
/** Slack's channel command is the private one (the @ picker adds the mention), so it is shown once. */
const singleCommand = (provider: ChatProviderDescriptor, link: string) => provider.bot.discoveryCommand?.(link) === provider.bot.discoveryCommand?.(link, true)

function connectSteps(provider: ChatProviderDescriptor, deepLink: string, groupLink: string | undefined) {
  const privateStep = { label: provider.bot.privateLabel ?? 'Private chat with the bot', href: deepLink, hint: provider.bot.privateHint }
  const groupStep = { label: provider.bot.groupLabel ?? 'Add to a group', href: groupLink, hint: provider.bot.groupHint }
  // Telegram's group link carries the setup code; without a link the group step is advice only.
  return provider.bot.groupFirst ? [groupStep, privateStep] : [privateStep, groupStep]
}

function DiscoveryCommands({ provider, link }: { provider: ChatProviderDescriptor; link: string }) {
  if (singleCommand(provider, link)) return <ChatDiscoveryCommand provider={provider} link={link} label="Setup command" />
  return <><ChatDiscoveryCommand provider={provider} link={link} /><ChatDiscoveryCommand provider={provider} link={link} group /></>
}

function candidateLine(candidate: SetupCandidate | undefined, withCode: boolean, label = 'Telegram'): string {
  if (!candidate) return `Waiting for ${label}…`
  const person = `${candidate.label}${candidate.username ? ` (@${candidate.username})` : ''} · ${label} ID ${candidate.userId}`
  const code = withCode && candidate.comparisonCode ? ` · Comparison code: ${candidate.comparisonCode}` : ''
  if (candidate.chatType === 'group') return `Group ${candidate.chatTitle ? `“${candidate.chatTitle}”` : 'connected'} · started by ${person}${code}`
  return `Connected as ${person}${code}`
}

/**
 * One token-led setup for a chat, its notifications, and optional task control.
 * `taskControlUnavailable` is the server's reason task control is off (e.g. `flag_off`): notifications still work.
 */
export function ChatWizard({ provider, projectId, open, onOpenChange, onComplete, repairing = false, addingChat = false, existingNames = [], taskControlUnavailable, upgradeReceiver, intent }: {
  repairing?: boolean; provider: ChatProviderDescriptor; projectId: string; open: boolean; onOpenChange: (open: boolean) => void; onComplete?: () => void
  addingChat?: boolean; existingNames?: readonly string[]; taskControlUnavailable?: string
  intent?: 'notifications' | 'conversation'
  upgradeReceiver?: { id: string; name: string; expectedRevision: string }
}) {
  const [step, setStep] = useState<Step>('token')
  const [name, setName] = useState(`${provider.name} notifications`)
  const [credentials, setCredentials] = useState<Record<string, string>>({})
  const [dedicated, setDedicated] = useState(false), dedicatedHintId = useId()
  const [visibility, setVisibility] = useState(false)
  const [comparisonVerified, setComparisonVerified] = useState(false)
  const [taskControl, setTaskControl] = useState(false)
  // Groups cannot start tasks, so their control step never offers Start tasks.
  const [groupChat, setGroupChat] = useState(false)
  const [controlEnabled, setControlEnabled] = useState(false)
  const [permissions, setPermissions] = useState<ChatInboundGrant['permissions']>(['respond'])
  const [setup, setSetup] = useState<{ setupId: string; receiverId: string; deepLink: string; consumed?: boolean }>()
  const [status, setStatus] = useState<ChatSetupStatus>()
  // The revision activation returned; the pre-activation status revision is stale once the chat exists.
  const [activatedRevision, setActivatedRevision] = useState<string>()
  const [error, setError] = useState('')
  const [pollError, setPollError] = useState('')
  const [busy, setBusy] = useState(false)
  // An activation in flight cannot be abandoned: the server may already have created the chat.
  const [activating, setActivating] = useState(false)
  const nameField = useRef<HTMLInputElement>(null)
  const connectTarget = useRef<HTMLOListElement>(null)
  const activateTarget = useRef<HTMLParagraphElement>(null)
  const controlTarget = useRef<HTMLParagraphElement>(null)
  const doneTarget = useRef<HTMLParagraphElement>(null)
  const api = provider.bot.setupApi
  const candidate = status?.candidate
  const group = candidate?.chatType === 'group'
  const controlAvailable = !taskControlUnavailable
  const controlUnavailableText = taskControlUnavailable ? provider.bot.unavailableMessages[taskControlUnavailable] ?? provider.bot.unavailableMessages.unavailable : ''
  const comparisonRequired = step === 'control' && candidate?.chatType === 'private' && !!candidate.comparisonCode
  const credentialFields = provider.bot.fields.filter(field => !field.visibleWhen || field.visibleWhen(credentials))
  const fieldValid = (field: (typeof credentialFields)[number], value: string) => (field.optional === true && value === '') || field.pattern.test(value)
  const validToken = credentialFields.every(field => fieldValid(field, (credentials[field.name] ?? '').trim()))
  const groupLink = setup && step === 'connect' ? provider.bot.groupLink(setup.deepLink) : undefined
  const suggestedNames = useRef(existingNames)
  suggestedNames.current = existingNames
  // Each open/project session owns its pending pairing and async responses.
  const controlAttempt = useRef(0)
  const session = useRef<{ active: boolean; projectId: string; api: ChatSetupApi; setupId?: string; activating: boolean; activationGeneration: number }>(undefined)
  const abandon = (current: NonNullable<typeof session.current>) => {
    if (current.setupId) {
      void current.api.cancel(current.projectId, current.setupId).catch(() => undefined)
      current.setupId = undefined
    }
  }
  const setupCode = (cause: unknown) => cause instanceof Error ? setupErrorCode(cause.message, provider.id) : ''
  const isCurrent = (current: typeof session.current): current is NonNullable<typeof session.current> => !!current?.active && session.current === current

  useEffect(() => {
    if (!open) return
    const current = { active: true, projectId, api, activating: false, activationGeneration: 0 }
    session.current = current
    setStep('token'); setError(''); setPollError(''); setBusy(false); setActivating(false); setSetup(undefined); setStatus(undefined); setActivatedRevision(undefined); setGroupChat(false)
    setCredentials({}); setDedicated(false); setVisibility(false); setComparisonVerified(false); setTaskControl(intent === 'conversation' && controlAvailable); setControlEnabled(false); setPermissions(['respond'])
    setName(upgradeReceiver?.name ?? uniqueNotificationName(suggestedNames.current, provider.name))
    return () => { current.active = false; abandon(current) }
  }, [open, projectId, api, provider.id, provider.name, upgradeReceiver?.id, upgradeReceiver?.expectedRevision, intent])
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
      if (step === 'control') { setError(`The task-control link expired. Notifications are on — use Enable task control on this chat on the ${provider.name} integration page to try again.`); finishWithoutControl() }
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
        if (cause instanceof Error && setupGone(setupErrorCode(cause.message, provider.id))) expire()
        else setPollError(wizardError(provider, cause, `Could not read ${provider.name} setup status.`))
      }
    }
    void poll(); const timer = window.setInterval(() => void poll(), 2_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [api, projectId, open, setup, step, provider])

  const begin = async (input: ChatSetupBegin) => {
    const current = session.current
    if (!isCurrent(current)) return
    setBusy(true); setError('')
    try {
      const begun = await beginChatSetup(api, provider.bot.api.list, projectId, input, setupCode, () => isCurrent(current))
      if (!begun) return
      if (!isCurrent(current)) { void api.cancel(projectId, begun.setupId).catch(() => undefined); return }
      current.setupId = begun.setupId
      setSetup({ setupId: begun.setupId, receiverId: begun.receiverId, deepLink: begun.deepLink }); setStatus(undefined); setStep('connect')
    } catch (cause) { if (isCurrent(current)) setError(wizardError(provider, cause, `Could not start ${provider.name} setup.`)) } finally { if (isCurrent(current)) setBusy(false) }
  }
  const start = () => {
    if (!validToken || !name.trim() || !dedicated) return
    const input = provider.bot.begin(Object.fromEntries(Object.entries(credentials).map(([key, value]) => [key, value.trim()])), name.trim())
    void begin({ ...input, ...(upgradeReceiver ? { receiverId: upgradeReceiver.id, expectedRevision: upgradeReceiver.expectedRevision } : {}) })
  }
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
      setControlEnabled(withControl); if (!withControl && intent !== 'conversation') setTaskControl(false)
      // A private chat already answered the task-control question on the connect step; only a group needs the second, private setup.
      setStep(withControl || intent === 'notifications' || !group ? 'done' : 'activate'); onComplete?.()
    } catch (cause) { if (isCurrent(current)) setError(wizardError(provider, cause, `Could not activate ${provider.name} notifications.`)) } finally { current.activating = false; if (isCurrent(current)) { setBusy(false); setActivating(false) } }
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
      const begun = await beginChatSetup(api, provider.bot.api.list, projectId, { receiverId: setup.receiverId, expectedRevision: activatedRevision, dedicatedBot: true, ...(group ? { groupVisibilityAccepted: true as const } : {}) }, setupCode, isCurrentAttempt)
      if (!begun) return
      if (!isCurrentAttempt()) { void api.cancel(projectId, begun.setupId).catch(() => undefined); return }
      current.setupId = begun.setupId
      setSetup({ setupId: begun.setupId, receiverId: begun.receiverId, deepLink: begun.deepLink }); setStatus(undefined); setComparisonVerified(false); setStep('control')
    } catch (cause) { if (isCurrentAttempt()) setError(wizardError(provider, cause, 'Could not start task-control setup.')) } finally { if (isCurrentAttempt()) setBusy(false) }
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
    } catch (cause) { if (isCurrentAttempt()) setError(wizardError(provider, cause, 'Could not activate task control.')) } finally { current.activating = false; if (isCurrent(current)) setActivating(false); if (isCurrentAttempt()) setBusy(false) }
  }
  const close = () => { const current = session.current; if (current) { current.active = false; abandon(current) }; onOpenChange(false) }
  const title = useMemo(() => ({ token: repairing ? `Repair ${provider.name} connection` : addingChat ? `Add a ${provider.name} chat` : `Connect ${provider.name}`, connect: `Connect your ${provider.name} chat`, activate: `${provider.name} notifications are active`, control: 'Optional task control', done: `${provider.name} is ready` }[step]), [step, repairing, addingChat, provider.name])
  const stepDescriptions: Record<Step, string> = {
    token: repairing ? `Paste fresh credentials from the same ${provider.name} bot. You will confirm the chat and its permissions again.` : addingChat ? `Paste the same bot ${provider.bot.fields.length > 1 ? 'tokens' : 'token'} to connect another chat. Nothing is sent until you activate notifications.` : provider.bot.credentialHint,
    connect: provider.bot.discoveryHint,
    activate: `Notifications are on. You can also let one trusted member control tasks from ${provider.name} after a private setup.`,
    control: provider.bot.approval.controlHint,
    done: `People and permissions can be changed later on the ${provider.name} integration page.`,
  }
  const shownError = error || pollError

  return <Dialog open={open} onOpenChange={value => { if (!value && !activating) close() }}><DialogContent className="max-h-[90dvh] overflow-y-auto">
    <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{stepDescriptions[step]}</DialogDescription></DialogHeader>
    {step === 'token' && <div className="flex flex-col gap-4">
      {!addingChat && <ChatSetupHelp providerId={provider.id} help={provider.bot.help} />}
      {upgradeReceiver && <p className="text-sm">{repairing ? 'Repairing access for' : 'Adding task control to'} {upgradeReceiver.name}. Its notification settings are kept; no second notification connection is created.</p>}
      <label className="flex flex-col gap-1.5 text-sm font-medium">Notification name<Input ref={nameField} value={name} onChange={event => setName(event.target.value)} autoComplete="off" /></label>
      {credentialFields.map(field => {
        const value = credentials[field.name] ?? '', invalid = value.trim() !== '' && !fieldValid(field, value.trim())
        const hintId = `${provider.id}-${field.name}-format`
        return <div key={field.name} className="flex flex-col gap-1.5">
          <label className="flex flex-col gap-1.5 text-sm font-medium">{field.optional ? `${field.label} (optional)` : field.label}<Input type={field.secret === false ? 'text' : 'password'} value={value} onChange={event => setCredentials(current => ({ ...current, [field.name]: event.target.value }))} autoComplete="off" placeholder={field.placeholder} aria-invalid={invalid} aria-describedby={invalid ? hintId : undefined} /></label>
          {field.hint && <p className="text-ui text-muted-foreground">{field.hint}</p>}
          {invalid && <p id={hintId} className="text-ui text-danger">{field.invalid}</p>}
        </div>
      })}
      <p className="text-ui text-muted-foreground">
        {addingChat ? `${provider.bot.credentialHelp.add} ` : provider.bot.credentialHelp.create ? <>{provider.bot.credentialHelp.create} <a className="underline" href={provider.bot.help.href} target="_blank" rel="noreferrer">{provider.bot.help.label}</a>. </> : null}{provider.bot.credentialHelp.storage}
      </p>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5" aria-labelledby={`${dedicatedHintId}-label`} aria-describedby={dedicatedHintId} checked={dedicated} onChange={event => setDedicated(event.target.checked)} />
        <span className="flex flex-col gap-0.5"><span id={`${dedicatedHintId}-label`}>This bot is dedicated to this project</span><span id={dedicatedHintId} className="text-ui text-muted-foreground">Use a separate bot for another app or Cezar project. Sharing this bot can send your commands to the wrong application. Confirm that it is used only here to continue.</span></span></label>
      <DialogFooter><Button onClick={start} disabled={!validToken || !name.trim() || !dedicated || busy}>{busy ? 'Starting…' : 'Continue'}</Button></DialogFooter>
    </div>}
    {step === 'connect' && <div className="flex flex-col gap-4">
      {/* Once the command arrived the instructions are done; only the decision stays on screen. */}
      {setup && !candidate && <ol ref={connectTarget} tabIndex={-1} className="flex list-decimal flex-col gap-2 pl-5 text-sm">
        {connectSteps(provider, setup.deepLink, groupLink).map(step => <li key={step.label}>
          {step.href ? <a className="break-all underline" href={step.href} target="_blank" rel="noreferrer">{step.label}</a> : <span className="font-medium">{step.label}</span>}
          <span className="block text-ui text-muted-foreground">{step.hint}</span>
        </li>)}
      </ol>}
      {setup && !candidate && <DiscoveryCommands provider={provider} link={setup.deepLink} />}
      <p role="status" className="text-sm">{candidateLine(candidate, false, provider.name)}{candidate ? '' : ' Nothing has been sent to the chat yet.'}</p>
      {candidate && <p className="text-ui text-muted-foreground">Setup command received. Activate to send a test notification and turn notifications on.</p>}
      {!candidate && <ChatSetupHelp providerId={provider.id} help={provider.bot.help} connecting />}
      {group && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={visibility} onChange={event => setVisibility(event.target.checked)} />I understand all members of this group can read project messages.</label>}
      {candidate && !group && <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5" aria-label="Enable task control for this private chat" checked={taskControl && controlAvailable} disabled={!controlAvailable} onChange={event => setTaskControl(event.target.checked)} />
        <span className="flex flex-col gap-0.5"><span>Enable task control for this private chat</span><span className="text-ui text-muted-foreground">{controlAvailable ? provider.bot.approval.privateControl : controlUnavailableText}</span></span></label>}
      {group && <p className="text-ui text-muted-foreground">{controlAvailable ? provider.bot.approval.groupControl : controlUnavailableText}</p>}
      {candidate && !group && taskControl && controlAvailable && <div className="flex flex-col gap-3"><p className="rounded-md border border-warning/50 bg-warning/10 p-3 text-ui">{risk}</p><PermissionChoices permissions={permissions} onChange={setPermissions} /></div>}
      <DialogFooter><Button variant="outline" disabled={activating} onClick={close}>Cancel setup</Button>
        <Button onClick={() => void activateNotifications()} disabled={!candidate || !status || (group && !visibility) || busy}>{busy ? 'Sending test and activating…' : candidate && taskControl && controlAvailable && !group ? 'Activate notifications and task control' : 'Activate notifications'}</Button></DialogFooter>
    </div>}
    {step === 'activate' && <div className="flex flex-col gap-4">
      <p ref={activateTarget} tabIndex={-1} role="status">Choose whether a person may control tasks from this group.</p>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5" aria-label={`Enable optional task control for a ${provider.name} person`} checked={taskControl} disabled={!controlAvailable} onChange={event => setTaskControl(event.target.checked)} />
        <span className="flex flex-col gap-0.5"><span>{`Enable optional task control for a ${provider.name} person`}</span>{!controlAvailable && <span className="text-ui text-muted-foreground">{controlUnavailableText}</span>}</span></label>
      {taskControl && <p className="rounded-md border border-warning/50 bg-warning/10 p-3 text-ui">{risk}</p>}
      <DialogFooter><Button variant="outline" onClick={finishWithoutControl}>Skip task control</Button>
        <Button onClick={() => void beginControl()} disabled={busy}>{busy ? 'Starting…' : 'Continue'}</Button></DialogFooter>
    </div>}
    {step === 'control' && <div className="flex flex-col gap-4">
      {setup && !candidate && <p ref={controlTarget} tabIndex={-1} className="text-sm"><a className="underline" href={setup.deepLink} target="_blank" rel="noreferrer">{provider.bot.approval.privateLink ?? provider.bot.privateLabel ?? 'Private chat with the bot'}</a></p>}
      {setup && !candidate && <ChatDiscoveryCommand provider={provider} link={setup.deepLink} label={singleCommand(provider, setup.deepLink) ? 'Setup command' : undefined} />}
      <p role="status" className="text-sm">{candidateLine(candidate, true, provider.name)}</p>
      {comparisonRequired && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={comparisonVerified} onChange={event => setComparisonVerified(event.target.checked)} />{`I compared the code sent privately by ${provider.name}. Task control stays disabled until this comparison is verified.`}</label>}
      {comparisonRequired && <p className="text-ui text-muted-foreground">{provider.bot.approval.comparisonHint}</p>}
      <PermissionChoices permissions={permissions} onChange={setPermissions} allowStart={!groupChat} />
      <DialogFooter><Button variant="outline" onClick={finishWithoutControl} disabled={busy}>Skip task control</Button>
        <Button onClick={() => void approve()} disabled={!candidate || busy || (comparisonRequired && !comparisonVerified)}>{busy ? 'Activating…' : 'Activate task control'}</Button></DialogFooter>
    </div>}
    {step === 'done' && <div className="flex flex-col gap-4">
      <p ref={doneTarget} tabIndex={-1} role="status">Notifications are active{controlEnabled ? ' and task control is enabled' : '; task control is off'}.</p>
      <p className="text-sm text-muted-foreground">Sending: verified by a test notification. Receiving: verified by your setup command.</p>
      <DialogFooter><Button onClick={close}>Done</Button></DialogFooter>
    </div>}
    {shownError && <p role="alert" className="text-sm text-danger">{shownError}</p>}
  </DialogContent></Dialog>
}
