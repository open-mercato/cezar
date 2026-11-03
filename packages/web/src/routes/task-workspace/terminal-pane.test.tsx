import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TerminalSession } from '@open-mercato/cezar-api-client'

/**
 * `TerminalPane`'s size handshake (spec `.ai/specs/2026-10-07-task-workspace.md` §6, "resize
 * propagation").
 *
 * The regression this pins: the emulator is constructed at xterm's default 80x24 and the OPENING
 * fit is what takes it to whatever the drawer actually measures. An `onResize` listener attached
 * after that fit never hears the one event that matters, and nothing fires again afterwards — the
 * ResizeObserver only re-fits when the HOST changes size, and a fit that computes the same
 * dimensions emits no event at all. The shell is then left believing it has 80 columns while the
 * user is looking at ~120, so zsh wraps its lines early and anything full-screen draws wrongly.
 *
 * Verified to fail against the previous ordering: with `term.onResize(...)` registered after
 * `fitRef.current()`, the first case below sees zero `resizeRunTerminal` calls.
 */

const resizeRunTerminal = vi.fn(async () => ({ resized: true }))
const writeRunTerminal = vi.fn(async () => ({ delivered: true }))
const readRunTerminal = vi.fn(async () => ({ data: '', cursor: 0, truncated: false, exitCode: null }))

vi.mock('@/api/client', () => ({
  resizeRunTerminal: (...args: unknown[]) => resizeRunTerminal(...(args as [])),
  writeRunTerminal: (...args: unknown[]) => writeRunTerminal(...(args as [])),
  readRunTerminal: (...args: unknown[]) => readRunTerminal(...(args as [])),
}))

// The pane only reads output once the transport is known; `undefined` would park it before the
// size handshake is even reached, which would make these cases vacuous.
vi.mock('@/api/host-usage', () => ({ useHostTransport: () => 'poll' as const }))
vi.mock('@/api/ws', () => ({ subscribeTopic: () => () => {} }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

/** What the next fake `fit()` will resize the terminal to. */
let fitTo: { cols: number; rows: number } | null = { cols: 124, rows: 15 }

/**
 * A minimal xterm stand-in. The one behavior that matters is the real one's: `fit()` changes the
 * dimensions and EMITS `onResize` — and emits nothing when the dimensions are unchanged.
 */
class FakeTerminal {
  cols = 80
  rows = 24
  private resizeHandlers: Array<(size: { cols: number; rows: number }) => void> = []

  onResize(handler: (size: { cols: number; rows: number }) => void) {
    this.resizeHandlers.push(handler)
  }
  onData() {}
  /** The clipboard bindings attach one of these; this suite is about the size handshake. */
  attachCustomKeyEventHandler() {}
  hasSelection() {
    return false
  }
  getSelection() {
    return ''
  }
  loadAddon() {}
  open() {}
  focus() {}
  write() {}
  dispose() {}

  /** The fit addon's effect, with xterm's own "no event when nothing changed" rule. */
  applyFit(size: { cols: number; rows: number }) {
    if (size.cols === this.cols && size.rows === this.rows) return
    this.cols = size.cols
    this.rows = size.rows
    for (const handler of this.resizeHandlers) handler({ cols: this.cols, rows: this.rows })
  }
}

let lastTerminal: FakeTerminal | null = null

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor() {
      const term = new FakeTerminal()
      lastTerminal = term
      return term as unknown as this
    }
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {
      if (fitTo) lastTerminal?.applyFit(fitTo)
    }
  },
}))

const { TerminalPane } = await import('./terminal-pane')

const SESSION: TerminalSession = {
  id: 's-1',
  runId: 'r1',
  cwd: '/tmp/wt/r1',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  startedAt: '2026-10-08T01:00:00.000Z',
  exitCode: null,
  label: 'Terminal 1',
  busy: false,
  topic: 'terminal:s-1',
}

beforeEach(() => {
  resizeRunTerminal.mockClear()
  fitTo = { cols: 124, rows: 15 }
  // jsdom gives every element a zero box, and the pane deliberately refuses to fit a host that
  // measures zero — that guard exists so a hidden tab cannot resize the PTY to nothing.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1016)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(223)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  lastTerminal = null
})

describe('TerminalPane — telling the PTY its real size', () => {
  it('sends the size the opening fit produced', async () => {
    render(<TerminalPane runId="r1" session={SESSION} active />)

    await waitFor(() => expect(resizeRunTerminal).toHaveBeenCalled())
    // The dimensions the drawer actually measures, not the 80x24 the emulator was built at.
    expect(resizeRunTerminal).toHaveBeenCalledWith('r1', 's-1', 124, 15)
  })

  it('still sends a size when the opening fit changes nothing', async () => {
    // The mirror case: a drawer that really does measure 80x24 makes `fit()` a no-op, so xterm
    // emits no resize event at all. Without the unconditional send the server would never be told
    // anything — which happens to be right here, and would be silently wrong the moment the
    // server's default and the emulator's stopped agreeing.
    fitTo = null
    render(<TerminalPane runId="r1" session={SESSION} active />)

    await waitFor(() => expect(resizeRunTerminal).toHaveBeenCalled())
    expect(resizeRunTerminal).toHaveBeenCalledWith('r1', 's-1', 80, 24)
  })
})
