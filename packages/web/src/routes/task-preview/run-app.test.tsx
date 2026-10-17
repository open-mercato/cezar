import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TerminalSession } from '@open-mercato/cezar-api-client'

const api = vi.hoisted(() => ({
  getRunTerminalCommands: vi.fn(),
  createRunTerminal: vi.fn(),
  writeRunTerminal: vi.fn(async () => undefined),
  getRunTerminalUrls: vi.fn(),
  getRunTerminal: vi.fn(),
}))
vi.mock('@/api/client', () => api)

const { RunAppPanel, rememberedCommandKey, startedAddress, suggestCommand } = await import('./run-app')

const session = (overrides: Partial<TerminalSession> = {}): TerminalSession => ({
  id: 's-1',
  runId: 'r1',
  cwd: '/tmp/wt/r1',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  startedAt: new Date().toISOString(),
  exitCode: null,
  label: 'Terminal 1',
  busy: true,
  topic: 'terminal:s-1',
  ...overrides,
})

const commands = [
  { command: 'npm run build', source: 'package.json' },
  { command: 'npm run dev', source: 'package.json', detail: 'vite' },
  { command: 'make start', source: 'Makefile' },
]

beforeEach(() => {
  localStorage.clear()
  for (const fn of Object.values(api)) fn.mockReset()
  api.writeRunTerminal.mockResolvedValue(undefined)
  api.getRunTerminalCommands.mockResolvedValue({ commands })
  api.createRunTerminal.mockResolvedValue(session())
  api.getRunTerminal.mockResolvedValue({ available: true, sessions: [session()] })
})

afterEach(() => cleanup())

describe('suggestCommand', () => {
  it('prefers dev, then start, serve and preview, and offers nothing it cannot rank', () => {
    expect(suggestCommand(commands)).toBe('npm run dev')
    expect(suggestCommand(commands.filter((entry) => entry.command !== 'npm run dev'))).toBe('make start')
    expect(suggestCommand([{ command: 'npm run build', source: 'package.json' }])).toBeNull()
  })
})

describe('startedAddress', () => {
  it('takes an address printed after the start, preferring one that answers', () => {
    const since = Date.parse('2026-10-17T10:00:00Z')
    const urls = [
      { url: 'http://localhost:9999', lastSeenAt: '2026-10-17T09:00:00Z', running: true },
      { url: 'http://localhost:5174', lastSeenAt: '2026-10-17T10:00:02Z', running: null },
      { url: 'http://localhost:5173', lastSeenAt: '2026-10-17T10:00:03Z', running: true },
      { url: 'http://localhost:4000', lastSeenAt: '2026-10-17T10:00:04Z', running: false },
    ]
    expect(startedAddress(urls, since)).toBe('http://localhost:5173')
    expect(startedAddress(urls.slice(0, 1), since)).toBeNull()
  })
})

describe('RunAppPanel', () => {
  it('runs the suggested command in a new terminal and opens the address it prints', async () => {
    api.getRunTerminalUrls.mockResolvedValue({
      urls: [{ url: 'http://localhost:5173', lastSeenAt: new Date(Date.now() + 500).toISOString(), running: true }],
    })
    const onOpen = vi.fn()
    render(<RunAppPanel runId="r1" projectId="cezar" onOpen={onOpen} />)

    fireEvent.click(await screen.findByRole('button', { name: /Run npm run dev/ }))

    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('http://localhost:5173'))
    expect(api.createRunTerminal).toHaveBeenCalledWith('r1', {})
    expect(api.writeRunTerminal).toHaveBeenCalledWith('r1', 's-1', 'npm run dev\r')
    // Remembered for the next task in this project.
    expect(localStorage.getItem(rememberedCommandKey('cezar'))).toBe('npm run dev')
  })

  it('suggests the command that worked last time over the discovered one', async () => {
    localStorage.setItem(rememberedCommandKey('cezar'), 'make start')
    render(<RunAppPanel runId="r1" projectId="cezar" onOpen={() => {}} />)
    expect(await screen.findByRole('button', { name: /Run make start/ })).not.toBeNull()
  })

  it('says so when the command exits before printing an address, and offers the terminal', async () => {
    api.getRunTerminalUrls.mockResolvedValue({ urls: [] })
    api.getRunTerminal.mockResolvedValue({ available: true, sessions: [session({ exitCode: 1 })] })
    const onShowTerminal = vi.fn()
    const onOpen = vi.fn()
    render(<RunAppPanel runId="r1" projectId="cezar" onOpen={onOpen} onShowTerminal={onShowTerminal} />)

    fireEvent.click(await screen.findByRole('button', { name: /Run npm run dev/ }))

    expect(await screen.findByText(/npm run dev exited with code 1/)).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show terminal' }))
    expect(onShowTerminal).toHaveBeenCalled()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('offers only the menu when nothing in the project looks like a start command', async () => {
    api.getRunTerminalCommands.mockResolvedValue({ commands: [{ command: 'npm run build', source: 'package.json' }] })
    render(<RunAppPanel runId="r1" projectId="cezar" onOpen={() => {}} />)
    expect(await screen.findByRole('button', { name: /Choose a command/ })).not.toBeNull()
    expect(screen.queryByRole('button', { name: /^Run / })).toBeNull()
  })
})
