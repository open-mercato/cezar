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
      className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1"
    >
      <span className="mr-1 text-[11px] text-soft-foreground">Wykryte adresy</span>
      {urls.map((entry) => (
        <span
          key={entry.url}
          data-slot="detected-url"
          data-running={entry.running === true ? '' : undefined}
          className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px]"
        >
          {/* Three states, not two: `null` is "not probed yet", which is not the same claim as
              "nothing is listening". */}
          <CircleIcon
            aria-hidden="true"
            className={cn(
              'size-2',
              entry.running === true
                ? 'fill-emerald-500 text-emerald-500'
                : entry.running === false
                  ? 'fill-muted text-muted-foreground'
                  : 'text-soft-foreground',
            )}
          />
          <span className="font-mono">{entry.url}</span>
          <span className="text-soft-foreground">
            {entry.running === true ? 'działa' : entry.running === false ? 'nie odpowiada' : '…'}
          </span>
          <button
            type="button"
            title="Otwórz w Przeglądarce"
            aria-label={`Otwórz ${entry.url} w Przeglądarce`}
            onClick={() => setNoRoom(!onOpen(entry.url))}
            className="ml-0.5 grid size-4 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ExternalLinkIcon aria-hidden="true" className="size-3" />
          </button>
        </span>
      ))}
      {noRoom ? (
        <span className="text-[11px] text-soft-foreground">
          Układ ma już trzy kolumny — zamknij jedną, by otworzyć Przeglądarkę.
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
          Uruchom
          <ChevronDownIcon aria-hidden="true" className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 w-80 overflow-y-auto">
        <DropdownMenuLabel>Polecenia z projektu</DropdownMenuLabel>
        {commands.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-soft-foreground">
            Nie znaleziono poleceń w package.json ani Makefile. Wpisz własne poniżej.
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
              <span className="text-[10px] text-soft-foreground">
                {entry.source}
                {entry.detail ? ` — ${entry.detail}` : ''}
              </span>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="font-normal text-soft-foreground">Własne polecenie</DropdownMenuLabel>
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
          <input
            value={manual}
            onChange={(event) => setManual(event.target.value)}
            // Radix would treat typing as menu type-ahead and steal the keystrokes.
            onKeyDown={(event) => event.stopPropagation()}
            placeholder="np. npm run dev"
            aria-label="Własne polecenie"
            spellCheck={false}
            className="w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs outline-none focus-visible:border-foreground"
          />
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
