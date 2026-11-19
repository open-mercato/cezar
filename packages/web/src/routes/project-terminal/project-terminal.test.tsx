import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TerminalSession } from '@open-mercato/cezar-api-client'

/** The project Terminal page (#1526): the drawer's tabs over the PROJECT's routes, never a task's. */

const project = {
  getProjectTerminal: vi.fn(),
  createProjectTerminal: vi.fn(),
  stopProjectTerminal: vi.fn(async () => undefined),
  writeProjectTerminal: vi.fn(async () => undefined),
}
const task = {
  getRunTerminal: vi.fn(),
  createRunTerminal: vi.fn(),
  stopRunTerminal: vi.fn(),
  writeRunTerminal: vi.fn(),
}
let terminalAllowed = true

vi.mock('@/api/client', () => ({
  ...Object.fromEntries(
    Object.entries({ ...project, ...task }).map(([name, fn]) => [name, (...args: unknown[]) => fn(...(args as []))]),
  ),
}))

vi.mock('@/api/queries', () => ({
  useHealth: () => ({ data: { repo: { root: '/tmp/project' }, capabilities: { terminal: terminalAllowed } } }),
}))

vi.mock('@/lib/project-router', () => ({ useActiveProjectId: () => 'cezar' }))

vi.mock('../task-workspace/terminal-pane', () => ({
  TerminalPane: ({ session }: { session: TerminalSession }) => <div data-testid="pane" data-session={session.id} />,
}))

vi.mock('../task-workspace/terminal-extras', () => ({
  CommandPicker: () => null,
  DetectedUrlsStrip: () => <div data-testid="detected-urls" />,
}))

const { ProjectTerminalRoute } = await import('./project-terminal')

function session(id: string, overrides: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id,
    runId: 'project:/tmp/project',
    cwd: '/tmp/project',
    shell: '/bin/bash',
    cols: 80,
    rows: 24,
    startedAt: '2026-11-13T01:00:00.000Z',
    exitCode: null,
    label: `Terminal ${id}`,
    busy: false,
    topic: `terminal:${id}`,
    ...overrides,
  }
}

beforeEach(() => {
  terminalAllowed = true
  for (const fn of [...Object.values(project), ...Object.values(task)]) fn.mockClear()
})
afterEach(cleanup)

describe('ProjectTerminalRoute', () => {
  it('opens a shell in the project when it has none, over the project routes only', async () => {
    project.getProjectTerminal.mockResolvedValue({ available: true, sessions: [] })
    project.createProjectTerminal.mockResolvedValue(session('p-1'))
    render(<ProjectTerminalRoute />)

    expect((await screen.findByTestId('pane')).getAttribute('data-session')).toBe('p-1')
    expect(project.createProjectTerminal).toHaveBeenCalledWith({})
    expect(task.getRunTerminal).not.toHaveBeenCalled()
    expect(task.createRunTerminal).not.toHaveBeenCalled()
    // Detected addresses open in a task's Preview; the project page has none.
    expect(screen.queryByTestId('detected-urls')).toBeNull()
  })

  it('reattaches to the project’s running shell, and Stop interrupts it there', async () => {
    project.getProjectTerminal.mockResolvedValue({ available: true, sessions: [session('p-1', { busy: true })] })
    render(<ProjectTerminalRoute />)

    await screen.findByTestId('pane')
    expect(project.createProjectTerminal).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /^Stop$/ }))
    expect(project.writeProjectTerminal).toHaveBeenCalledWith('p-1', '\x03')
    expect(task.writeRunTerminal).not.toHaveBeenCalled()
  })

  it('says why when the server has no PTY to give', async () => {
    project.getProjectTerminal.mockResolvedValue({ available: false, reason: 'node-pty is not installed', sessions: [] })
    render(<ProjectTerminalRoute />)

    await waitFor(() => expect(screen.getByText('node-pty is not installed')).not.toBeNull())
    expect(project.createProjectTerminal).not.toHaveBeenCalled()
  })

  it('opens nothing where the terminal policy is off', () => {
    terminalAllowed = false
    render(<ProjectTerminalRoute />)

    expect(screen.getByText('Terminal disabled')).not.toBeNull()
    expect(project.getProjectTerminal).not.toHaveBeenCalled()
  })
})
