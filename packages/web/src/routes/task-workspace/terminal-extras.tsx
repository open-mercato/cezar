import { ChevronDownIcon, CircleIcon, ExternalLinkIcon, PlayIcon } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { getRunTerminalCommands, getRunTerminalUrls } from '@/api/client'
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
import { cn } from '@/lib/utils'

/**
 * The two strips the terminal drawer wears above its tabs (spec
 * `.ai/specs/2026-10-07-task-workspace.md` §6 and §7): the addresses this task's shells printed,
 * and the commands its project defines.
 *
 * Neither does anything on its own. A detected address opens only when the user clicks
 * `Otwórz w Przeglądarce`, and a discovered command runs only when the user picks it — both are
 * the spec's explicit rules, and both are why these are lists rather than automations.
 */

/** How often the detected-address strip re-probes. Each refresh is one TCP connect per address
 *  on the server, and a server coming up is something a user waits a second or two for anyway. */
const URL_REFRESH_MS = 3_000

export function DetectedUrlsStrip({
  runId,
  onOpen,
}: {
  runId: string
  /** Opens the address in a Browser column. Returns false when the layout had no room for one,
   *  so the strip can say so instead of appearing to do nothing. */
  onOpen: (url: string) => boolean
}) {
  const [urls, setUrls] = useState<DetectedUrlEntry[]>([])
  const [noRoom, setNoRoom] = useState(false)

  useEffect(() => {
    let active = true
    const pull = () => {
      void getRunTerminalUrls(runId)
        .then((state) => {
          if (active) setUrls(state.urls)
        })
        .catch(() => {})
    }
    pull()
    const timer = setInterval(pull, URL_REFRESH_MS)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [runId])

  if (urls.length === 0) return null

  return (
    <div
      data-slot="detected-urls"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/70 px-3 py-1.5"
    >
      <span className="text-xs text-muted-foreground">Detected addresses</span>
      {urls.map((entry) => (
        <span
          key={entry.url}
          data-slot="detected-url"
          data-running={entry.running === true ? '' : undefined}
          className="flex items-center gap-1.5 rounded-sm bg-muted/60 py-0.5 pr-0.5 pl-2 text-xs"
        >
          {/* Three states, not two: `null` is "not probed yet", which is not the same claim as
              "nothing is listening". */}
          <CircleIcon
            aria-hidden="true"
            className={cn(
              'size-2',
              entry.running === true
                ? 'fill-success text-success'
                : entry.running === false
                  ? 'fill-muted text-muted-foreground'
                  : 'text-soft-foreground',
            )}
          />
          <span className="font-mono">{entry.url}</span>
          <span className="text-soft-foreground">
            {entry.running === true ? 'running' : entry.running === false ? 'not responding' : '…'}
          </span>
          {/* §7 names this control literally — "The user clicks `Otwórz w Przeglądarce`" — so the
              words are on it, not only in its tooltip. An icon alone was discoverable by hover
              and by screen reader, and invisible to everyone reading the strip. */}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label={`Open ${entry.url} in Browser`}
            onClick={() => setNoRoom(!onOpen(entry.url))}
            className="h-auto px-1.5 py-0.5 text-[length:inherit] hover:bg-background"
          >
            <ExternalLinkIcon aria-hidden="true" className="size-3" />
            <span>Open in Browser</span>
          </Button>
        </span>
      ))}
      {noRoom ? (
        <span className="text-xs text-muted-foreground">
          This layout already has three columns — close one to open the Browser.
        </span>
      ) : null}
    </div>
  )
}

export function CommandPicker({
  runId,
  onRun,
}: {
  runId: string
  /** Runs the command in a NEW terminal tab (spec §6) — never in the one you are looking at. */
  onRun: (command: string) => void
}) {
  const [commands, setCommands] = useState<DiscoveredCommandEntry[]>([])
  const [manual, setManual] = useState('')

  const load = useCallback(() => {
    void getRunTerminalCommands(runId)
      .then((state) => setCommands(state.commands))
      .catch(() => {})
  }, [runId])

  return (
    <DropdownMenu onOpenChange={(open) => open && load()}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-6 shrink-0 px-2 text-xs text-muted-foreground">
          <PlayIcon aria-hidden="true" className="size-3" />
          Run
          <ChevronDownIcon aria-hidden="true" className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 w-80 overflow-y-auto">
        <DropdownMenuLabel>Project commands</DropdownMenuLabel>
        {commands.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-soft-foreground">
            No commands found in package.json or a Makefile. Type your own below.
          </p>
        ) : (
          commands.map((entry) => (
            <DropdownMenuItem
              key={`${entry.source}:${entry.command}`}
              onSelect={() => onRun(entry.command)}
              className="flex-col items-start gap-0"
            >
              <span className="font-mono text-xs">{entry.command}</span>
              {/* The source file travels with the command: `dev` means one thing in a Makefile
                  and another in npm, and you are about to hand a shell one of them. */}
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
            const command = manual.trim()
            if (command === '') return
            setManual('')
            onRun(command)
          }}
        >
          <Input
            value={manual}
            onChange={(event) => setManual(event.target.value)}
            // Radix would treat typing as menu type-ahead and steal the keystrokes.
            onKeyDown={(event) => event.stopPropagation()}
            placeholder="e.g. npm run dev"
            aria-label="Custom command"
            spellCheck={false}
            className="h-8 px-2 font-mono text-xs shadow-none focus-visible:ring-0 md:text-xs dark:bg-card"
          />
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
