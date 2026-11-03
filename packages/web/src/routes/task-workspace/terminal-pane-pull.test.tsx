import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TerminalSession } from '@open-mercato/cezar-api-client'

/**
 * The pane's output pull (spec `.ai/specs/2026-10-07-task-workspace.md` §6).
 *
 * The regression this pins: `pull()` read `cursorRef.current`, awaited the fetch, and advanced
 * the cursor only AFTER the response. The per-session topic rings once per output chunk, so a
 * burst — an interrupt, a fast-printing build, or the mount's own immediate pull racing the
 * first ring — started several reads before any had returned. All of them asked from the same
 * cursor, all of them got the same bytes, and all of them wrote those bytes to the emulator.
 *
 * Observed live on 2026-10-08 against a real PTY: the server's buffer held one `^C`, one copy of
 * the typed command and three prompt lines, while the screen showed five, three and eleven. It
 * also explains the doubled opening prompt (`… % %`).
 */

/** The server's scrollback, as a cursor-addressed buffer — the shape the real endpoint has. */
let serverBuffer = ''
/** Resolves the in-flight reads, so a test decides when (and in what order) they land. */
let pendingReads: Array<() => void> = []

const readRunTerminal = vi.fn(async (_runId: string, _sessionId: string, cursor: number) => {
  // Snapshot the answer at CALL time, the way a server would, then park it.
  const answer = { data: serverBuffer.slice(cursor), cursor: serverBuffer.length, truncated: false, exitCode: null }
  await new Promise<void>((resolve) => pendingReads.push(resolve))
  return answer
})

vi.mock('@/api/client', () => ({
  readRunTerminal: (...args: unknown[]) => readRunTerminal(...(args as [string, string, number])),
  resizeRunTerminal: vi.fn(async () => ({ resized: true })),
  writeRunTerminal: vi.fn(async () => ({ delivered: true })),
}))

/** Captured so a test can ring the topic the way the server does. */
let ring: (() => void) | null = null
vi.mock('@/api/ws', () => ({
  subscribeTopic: (_topic: string, onMessage: () => void) => {
    ring = onMessage
    return () => { ring = null }
  },
}))
vi.mock('@/api/host-usage', () => ({ useHostTransport: () => 'local' as const }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

/** Records what actually reached the emulator — the thing the user sees. */
let written: string[] = []

class FakeTerminal {
  cols = 80
  rows = 24
  onResize() {}
  onData() {}
  attachCustomKeyEventHandler() {}
  hasSelection() { return false }
  getSelection() { return '' }
  loadAddon() {}
  open() {}
  focus() {}
  write(chunk: string) { written.push(chunk) }
  dispose() {}
}

vi.mock('@xterm/xterm', () => ({
  Terminal: class { constructor() { return new FakeTerminal() as unknown as this } },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))

const { TerminalPane } = await import('./terminal-pane')

const SESSION: TerminalSession = {
  id: 's-1', runId: 'r1', cwd: '/tmp/wt/r1', shell: '/bin/zsh',
  cols: 80, rows: 24, startedAt: '2026-10-08T01:00:00.000Z',
  exitCode: null, label: 'Terminal 1', busy: false, topic: 'terminal:s-1',
}

/** Let every parked read return, then let the microtasks they queue settle. */
async function settleReads() {
  for (let round = 0; round < 6; round += 1) {
    const due = pendingReads
    pendingReads = []
    for (const resolve of due) resolve()
    await new Promise((r) => setTimeout(r, 0))
  }
}

beforeEach(() => {
  serverBuffer = ''
  pendingReads = []
  written = []
  ring = null
  readRunTerminal.mockClear()
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1016)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(223)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TerminalPane — pulling output', () => {
  it('writes a burst exactly once, however many times the topic rings', async () => {
    serverBuffer = 'prompt$ sleep 120\r\n^C\r\nprompt$ '
    render(<TerminalPane runId="r1" session={SESSION} active />)
    await waitFor(() => expect(readRunTerminal).toHaveBeenCalled())

    // Three rings arriving while the first read is still in flight — zsh emits the interrupt,
    // the newline and the fresh prompt as separate chunks, and each one rings.
    ring?.()
    ring?.()
    ring?.()
    await settleReads()

    expect(written.join('')).toBe(serverBuffer)
  })

  it('never asks twice from the same cursor', async () => {
    serverBuffer = 'abcdef'
    render(<TerminalPane runId="r1" session={SESSION} active />)
    await waitFor(() => expect(readRunTerminal).toHaveBeenCalled())
    ring?.()
    ring?.()
    await settleReads()

    const cursors = readRunTerminal.mock.calls.map((call) => call[2])
    expect(new Set(cursors).size).toBe(cursors.length)
  })

  it('still picks up output that arrived while a read was in flight', async () => {
    // The coalesced ring must not be DROPPED — it has to run again afterwards, or the last
    // chunk of a burst never reaches the screen.
    serverBuffer = 'first'
    render(<TerminalPane runId="r1" session={SESSION} active />)
    await waitFor(() => expect(readRunTerminal).toHaveBeenCalled())

    serverBuffer = 'firstsecond'
    ring?.()
    await settleReads()

    expect(written.join('')).toBe('firstsecond')
  })
})
