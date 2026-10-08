import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TerminalSession } from '@open-mercato/cezar-api-client'

/**
 * The terminal drawer's tab lifecycle (spec `.ai/specs/2026-10-07-task-workspace.md` §6).
 *
 * Two regressions live here, both of which were invisible without a test at this level:
 *
 *  - `Zatrzymaj` CLOSED the tab. §6 is explicit — "Stop interrupts; the tab's X closes… Stop
 *    sends Ctrl-C" — and you stop a build precisely so you can read in that same pane why it was
 *    wrong. The code that did otherwise justified itself by citing a §11 sentence this spec does
 *    not contain.
 *  - A closed tab CAME BACK. The server retained an explicitly killed session for a minute, and
 *    the drawer reconciles its strip against the server list every two seconds, so the tab the
 *    user had just closed reappeared. Fixed server-side; pinned from this end too, because this
 *    is the component whose poll made it visible.
 */

const getRunTerminal = vi.fn()
const createRunTerminal = vi.fn()
const stopRunTerminal = vi.fn(async () => undefined)
const writeRunTerminal = vi.fn(async () => undefined)

vi.mock('@/api/client', () => ({
  getRunTerminal: (...args: unknown[]) => getRunTerminal(...(args as [])),
  createRunTerminal: (...args: unknown[]) => createRunTerminal(...(args as [])),
  stopRunTerminal: (...args: unknown[]) => stopRunTerminal(...(args as [])),
  writeRunTerminal: (...args: unknown[]) => writeRunTerminal(...(args as [])),
}))

vi.mock('@/api/queries', () => ({
  useHealth: () => ({ data: { repo: { root: '/tmp/project' }, capabilities: { terminal: true } } }),
}))

// The emulator is not what these cases are about, and mounting it would drag xterm in.
vi.mock('./terminal-pane', () => ({
  TerminalPane: ({ session }: { session: TerminalSession }) => (
    <div data-testid="pane" data-session={session.id} />
  ),
}))

// Both read the server on their own schedule; neither is under test here.
vi.mock('./terminal-extras', () => ({
  CommandPicker: () => null,
  DetectedUrlsStrip: () => null,
}))

const { TerminalDrawer } = await import('./terminal-drawer')

function session(id: string, overrides: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id,
    runId: 'r1',
    cwd: '/tmp/wt/r1',
    shell: '/bin/zsh',
    cols: 80,
    rows: 24,
    startedAt: '2026-10-08T01:00:00.000Z',
    exitCode: null,
    label: `Terminal ${id}`,
    busy: false,
    topic: `terminal:${id}`,
    ...overrides,
  }
}

const drawer = (onClose = () => {}) =>
  render(
    <TerminalDrawer
      runId="r1"
      height={320}
      onHeightChange={() => {}}
      onClose={onClose}
      // The detected-URL strip is stubbed out above, so nothing here reaches this.
      onOpenInBrowser={() => true}
    />,
  )

/** The strip's tabs, in order, by the label the server gave each one. */
const tabNames = () => screen.queryAllByRole('tab').map((tab) => tab.textContent)

beforeEach(() => {
  getRunTerminal.mockReset()
  createRunTerminal.mockReset()
  stopRunTerminal.mockClear()
  writeRunTerminal.mockClear()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('TerminalDrawer — opening', () => {
  it('reattaches to a live session instead of forking a second shell', async () => {
    getRunTerminal.mockResolvedValue({ available: true, sessions: [session('s-1')] })
    drawer()

    await waitFor(() => expect(screen.getByTestId('pane').getAttribute('data-session')).toBe('s-1'))
    expect(createRunTerminal).not.toHaveBeenCalled()
  })

  it('starts a fresh shell when the task has only a CORPSE to offer', async () => {
    // A shell that exited on its own is kept server-side for a minute so a still-polling client
    // can read its last line and exit code. Reattaching a freshly opened drawer to nothing but
    // that would show a dead pane and no shell — §6: "if it has no tabs, create a fresh terminal
    // session".
    getRunTerminal.mockResolvedValue({ available: true, sessions: [session('dead', { exitCode: 0 })] })
    createRunTerminal.mockResolvedValue(session('s-new'))
    drawer()

    await waitFor(() => expect(createRunTerminal).toHaveBeenCalledWith('r1', {}))
    expect(screen.getByTestId('pane').getAttribute('data-session')).toBe('s-new')
  })
})

describe('TerminalDrawer — Zatrzymaj', () => {
  it('sends Ctrl-C and KEEPS the tab', async () => {
    getRunTerminal.mockResolvedValue({ available: true, sessions: [session('s-1', { busy: true })] })
    drawer()
    await waitFor(() => expect(screen.queryByTestId('pane')).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: /Zatrzymaj/ }))

    expect(writeRunTerminal).toHaveBeenCalledWith('r1', 's-1', '\x03')
    // The pane is still there, which is the whole point: you stop a build to read its output.
    expect(stopRunTerminal).not.toHaveBeenCalled()
    expect(screen.getByTestId('pane').getAttribute('data-session')).toBe('s-1')
  })
})

describe('TerminalDrawer — closing a tab', () => {
  it('does not let the poll put a closed tab back', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    getRunTerminal.mockResolvedValue({ available: true, sessions: [session('s-1'), session('s-2')] })
    drawer()
    await waitFor(() => expect(tabNames()).toHaveLength(2))

    fireEvent.click(screen.getByRole('button', { name: 'Zamknij Terminal s-1' }))
    expect(stopRunTerminal).toHaveBeenCalledWith('r1', 's-1')
    await waitFor(() => expect(tabNames()).toHaveLength(1))

    // The server has forgotten it, so the next reconcile agrees with the strip rather than
    // resurrecting the tab the user just closed.
    getRunTerminal.mockResolvedValue({ available: true, sessions: [session('s-2')] })
    await vi.advanceTimersByTimeAsync(5_000)

    expect(tabNames()).toEqual(['Terminal s-2'])
  })

  it('asks first when something is running in it, and takes the tree on confirm', async () => {
    getRunTerminal.mockResolvedValue({
      available: true,
      sessions: [session('s-1', { busy: true, label: 'npm run build' }), session('s-2')],
    })
    drawer()
    await waitFor(() => expect(tabNames()).toHaveLength(2))

    fireEvent.click(screen.getByRole('button', { name: 'Zamknij npm run build' }))
    // Nothing is stopped on the strength of the click alone (§6).
    expect(stopRunTerminal).not.toHaveBeenCalled()

    fireEvent.click(await screen.findByRole('button', { name: 'Zamknij mimo to' }))
    await waitFor(() => expect(stopRunTerminal).toHaveBeenCalledWith('r1', 's-1'))
  })

  it('asks first when the host cannot tell whether anything is running', async () => {
    // `busy: null` is a host with no readable process table (Windows). Treating "unknown" as
    // "idle" skipped the warning §6 requires and took a running build with it.
    getRunTerminal.mockResolvedValue({
      available: true,
      sessions: [session('s-1', { busy: null }), session('s-2')],
    })
    drawer()
    await waitFor(() => expect(tabNames()).toHaveLength(2))

    fireEvent.click(screen.getByRole('button', { name: 'Zamknij Terminal s-1' }))
    expect(stopRunTerminal).not.toHaveBeenCalled()

    // And it says so honestly, rather than claiming a process it never saw.
    expect(await screen.findByText(/nie potrafi sprawdzić/)).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Zamknij mimo to' }))
    await waitFor(() => expect(stopRunTerminal).toHaveBeenCalledWith('r1', 's-1'))
  })

  it('offers no Stop when busy-ness is unknown', async () => {
    // An interrupt aimed at a shell we cannot see into would be a guess dressed as a control.
    getRunTerminal.mockResolvedValue({ available: true, sessions: [session('s-1', { busy: null })] })
    drawer()
    await waitFor(() => expect(screen.queryByTestId('pane')).not.toBeNull())

    expect(screen.queryByRole('button', { name: /Zatrzymaj/ })).toBeNull()
  })

  it('hides the drawer when the last tab goes', async () => {
    const onClose = vi.fn()
    getRunTerminal.mockResolvedValue({ available: true, sessions: [session('s-1')] })
    drawer(onClose)
    await waitFor(() => expect(tabNames()).toHaveLength(1))

    fireEvent.click(screen.getByRole('button', { name: 'Zamknij Terminal s-1' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})
