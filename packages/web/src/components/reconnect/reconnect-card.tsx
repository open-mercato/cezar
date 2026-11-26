import { CheckIcon, ChevronDownIcon, ChevronUpIcon, ExternalLinkIcon } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link as GlobalLink } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import type { AgentProfile, LoginMethod, LoginSession, ProviderId, ReconnectResumed } from '@open-mercato/cezar-api-client'

import { sendLoginSessionInput } from '@/api/client'
import { useAgentProfiles, writeLoginSession } from '@/api/queries'
import { useAddAccount } from '@/components/add-account/add-account-host'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { toast } from '@/components/ui/toaster'
import { writeClipboard } from '@/lib/clipboard'
import { cn } from '@/lib/utils'

import { agentName, failureCopy, fallbackCommand, KEY_CAPABLE, TERMINAL_ONLY, urlHost } from './copy'
import { RunnerMark } from './runner-mark'
import { useReconnectSurface } from './surface'
import { useReconnect } from './use-reconnect'

/**
 * The inline reconnect card (spec 2026-11-18-inline-account-reconnect, design page `.html`):
 * expired → signing in (whatever the vendor supports) → signed in, or failed with a fixed reason.
 * Its state is the ACCOUNT's login session, so every card for one account moves together.
 */

export type ReconnectPlace = 'manager' | 'task' | 'attention'

export interface ReconnectCardProps {
  provider: ProviderId
  /** `default` for the discovered login. */
  profileId: string
  place: ReconnectPlace
  /** A phone-width row: fewer words, full-width actions. */
  compact?: boolean
  /** Already inside a sheet or dialog: never opens its own. */
  inSheet?: boolean
  /** "Also waiting on Work: 2 tasks · 1 manager" under the actions. */
  blocked?: ReactNode
  className?: string
}

export function ReconnectCard({ provider, profileId, place, compact = false, inSheet = false, blocked, className }: ReconnectCardProps) {
  const { session, news, profiles, profile, account, who, remote, narrow, view, startError, start, recheck, reconnect: begin, checkAgain, stop } = useReconnect(provider, profileId)
  const surface = useReconnectSurface()
  const [more, setMore] = useState(false)
  // Only the card that started the sign-in opens its sheet: two cards for one account must not stack two.
  const [sheetOpen, setSheetOpen] = useState(false)
  const reconnect = (method?: LoginMethod) => {
    setMore(false)
    setSheetOpen(true)
    begin(method)
  }

  const switchMenu = surface?.switchTo
    ? <SwitchAccount provider={provider} profileId={profileId} profiles={profiles ?? []} kind={surface.kind} onSwitch={surface.switchTo} />
    : null
  const moreButton = (
    <Button type="button" variant="ghost" size="sm" aria-expanded={more} data-action="reconnect-more" onClick={() => setMore((open) => !open)}>
      More options
      {more ? <ChevronUpIcon aria-hidden="true" className="size-3.5" /> : <ChevronDownIcon aria-hidden="true" className="size-3.5" />}
    </Button>
  )
  const moreBlock = more ? (
    <MoreOptions
      provider={provider}
      command={session?.command ?? startError?.command ?? fallbackCommand(provider, profile?.configDir, profile?.isDefault ?? profileId === 'default')}
      checking={recheck.isPending}
      onCheck={checkAgain}
      onKey={KEY_CAPABLE.has(provider) ? () => reconnect('key') : undefined}
    />
  ) : null

  if (view === 'signing' && session) {
    const body = (
      <SigningBody session={session} who={who} remote={remote} compact={compact || narrow} />
    )
    const actions = (
      <SigningActions
        session={session}
        remote={remote}
        stacked={narrow && !inSheet}
        onCheck={checkAgain}
        onRestart={() => reconnect()}
        onCancel={stop}
        checking={recheck.isPending}
      />
    )
    if (narrow && !inSheet) {
      // A phone signs in in a bottom sheet (design, Mobile); the card stays behind it as a reminder.
      return (
        <div data-slot="reconnect-card" data-state="signing" data-provider={provider} className={cn(CARD, BUSY, className)}>
          <div className="flex items-center gap-2 text-ui font-semibold">
            <Spinner className="size-3.5" />
            <RunnerMark provider={provider} small />
            Signing in to {who}
          </div>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <Button type="button" variant="outline" size="sm" onClick={() => setSheetOpen(true)}>Show sign-in</Button>
            <Button type="button" variant="ghost" size="sm" onClick={stop}>Cancel</Button>
          </div>
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetContent side="bottom" data-slot="reconnect-sheet" className="rounded-t-2xl px-4 pt-3 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
              <div aria-hidden="true" className="mx-auto mb-3 h-1 w-9 rounded-full bg-muted" />
              <SheetTitle className="flex items-center gap-2 text-base">
                <RunnerMark provider={provider} />
                Reconnect {who}
              </SheetTitle>
              <SheetDescription className="sr-only">Finish signing in to {who}.</SheetDescription>
              {body}
              <div className="mt-3 flex flex-col items-stretch gap-1.5">{actions}</div>
            </SheetContent>
          </Sheet>
        </div>
      )
    }
    return (
      <div data-slot="reconnect-card" data-state="signing" data-provider={provider} role="group" aria-live="polite" aria-label={`Signing in to ${who}`} className={cn(CARD, BUSY, className)}>
        <div className="flex items-start gap-2.5">
          <Spinner className="mt-1 size-3.5" />
          <div className="min-w-0 flex-1">
            <div className={TITLE}><RunnerMark provider={provider} small /> Signing in to {who}</div>
            {body}
          </div>
        </div>
        <div className={ACTIONS}>{actions}</div>
      </div>
    )
  }

  if (view === 'success') {
    const resumed = session?.resumed ?? news?.resumed
    return (
      <div data-slot="reconnect-card" data-state="success" data-provider={provider} role="status" className={cn(CARD, 'border-success/30 bg-success/5', className)}>
        <div className="flex items-start gap-2.5">
          <CheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success-strong" />
          <div className="min-w-0 flex-1">
            <div className={TITLE}>{who} is signed in again</div>
            {place === 'task' && surface?.parked === null ? (
              <div className={SUB}>Continue the task to pick up where it stopped.</div>
            ) : (
              <div className={cn(SUB, 'flex items-center gap-1.5')}>
                <Spinner className="size-3" />
                {place === 'task' ? 'Continuing the run from the same session…' : place === 'manager' ? 'Resuming this turn…' : 'Resuming what waited on it…'}
              </div>
            )}
          </div>
        </div>
        {resumed ? <ResumedList account={account} resumed={resumed} compact={compact} /> : null}
      </div>
    )
  }

  if (view === 'failed') {
    const reason = startError?.message ?? failureCopy(session?.reason, session?.method, provider, account)
    return (
      <div data-slot="reconnect-card" data-state="failed" data-provider={provider} role="alert" className={cn(CARD, className)}>
        <div className="flex items-start gap-2.5">
          <RunnerMark provider={provider} />
          <div className="min-w-0">
            <div className={TITLE}>Sign-in to {who} didn't finish</div>
            <div data-slot="reconnect-reason" className={SUB}>{reason}</div>
          </div>
        </div>
        <div className={cn(ACTIONS, compact && 'flex-col items-stretch')}>
          <Button type="button" variant="contrast" size="sm" data-action="reconnect-start" disabled={start.isPending} onClick={() => reconnect()}>Try again</Button>
          {switchMenu}
          {moreButton}
        </div>
        {startError?.command && !more ? <CommandLine command={startError.command} label="Run this on the computer running cezar:" /> : null}
        {moreBlock}
      </div>
    )
  }

  const terminalLocal = TERMINAL_ONLY.has(provider) && !remote
  return (
    <div data-slot="reconnect-card" data-state="expired" data-provider={provider} role="group" aria-label={`${who} is signed out`} className={cn(CARD, className)}>
      <div className="flex items-start gap-2.5">
        <RunnerMark provider={provider} />
        <div className="min-w-0">
          <div className={TITLE}>
            {who} is signed out
            <span data-slot="reconnect-pill" className={cn(PILL, 'border-danger/35 bg-danger/10 text-danger-strong')}>Login expired</span>
          </div>
          <div className={SUB}>
            {place === 'task' && surface?.parked === null
              // A task that is no longer parked (it failed, finished or was stopped) resumes nothing on its own.
              ? 'The run stopped when the login expired. Reconnect, then Continue the task.'
              : place === 'task'
              ? 'The run paused at its first request after the login expired. Reconnect and it continues from the same session.'
              : place === 'manager'
                ? 'This turn stopped before answering. Reconnect and it picks up where it stopped.'
                : 'Reconnect and everything waiting on it resumes.'}
          </div>
        </div>
      </div>
      <div className={cn(ACTIONS, compact && 'flex-col items-stretch')}>
        <Button type="button" variant="contrast" size="sm" data-action="reconnect-start" disabled={start.isPending} onClick={() => reconnect()}>
          {start.isPending ? <Spinner className="size-3" /> : null}
          {terminalLocal ? <>Sign in to {account} <ExternalLinkIcon aria-hidden="true" className="size-3" /></> : <>Reconnect {account}</>}
        </Button>
        {switchMenu}
        {moreButton}
      </div>
      {moreBlock}
      {blocked && !compact ? (
        <div data-slot="reconnect-blocked" className="mt-2.5 flex flex-wrap items-center gap-1.5 text-micro text-soft-foreground">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-pending" />
          {blocked}
        </div>
      ) : null}
    </div>
  )
}

const CARD = 'mt-2 max-w-[640px] rounded-[10px] border border-danger/30 bg-danger/5 px-3.5 py-3 transition-colors'
const BUSY = 'border-border bg-card'
const TITLE = 'flex flex-wrap items-center gap-1.5 text-ui font-semibold text-foreground'
const SUB = 'mt-0.5 text-xs text-muted-foreground'
const ACTIONS = 'mt-2.5 flex flex-wrap items-center gap-1.5'
const PILL = 'inline-flex h-[18px] items-center rounded-full border px-1.5 text-micro font-semibold tracking-[.02em] whitespace-nowrap'

/** The quiet line every other blocked surface shows once the account is back, or, for an older
 *  occurrence of a still-signed-out account, where the live card is (design: one card per account). */
export function ReconnectedLine({ provider, profileId, at, signedOutHere = false }: {
  provider?: ProviderId
  profileId?: string
  at?: string | undefined
  signedOutHere?: boolean
}) {
  const label = useAccountLabel(provider, profileId ?? 'default')
  const who = provider ? ` ${agentName(provider)} · ${label}` : ''
  const time = at ? new Date(at) : undefined
  const clock = time && Number.isFinite(time.getTime()) ? time.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : undefined
  return (
    <p data-slot="reconnected-line" data-state={signedOutHere ? 'older' : 'reconnected'} className="mt-1.5 flex items-center gap-1.5 text-label text-muted-foreground">
      {signedOutHere ? (
        <><span aria-hidden="true">·</span>{who.trim()} was signed out here</>
      ) : (
        <><CheckIcon aria-hidden="true" className="size-3.5 text-success-strong" />Reconnected{who} · resumed{clock ? <> at <time dateTime={at}>{clock}</time></> : null}</>
      )}
    </p>
  )
}

export function useAccountLabel(provider: ProviderId | undefined, profileId: string): string {
  const profiles = useAgentProfiles().data?.profiles
  return profiles?.find((row) => row.provider === provider && row.id === profileId)?.label ?? (profileId === 'default' ? 'Default' : profileId)
}

// ---- signing in ------------------------------------------------------------------------------

/** The sign-in body, shared by the reconnect card and Add account (spec 2026-11-24). */
export function SigningBody({ session, who, remote, compact, stepsLabel = 'resume' }: {
  session: LoginSession
  who: string
  remote: boolean
  compact: boolean
  /** `verify` in Add account: there is nothing to resume. */
  stepsLabel?: 'resume' | 'verify'
}) {
  const name = agentName(session.provider)
  const host = urlHost(session.url)
  const queryClient = useQueryClient()
  if (session.phase === 'starting') {
    return <p className={SUB}>Starting {name}'s sign-in…</p>
  }
  if (session.phase === 'verifying') {
    return <Steps steps={[['done', 'Sign-in finished'], ['now', 'Verifying the account'], ['todo', stepsLabel === 'resume' ? 'Resume' : 'Ready']]} />
  }
  switch (session.method) {
    case 'browser':
      // Never opened for the user: they paste it into the browser profile the account lives in.
      return (
        <>
          <p className={SUB}>
            Open this link in the browser and profile you sign in to {name} with, then approve access. {stepsLabel === 'resume' ? 'This card' : 'This dialog'} updates by itself.
          </p>
          {session.url ? <CommandLine command={session.url} copyLabel="Copy link" /> : null}
          <Steps steps={[['done', 'Sign-in started'], ['now', 'Approve in your browser'], ['todo', stepsLabel === 'resume' ? 'Verify & resume' : 'Verify']]} />
        </>
      )
    case 'link':
      return (
        <>
          <p className={SUB}>
            Open the {name} sign-in {remote ? 'on this or any device' : 'in your browser'} and approve. {name} confirms it to cezar directly, with no callback to this computer.
          </p>
          {session.url ? <CommandLine command={session.url} copyLabel="Copy link" /> : null}
        </>
      )
    case 'device':
      return (
        <>
          <p className={SUB}>
            Enter this code at <b className="font-semibold text-foreground">{host ?? 'the sign-in page'}</b>{remote ? ', on this or any device' : ''}.
          </p>
          {session.userCode ? <DeviceCode code={session.userCode} expiresAt={session.expiresAt} /> : <p className={SUB}>Waiting for the code…</p>}
        </>
      )
    case 'paste':
      return (
        <>
          <Steps steps={[['done', 'Sign-in started'], ['now', 'Approve & copy the code'], ['todo', 'Paste it here']]} />
          <p className={cn(SUB, 'mt-2')}>
            1. Open the sign-in link on {compact ? 'this phone' : 'any device'} and approve. {name} then shows a one-time code.
            <br />
            2. Paste that code here. It goes straight to {name} on your computer.
          </p>
          <SecretForm
            session={session}
            kind="code"
            placeholder={`Paste the code from ${name}`}
            submitLabel="Sign in"
            onAnswer={(next) => writeLoginSession(queryClient, next)}
          />
        </>
      )
    case 'key':
      return (
        <>
          <p className={SUB}>
            {session.provider === 'opencode'
              ? "Paste an API key for the provider this account used. It goes straight into OpenCode's own credential store; cezar doesn't keep it."
              : "Paste an OpenAI API key. Codex stores it in this account's folder; cezar doesn't keep it."}
          </p>
          {KEY_CAPABLE.has(session.provider) ? (
            <SecretForm
              session={session}
              kind="key"
              placeholder="sk-…"
              submitLabel="Save & sign in"
              keyProviders={session.provider === 'opencode' ? session.keyProviders : undefined}
              onAnswer={(next) => writeLoginSession(queryClient, next)}
            />
          ) : null}
        </>
      )
    case 'terminal':
      return remote ? (
        <>
          <p className={SUB}>{name} can only sign in on the computer running cezar. Run this there, then come back:</p>
          {session.command ? <CommandLine command={session.command} /> : null}
        </>
      ) : (
        <p className={SUB}>{name} signs in only in its own window. We opened it in a terminal; finish there and this card notices by itself.</p>
      )
  }
  return <p className={SUB}>Signing in to {who}…</p>
}

export function SigningActions({ session, remote, stacked, checking, onCheck, onRestart, onCancel }: {
  session: LoginSession
  remote: boolean
  stacked: boolean
  checking: boolean
  onCheck: () => void
  onRestart: () => void
  onCancel: () => void
}) {
  const host = urlHost(session.url)
  const open = session.url ? () => openUrl(session.url!) : undefined
  const size = stacked ? 'default' : 'sm'
  let primary: ReactNode = null
  if (session.method === 'browser' && open) primary = <Button type="button" variant="outline" size={size} onClick={open}>Open in default browser <ExternalLinkIcon aria-hidden="true" className="size-3" /></Button>
  else if (session.method === 'link' && open) primary = <Button type="button" variant={stacked ? 'contrast' : 'outline'} size={size} onClick={open}>Open {agentName(session.provider)} sign-in <ExternalLinkIcon aria-hidden="true" className="size-3" /></Button>
  else if (session.method === 'device' && open) {
    const code = session.userCode
    primary = stacked && code ? (
      <Button type="button" variant="contrast" size={size} onClick={() => { void writeClipboard(code).catch(() => {}); open() }}>
        Copy code &amp; open {host} <ExternalLinkIcon aria-hidden="true" className="size-3" />
      </Button>
    ) : <Button type="button" variant="outline" size={size} onClick={open}>Open {host} <ExternalLinkIcon aria-hidden="true" className="size-3" /></Button>
  } else if (session.method === 'paste' && open) primary = <Button type="button" variant="outline" size={size} onClick={open}>Open sign-in link <ExternalLinkIcon aria-hidden="true" className="size-3" /></Button>
  else if (session.method === 'terminal') {
    primary = remote ? (
      <Button type="button" variant="outline" size={size} disabled={checking} onClick={onCheck}>I've signed in · Check</Button>
    ) : (
      <>
        <Button type="button" variant="outline" size={size} onClick={onRestart}>Open again</Button>
        <Button type="button" variant="outline" size={size} disabled={checking} onClick={onCheck}>I've signed in</Button>
      </>
    )
  }
  return (
    <>
      {primary}
      <Button type="button" variant="ghost" size={size} data-action="reconnect-cancel" onClick={onCancel}>Cancel</Button>
    </>
  )
}

function Steps({ steps }: { steps: Array<['done' | 'now' | 'todo', string]> }) {
  return (
    <ol data-slot="reconnect-steps" className="mt-2.5 flex flex-wrap gap-3.5 text-micro text-soft-foreground">
      {steps.map(([state, label]) => (
        <li key={label} data-state={state} className={cn('flex items-center gap-1', state === 'done' && 'text-success-strong', state === 'now' && 'text-foreground')}>
          <span aria-hidden="true">{state === 'done' ? '✓' : state === 'now' ? '●' : '○'}</span>
          {label}
        </li>
      ))}
    </ol>
  )
}

function DeviceCode({ code, expiresAt }: { code: string; expiresAt: string | undefined }) {
  const left = useCountdown(expiresAt)
  return (
    <div data-slot="reconnect-device" className="mt-2.5 flex flex-wrap items-center gap-2.5">
      <span aria-label="One-time code" className="rounded-lg border border-border bg-background px-3 py-1.5 font-mono text-xl font-semibold tracking-[.18em]">{code}</span>
      <CopyButton text={code} label="Copy code" variant="outline" />
      {left !== undefined ? (
        <span className="text-label text-muted-foreground">Expires in <span data-slot="reconnect-countdown" className="font-mono">{left}</span></span>
      ) : null}
    </div>
  )
}

/** "14:59", ticking each second; undefined without an expiry. */
export function useCountdown(expiresAt: string | undefined): string | undefined {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!expiresAt) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [expiresAt])
  if (!expiresAt) return undefined
  const end = Date.parse(expiresAt)
  if (!Number.isFinite(end)) return undefined
  const ms = Math.max(0, end - now)
  return `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`
}

/**
 * The code or key field. The value lives ONLY in the input element: read on submit, cleared at
 * once, sent straight to the route — no React state, no mutation cache, no log.
 */
function SecretForm({ session, kind, placeholder, submitLabel, keyProviders, onAnswer }: {
  session: LoginSession
  kind: 'code' | 'key'
  placeholder: string
  submitLabel: string
  keyProviders?: string[] | undefined
  onAnswer: (session: LoginSession) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [picked, setKeyProvider] = useState<string | undefined>()
  const keyProvider = picked !== undefined && keyProviders?.includes(picked) ? picked : keyProviders?.[0]
  const [sending, setSending] = useState(false)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const field = input.current
    const value = field?.value.trim() ?? ''
    if (field) field.value = ''
    if (!value) return
    setSending(true)
    sendLoginSessionInput(session.sessionId, kind === 'code' ? { code: value } : { apiKey: value, ...(keyProvider ? { keyProvider } : {}) })
      .then(onAnswer)
      .catch((error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'danger' }))
      .finally(() => setSending(false))
  }
  return (
    <form data-slot="reconnect-secret" onSubmit={submit} className="mt-2 flex flex-wrap gap-1.5">
      {keyProviders && keyProviders.length > 0 ? (
        <Select value={keyProvider} onValueChange={setKeyProvider}>
          <SelectTrigger size="sm" aria-label="Provider" data-slot="reconnect-key-provider" className="h-[30px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {keyProviders.map((id) => <SelectItem key={id} value={id}>{id}</SelectItem>)}
          </SelectContent>
        </Select>
      ) : null}
      <input
        ref={input}
        type="password"
        autoComplete="off"
        spellCheck={false}
        aria-label={kind === 'code' ? 'One-time code' : 'API key'}
        placeholder={placeholder}
        className="h-[30px] min-w-[140px] flex-1 rounded-sm border border-border bg-background px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30"
      />
      <Button type="submit" variant="contrast" size="sm" disabled={sending}>{submitLabel}</Button>
    </form>
  )
}

// ---- shared bits ---------------------------------------------------------------------------

function openUrl(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer')
}

function CopyButton({ text, label, variant = 'ghost' }: { text: string; label: string; variant?: 'ghost' | 'outline' }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <Button
      type="button"
      variant={variant}
      size="sm"
      onClick={() => writeClipboard(text).then(() => setCopied(true), () => toast('Could not copy', { tone: 'danger' }))}
    >
      {copied ? 'Copied' : label}
    </Button>
  )
}

function CommandLine({ command, label, copyLabel = 'Copy' }: { command: string; label?: string; copyLabel?: string }) {
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {label ? <p className="text-xs text-muted-foreground">{label}</p> : null}
      <div data-slot="reconnect-command" className="flex max-w-full items-center gap-1.5 rounded-lg border border-border bg-background py-1 pr-1 pl-2">
        <code className="min-w-0 flex-1 overflow-auto font-mono text-xs whitespace-nowrap">{command}</code>
        <CopyButton text={command} label={copyLabel} />
      </div>
    </div>
  )
}

function MoreOptions({ provider, command, checking, onCheck, onKey }: {
  provider: ProviderId
  command: string | undefined
  checking: boolean
  onCheck: () => void
  onKey: (() => void) | undefined
}) {
  const link = 'h-auto p-0 font-medium text-foreground underline underline-offset-2 hover:no-underline'
  return (
    <div data-slot="reconnect-more" className="mt-2.5 flex flex-col gap-2 border-t border-dashed border-border pt-2.5 text-xs">
      <button type="button" data-action="reconnect-check" disabled={checking} onClick={onCheck} className={cn(link, 'self-start disabled:opacity-50')}>
        Already signed in? Check again
      </button>
      {onKey ? (
        <button type="button" data-action="reconnect-key" onClick={onKey} className={cn(link, 'self-start')}>
          Sign in with an API key instead
        </button>
      ) : null}
      {/* Global settings sit outside every project scope — react-router's own Link. */}
      <GlobalLink to="/settings/global/accounts" className={cn(link, 'self-start')}>Open Settings → Agent accounts</GlobalLink>
      {command ? <CommandLine command={command} label={`Last resort, on the machine running cezar (${agentName(provider)}):`} /> : null}
    </div>
  )
}

function SwitchAccount({ provider, profileId, profiles, kind, onSwitch }: {
  provider: ProviderId
  profileId: string
  profiles: readonly AgentProfile[]
  kind: 'manager' | 'task'
  onSwitch: (profileId: string) => Promise<unknown>
}) {
  const [busy, setBusy] = useState(false)
  const addAccount = useAddAccount()
  const mine = profiles.filter((row) => row.provider === provider && !row.pending)
  const others = mine.filter((row) => row.id !== profileId)
  const canAdd = addAccount?.capable.includes(provider) ?? false
  if (others.length === 0 && !canAdd) return null
  const usable = (row: AgentProfile) => row.status?.status !== 'disconnected' && row.status?.status !== 'not-installed'
  const healthy = others.find((row) => row.status?.status === 'connected') ?? others.find(usable)
  const go = (id: string) => {
    setBusy(true)
    onSwitch(id)
      .catch((error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'danger' }))
      .finally(() => setBusy(false))
  }
  return (
    <span data-slot="reconnect-switch" className="inline-flex">
      {healthy ? (
        <Button type="button" variant="outline" size="sm" data-action="reconnect-switch" disabled={busy} className="rounded-r-none border-r-0" onClick={() => go(healthy.id)}>
          Use {healthy.label} instead
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="sm" aria-label={healthy ? 'Accounts to switch to' : undefined} disabled={busy} className={cn(healthy && 'rounded-l-none px-1.5')}>
            {healthy ? null : 'Use another account'}
            <ChevronDownIcon aria-hidden="true" className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-60">
          <DropdownMenuLabel className="text-micro tracking-[.06em] text-soft-foreground uppercase">Accounts this {kind} may use</DropdownMenuLabel>
          {mine.map((row) => {
            const state = row.id === profileId ? 'disconnected' : row.status?.status
            return (
              <DropdownMenuItem key={row.id} data-account={row.id} disabled={row.id === profileId || !usable(row)} onSelect={() => go(row.id)}>
                <RunnerMark provider={provider} small />
                {agentName(provider)} · {row.label}
                {state === 'connected' ? <span className={cn(PILL, 'ml-auto border-success/35 bg-success/10 text-success-strong')}>Signed in</span>
                  : state === 'disconnected' ? <span className={cn(PILL, 'ml-auto border-danger/35 bg-danger/10 text-danger-strong')}>Signed out</span>
                    : state === 'not-installed' ? <span className={cn(PILL, 'ml-auto')}>Not installed</span> : null}
              </DropdownMenuItem>
            )
          })}
          {canAdd && addAccount ? (
            <DropdownMenuItem data-action="reconnect-add-account" onSelect={() => addAccount.open({ provider, onAdded: (profile) => go(profile.id) })}>
              Add an account…
            </DropdownMenuItem>
          ) : null}
          <p className="px-2 py-1.5 text-micro text-soft-foreground">
            {kind === 'task'
              ? 'Switching account starts a fresh session; the task keeps its worktree and changes.'
              : 'The manager keeps its memory; the next turn starts a fresh transcript.'}
          </p>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  )
}

function ResumedList({ account, resumed: all, compact }: { account: string; resumed: ReconnectResumed; compact: boolean }) {
  const ownId = useReconnectSurface()?.ownId
  const resumed: ReconnectResumed = {
    runs: all.runs.filter((run) => run.runId !== ownId),
    managers: all.managers.filter((manager) => manager.managerId !== ownId),
  }
  const count = resumed.runs.length + resumed.managers.length
  if (count === 0) return null
  if (compact) {
    return (
      <p data-slot="reconnect-resumed" className="mt-2.5 flex items-center gap-1.5 text-micro text-soft-foreground">
        <Spinner className="size-2.5" />
        Also resuming on {account}: {plural(resumed.runs.length, 'task')}{resumed.runs.length && resumed.managers.length ? ' · ' : ''}{plural(resumed.managers.length, 'manager')}
      </p>
    )
  }
  return (
    <div data-slot="reconnect-resumed" className="mt-2.5 flex flex-col gap-2 border-t border-dashed border-border pt-2.5 text-xs">
      <p>Also resuming on {account}:</p>
      <ul className="flex flex-col gap-1">
        {resumed.runs.map((run) => (
          <li key={`${run.projectId}/${run.runId}`} className="flex items-center gap-2">
            <Spinner className="size-2.5" />
            <GlobalLink to={`/p/${encodeURIComponent(run.projectId)}/tasks/${encodeURIComponent(run.runId)}`} className="underline underline-offset-2">Task “{run.title}”</GlobalLink>
          </li>
        ))}
        {resumed.managers.map((manager) => (
          <li key={manager.managerId} className="flex items-center gap-2">
            <Spinner className="size-2.5" />
            <GlobalLink to={`/manager/${encodeURIComponent(manager.managerId)}`} className="underline underline-offset-2">Manager “{manager.title}”</GlobalLink>
            <span className="text-soft-foreground">· chat turn</span>
          </li>
        ))}
      </ul>
      <p className="text-micro text-soft-foreground">Watch checks run on their next tick.</p>
    </div>
  )
}

const plural = (count: number, noun: string): string => (count === 0 ? '' : `${count} ${noun}${count === 1 ? '' : 's'}`)
