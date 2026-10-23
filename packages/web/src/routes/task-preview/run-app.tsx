import { ChevronDownIcon, LoaderCircleIcon, PencilIcon, PlayIcon, TerminalIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { createRunTerminal, getRunTerminal, getRunTerminalCommands, getRunTerminalUrls, writeRunTerminal } from '@/api/client'
import type {
  DetectedUrlEntry,
  DiscoveredCommandEntry,
  EffectiveStartApp,
  WorktreeLifecycleProjection,
} from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'

import { StartAppEditor } from './start-app-editor'

/** How often the started app is looked for, and how long before the panel stops waiting. */
const POLL_MS = 1000
const GIVE_UP_MS = 120_000
/** An install can take minutes on its own. */
const GIVE_UP_INSTALLING_MS = 600_000

/** The script names that start an app, best first. */
const START_SCRIPTS = ['dev', 'start', 'serve', 'preview', 'run']

/** The command this browser last started the app with, per project — a convenience, never config. */
export const rememberedCommandKey = (projectId: string | null) => `cez:preview-run:${projectId ?? 'default'}`

function readRemembered(projectId: string | null): string | null {
  try {
    return window.localStorage.getItem(rememberedCommandKey(projectId))
  } catch {
    return null
  }
}

function remember(projectId: string | null, command: string): void {
  try {
    window.localStorage.setItem(rememberedCommandKey(projectId), command)
  } catch {
    // No storage: the suggestion is rediscovered next time.
  }
}

/** The discovered command most likely to start the app: `npm run dev`, then `start`, `serve`… */
export function suggestCommand(commands: readonly DiscoveredCommandEntry[]): string | null {
  for (const name of START_SCRIPTS) {
    const hit = commands.find((entry) => new RegExp(`^(npm run|make) ${name}$`).test(entry.command))
    if (hit) return hit.command
  }
  return null
}

/** `localhost` and `127.0.0.1` are the same machine; a printed address uses either. */
function sameOrigin(a: string, b: string): boolean {
  try {
    const left = new URL(a)
    const right = new URL(b)
    const host = (url: URL) => (url.hostname === '127.0.0.1' || url.hostname === '[::1]' ? 'localhost' : url.hostname)
    const port = (url: URL) => url.port || (url.protocol === 'https:' ? '443' : '80')
    return left.protocol === right.protocol && host(left) === host(right) && port(left) === port(right)
  } catch {
    return false
  }
}

/**
 * The address to open, once the app is up: printed after the start and not known to be down.
 * With a recipe's `url`, that address — once something on its origin has printed.
 */
export function startedAddress(urls: readonly DetectedUrlEntry[], since: number, wanted?: string): string | null {
  const fresh = urls.filter((entry) => Date.parse(entry.lastSeenAt) >= since && entry.running !== false)
  if (wanted) return fresh.some((entry) => sameOrigin(entry.url, wanted)) ? wanted : null
  return (fresh.find((entry) => entry.running === true) ?? fresh[0])?.url ?? null
}

interface Plan {
  services: string[]
  url?: string
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'installing'; install: string; plan: Plan }
  | { kind: 'starting'; plan: Plan }
  | { kind: 'exited'; command: string; code: number }
  | { kind: 'no-address'; plan: Plan }
  | { kind: 'failed' }

/**
 * An empty Preview tab's way to the task's app (spec `2026-10-09-design-mode` §7b–7c): the
 * project's start recipe when it has one, else a discovered start command. Each service runs in
 * its own terminal tab of the task; the address the app prints opens here.
 */
export function RunAppPanel({
  runId,
  projectId,
  onOpen,
  onShowTerminal,
  setup,
}: {
  runId: string
  projectId: string | null
  onOpen: (url: string) => void
  onShowTerminal?: () => void
  /** The task worktree's lifecycle (#1495): its setup scripts prepare it, so the app waits for them. */
  setup?: WorktreeLifecycleProjection
}) {
  // The same reading the task's status pill makes (`deriveAttention`).
  const setupFailed = setup?.phase === 'setup' && setup.needsAttention
  const setupRunning = setup?.phase === 'setup' && !setup.needsAttention && setup.activeOperationId !== undefined
  const [commands, setCommands] = useState<DiscoveredCommandEntry[] | null>(null)
  const [install, setInstall] = useState<string | null>(null)
  const [recipe, setRecipe] = useState<EffectiveStartApp | null>(null)
  const [remembered, setRemembered] = useState(() => readRemembered(projectId))
  const [custom, setCustom] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [editing, setEditing] = useState(false)

  const load = useCallback(() => {
    let cancelled = false
    void getRunTerminalCommands(runId)
      .then((state) => {
        if (cancelled) return
        setCommands(state.commands)
        setInstall(state.install ?? null)
        setRecipe(state.recipe ?? null)
      })
      .catch(() => !cancelled && setCommands([]))
    return () => {
      cancelled = true
    }
  }, [runId])
  useEffect(() => load(), [load])

  const suggested = remembered ?? (commands ? suggestCommand(commands) : null)

  // The current attempt: a newer one (or leaving the tab) makes every pending step of an older
  // one a no-op.
  const attemptRef = useRef<object | null>(null)
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([])
  useEffect(
    () => () => {
      attemptRef.current = null
      for (const timer of timers.current) clearTimeout(timer)
    },
    [],
  )

  const start = useCallback(
    (plan: Plan, options: { remember?: boolean } = {}) => {
      const services = plan.services.map((command) => command.trim()).filter(Boolean)
      if (services.length === 0) return
      const attempt = {}
      attemptRef.current = attempt
      const live = () => attemptRef.current === attempt
      const wait = (fn: () => void) => timers.current.push(setTimeout(fn, POLL_MS))
      const ready: Plan = { services, ...(plan.url ? { url: plan.url } : {}) }
      if (options.remember && services[0]) {
        remember(projectId, services[0])
        setRemembered(services[0])
      }

      const exitOf = async (sessionIds: readonly string[]) => {
        const state = await getRunTerminal(runId).catch(() => null)
        for (const [index, id] of sessionIds.entries()) {
          const code = state?.sessions.find((entry) => entry.id === id)?.exitCode
          if (code !== undefined && code !== null) return { index, code }
        }
        return null
      }

      const runServices = async () => {
        setPhase({ kind: 'starting', plan: ready })
        // A second of slack: the address is stamped by the server's clock, not this one.
        const since = Date.now() - 1000
        const ids: string[] = []
        for (const command of services) {
          const session = await createRunTerminal(runId, {})
          if (!live()) return
          ids.push(session.id)
          await writeRunTerminal(runId, session.id, `${command}\r`)
        }
        const poll = async () => {
          if (!live()) return
          if (Date.now() - since > GIVE_UP_MS) {
            setPhase({ kind: 'no-address', plan: ready })
            return
          }
          const urls = await getRunTerminalUrls(runId).catch(() => null)
          if (!live()) return
          const address = urls ? startedAddress(urls.urls, since, ready.url) : null
          if (address) {
            attemptRef.current = null
            onOpen(address)
            return
          }
          const exited = await exitOf(ids)
          if (!live()) return
          if (exited) {
            setPhase({ kind: 'exited', command: services[exited.index]!, code: exited.code })
            return
          }
          wait(() => void poll())
        }
        await poll()
      }

      const run = async () => {
        if (!install) return runServices()
        // Dependencies first, in a tab of their own that closes with the install's own status —
        // every service waits for it, which one shell running `install && service` could not do.
        setPhase({ kind: 'installing', install, plan: ready })
        const since = Date.now()
        const session = await createRunTerminal(runId, {})
        if (!live()) return
        await writeRunTerminal(runId, session.id, `${install} && exit 0 || exit 1\r`)
        const poll = async () => {
          if (!live()) return
          if (Date.now() - since > GIVE_UP_INSTALLING_MS) {
            setPhase({ kind: 'no-address', plan: ready })
            return
          }
          const exited = await exitOf([session.id])
          if (!live()) return
          if (!exited) return wait(() => void poll())
          if (exited.code !== 0) {
            setPhase({ kind: 'exited', command: install, code: exited.code })
            return
          }
          setInstall(null)
          await runServices()
        }
        wait(() => void poll())
      }

      void run().catch(() => {
        if (live()) setPhase({ kind: 'failed' })
      })
    },
    [install, onOpen, projectId, runId],
  )

  const others = (commands ?? []).filter((entry) => recipe !== null || entry.command !== suggested)
  const showTerminal = onShowTerminal ? (
    <Button type="button" variant="outline" size="sm" onClick={onShowTerminal}>
      <TerminalIcon aria-hidden="true" />
      Show terminal
    </Button>
  ) : null
  const editor = (
    <StartAppEditor
      open={editing}
      onOpenChange={setEditing}
      suggestion={recipe ? { services: recipe.services, ...(recipe.url ? { url: recipe.url } : {}) } : { services: suggested ? [suggested] : [''] }}
      onSaved={load}
    />
  )

  if (phase.kind === 'installing' || phase.kind === 'starting') {
    const what = phase.plan.services.join(' · ')
    return (
      <Shell
        icon={<LoaderCircleIcon aria-hidden="true" className="size-5 motion-safe:animate-spin" />}
        title={phase.kind === 'installing' ? `Installing dependencies (${phase.install})` : `Starting ${what}`}
        subtitle={
          phase.kind === 'installing'
            ? `This worktree has no dependencies yet. ${what} starts as soon as they are installed.`
            : `Running in ${phase.plan.services.length > 1 ? 'new terminal tabs' : 'a new terminal tab'} of this task. The page opens here as soon as the app is up${phase.plan.url ? ` at ${phase.plan.url}` : ''}.`
        }
      >
        {showTerminal}
      </Shell>
    )
  }

  const outcome =
    phase.kind === 'exited'
      ? `${phase.command} exited with code ${phase.code} before the app was up.`
      : phase.kind === 'no-address'
        ? `${phase.plan.services.join(' · ')} is still running, but ${phase.plan.url ? `nothing answered at ${phase.plan.url}` : 'printed no address'} yet. Enter it above, or check the terminal.`
        : phase.kind === 'failed'
          ? 'Could not open a terminal for this task.'
          : null

  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={recipe || suggested ? 'outline' : 'primary'}
          size="sm"
          data-action="run-app-other"
          disabled={setupRunning}
        >
          {recipe || suggested ? 'Other command' : 'Choose a command'}
          <ChevronDownIcon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="max-h-80 w-80 overflow-y-auto">
        <DropdownMenuLabel>Project commands</DropdownMenuLabel>
        {others.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-soft-foreground">
            {commands === null ? 'Looking…' : 'No other commands in package.json or a Makefile.'}
          </p>
        ) : (
          others.map((entry) => (
            <DropdownMenuItem
              key={`${entry.source}:${entry.command}`}
              onSelect={() => start({ services: [entry.command] }, { remember: true })}
              className="flex-col items-start gap-0"
            >
              <span className="font-mono text-xs">{entry.command}</span>
              <span className="text-[11px] text-soft-foreground">
                {entry.source}
                {entry.detail ? ` — ${entry.detail}` : ''}
              </span>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="font-normal text-soft-foreground">Custom command</DropdownMenuLabel>
        <form
          className="px-2 pb-1"
          onSubmit={(event) => {
            event.preventDefault()
            start({ services: [custom] }, { remember: true })
            setCustom('')
          }}
        >
          <Input
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
            // Radix would treat typing as menu type-ahead and steal the keystrokes.
            onKeyDown={(event) => event.stopPropagation()}
            placeholder="e.g. npm run dev"
            aria-label="Custom command"
            spellCheck={false}
            className="h-8 px-2 font-mono text-xs shadow-none focus-visible:ring-0 md:text-xs"
          />
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  const installNote = install ? ` Installs its dependencies first (${install}).` : ''
  const setupNote = setupRunning
    ? "This worktree's setup scripts are still running. Start the app when they finish."
    : setupFailed
      ? "This worktree's setup needs attention — retry it from the task's Chat, or start the app anyway."
      : null
  return (
    <Shell
      icon={<PlayIcon aria-hidden="true" className="size-5" />}
      title={recipe ? 'Start the app' : 'Run the app'}
      subtitle={
        outcome ??
        (recipe
          ? `${recipe.scope === 'personal' ? 'Your' : "This project's"} start recipe runs each service in its own terminal tab and opens ${recipe.url ?? 'the address it prints'}.${installNote}`
          : `Starts the task's app in a terminal of its worktree and opens the address it prints.${installNote} Or enter an address above.`)
      }
    >
      {setupNote ? (
        <p data-slot="run-app-setup" role="status" className="max-w-md text-xs text-foreground">
          {setupNote}
        </p>
      ) : null}
      {recipe ? (
        <ul data-slot="start-app-services" className="flex flex-col gap-0.5 font-mono text-xs text-foreground">
          {recipe.services.map((service, index) => (
            <li key={index}>{service}</li>
          ))}
        </ul>
      ) : null}
      <div data-slot="run-app-actions" className="flex flex-wrap items-center justify-center gap-2">
        {recipe ? (
          <Button type="button" size="sm" data-action="start-app" disabled={setupRunning} onClick={() => start(recipe)}>
            <PlayIcon aria-hidden="true" />
            Start app
          </Button>
        ) : suggested ? (
          <Button
            type="button"
            size="sm"
            data-action="run-app"
            disabled={setupRunning}
            onClick={() => start({ services: [suggested] }, { remember: true })}
          >
            <PlayIcon aria-hidden="true" />
            Run <code className="font-mono text-[12px]">{suggested}</code>
          </Button>
        ) : null}
        {menu}
        {outcome ? showTerminal : null}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        data-action="edit-start-app"
        className="text-muted-foreground"
        onClick={() => setEditing(true)}
      >
        <PencilIcon aria-hidden="true" />
        {recipe ? 'Edit start recipe' : 'Save a start recipe for this project'}
      </Button>
      {editor}
    </Shell>
  )
}

function Shell({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: React.ReactNode
  title: string
  subtitle: string
  children?: React.ReactNode
}) {
  return (
    <div
      data-slot="run-app"
      className="flex h-full flex-col items-center justify-center gap-3 px-6 py-8 text-center"
    >
      <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">{icon}</span>
      <div className="flex max-w-md flex-col gap-1">
        <h2 className="text-sm font-medium text-foreground">{title}</h2>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
      {children}
    </div>
  )
}
