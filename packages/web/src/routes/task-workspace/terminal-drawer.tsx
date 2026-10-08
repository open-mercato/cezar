import { Loader2Icon, PlusIcon, SquareIcon, XIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { createRunTerminal, getRunTerminal, stopRunTerminal, writeRunTerminal } from '@/api/client'
import { useHealth } from '@/api/queries'
import type { TerminalSession } from '@open-mercato/cezar-api-client'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import {
  DRAWER_HEIGHT_STEP,
  DRAWER_HEIGHT_STEP_LARGE,
  MAX_DRAWER_HEIGHT,
  MIN_DRAWER_HEIGHT,
  clampDrawerHeight,
} from './drawer-state'
import { CommandPicker, DetectedUrlsStrip } from './terminal-extras'
import { TerminalPane } from './terminal-pane'

/**
 * The bottom terminal drawer (spec `.ai/specs/2026-10-07-task-workspace.md` §6).
 *
 * Several tabs, each its own PTY session in this task's worktree, shared by every saved layout —
 * the drawer belongs to the TASK, not to a layout, so switching layouts keeps the same shells.
 *
 * Tab names come from the SERVER, which reads them off the process table rather than from what
 * was typed (`server/terminal/foreground.ts`). That is also where `busy` comes from, so the name
 * on a tab and the warning you get for closing it can never disagree.
 */

/** How often the tab strip re-reads labels and busy flags. The output itself does not wait for
 *  this — each pane streams on its own — so this only has to be quick enough that a tab renames
 *  itself promptly when a command starts. */
const STATE_REFRESH_MS = 2_000

export function TerminalDrawer({
  runId,
  height,
  onHeightChange,
  onClose,
  onOpenInBrowser,
}: {
  runId: string
  height: number
  onHeightChange: (height: number) => void
  onClose: () => void
  /** Opens a detected address in a Browser column (spec §7). Returns false when the layout had
   *  no room, so the strip can say so. */
  onOpenInBrowser: (url: string) => boolean
}) {
  const [sessions, setSessions] = useState<TerminalSession[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const [starting, setStarting] = useState(true)
  /** The tab a close is waiting on, because something is running in it (spec §6). */
  const [confirming, setConfirming] = useState<TerminalSession | null>(null)

  // Who this shell belongs to (spec §6). The HOST is the authority this cockpit is served from —
  // the machine the PTY actually runs on, which is the fact a worktree path cannot convey — and
  // the PROJECT is the repository root's own folder name, the way the rest of the cockpit names
  // a project. Both degrade to something honest rather than blank.
  const health = useHealth()
  const hostLabel = typeof window === 'undefined' ? 'ten host' : window.location.host
  const repoRoot = health.data?.repo?.root ?? health.data?.repoRoot ?? ''
  const projectLabel = repoRoot.split(/[\\/]/).filter(Boolean).pop() ?? 'projekt'

  // Opening the drawer reattaches to whatever this task already has, and creates a shell only
  // when it has none (spec §6) — reopening must never lose a running build, and must never
  // quietly fork a second shell beside it.
  useEffect(() => {
    let cancelled = false
    setStarting(true)
    setUnavailable(null)
    setSessions([])
    setActiveId(null)

    void (async () => {
      try {
        const state = await getRunTerminal(runId)
        if (cancelled) return
        if (!state.available) {
          setUnavailable(state.reason ?? 'Terminal nie jest dostępny w tym cockpicie.')
          return
        }
        // LIVE sessions only decide whether this task already has tabs. A shell that exited on
        // its own is kept server-side for a minute so a still-polling client can read its last
        // line and exit code — useful while the drawer is open, but reattaching a freshly opened
        // drawer to nothing but corpses would show the user a dead pane and no shell. Spec §6:
        // "if it has no tabs, create a fresh terminal session".
        const existing = state.sessions.filter((session) => session.exitCode === null)
        const live = existing.length > 0 ? existing : [await createRunTerminal(runId, {})]
        if (cancelled) return
        setSessions(live)
        setActiveId(live[0]?.id ?? null)
      } catch (error) {
        if (!cancelled) setUnavailable(error instanceof Error ? error.message : String(error))
      } finally {
        if (!cancelled) setStarting(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [runId])

  // Keep labels and busy flags current. Deliberately a poll rather than a socket topic: this is
  // the strip's chrome, it changes at human speed, and it must work on a hosted cockpit, which
  // opens no WebSocket at all.
  useEffect(() => {
    if (unavailable || starting) return
    let active = true
    const timer = setInterval(() => {
      void getRunTerminal(runId)
        .then((state) => {
          if (!active || !state.available) return
          setSessions(state.sessions)
          // A session the server has forgotten (exited, then reaped) must not keep a tab.
          setActiveId((current) =>
            current && state.sessions.some((entry) => entry.id === current)
              ? current
              : (state.sessions[0]?.id ?? null),
          )
        })
        .catch(() => {})
    }, STATE_REFRESH_MS)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [runId, starting, unavailable])

  const addTab = useCallback(() => {
    void createRunTerminal(runId, {})
      .then((session) => {
        setSessions((current) => [...current, session])
        setActiveId(session.id)
      })
      .catch((error: unknown) => {
        setUnavailable(error instanceof Error ? error.message : String(error))
      })
  }, [runId])

  /**
   * `Ctrl/Cmd + Shift + \`` opens another tab (spec §6: "Add a tab with a `+` button or a
   * keyboard shortcut") — VS Code's own binding for the same act, which is the terminal strip
   * this drawer is modelled on.
   *
   * Shift is what keeps it off the shell's own keyboard: a bare Ctrl-key combination belongs to
   * the program running in the PTY, and intercepting one would make this drawer a worse terminal
   * than the one it embeds.
   */
  useEffect(() => {
    if (unavailable) return
    const onKey = (event: KeyboardEvent) => {
      if (!event.shiftKey || !(event.ctrlKey || event.metaKey)) return
      if (event.code !== 'Backquote') return
      event.preventDefault()
      addTab()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [addTab, unavailable])

  /** Close a tab and stop its process tree. The last tab closing hides the drawer (spec §6). */
  const closeTab = useCallback(
    (session: TerminalSession) => {
      setConfirming(null)
      void stopRunTerminal(runId, session.id).catch(() => {})
      setSessions((current) => {
        const index = current.findIndex((entry) => entry.id === session.id)
        const remaining = current.filter((entry) => entry.id !== session.id)
        if (remaining.length === 0) onClose()
        // The tab to the right, or the previous one when there is none — the grammar the layout
        // cards use, and the one every editor uses.
        else if (index >= 0) {
          setActiveId((active) =>
            active === session.id ? (remaining[Math.min(index, remaining.length - 1)]?.id ?? null) : active,
          )
        }
        return remaining
      })
    },
    [onClose, runId],
  )

  /**
   * Run a discovered (or typed) command in a NEW tab — never in the one being looked at.
   *
   * The spec is explicit that a selected command runs in a new terminal tab, and the reason is
   * worth stating: the tab you are looking at may be mid-build, and a command typed into it
   * would either queue behind that or interleave with it.
   */
  const runCommand = useCallback(
    (command: string) => {
      void createRunTerminal(runId, {})
        .then(async (session) => {
          setSessions((current) => [...current, session])
          setActiveId(session.id)
          await writeRunTerminal(runId, session.id, `${command}\r`)
        })
        .catch(() => {})
    },
    [runId],
  )

  const active = sessions.find((entry) => entry.id === activeId) ?? null

  return (
    <section
      data-slot="terminal-drawer"
      aria-label="Terminal"
      className="relative flex shrink-0 flex-col border-t border-border bg-background"
      style={{ height: `${height}px` }}
    >
      <DrawerResizeHandle height={height} onHeightChange={onHeightChange} />

      {unavailable ? null : <DetectedUrlsStrip runId={runId} onOpen={onOpenInBrowser} />}

      <header className="flex h-8 shrink-0 items-center gap-1 border-b border-border pl-1 pr-2">
        <div
          role="tablist"
          aria-label="Zakładki terminala"
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
        >
          {sessions.map((session) => (
            <TerminalTab
              key={session.id}
              session={session}
              active={session.id === activeId}
              onSelect={() => setActiveId(session.id)}
              onClose={() => (session.busy ? setConfirming(session) : closeTab(session))}
            />
          ))}
          {unavailable ? null : (
            <button
              type="button"
              aria-label="Nowa zakładka terminala"
              title="Nowa zakładka terminala"
              onClick={addTab}
              className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <PlusIcon aria-hidden="true" className="size-3.5" />
            </button>
          )}
        </div>

        {active ? (
          // HOST · PROJECT · WORKTREE, stated (spec §6: terminal input "must be explicitly
          // user-initiated and clearly identify host, project and worktree"). A shell that does
          // not say whose machine it is typing on is a trap — the worktree path alone reads the
          // same whether this cockpit is localhost or a VPS.
          //
          // CAPPED, because the path is long and the tab strip shares this row with it: an
          // uncapped `shrink` takes its content width as its basis, which pushed every tab after
          // the first out of view on a real path. The title carries the whole thing.
          <span className="hidden max-w-[34%] shrink lg:block" title={`${hostLabel} · ${projectLabel} · ${active.cwd}`}>
            <span className="block truncate text-[11px] text-soft-foreground">
              <span className="text-muted-foreground">{hostLabel}</span>
              {' · '}
              {projectLabel}
              {' · '}
              {active.cwd}
            </span>
          </span>
        ) : null}
        {unavailable ? null : <CommandPicker runId={runId} onRun={runCommand} />}
        {active?.busy ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 px-2 text-xs"
            // Spec §6: "Stop interrupts; the tab's X closes." Ctrl-C down the PTY, and nothing
            // else — stopping a command is not the same act as closing a terminal, and you stop
            // a build precisely so you can read in that same pane why it was wrong. No
            // confirmation, because an interrupt is cheap and recoverable; the tab's X is the
            // one that asks, because it takes the whole process tree.
            title="Przerwij polecenie (Ctrl-C)"
            onClick={() => void writeRunTerminal(runId, active.id, '\x03').catch(() => {})}
          >
            <SquareIcon aria-hidden="true" className="size-3" />
            Zatrzymaj
          </Button>
        ) : null}
        <button
          type="button"
          aria-label="Ukryj terminal"
          title="Ukryj terminal — procesy działają dalej"
          onClick={onClose}
          className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <XIcon aria-hidden="true" className="size-3.5" />
        </button>
      </header>

      {unavailable ? (
        // An honest empty state carrying the reason — never a terminal that looks real and does
        // nothing (spec §5.1).
        <p data-slot="terminal-unavailable" className="px-3 py-4 text-xs text-soft-foreground">
          {unavailable}
        </p>
      ) : starting ? (
        <p className="flex items-center gap-2 px-3 py-4 text-xs text-soft-foreground">
          <Loader2Icon aria-hidden="true" className="size-3.5 animate-spin" />
          Uruchamianie powłoki…
        </p>
      ) : (
        // Every pane stays MOUNTED and only the active one is shown. A tab is a live shell with a
        // screen full of scrollback; unmounting it to switch tabs would throw that screen away and
        // make every switch replay the whole buffer from the server.
        <div className="relative min-h-0 flex-1">
          {sessions.map((session) => (
            <TerminalPane key={session.id} runId={runId} session={session} active={session.id === activeId} />
          ))}
        </div>
      )}

      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>W tej zakładce coś działa</AlertDialogTitle>
            <AlertDialogDescription>
              {confirming ? `„${confirming.label}” wciąż działa. ` : ''}
              Zamknięcie zakładki zatrzyma ten proces i wszystko, co uruchomił.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Anuluj</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirming && closeTab(confirming)}>
              Zamknij mimo to
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

function TerminalTab({
  session,
  active,
  onSelect,
  onClose,
}: {
  session: TerminalSession
  active: boolean
  onSelect: () => void
  onClose: () => void
}) {
  return (
    <div
      data-slot="terminal-tab"
      data-active={active ? '' : undefined}
      className={cn(
        'group flex h-6 shrink-0 items-center rounded pl-2 pr-0.5 text-xs',
        active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onClick={onSelect}
        title={session.exitCode === null ? session.label : `${session.label} — zakończony (${session.exitCode})`}
        className="max-w-40 truncate outline-none focus-visible:underline"
      >
        {session.label}
      </button>
      <button
        type="button"
        aria-label={`Zamknij ${session.label}`}
        onClick={onClose}
        className={cn(
          'ml-1 grid size-4 shrink-0 place-items-center rounded opacity-0 transition-opacity hover:bg-background focus-visible:opacity-100 group-hover:opacity-100',
          active && 'opacity-60',
        )}
      >
        <XIcon aria-hidden="true" className="size-3" />
      </button>
    </div>
  )
}

/**
 * The drawer's top edge (spec §6: "Its top edge can be dragged to change drawer height").
 *
 * The same ARIA window-splitter pattern the sidebar's handle and the workspace's column dividers
 * use — a `separator` is the one role that is both focusable and carries a value range, so one
 * affordance serves a pointer and a keyboard. Horizontal here, so the keys that move it are Up
 * and Down, and dragging UP makes the drawer taller.
 */
function DrawerResizeHandle({
  height,
  onHeightChange,
}: {
  height: number
  onHeightChange: (height: number) => void
}) {
  const origin = useRef<{ y: number; height: number } | null>(null)

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    origin.current = { y: event.clientY, height }
    event.currentTarget.setPointerCapture(event.pointerId)
    // Without this the drag selects the text of whatever it passes over…
    event.preventDefault()
    // …and preventing the default also suppresses the focus the press would have given this
    // `tabIndex=0` element, leaving a mouse user unable to fine-tune with the arrows right after.
    event.currentTarget.focus()
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = origin.current
    if (!start) return
    onHeightChange(clampDrawerHeight(start.height - (event.clientY - start.y)))
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!origin.current) return
    origin.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? DRAWER_HEIGHT_STEP_LARGE : DRAWER_HEIGHT_STEP
    const next =
      event.key === 'ArrowUp'
        ? height + step
        : event.key === 'ArrowDown'
          ? height - step
          : event.key === 'Home'
            ? MAX_DRAWER_HEIGHT
            : event.key === 'End'
              ? MIN_DRAWER_HEIGHT
              : null
    if (next === null) return
    // Only for the keys we handled: Tab, Escape and the rest stay the browser's.
    event.preventDefault()
    onHeightChange(clampDrawerHeight(next))
  }

  return (
    <div
      data-slot="drawer-resize-handle"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Zmień wysokość terminala"
      aria-valuenow={height}
      aria-valuemin={MIN_DRAWER_HEIGHT}
      aria-valuemax={MAX_DRAWER_HEIGHT}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      title="Przeciągnij, by zmienić wysokość — strzałki regulują precyzyjnie"
      // A 5px grab strip straddling the top border, invisible until reached for. `touch-none` is
      // load-bearing: without it a touch drag is claimed by the browser's panning.
      className="absolute inset-x-0 -top-[3px] z-20 h-[5px] cursor-row-resize touch-none bg-transparent transition-colors hover:bg-violet/40 focus-visible:bg-violet/60 focus-visible:outline-none"
    />
  )
}
