import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TerminalSession } from '@open-mercato/cezar-api-client'

/** OSC 52 clipboard writes (#2441) and the persisted font size (#2435), through the real xterm. */

const resizeRunTerminal = vi.fn(async (..._args: unknown[]) => ({ resized: true }))
const writeClipboard = vi.fn(async (_text: string) => {})

vi.mock('@/api/client', () => ({
  resizeRunTerminal: (...args: unknown[]) => resizeRunTerminal(...args),
  writeRunTerminal: async () => ({ delivered: true }),
  readRunTerminal: async () => ({ data: '', cursor: 0, truncated: false, exitCode: null }),
}))
vi.mock('@/api/host-usage', () => ({ useHostTransport: () => 'poll' as const }))
vi.mock('@/api/ws', () => ({ subscribeTopic: () => () => {} }))
vi.mock('@/lib/clipboard', () => ({ writeClipboard: (text: string) => writeClipboard(text) }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} activate() {} dispose() {} } }))

const { TerminalPane } = await import('./terminal-pane')
const { TERMINAL_FONT_STORAGE_KEY, writeTerminalFont } = await import('@/lib/terminal-font-pref')
const { decodeOsc52 } = await import('@/lib/osc52')

const SESSION: TerminalSession = {
  id: 's-1', runId: 'r1', cwd: '/tmp/wt/r1', shell: '/bin/zsh', cols: 80, rows: 24,
  startedAt: '2026-10-08T01:00:00.000Z', exitCode: null, label: 'Terminal 1', busy: false, topic: 'terminal:s-1',
}

const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)))

let pulled = ''
beforeEach(() => {
  writeClipboard.mockClear()
  resizeRunTerminal.mockClear()
  localStorage.clear()
  pulled = ''
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Mount and return the xterm instance through its DOM-less write path: feed bytes via the pane's read. */
async function mountWith(data: string) {
  const client = await import('@/api/client')
  vi.spyOn(client, 'readRunTerminal').mockResolvedValueOnce({ data, cursor: data.length, truncated: false, exitCode: null } as never)
  render(<TerminalPane runId="r1" session={SESSION} active />)
}

describe('OSC 52', () => {
  it.each([
    ['BEL', '\x07'],
    ['ST', '\x1b\\'],
  ])('writes the decoded text to the clipboard (%s terminator)', async (_n, end) => {
    await mountWith(`\x1b]52;c;${b64('hello world')}${end}`)
    await waitFor(() => expect(writeClipboard).toHaveBeenCalledWith('hello world'))
  })

  it('decodes non-ASCII as UTF-8', () => {
    expect(decodeOsc52(`c;${b64('zażółć 🙂')}`)).toBe('zażółć 🙂')
  })

  it('ignores read requests', () => {
    expect(decodeOsc52('c;?')).toBeNull()
  })

  it('ignores bad base64 and oversized payloads', () => {
    expect(decodeOsc52('c;!!!notbase64')).toBeNull()
    expect(decodeOsc52(`c;${'A'.repeat(2_000_000)}`)).toBeNull()
  })

  it('does not throw when the clipboard write is refused', async () => {
    writeClipboard.mockRejectedValueOnce(new Error('denied'))
    await mountWith(`\x1b]52;c;${b64('x')}\x07`)
    await waitFor(() => expect(writeClipboard).toHaveBeenCalled())
  })
})

describe('terminal font size', () => {
  it('starts from the stored size, clamped', async () => {
    localStorage.setItem(TERMINAL_FONT_STORAGE_KEY, '999')
    const { readTerminalFont } = await import('@/lib/terminal-font-pref')
    expect(readTerminalFont()).toBe(32)
    localStorage.setItem(TERMINAL_FONT_STORAGE_KEY, 'junk')
    expect(readTerminalFont()).toBe(12.5)
  })

  it('applies a change live and tells the PTY', async () => {
    render(<TerminalPane runId="r1" session={SESSION} active />)
    await waitFor(() => expect(resizeRunTerminal).toHaveBeenCalled())
    resizeRunTerminal.mockClear()
    act(() => writeTerminalFont(20))
    await waitFor(() => expect(resizeRunTerminal).toHaveBeenCalled())
    expect(localStorage.getItem(TERMINAL_FONT_STORAGE_KEY)).toBe('20')
  })

  it('Ctrl+= grows the font and is not typed into the shell', async () => {
    render(<TerminalPane runId="r1" session={SESSION} active />)
    const textarea = await waitFor(() => {
      const found = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
      expect(found).not.toBeNull()
      return found!
    })
    const ev = new KeyboardEvent('keydown', { key: '=', ctrlKey: true, bubbles: true, cancelable: true })
    textarea.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    expect(localStorage.getItem(TERMINAL_FONT_STORAGE_KEY)).toBe('13.5')
  })
})
