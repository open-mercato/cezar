import { CheckIcon, ExternalLinkIcon } from 'lucide-react'
import * as React from 'react'

import type { AgentSetupEntry, AgentSetupProvider, AgentSetupSession } from '@open-mercato/cezar-api-client'

import { useAgentSetup, useInvalidateHealth, useProviderStatus, useRefreshProviderStatus, useStartAgentSetup } from '@/api/queries'
import { SetupTerminal } from '@/components/agent-setup'
import { ReconnectCard } from '@/components/reconnect/reconnect-card'
import { TERMINAL_ONLY } from '@/components/reconnect/copy'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { toast } from '@/components/ui/toaster'
import { installMethodLabel, type AgentRowAction } from '@/lib/agent-setup'
import { writeClipboard } from '@/lib/clipboard'
import { isPhone } from '@/lib/phone-app'
import { providerStatusFor } from '@/lib/provider-status'
import { PROVIDER_LABELS } from '@/lib/provider-auth-alert'

/**
 * Install, update or sign in to one agent, from wherever its row is greyed out (spec
 * `.ai/specs/2026-11-25-agent-cli-install-and-update.md`): confirm the exact command, run it in the
 * setup terminal, then sign in. A command cezar does not run is shown with Copy and the docs link.
 */

export type AgentSetupSheetAction = 'install' | 'update' | 'sign-in'

type Phase = 'confirm' | 'waiting' | 'running' | 'sign-in' | 'done' | 'failed'

const SIGN_IN_POLL_MS = 3_000
const WAIT_POLL_MS = 5_000

export function AgentSetupSheet({
  provider,
  action,
  open,
  onOpenChange,
}: {
  provider: AgentSetupProvider
  action: AgentSetupSheetAction
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const phone = React.useMemo(() => isPhone(), [])
  const title = `${action === 'install' ? 'Install' : action === 'update' ? 'Update' : 'Sign in to'} ${PROVIDER_LABELS[provider]}`
  const body = open ? <AgentSetupFlow provider={provider} action={action} onClose={() => onOpenChange(false)} /> : null
  if (phone) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" data-slot="agent-setup-sheet" className="max-h-[92dvh] overflow-y-auto rounded-t-2xl px-4 pt-3 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <div aria-hidden="true" className="mx-auto mb-3 h-1 w-9 rounded-full bg-muted" />
          <SheetTitle className="text-base">{title}</SheetTitle>
          <SheetDescription className="sr-only">{title} on your computer.</SheetDescription>
          {body}
        </SheetContent>
      </Sheet>
    )
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-slot="agent-setup-sheet" className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription className="sr-only">{title} on this computer.</DialogDescription>
        {body}
      </DialogContent>
    </Dialog>
  )
}

export function AgentSetupFlow({ provider, action, onClose }: { provider: AgentSetupProvider; action: AgentSetupSheetAction; onClose: () => void }) {
  const setup = useAgentSetup()
  const status = useProviderStatus()
  const refresh = useRefreshProviderStatus()
  const start = useStartAgentSetup()
  const invalidateHealth = useInvalidateHealth()
  const label = PROVIDER_LABELS[provider]
  // The page that opened the sheet may already know the newest release; never asked from here.
  const looked = useAgentSetup({ latest: true, enabled: false }).data?.agents.find((agent) => agent.provider === provider)
  const listed = setup.data?.agents.find((agent) => agent.provider === provider)
  const entry = listed && looked?.latestVersion && looked.version === listed.version
    ? { ...listed, latestVersion: looked.latestVersion }
    : listed
  const available = setup.data?.available === true
  const interactive = setup.data?.available === true && setup.data.interactive
  const session = setup.data?.session ?? null
  const row = providerStatusFor(status.data, provider)

  const [phase, setPhase] = React.useState<Phase>(action === 'sign-in' ? 'sign-in' : 'confirm')
  // The wait lives in this sheet: closing it mid-wait must say the update did not start (#2474 review).
  const phaseNow = React.useRef(phase)
  phaseNow.current = phase
  React.useEffect(() => () => {
    if (phaseNow.current === 'waiting') toast(`${PROVIDER_LABELS[provider]} was not updated: the sheet closed while it waited for tasks.`)
  }, [provider])
  const [failure, setFailure] = React.useState<string | null>(null)
  const [shown, setShown] = React.useState<AgentSetupSession | null>(null)
  const [updatedTo, setUpdatedTo] = React.useState<string | null>(null)
  const refreshMutate = refresh.mutate
  const refreshAsync = refresh.mutateAsync

  // A session for this agent already running (a reload, another tab) is rejoined, not restarted.
  React.useEffect(() => {
    if (session && session.provider === provider && session.exitCode === null && phase === 'confirm') {
      setShown(session)
      setPhase(session.action === 'login' ? 'sign-in' : 'running')
    }
  }, [phase, provider, session])
  React.useEffect(() => {
    if (session && shown && session.id === shown.id) setShown(session)
  }, [session, shown])

  // `mutate` is stable; the mutation object is not, and depending on it re-fired the wait below.
  const startMutate = start.mutate
  const run = React.useCallback(
    (kind: 'install' | 'update' | 'login', force?: boolean) => {
      setFailure(null)
      startMutate(
        { provider, action: kind, ...(force ? { force } : {}) },
        {
          onSuccess: (next) => {
            setShown(next)
            setPhase(kind === 'login' ? 'sign-in' : 'running')
          },
          onError: (error: Error) => {
            setFailure(error.message)
            setPhase(kind === 'login' ? 'sign-in' : 'failed')
          },
        },
      )
    },
    [provider, startMutate],
  )

  // "Update when they finish": ask until no task runs on this agent, then start it exactly once.
  const refetchSetup = setup.refetch
  const waitFired = React.useRef(false)
  React.useEffect(() => {
    if (phase !== 'waiting') {
      waitFired.current = false
      return
    }
    if (entry?.activeRuns === 0) {
      if (waitFired.current) return
      waitFired.current = true
      run('update')
      return
    }
    const timer = window.setInterval(() => void refetchSetup(), WAIT_POLL_MS)
    return () => window.clearInterval(timer)
  }, [entry?.activeRuns, phase, refetchSetup, run])

  // An install or update that ended: the status, read now, says what it achieved.
  const settled = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (!shown || shown.action === 'login' || shown.exitCode === null || settled.current === shown.id) return
    settled.current = shown.id
    invalidateHealth()
    if (shown.exitCode !== 0) {
      void refetchSetup()
      setFailure(`${label} did not ${shown.action === 'install' ? 'install' : 'update'}. The terminal says why.`)
      setPhase('failed')
      return
    }
    if (shown.action === 'update') {
      // The version the agent reports now, read after the server re-probed it, not before.
      void refetchSetup().then((next) => {
        setUpdatedTo(next.data?.agents.find((agent) => agent.provider === provider)?.version ?? null)
        setPhase('done')
      })
      return
    }
    void refetchSetup()
    void refreshAsync().then(
      (next) => {
        const now = next.providers.find((candidate) => candidate.provider === provider)
        if (now?.status === 'connected') return setPhase('done')
        if (now && now.status !== 'not-installed') return setPhase('sign-in')
        setFailure(`${label} installed, but cezar cannot find it. Restart cezar from a new terminal, or check that the install folder is on your PATH.`)
        setPhase('failed')
      },
      () => {
        setFailure('cezar could not check the agent. Try again.')
        setPhase('failed')
      },
    )
  }, [invalidateHealth, label, provider, refetchSetup, refreshAsync, shown])

  // Nothing tells the page a sign-in landed: ask until it does.
  React.useEffect(() => {
    if (phase !== 'sign-in') return
    const timer = window.setInterval(() => refreshMutate(), SIGN_IN_POLL_MS)
    return () => window.clearInterval(timer)
  }, [phase, refreshMutate])
  React.useEffect(() => {
    if (phase === 'sign-in' && row?.status === 'connected') setPhase('done')
  }, [phase, row?.status])

  if (setup.isPending) return <p className="flex items-center gap-2 py-6 text-ui text-muted-foreground"><Spinner /> Checking this computer…</p>
  if (!entry) return <p className="py-4 text-ui text-danger">The agent could not be checked. Try again.</p>

  return (
    <div data-slot="agent-setup-flow" data-phase={phase} data-provider={provider} className="mt-2 flex flex-col gap-3">
      <Steps action={action} phase={phase} entry={entry} />
      {phase === 'confirm' || phase === 'waiting' ? (
        <Confirm
          entry={entry}
          action={action === 'update' ? 'update' : 'install'}
          available={available}
          interactive={interactive}
          reason={setup.data?.reason ?? null}
          waiting={phase === 'waiting'}
          busy={start.isPending}
          onRun={(force) => run(action === 'update' ? 'update' : 'install', force)}
          onWait={() => setPhase('waiting')}
          onCancel={onClose}
        />
      ) : null}
      {(phase === 'running' || (phase === 'failed' && shown)) && shown && shown.action !== 'login' ? (
        <SetupTerminal key={shown.id} session={shown} running={shown.exitCode === null} installing={shown.action === 'install'} />
      ) : null}
      {phase === 'running' ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-ui text-soft-foreground">{interactive ? 'Closing this keeps it running; open it again to rejoin.' : 'The log is read-only on your phone.'}</p>
          <Button size="sm" variant="outline" className="font-normal" onClick={onClose}>Run in background</Button>
        </div>
      ) : null}
      {phase === 'sign-in' ? (
        <SignIn provider={provider} entry={entry} interactive={interactive && available} session={shown?.action === 'login' ? shown : null} failure={failure} busy={start.isPending} onTerminal={() => run('login')} onCheck={() => refreshMutate()} />
      ) : null}
      {phase === 'failed' ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p role="alert" className="min-w-0 flex-1 text-ui text-danger">{failure}</p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="font-normal" onClick={onClose}>Close</Button>
            <Button size="sm" className="font-normal" disabled={start.isPending} onClick={() => { setShown(null); setPhase('confirm') }}>Try again</Button>
          </div>
        </div>
      ) : null}
      {phase === 'done' ? (
        <div role="status" className="flex items-center justify-between gap-3 rounded-md border border-success/30 bg-success/5 px-3 py-2.5">
          <p className="flex items-center gap-2 text-ui text-foreground">
            <CheckIcon aria-hidden="true" className="size-4 text-success-strong" />
            {action === 'update'
              ? updatedTo ? `${label} is updated. It reports ${updatedTo} now.` : `${label} is updated.`
              : `${label} is ready.`}
          </p>
          <Button size="sm" className="font-normal" onClick={onClose}>Done</Button>
        </div>
      ) : null}
    </div>
  )
}

function Steps({ action, phase, entry }: { action: AgentSetupSheetAction; phase: Phase; entry: AgentSetupEntry }) {
  const order: Phase[] = ['confirm', 'running', 'sign-in', 'done']
  const at = Math.max(0, order.indexOf(phase === 'waiting' ? 'confirm' : phase === 'failed' ? 'running' : phase))
  const steps = action === 'update'
    ? [['confirm', 'Confirm'], ['running', 'Update'], ['done', 'Done']]
    : action === 'sign-in'
      ? [['sign-in', 'Sign in'], ['done', 'Done']]
      : [['confirm', 'Confirm'], ['running', entry.install.runnable ? 'Install' : 'Install yourself'], ['sign-in', 'Sign in'], ['done', 'Done']]
  return (
    <ol aria-label="Steps" className="flex flex-wrap gap-x-4 gap-y-1 text-meta text-muted-foreground">
      {steps.map(([id, text]) => {
        const index = order.indexOf(id as Phase)
        const state = index < at || phase === 'done' ? 'done' : index === at ? 'current' : 'todo'
        return (
          <li key={id} data-state={state} aria-current={state === 'current' ? 'step' : undefined} className={state === 'current' ? 'font-medium text-foreground' : state === 'done' ? 'text-success-strong' : ''}>
            {state === 'done' ? '✓ ' : ''}{text}
          </li>
        )
      })}
    </ol>
  )
}

function Confirm({
  entry,
  action,
  available,
  interactive,
  reason,
  waiting,
  busy,
  onRun,
  onWait,
  onCancel,
}: {
  entry: AgentSetupEntry
  action: 'install' | 'update'
  available: boolean
  interactive: boolean
  reason: string | null
  waiting: boolean
  busy: boolean
  onRun: (force?: boolean) => void
  onWait: () => void
  onCancel: () => void
}) {
  const plan = action === 'install' ? entry.install : entry.update
  const command = plan?.command ?? null
  const phoneBlocked = !interactive && plan?.sudo === true
  const canRun = available && plan?.runnable === true && command !== null && !phoneBlocked
  const method = installMethodLabel(action === 'update' ? entry.method : entry.install.method)
  const label = PROVIDER_LABELS[entry.provider]
  const why = !plan?.runnable
    ? entry.copyOnlyReason ?? (command
      ? 'cezar has not verified this command against the vendor’s docs yet, so it shows it for you to run.'
      : action === 'update'
        ? `cezar cannot tell how this copy of ${label} was installed, so it has no update to run. Update it the way you installed it; the vendor’s page shows how.`
        : 'cezar does not know this installer yet. The vendor’s page shows how to install it.')
    : !available
      ? reason
      : phoneBlocked
        ? 'This needs your computer password, so it has to finish on your computer.'
        : null
  return (
    <div className="flex flex-col gap-3">
      <p className="text-ui text-muted-foreground">
        {canRun
          ? interactive
            ? 'cezar runs this on this computer, in your home folder, with your user account.'
            : 'This runs on your computer, with your user account.'
          : command
            ? 'Run this in a terminal on the computer running cezar.'
            : action === 'update'
              ? `Update ${label} on the computer running cezar, the way it was installed.`
              : 'Install it on the computer running cezar, following the vendor’s steps.'}
      </p>
      {command ? <CommandBox command={command} /> : null}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-meta">
        {method ? (<><dt className="text-muted-foreground">{action === 'update' ? 'Installed via' : 'Method'}</dt><dd>{method}</dd></>) : null}
        {entry.version ? (<><dt className="text-muted-foreground">Installed</dt><dd className="font-mono">{entry.version}</dd></>) : null}
        {entry.latestVersion ? (<><dt className="text-muted-foreground">Latest</dt><dd className="font-mono">{entry.latestVersion}</dd></>) : null}
        {entry.minVersion ? (<><dt className="text-muted-foreground">cezar needs</dt><dd className="font-mono">{entry.minVersion} or newer</dd></>) : null}
      </dl>
      {why ? <p data-slot="agent-setup-why" className="rounded-md border border-pending/40 bg-pending/5 px-3 py-2 text-ui text-foreground">{why}</p> : null}
      {canRun && plan?.sudo ? <p className="text-ui text-soft-foreground">It asks for your computer password in the terminal below.</p> : null}
      {action === 'update' && entry.activeRuns > 0 && canRun ? (
        <p data-slot="agent-setup-active-runs" className="rounded-md border border-pending/40 bg-pending/5 px-3 py-2 text-ui text-foreground">
          {entry.activeRuns} task{entry.activeRuns === 1 ? ' is' : 's are'} running on {label}. Updating now can interrupt
          {entry.method === 'npm' ? ' them, because npm replaces the files in place.' : ' a task that starts the CLI again.'}
        </p>
      ) : null}
      {action === 'update' && entry.autoUpdates ? <p className="text-meta text-soft-foreground">{label} also updates itself; this does it sooner.</p> : null}
      {waiting ? (
        <p data-slot="agent-setup-waiting" role="status" className="text-ui text-soft-foreground">
          Keep this open: the update starts here once the tasks finish. Closing it cancels the wait.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <a href={entry.docsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-meta text-foreground underline underline-offset-2">
          Official docs <ExternalLinkIcon aria-hidden="true" className="size-3" />
        </a>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" className="font-normal" onClick={onCancel}>{canRun ? 'Cancel' : 'Close'}</Button>
          {canRun && action === 'update' && entry.activeRuns > 0 ? (
            <>
              <Button size="sm" variant="outline" className="font-normal" disabled={busy} onClick={() => onRun(true)}>Update now</Button>
              <Button size="sm" className="font-normal" disabled={busy || waiting} onClick={onWait}>
                {waiting ? (<><Spinner /> Waiting for tasks…</>) : 'Update when they finish'}
              </Button>
            </>
          ) : canRun ? (
            <Button size="sm" className="font-normal" disabled={busy} onClick={() => onRun()}>
              {busy ? <Spinner /> : null}
              {action === 'update' ? 'Update' : 'Install'}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function SignIn({
  provider,
  entry,
  interactive,
  session,
  failure,
  busy,
  onTerminal,
  onCheck,
}: {
  provider: AgentSetupProvider
  entry: AgentSetupEntry
  interactive: boolean
  session: AgentSetupSession | null
  failure: string | null
  busy: boolean
  onTerminal: () => void
  onCheck: () => void
}) {
  if (!TERMINAL_ONLY.has(provider)) return <ReconnectCard provider={provider} profileId="default" place="attention" inSheet compact={!interactive} />
  if (session) return <SetupTerminal key={session.id} session={session} running={session.exitCode === null} installing={false} />
  // No headless sign-in (spec 2026-11-18): a terminal here, or the computer.
  return (
    <div data-slot="agent-setup-terminal-sign-in" className="flex flex-col gap-2">
      <p className="text-ui text-muted-foreground">
        {interactive
          ? `${PROVIDER_LABELS[provider]} signs in from its own terminal. Open one here and follow it.`
          : `${PROVIDER_LABELS[provider]} signs in from a terminal on your computer. Finish on your computer; this updates by itself.`}
      </p>
      {entry.loginCommand ? <CommandBox command={entry.loginCommand} /> : null}
      {failure ? <p role="alert" className="text-ui text-danger">{failure}</p> : null}
      <div className="flex flex-wrap gap-2">
        {interactive ? (
          <Button size="sm" className="font-normal" disabled={busy || entry.loginCommand === null} onClick={onTerminal}>Open terminal here</Button>
        ) : (
          <span data-slot="agent-setup-finish-on-computer" className="text-ui font-medium text-foreground">Finish on my computer</span>
        )}
        <Button size="sm" variant="outline" className="font-normal" onClick={onCheck}>Check again</Button>
      </div>
    </div>
  )
}

function CommandBox({ command }: { command: string }) {
  const copy = async () => {
    try {
      await writeClipboard(command)
      toast('Command copied')
    } catch {
      toast('Could not copy the command', { tone: 'danger' })
    }
  }
  return (
    <div data-slot="agent-setup-command" className="flex items-center gap-2 rounded-md border border-border bg-card-2 px-3 py-2">
      <code className="min-w-0 flex-1 break-all font-mono text-meta text-foreground">{command}</code>
      <Button size="sm" variant="ghost" className="shrink-0 font-normal" onClick={() => void copy()}>Copy</Button>
    </div>
  )
}

/** One sheet per surface, opened from any row's action. */
export function useAgentSetupSheet() {
  const [target, setTarget] = React.useState<{ provider: AgentSetupProvider; action: AgentSetupSheetAction } | null>(null)
  const open = React.useCallback((provider: AgentSetupProvider, action: AgentRowAction) => {
    setTarget({ provider, action: action === 'sign-in' ? 'sign-in' : action === 'update' ? 'update' : 'install' })
  }, [])
  const element = target ? (
    <AgentSetupSheet provider={target.provider} action={target.action} open onOpenChange={(next) => { if (!next) setTarget(null) }} />
  ) : null
  return { open, element }
}
