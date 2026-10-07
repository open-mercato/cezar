import { useCallback, useEffect, useRef, useState } from 'react'

import { readRunTerminal, resizeRunTerminal, writeRunTerminal } from '@/api/client'
import { useHostTransport } from '@/api/host-usage'
import { subscribeTopic } from '@/api/ws'
import type { TerminalSession } from '@open-mercato/cezar-api-client'
import { cn } from '@/lib/utils'

import '@xterm/xterm/css/xterm.css'

/**
 * One terminal tab's screen: an emulator bound to one PTY session (spec
 * `.ai/specs/2026-10-07-task-workspace.md` §6).
 *
 * TRANSPORT. Output is never pushed over the socket. On a local cockpit the session's topic
 * wakes us with a cursor and the bytes come back over authenticated HTTP; on a hosted one there
 * is no socket at all — a browser WebSocket cannot carry reverse-proxy credentials, which is why
 * every WS consumer in this cockpit is gated on `localHandoff` — so the same read is polled. The
 * socket is only ever the bell; losing it costs latency and nothing else, which is what makes
 * the fallback below safe.
 *
 * A pane stays mounted while its tab is in the background, but it stops READING. The cursor is
 * what makes that free: on reactivation one read returns everything that accumulated, because
 * the server holds the scrollback either way.
 */

/** How often a hosted cockpit (or one whose topic was refused) asks for new output. */
const POLL_MS = 400

/** Written into the screen when retained scrollback was dropped. Plain text rather than a dimmed
 *  ANSI sequence: this is the cockpit talking, and it must not be mistakable for — or corrupt the
 *  state of — the program that is writing. */
const TRUNCATION_NOTICE = '\r\n[... wcześniejsze wyjście wypadło ze scrollbacku ...]\r\n'

export function TerminalPane({
  runId,
  session,
  active,
}: {
  runId: string
  session: TerminalSession
  active: boolean
}) {
  const transport = useHostTransport()
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<{ write(data: string): void } | null>(null)
  const fitRef = useRef<(() => void) | null>(null)
  const focusRef = useRef<(() => void) | null>(null)
  const cursorRef = useRef(0)

  /**
   * The emulator is mounted and can be written to.
   *
   * Load-bearing, not cosmetic: the emulator arrives through a dynamic import, so for the first
   * frames there is nothing to write to. Reading output in that window ADVANCES THE CURSOR and
   * drops what it read, and every later read returns nothing new — the screen then stays blank
   * forever over a perfectly healthy shell.
   */
  const [screenReady, setScreenReady] = useState(false)
  /**
   * The session's topic is not readable on this connection, so fall back to polling.
   *
   * Not a dev-only path. Browsers do not send `Sec-Fetch-*` headers on a WebSocket handshake, so
   * a connection that is not provably same-authority — a Vite dev proxy, and Safari and Firefox
   * generally — is admitted UNTRUSTED by the hub and may read only topics marked
   * loopback-readable. A terminal's topic is deliberately not one of those.
   */
  const [socketRefused, setSocketRefused] = useState(false)

  // Mount the emulator ---------------------------------------------------------------------
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    let detach: (() => void) | undefined

    void (async () => {
      // Imported here, not at module scope: the emulator is ~85 KB gzipped, and a user who never
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
      termRef.current = term
      fitRef.current = () => {
        // Fitting a hidden element measures zero and would resize the PTY to nothing.
        if (host.clientHeight > 0 && host.clientWidth > 0) fit.fit()
      }
      focusRef.current = () => term.focus()
      fitRef.current()
      setScreenReady(true)

      term.onData((data) => {
        void writeRunTerminal(runId, session.id, data).catch(() => {})
      })
      // The PTY has to learn the real size, or every program that draws in columns wraps wrongly.
      term.onResize(({ cols, rows }) => {
        void resizeRunTerminal(runId, session.id, cols, rows).catch(() => {})
      })

      const observer =
        typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => fitRef.current?.())
      observer?.observe(host)
      detach = () => {
        observer?.disconnect()
        term.dispose()
      }
    })()

    return () => {
      disposed = true
      termRef.current = null
      fitRef.current = null
      focusRef.current = null
      setScreenReady(false)
      detach?.()
    }
  }, [runId, session.id])

  // A pane that was hidden measured zero, so its size is stale the moment it is shown again.
  useEffect(() => {
    if (!active || !screenReady) return
    fitRef.current?.()
    focusRef.current?.()
  }, [active, screenReady])

  // Pull output ------------------------------------------------------------------------------
  const pull = useCallback(async () => {
    const read = await readRunTerminal(runId, session.id, cursorRef.current)
    cursorRef.current = read.cursor
    // Say so rather than splicing a gap into the screen silently.
    if (read.truncated) termRef.current?.write(TRUNCATION_NOTICE)
    if (read.data) termRef.current?.write(read.data)
  }, [runId, session.id])

  useEffect(() => {
    if (!screenReady || !active || transport === undefined) return
    let running = true
    const safePull = () => {
      if (running) void pull().catch(() => {})
    }
    safePull()

    if (transport === 'local' && !socketRefused) {
      // The topic carries a cursor and nothing else; this is the "there is more" bell.
      const release = subscribeTopic(session.topic, safePull, () => setSocketRefused(true))
      return () => {
        running = false
        release()
      }
    }
    const timer = setInterval(safePull, POLL_MS)
    return () => {
      running = false
      clearInterval(timer)
    }
  }, [active, pull, screenReady, session.topic, socketRefused, transport])

  return (
    <div
      ref={hostRef}
      data-slot="terminal-screen"
      data-session={session.id}
      // Hidden rather than unmounted: a background tab keeps its screen and its scrollback.
      // `invisible` + zero size rather than `display:none`, so xterm's own measurements do not
      // throw while it is away.
      className={cn(
        'absolute inset-0 overflow-hidden px-2 py-1',
        active ? 'visible' : 'invisible pointer-events-none',
        session.exitCode !== null && 'opacity-60',
      )}
    />
  )
}
