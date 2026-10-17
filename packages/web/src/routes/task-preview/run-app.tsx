import { ChevronDownIcon, LoaderCircleIcon, PlayIcon, TerminalIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { createRunTerminal, getRunTerminal, getRunTerminalCommands, getRunTerminalUrls, writeRunTerminal } from '@/api/client'
import type { DetectedUrlEntry, DiscoveredCommandEntry } from '@open-mercato/cezar-api-client'
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

/** How often the started app is looked for, and how long before the panel stops waiting. */
const POLL_MS = 1000
const GIVE_UP_MS = 120_000

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

/** The address the started app printed: seen after it was started, and not known to be down. */
export function startedAddress(urls: readonly DetectedUrlEntry[], since: number): string | null {
  const fresh = urls.filter((entry) => Date.parse(entry.lastSeenAt) >= since && entry.running !== false)
  return (fresh.find((entry) => entry.running === true) ?? fresh[0])?.url ?? null
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting'; command: string; sessionId: string | null }
  | { kind: 'exited'; command: string; code: number }
  | { kind: 'no-address'; command: string }
  | { kind: 'failed'; command: string }

/**
 * An empty Preview tab's way to the task's app: run its start command in a new terminal tab of
 * the task, wait for the address it prints, and open it here. The command is discovered from
 * `package.json` / a `Makefile`, and the one that worked is remembered for the next task.
 */
export function RunAppPanel({
  runId,
  projectId,
  onOpen,
  onShowTerminal,
}: {
  runId: string
  projectId: string | null
  onOpen: (url: string) => void
  onShowTerminal?: () => void
}) {
  const [commands, setCommands] = useState<DiscoveredCommandEntry[] | null>(null)
  const [remembered, setRemembered] = useState(() => readRemembered(projectId))
  const [custom, setCustom] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })

  useEffect(() => {
    let cancelled = false
    void getRunTerminalCommands(runId)
      .then((state) => !cancelled && setCommands(state.commands))
      .catch(() => !cancelled && setCommands([]))
    return () => {
      cancelled = true
    }
  }, [runId])

  const suggested = remembered ?? (commands ? suggestCommand(commands) : null)

  // The wait: a fresh address opens the app; the command exiting, or nothing after two minutes,
  // says so instead of spinning forever.
  const waiting = useRef<{ since: number; timer: ReturnType<typeof setTimeout> | null } | null>(null)
  useEffect(
    () => () => {
      if (waiting.current?.timer) clearTimeout(waiting.current.timer)
      waiting.current = null
    },
    [],
  )

  const start = useCallback(
    (command: string) => {
      const trimmed = command.trim()
      if (trimmed === '') return
      if (waiting.current?.timer) clearTimeout(waiting.current.timer)
      // A second of slack: the address is stamped by the server's clock, not this one.
      const since = Date.now() - 1000
      const attempt = { since, timer: null as ReturnType<typeof setTimeout> | null }
      waiting.current = attempt
      setPhase({ kind: 'starting', command: trimmed, sessionId: null })
      remember(projectId, trimmed)
      setRemembered(trimmed)

      void createRunTerminal(runId, {})
        .then(async (session) => {
          if (waiting.current !== attempt) return
          setPhase({ kind: 'starting', command: trimmed, sessionId: session.id })
          await writeRunTerminal(runId, session.id, `${trimmed}\r`)
          const poll = async () => {
            if (waiting.current !== attempt) return
            if (Date.now() - since > GIVE_UP_MS) {
              setPhase({ kind: 'no-address', command: trimmed })
              return
            }
            const [urls, state] = await Promise.all([
              getRunTerminalUrls(runId).catch(() => null),
              getRunTerminal(runId).catch(() => null),
            ])
            if (waiting.current !== attempt) return
            const address = urls ? startedAddress(urls.urls, since) : null
            if (address) {
              waiting.current = null
              onOpen(address)
              return
            }
            const exitCode = state?.sessions.find((entry) => entry.id === session.id)?.exitCode
            if (exitCode !== undefined && exitCode !== null) {
              setPhase({ kind: 'exited', command: trimmed, code: exitCode })
              return
            }
            attempt.timer = setTimeout(() => void poll(), POLL_MS)
          }
          await poll()
        })
        .catch(() => {
          if (waiting.current === attempt) setPhase({ kind: 'failed', command: trimmed })
        })
    },
    [onOpen, projectId, runId],
  )

  const others = (commands ?? []).filter((entry) => entry.command !== suggested)
  const showTerminal = onShowTerminal ? (
    <Button type="button" variant="outline" size="sm" onClick={onShowTerminal}>
      <TerminalIcon aria-hidden="true" />
      Show terminal
    </Button>
  ) : null

  if (phase.kind === 'starting') {
    return (
      <Shell
        icon={<LoaderCircleIcon aria-hidden="true" className="size-5 motion-safe:animate-spin" />}
        title={`Starting ${phase.command}`}
        subtitle="Running in a new terminal tab of this task. The page opens here as soon as the app prints its address."
      >
        {showTerminal}
      </Shell>
    )
  }

  const outcome =
    phase.kind === 'exited'
      ? `${phase.command} exited with code ${phase.code} before printing an address.`
      : phase.kind === 'no-address'
        ? `${phase.command} is still running, but printed no address in two minutes. Enter it above, or check the terminal.`
        : phase.kind === 'failed'
          ? 'Could not open a terminal for this task.'
          : null

  return (
    <Shell
      icon={<PlayIcon aria-hidden="true" className="size-5" />}
      title="Run the app"
      subtitle={
        outcome ??
        "Starts the task's app in a terminal of its worktree and opens the address it prints. Or enter an address above."
      }
    >
      <div data-slot="run-app-actions" className="flex flex-wrap items-center justify-center gap-2">
        {suggested ? (
          <Button type="button" size="sm" data-action="run-app" onClick={() => start(suggested)}>
            <PlayIcon aria-hidden="true" />
            Run <code className="font-mono text-[12px]">{suggested}</code>
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant={suggested ? 'outline' : 'primary'} size="sm" data-action="run-app-other">
              {suggested ? 'Other command' : 'Choose a command'}
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
                  onSelect={() => start(entry.command)}
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
                start(custom)
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
        {outcome ? showTerminal : null}
      </div>
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
