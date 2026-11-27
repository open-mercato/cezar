import { ChevronDownIcon, ExternalLinkIcon, PanelRightIcon, PlusIcon } from 'lucide-react'
import { Fragment, useCallback, useEffect, useState } from 'react'

import { getRunTerminalUrls } from '@/api/client'
import type { DetectedUrlEntry, DiscoveredCommandsResponse } from '@open-mercato/cezar-api-client'
import { StatusDot } from '@/components/status-dot'
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

import type { TerminalScope } from './terminal-scope'

/**
 * The two strips the terminal drawer wears above its tabs (spec
 * `.ai/specs/2026-10-07-task-workspace.md` §6 and §7): the addresses this task's shells printed,
 * and the commands its project defines.
 *
 * Neither does anything on its own. A detected address opens only when the user clicks
 * `Open in Browser` or `Open Preview`, and a discovered command runs only when the user picks it — both are
 * the spec's explicit rules, and both are why these are lists rather than automations.
 */

/** How often the detected-address strip re-probes. Each refresh is one TCP connect per address
 *  on the server, and a server coming up is something a user waits a second or two for anyway. */
const URL_REFRESH_MS = 3_000

/** The defined commands' groups, in the order the server sends them: yours, then the repo's. */
const CONFIGURED_GROUPS = [
  { scope: 'personal', label: 'Your commands' },
  { scope: 'project', label: 'From the repo config' },
] as const

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
      <span className="text-label text-muted-foreground">Detected addresses</span>
      {urls.map((entry) => (
        <span
          key={entry.url}
          data-slot="detected-url"
          data-running={entry.running === true ? '' : undefined}
          className="flex items-center gap-1.5 rounded-sm bg-muted/60 py-0.5 pr-0.5 pl-2 text-xs"
        >
          {/* Three states, not two: `null` is "not probed yet", which is not the same claim as
              "nothing is listening". The design system's dot: green = the check passed. */}
          <StatusDot
            aria-hidden="true"
            data-probe={entry.running === true ? 'running' : entry.running === false ? 'down' : 'unknown'}
            tone={entry.running === true ? 'success' : 'neutral'}
            className={cn(entry.running === null && 'opacity-50')}
          />
          <span className="font-mono">{entry.url}</span>
          <span className="text-soft-foreground">
            {entry.running === true ? 'running' : entry.running === false ? 'not responding' : '…'}
          </span>
          {/* Two destinations, both named on the control: the user's own browser (a new tab; the
              desktop shell hands `_blank` to the default browser), and the task's Preview. */}
          <Button
            asChild
            variant="ghost"
            size="xs"
            className="h-auto px-1.5 py-0.5 text-[length:inherit] hover:bg-background"
          >
            <a href={entry.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${entry.url} in Browser`}>
              <ExternalLinkIcon aria-hidden="true" className="size-3" />
              <span>Open in Browser</span>
            </a>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label={`Open ${entry.url} in Preview`}
            onClick={() => setNoRoom(!onOpen(entry.url))}
            className="h-auto px-1.5 py-0.5 text-[length:inherit] hover:bg-background"
          >
            <PanelRightIcon aria-hidden="true" className="size-3" />
            <span>Open Preview</span>
          </Button>
        </span>
      ))}
      {noRoom ? (
        <span className="text-xs text-muted-foreground">
          No room to open it here — this layout has three columns, or its Preview is out of tabs.
        </span>
      ) : null}
    </div>
  )
}

/**
 * The chevron beside `+` (#1554): `+` itself opens an empty terminal in one click, and this menu
 * holds everything secondary, in labelled sections — another shell, the project's defined
 * commands (#1555), the ones detected from `package.json` / a Makefile, and a typed command.
 *
 * With nothing defined the menu offers what it always offered: detected commands and a custom
 * line. A command always runs in a NEW tab of this scope's own tree (spec §6).
 */
export function NewTerminalMenu({
  scope,
  shells,
  onNew,
  onRun,
}: {
  /** Whose commands: a task's worktree or the project root. */
  scope: Pick<TerminalScope, 'commands'>
  /** The host's shells, default first; the menu offers the others by name. */
  shells: string[]
  /** Opens an empty terminal, in `shell` when one is named. */
  onNew: (shell?: string) => void
  /** Runs the command in a NEW terminal tab (spec §6) — never in the one you are looking at. */
  onRun: (command: string) => void
}) {
  const [state, setState] = useState<DiscoveredCommandsResponse | null>(null)
  const [manual, setManual] = useState('')

  const load = useCallback(() => {
    void scope.commands()
      .then(setState)
      .catch(() => {})
  }, [scope])

  const configured = state?.configured ?? []
  const detected = state?.commands ?? []

  return (
    <DropdownMenu onOpenChange={(open) => open && load()}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="More terminal options"
          title="Other shell, project commands, custom command"
          className="rounded"
        >
          <ChevronDownIcon aria-hidden="true" className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-96 w-80 overflow-y-auto">
        <DropdownMenuItem data-slot="empty-terminal" onSelect={() => onNew()}>
          <PlusIcon aria-hidden="true" className="size-3.5" />
          Empty terminal
        </DropdownMenuItem>
        {shells.length > 1 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Shell</DropdownMenuLabel>
            {shells.map((shell, index) => (
              <DropdownMenuItem key={shell} data-shell={shell} onSelect={() => onNew(shell)}>
                <span className="truncate font-mono text-xs">{shell}</span>
                {index === 0 ? <span className="ml-auto shrink-0 text-xs text-soft-foreground">default</span> : null}
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
        {/* Yours and the repo's apart (#1555 review): a repo-config command arrived with the
            checkout, so the menu must not let it pass for one you saved yourself. */}
        {CONFIGURED_GROUPS.map(({ scope: group, label }) => {
          const entries = configured.filter((entry) => entry.scope === group)
          if (entries.length === 0) return null
          return (
            <Fragment key={group}>
              <DropdownMenuSeparator />
              <DropdownMenuLabel data-slot="configured-group" data-scope={group}>{label}</DropdownMenuLabel>
              {entries.map((entry) => (
                <DropdownMenuItem
                  key={`${entry.scope}:${entry.command}`}
                  data-slot="configured-command"
                  data-scope={entry.scope}
                  onSelect={() => onRun(entry.command)}
                  className="flex-col items-start gap-0"
                >
                  <span className="text-xs">{entry.name}</span>
                  <span className="font-mono text-meta text-soft-foreground">{entry.command}</span>
                </DropdownMenuItem>
              ))}
            </Fragment>
          )
        })}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Detected commands</DropdownMenuLabel>
        {detected.length === 0 ? (
          <p className="px-2 py-1.5 text-label text-muted-foreground">
            No commands found in package.json or a Makefile.
          </p>
        ) : (
          detected.map((entry) => (
            <DropdownMenuItem
              key={`${entry.source}:${entry.command}`}
              onSelect={() => onRun(entry.command)}
              className="flex-col items-start gap-0"
            >
              <span className="font-mono text-xs">{entry.command}</span>
              {/* The source file travels with the command: `dev` means one thing in a Makefile
                  and another in npm, and you are about to hand a shell one of them. */}
              <span className="text-meta text-soft-foreground">
                {entry.source}
                {entry.detail ? ` — ${entry.detail}` : ''}
              </span>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Custom command</DropdownMenuLabel>
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
            className="h-8 px-2 font-mono text-xs shadow-none focus-visible:ring-0 md:text-xs"
          />
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
