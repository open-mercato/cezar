import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TerminalSession } from '@open-mercato/cezar-api-client'

const api = vi.hoisted(() => ({
  getStartApp: vi.fn(),
  setStartApp: vi.fn(),
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

describe('startedAddress with a recipe address', () => {
  it('waits for its origin, counting localhost and 127.0.0.1 as one', () => {
    const since = Date.parse('2026-10-17T10:00:00Z')
    const api4000 = { url: 'http://localhost:4000', lastSeenAt: '2026-10-17T10:00:01Z', running: true }
    const web = { url: 'http://127.0.0.1:5173/', lastSeenAt: '2026-10-17T10:00:02Z', running: null }
    expect(startedAddress([api4000], since, 'http://localhost:5173/app')).toBeNull()
    expect(startedAddress([api4000, web], since, 'http://localhost:5173/app')).toBe('http://localhost:5173/app')
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

  it('installs the dependencies in a tab of their own, then starts the app once they succeed', async () => {
    api.getRunTerminalCommands.mockResolvedValue({ commands, install: 'npm ci' })
    api.createRunTerminal
      .mockResolvedValueOnce(session({ id: 'install' }))
      .mockResolvedValueOnce(session({ id: 's-1' }))
    api.getRunTerminal.mockResolvedValue({ available: true, sessions: [session({ id: 'install', exitCode: 0 })] })
    api.getRunTerminalUrls.mockResolvedValue({
      urls: [{ url: 'http://localhost:5173', lastSeenAt: new Date(Date.now() + 5000).toISOString(), running: true }],
    })
    const onOpen = vi.fn()
    render(<RunAppPanel runId="r1" projectId="cezar" onOpen={onOpen} />)
    expect(await screen.findByText(/Installs its dependencies first \(npm ci\)/)).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Run npm run dev/ }))

    expect(await screen.findByText('Installing dependencies (npm ci)')).not.toBeNull()
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('http://localhost:5173'), { timeout: 4000 })
    expect(api.writeRunTerminal).toHaveBeenNthCalledWith(1, 'r1', 'install', 'npm ci && exit 0 || exit 1\r')
    expect(api.writeRunTerminal).toHaveBeenNthCalledWith(2, 'r1', 's-1', 'npm run dev\r')
    // Only the start command is remembered; the install is decided afresh each time.
    expect(localStorage.getItem(rememberedCommandKey('cezar'))).toBe('npm run dev')
  })

  it('stops at a failed install and starts nothing', async () => {
    api.getRunTerminalCommands.mockResolvedValue({ commands, install: 'npm ci' })
    api.createRunTerminal.mockResolvedValue(session({ id: 'install' }))
    api.getRunTerminal.mockResolvedValue({ available: true, sessions: [session({ id: 'install', exitCode: 1 })] })
    render(<RunAppPanel runId="r1" projectId="cezar" onOpen={() => {}} />)

    fireEvent.click(await screen.findByRole('button', { name: /Run npm run dev/ }))

    expect(await screen.findByText(/npm ci exited with code 1/, undefined, { timeout: 4000 })).not.toBeNull()
    expect(api.createRunTerminal).toHaveBeenCalledTimes(1)
  })

  it("starts every service of the project's recipe and opens the address it names", async () => {
    api.getRunTerminalCommands.mockResolvedValue({
      commands,
      recipe: { services: ['npm run api', 'npm run web'], url: 'http://localhost:5173/app', scope: 'project' },
    })
    api.createRunTerminal
      .mockResolvedValueOnce(session({ id: 'api' }))
      .mockResolvedValueOnce(session({ id: 'web' }))
    api.getRunTerminal.mockResolvedValue({ available: true, sessions: [session({ id: 'api' }), session({ id: 'web' })] })
    const fresh = new Date(Date.now() + 5000).toISOString()
    // The api prints first; only the web's origin is the one to show.
    api.getRunTerminalUrls
      .mockResolvedValueOnce({ urls: [{ url: 'http://localhost:4000', lastSeenAt: fresh, running: true }] })
      .mockResolvedValue({
        urls: [
          { url: 'http://localhost:4000', lastSeenAt: fresh, running: true },
          { url: 'http://127.0.0.1:5173/', lastSeenAt: fresh, running: true },
        ],
      })
    const onOpen = vi.fn()
    render(<RunAppPanel runId="r1" projectId="cezar" onOpen={onOpen} />)

    expect(await screen.findByText('Start the app')).not.toBeNull()
    expect(screen.getByText('npm run api')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Start app' }))

    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('http://localhost:5173/app'), { timeout: 4000 })
    expect(api.writeRunTerminal).toHaveBeenCalledWith('r1', 'api', 'npm run api\r')
    expect(api.writeRunTerminal).toHaveBeenCalledWith('r1', 'web', 'npm run web\r')
    // A recipe is not a remembered command.
    expect(localStorage.getItem(rememberedCommandKey('cezar'))).toBeNull()
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

describe('the worktree setup (#1495)', () => {
  it('waits while the setup scripts run, and says when they need attention', async () => {
    const projection = { worktreeId: '0d7c3c1e-6f2a-4b8e-9d1a-2f4c5b6a7e8f', generation: 1, phase: 'setup' as const }
    const { rerender } = render(
      <RunAppPanel
        runId="r1"
        projectId="cezar"
        onOpen={() => {}}
        setup={{ ...projection, state: 'running', activeOperationId: '1d7c3c1e-6f2a-4b8e-9d1a-2f4c5b6a7e8f', needsAttention: false }}
      />,
    )
    expect(await screen.findByText(/setup scripts are still running/)).not.toBeNull()
    expect(screen.getByRole('button', { name: /Run npm run dev/ }).hasAttribute('disabled')).toBe(true)

    rerender(
      <RunAppPanel runId="r1" projectId="cezar" onOpen={() => {}} setup={{ ...projection, state: 'needs_attention', needsAttention: true }} />,
    )
    expect(screen.getByText(/setup needs attention/)).not.toBeNull()
    expect(screen.getByRole('button', { name: /Run npm run dev/ }).hasAttribute('disabled')).toBe(false)
  })
})

describe('the start recipe editor', () => {
  it('saves the team recipe from the suggestion, and the panel then offers it', async () => {
    api.getStartApp.mockResolvedValue({ project: null, personal: null, personalAvailable: true })
    api.setStartApp.mockImplementation(async (body: { recipe: unknown }) => ({
      project: body.recipe,
      personal: null,
      personalAvailable: true,
    }))
    render(<RunAppPanel runId="r1" projectId="cezar" onOpen={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Save a start recipe for this project' }))

    const first = await screen.findByRole('textbox', { name: 'Service 1' })
    await waitFor(() => expect((first as HTMLInputElement).value).toBe('npm run dev'))
    fireEvent.click(screen.getByRole('button', { name: 'Add service' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Service 2' }), { target: { value: 'npm run api' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Address to show' }), { target: { value: 'http://localhost:5173' } })
    api.getRunTerminalCommands.mockResolvedValue({
      commands,
      recipe: { services: ['npm run dev', 'npm run api'], url: 'http://localhost:5173', scope: 'project' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(api.setStartApp).toHaveBeenCalledWith({
        scope: 'project',
        recipe: { services: ['npm run dev', 'npm run api'], url: 'http://localhost:5173' },
      }),
    )
    expect(await screen.findByRole('button', { name: 'Start app' })).not.toBeNull()
  })

  it('refuses an address that is not http(s), and offers no personal recipe outside the registry', async () => {
    api.getStartApp.mockResolvedValue({ project: null, personal: null, personalAvailable: false })
    render(<RunAppPanel runId="r1" projectId="cezar" onOpen={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Save a start recipe for this project' }))
    await screen.findByRole('textbox', { name: 'Service 1' })
    await waitFor(() => expect(screen.getByRole('radio', { name: /Only me/ }).hasAttribute('disabled')).toBe(true))
    fireEvent.change(screen.getByRole('textbox', { name: 'Address to show' }), { target: { value: 'localhost:5173' } })
    expect(screen.getByText('Start it with http:// or https://')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
  })
})
