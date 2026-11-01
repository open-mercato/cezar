import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TerminalSession } from '@open-mercato/cezar-api-client'

/**
 * Paste reaches the shell ONCE (spec `.ai/specs/2026-10-07-task-workspace.md` §6, "copy/paste").
 *
 * Driven through the REAL xterm, because the bug lived in the seam with it: returning `false`
 * from the custom key handler stops xterm's key handling but does not `preventDefault`, so the
 * browser still pastes into xterm's helper textarea and xterm's own `paste` listener sends the
 * text through `onData`. A handler that ALSO read the clipboard and wrote it sent it twice.
 */

const writeRunTerminal = vi.fn(async (..._args: unknown[]) => ({ delivered: true }))

vi.mock('@/api/client', () => ({
  resizeRunTerminal: async () => ({ resized: true }),
  writeRunTerminal: (...args: unknown[]) => writeRunTerminal(...args),
  readRunTerminal: async () => ({ data: '', cursor: 0, truncated: false, exitCode: null }),
}))
vi.mock('@/api/host-usage', () => ({ useHostTransport: () => 'poll' as const }))
vi.mock('@/api/ws', () => ({ subscribeTopic: () => () => {} }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
// jsdom lays nothing out, so there is nothing to fit to.
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} activate() {} dispose() {} } }))

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

const PASTED = 'echo pasted-once'

beforeEach(() => {
  writeRunTerminal.mockClear()
  // xterm watches the device pixel ratio through `matchMedia`, which jsdom does not have.
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }))
  // Clipboard read is PERMITTED — the case that doubled.
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { readText: async () => PASTED, writeText: async () => {} },
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('TerminalPane — paste', () => {
  it.each([
    ['Cmd+V', { metaKey: true }],
    ['Ctrl+Shift+V', { ctrlKey: true, shiftKey: true }],
  ])('%s delivers the clipboard to the shell exactly once', async (_name, modifiers) => {
    render(<TerminalPane runId="r1" session={SESSION} active />)
    const textarea = await waitFor(() => {
      const found = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
      expect(found).not.toBeNull()
      return found!
    })

    const keydown = new KeyboardEvent('keydown', { key: 'v', bubbles: true, cancelable: true, ...modifiers })
    textarea.dispatchEvent(keydown)
    // Not prevented, so a real browser now performs its own paste into the textarea…
    expect(keydown.defaultPrevented).toBe(false)
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', { value: { getData: () => PASTED } })
    textarea.dispatchEvent(paste)

    // …and that is the one delivery. Let any clipboard promise settle before counting.
    await new Promise((resolve) => setTimeout(resolve, 20))
    const deliveries = writeRunTerminal.mock.calls.filter((call) => String(call[2]).includes(PASTED))
    expect(deliveries).toHaveLength(1)
  })
})
