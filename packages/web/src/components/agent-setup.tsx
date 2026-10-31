import { ExternalLinkIcon, LoaderCircleIcon } from 'lucide-react'
import * as React from 'react'

import { cancelAgentSetup, readAgentSetup, resizeAgentSetup, writeAgentSetup } from '@/api/client'
import { useCancelAgentSetup, useInvalidateHealth, useRefreshProviderStatus, useStartAgentSetup } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { agentSetupListRows, signInUrl, type AgentSetupListRow } from '@/lib/agent-setup'
import { PROVIDER_LABELS } from '@/lib/provider-auth-alert'
import { TerminalPane, type TerminalIo } from '@/routes/task-workspace/terminal-pane'
import type { AgentSetupAction, AgentSetupProvider, AgentSetupSession, AgentSetupState, ProviderStatusResponse } from '@open-mercato/cezar-api-client'

/**
 * Install an agent and sign in to it, here (spec 2026-10-26-first-run-onboarding, "Set up an agent
 * here"). An install that exits 0 goes straight on to the login; a login that lands moves the page
 * on by itself, because `FirstRun` reads the same provider status. Every other exit stops with a
 * sentence and Try again.
 */

const LOGIN_POLL_MS = 3_000
const LOGIN_POLL_TICKS = 60
const IDLE_POLL_MS = 10_000
/** Enough for the end of a login's output: a sign-in link is printed near where the login waits. */
const OUTPUT_KEPT = 16_384

interface Stopped {
  provider: AgentSetupProvider
  action: AgentSetupAction
  message: string
}

export function agentSetupHeading(setup: Extract<AgentSetupState, { available: true }>, status: ProviderStatusResponse | undefined): string {
  return agentSetupListRows(setup, status).some((row) => row.state === 'signed-out') ? 'Sign in to an agent' : 'Pick your agent'
}

export function AgentSetupList({
  setup,
  status,
}: {
  setup: Extract<AgentSetupState, { available: true }>
  status: ProviderStatusResponse | undefined
}) {
  const onHealthChanged = useInvalidateHealth()
  const start = useStartAgentSetup()
  const cancel = useCancelAgentSetup()
  const refresh = useRefreshProviderStatus()
  const refreshAsync = refresh.mutateAsync
  const refreshMutate = refresh.mutate
  const rows = agentSetupListRows(setup, status)

  // Kept after the server forgets it (a minute after the exit): the screen is what explains a failure.
  const [shown, setShown] = React.useState<AgentSetupSession | null>(setup.session)
  const [stopped, setStopped] = React.useState<Stopped | null>(null)
  const session = setup.session
  React.useEffect(() => {
    if (session) setShown(session)
  }, [session])
  // Seen on the server and now gone while still running: killed elsewhere, or cezar restarted.
  const seen = React.useRef<string | null>(null)
  if (session) seen.current = session.id
  React.useEffect(() => {
    if (session || !shown || shown.exitCode !== null || seen.current !== shown.id) return
    setStopped({ provider: shown.provider, action: shown.action, message: 'The terminal closed before it finished.' })
    setShown(null)
  }, [session, shown])

  const startMutate = start.mutate
  const begin = React.useCallback(
    (provider: AgentSetupProvider, action: AgentSetupAction) => {
      setStopped(null)
      startMutate(
        { provider, action },
        {
          onSuccess: (next) => setShown(next),
          onError: (error: Error) => {
            setStopped({ provider, action, message: error.message })
            refreshMutate()
          },
        },
      )
    },
    [refreshMutate, startMutate],
  )

  // What a finished session means is decided once per session, against a status that is true now.
  const settled = React.useRef<string | null>(null)
  const exitCode = session?.exitCode ?? null
  React.useEffect(() => {
    if (!session || exitCode === null || settled.current === session.id) return
    settled.current = session.id
    const { provider, action } = session
    const label = PROVIDER_LABELS[provider]
    if (action === 'install') onHealthChanged()
    if (action === 'install' && exitCode !== 0) {
      setStopped({ provider, action, message: `${label} did not install. The terminal says why.` })
      return
    }
    void refreshAsync().then(
      (next) => {
        const row = next.providers.find((candidate) => candidate.provider === provider)
        if (row?.status === 'connected') return
        if (action === 'login') {
          setStopped({ provider, action, message: `The sign-in to ${label} did not finish.` })
        } else if (!row || row.status === 'not-installed') {
          setStopped({ provider, action, message: `${label} installed, but cezar cannot find it. Restart cezar from a new terminal, or check that npm’s global folder is on your PATH.` })
        } else {
          begin(provider, 'login')
        }
      },
      () => setStopped({ provider, action, message: 'cezar could not check the agent. Try again.' }),
    )
  }, [begin, exitCode, onHealthChanged, refreshAsync, session])

  const running = shown !== null && shown.exitCode === null
  const installing = running && shown?.action === 'install'
  const signingIn = running && shown?.action === 'login'

  // Nothing in the page learns of a login by itself, so ask until it lands. Not during an install:
  // the row must not change under a terminal that is still working.
  React.useEffect(() => {
    if (!signingIn) return
    let ticks = 0
    const timer = window.setInterval(() => {
      ticks += 1
      if (ticks > LOGIN_POLL_TICKS) window.clearInterval(timer)
      else refreshMutate()
    }, LOGIN_POLL_MS)
    return () => window.clearInterval(timer)
  }, [refreshMutate, signingIn])
  // Someone may install and sign in from their own terminal instead.
  React.useEffect(() => {
    if (running) return
    const timer = window.setInterval(() => refreshMutate(), IDLE_POLL_MS)
    return () => window.clearInterval(timer)
  }, [refreshMutate, running])

  // A login nobody is watching just waits forever; an install keeps going and is rejoined on return.
  // Decided a tick later: StrictMode's simulated remount must not kill the login a reload rejoined.
  const watchedLogin = React.useRef<string | null>(null)
  watchedLogin.current = signingIn && shown ? shown.id : null
  const mounted = React.useRef(false)
  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      const login = watchedLogin.current
      window.setTimeout(() => {
        if (!mounted.current && login) void cancelAgentSetup(login).catch(() => {})
      }, 0)
    }
  }, [])

  const close = () => {
    setStopped(null)
    if (shown && running) cancel.mutate(shown.id)
    setShown(null)
  }

  return (
    <div className="mt-7 flex w-full flex-col gap-3 text-left">
      {rows.map((row) => {
        const open = shown?.provider === row.provider
        const rowStopped = stopped?.provider === row.provider ? stopped : null
        const busy = running || start.isPending
        return (
          <div key={row.provider} data-slot="agent-row" data-state={row.state} data-provider={row.provider} className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-4">
              <div className="min-w-0 flex-1">
                <div className="text-lead text-foreground">{row.label}</div>
                <div className="text-ui text-muted-foreground">{row.state === 'missing' ? row.description : 'Installed, not signed in'}</div>
              </div>
              <RowAction row={row} open={open} busy={busy} onStart={begin} />
            </div>
            {!open && !rowStopped && row.state === 'missing' && row.installCommand === null ? <p className="mt-3 text-ui text-soft-foreground">{row.installHint}</p> : null}
            {!open && !rowStopped && row.state === 'missing' && row.installCommand ? <CommandLine command={row.installCommand} /> : null}
            {open && shown ? <SetupTerminal key={shown.id} session={shown} running={running} installing={installing} /> : null}
            {rowStopped ? (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <p role="alert" className="min-w-0 flex-1 text-ui text-danger">
                  {rowStopped.message}
                </p>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" className="font-normal" onClick={close}>
                    Close
                  </Button>
                  <Button size="sm" className="font-normal" disabled={start.isPending} onClick={() => begin(rowStopped.provider, rowStopped.action)}>
                    Try again
                  </Button>
                </div>
              </div>
            ) : null}
            {open && running ? (
              <div className="mt-3 flex items-center justify-between gap-3">
                <p className="text-ui text-soft-foreground">{installing ? 'Sign-in comes next.' : 'This page continues by itself.'}</p>
                <Button size="sm" variant="outline" className="font-normal" onClick={close}>
                  Cancel
                </Button>
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function RowAction({
  row,
  open,
  busy,
  onStart,
}: {
  row: AgentSetupListRow
  open: boolean
  busy: boolean
  onStart: (provider: AgentSetupProvider, action: AgentSetupAction) => void
}) {
  if (open) return null
  if (row.state === 'signed-out') {
    return (
      <Button className="font-normal" disabled={busy || row.loginCommand === null} onClick={() => onStart(row.provider, 'login')}>
        Sign in
      </Button>
    )
  }
  if (row.installCommand === null) return null
  return (
    <Button className="font-normal" disabled={busy} onClick={() => onStart(row.provider, 'install')}>
      Install
    </Button>
  )
}

/** Nothing runs on this machine that the user could not read first. */
function CommandLine({ command }: { command: string }) {
  return (
    <code className="mt-3 block truncate font-mono text-meta text-soft-foreground" title={command}>
      <span className="select-none">$ </span>
      {command}
    </code>
  )
}

function SetupTerminal({ session, running, installing }: { session: AgentSetupSession; running: boolean; installing: boolean }) {
  const [link, setLink] = React.useState<string | null>(null)
  const id = session.id
  const output = React.useRef('')
  const login = session.action === 'login'
  const io = React.useMemo<TerminalIo>(
    () => ({
      read: async (cursor) => {
        const read = await readAgentSetup(id, cursor)
        if (login && read.data) {
          output.current = (output.current + read.data).slice(-OUTPUT_KEPT)
          setLink(signInUrl(output.current))
        }
        return read
      },
      write: (data) => writeAgentSetup(id, data),
      resize: (cols, rows) => resizeAgentSetup(id, cols, rows),
    }),
    [id, login],
  )
  // Once it has exited there is one read left, and after a minute the session is gone: no bell, no poll.
  const paneSession = React.useMemo(
    () => ({ id, exitCode: running ? null : session.exitCode, topic: running ? session.topic : null }),
    [id, running, session.exitCode, session.topic],
  )
  const label = PROVIDER_LABELS[session.provider]
  return (
    <div data-slot="agent-setup-terminal" className="mt-3 flex flex-col gap-2">
      {running ? (
        <p role="status" className="flex items-center gap-2 text-ui text-muted-foreground">
          <LoaderCircleIcon className="size-3.5 shrink-0 motion-safe:animate-spin" aria-hidden="true" />
          {installing
            ? session.command.startsWith('sudo ')
              ? `Installing ${label}. Click the terminal and type your computer password if it asks.`
              : `Installing ${label}…`
            : `Sign in to ${label}. Click the terminal to answer its questions.`}
        </p>
      ) : null}
      <CommandLine command={session.command} />
      <div className="relative h-72 overflow-hidden rounded-lg border border-border bg-card-2">
        <TerminalPane runId={session.runId} session={paneSession} active io={io} />
      </div>
      {login && link && running ? (
        <Button asChild size="sm" variant="outline" className="self-start font-normal">
          <a href={link} target="_blank" rel="noopener noreferrer">
            Open sign-in page
            <ExternalLinkIcon aria-hidden="true" />
          </a>
        </Button>
      ) : null}
    </div>
  )
}
