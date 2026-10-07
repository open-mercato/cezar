import { Loader2Icon, SquareIcon, TerminalIcon, XIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  createRunTerminal,
  getRunTerminal,
  readRunTerminal,
  resizeRunTerminal,
  stopRunTerminal,
  writeRunTerminal,
} from '@/api/client'
import { useHostTransport } from '@/api/host-usage'
import { subscribeTopic } from '@/api/ws'
import type { TerminalSession } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import '@xterm/xterm/css/xterm.css'

/**
 * The bottom terminal drawer (spec `.ai/specs/2026-10-07-task-workspace.md` §6, Milestone 2).
 *
 * This is the first cut: ONE session per task, started explicitly, with the drawer hidden until
 * the user asks for it (§3 "Explicit actions" — starting a shell is never a side effect of
 * opening a view). Tabs, command-named tabs, a draggable height and URL detection come next;
 * none of them change the transport or the lifecycle this validates.
 *
 * TRANSPORT. Output is never pushed over the socket. On a local cockpit the session's topic wakes
 * us with a cursor and we read the bytes over authenticated HTTP; on a hosted one there is no
 * socket at all — a browser WebSocket cannot carry reverse-proxy credentials, which is why every
 * other WS consumer here is gated on `localHandoff` too — so the same read is polled. One code
 * path, one cursor, two clocks.
 */

/** How often a hosted cockpit asks for new output. Fast enough to feel live on a LAN, slow enough
 *  that an idle shell is not a request per frame. */
const POLL_MS = 400

/** Written into the screen when scrollback was dropped. Deliberately plain text rather than a
 *  dimmed ANSI sequence: this is the cockpit talking, and it must not be mistakable for — or
 *  corrupt the state of — the program that is writing. */
const TRUNCATION_NOTICE = '\r\n[... wcześniejsze wyjście wypadło ze scrollbacku ...]\r\n'

export function TerminalDrawer({ runId, onClose }: { runId: string; onClose: () => void }) {
  const transport = useHostTransport()
  const hostRef = useRef<HTMLDivElement>(null)
  const [session, setSession] = useState<TerminalSession | null>(null)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const [starting, setStarting] = useState(true)
  const [exited, setExited] = useState<number | null>(null)
  /**
   * The emulator is mounted and can be written to.
   *
   * Load-bearing, not cosmetic: the emulator arrives through a dynamic import, so for the first
   * frames after a session opens there is nothing to write to. Reading output in that window
   * ADVANCES THE CURSOR and drops what it read, and every later read returns nothing new — the
   * screen then stays blank forever over a perfectly healthy shell. Gate the reads on the screen
   * instead; the first read is from cursor 0, so nothing is lost by waiting.
   */
  const [screenReady, setScreenReady] = useState(false)
  /**
   * The session's topic is not readable on this connection, so fall back to polling.
   *
   * Not a dev-only path. The hub grades every upgrade, and a browser does NOT send `Sec-Fetch-*`
   * headers on a WebSocket handshake, so a connection that is not provably same-authority — a
   * Vite dev proxy, and Safari and Firefox generally — is admitted UNTRUSTED and may read only
   * topics marked loopback-readable. The terminal's topic is deliberately not one of those. The
   * socket is an optimisation here, never the mechanism: the bytes always come over HTTP, so
   * losing the bell costs latency and nothing else. Same degradation `host-usage` makes.
   */
  const [socketRefused, setSocketRefused] = useState(false)

  // The emulator and its cursor live in refs: they change on every frame of output and nothing
  // renders from them.
  const termRef = useRef<{ write(data: string): void } | null>(null)
  const cursorRef = useRef(0)

  // Open a session ---------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false
    setStarting(true)
    setUnavailable(null)
    setSession(null)
    setExited(null)
    setScreenReady(false)
    setSocketRefused(false)
    cursorRef.current = 0

    void (async () => {
      try {
        const state = await getRunTerminal(runId)
        if (cancelled) return
        if (!state.available) {
          setUnavailable(state.reason ?? 'Terminal nie jest dostępny w tym cockpicie.')
          return
        }
        // Reattach to the session this task already has rather than forking a second shell —
        // reopening the drawer must not lose a running build.
        const existing = state.sessions.find((entry) => entry.exitCode === null) ?? state.sessions[0]
        const opened = existing ?? (await createRunTerminal(runId, {}))
        if (!cancelled) setSession(opened)
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

  // Mount the emulator -----------------------------------------------------------------------
  useEffect(() => {
    const host = hostRef.current
    if (!session || !host) return
    let disposed = false
    let detach: (() => void) | undefined

    void (async () => {
      // Imported here, not at module scope: the emulator is ~80 KB gzipped, and a user who never
      // opens the drawer must not pay for it inside the workspace chunk.
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ])
      if (disposed) return

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 12,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        // Transparent so the drawer's own themed background shows through in light and dark
        // alike, instead of xterm painting its own black over the cockpit's palette.
        theme: { background: 'rgba(0,0,0,0)' },
        allowTransparency: true,
        scrollback: 5_000,
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(host)
      fit.fit()
      term.focus()
      termRef.current = term
      setScreenReady(true)

      term.onData((data) => {
        void writeRunTerminal(runId, session.id, data).catch(() => {})
      })
      // The PTY has to learn the real size, or every program that draws in columns wraps wrongly.
      term.onResize(({ cols, rows }) => {
        void resizeRunTerminal(runId, session.id, cols, rows).catch(() => {})
      })

      const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => fit.fit())
      observer?.observe(host)
      detach = () => {
        observer?.disconnect()
        term.dispose()
      }
    })()

    return () => {
      disposed = true
      termRef.current = null
      setScreenReady(false)
      detach?.()
    }
  }, [runId, session])

  // Pull output ------------------------------------------------------------------------------
  const pull = useCallback(async () => {
    if (!session) return
    const read = await readRunTerminal(runId, session.id, cursorRef.current)
    cursorRef.current = read.cursor
    // Say so rather than splicing a gap into the screen silently.
    if (read.truncated) termRef.current?.write(TRUNCATION_NOTICE)
    if (read.data) termRef.current?.write(read.data)
    if (read.exitCode !== null) setExited(read.exitCode)
  }, [runId, session])

  useEffect(() => {
    if (!session || transport === undefined || !screenReady) return
    let active = true
    const safePull = () => {
      if (active) void pull().catch(() => {})
    }
    safePull()

    if (transport === 'local' && !socketRefused) {
      // The topic carries a cursor and nothing else; this is the "there is more" bell.
      const release = subscribeTopic(session.topic, safePull, () => {
        // Refused (or the socket went away): stop waiting for a bell that will never ring and
        // let the effect re-run into the polling branch.
        setSocketRefused(true)
      })
      return () => {
        active = false
        release()
      }
    }
    const timer = setInterval(safePull, POLL_MS)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [pull, screenReady, session, socketRefused, transport])

  const stop = useCallback(() => {
    if (!session) return
    void stopRunTerminal(runId, session.id).catch(() => {})
  }, [runId, session])

  return (
    <section
      data-slot="terminal-drawer"
      aria-label="Terminal"
      className="flex h-64 shrink-0 flex-col border-t border-border bg-background"
    >
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-2">
        <TerminalIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
        <span className="shrink-0 text-xs font-medium text-muted-foreground">Terminal</span>
        {session ? (
          // The worktree, stated: a shell that does not say which tree it is typing into is a trap.
          <span className="min-w-0 truncate text-[11px] text-soft-foreground" title={session.cwd}>
            {session.cwd}
          </span>
        ) : null}
        {exited !== null ? (
          <span data-slot="terminal-exit" className="shrink-0 text-[11px] text-soft-foreground tabular-nums">
            zakończony ({exited})
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {session && exited === null ? (
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={stop}>
              <SquareIcon aria-hidden="true" className="size-3" />
              Zatrzymaj
            </Button>
          ) : null}
          <button
            type="button"
            aria-label="Zamknij terminal"
            onClick={onClose}
            className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <XIcon aria-hidden="true" className="size-3.5" />
          </button>
        </span>
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
        <div
          ref={hostRef}
          data-slot="terminal-screen"
          className={cn('min-h-0 flex-1 overflow-hidden px-2 py-1', exited !== null && 'opacity-60')}
        />
      )}
    </section>
  )
}
