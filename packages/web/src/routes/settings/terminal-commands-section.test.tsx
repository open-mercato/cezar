import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getTerminalCommands = vi.fn()
const setTerminalCommands = vi.fn()
let terminal = true

vi.mock('@/api/client', () => ({
  getTerminalCommands: (...args: unknown[]) => getTerminalCommands(...args),
  setTerminalCommands: (...args: unknown[]) => setTerminalCommands(...args),
}))
vi.mock('@/api/queries', () => ({
  useHealth: () => ({ data: { capabilities: { terminal } } }),
}))

const { TerminalCommandsSection } = await import('./terminal-commands-section')

beforeEach(() => {
  terminal = true
  getTerminalCommands.mockReset()
  setTerminalCommands.mockReset()
})
afterEach(cleanup)

describe('TerminalCommandsSection (#1555)', () => {
  it('shows the empty state and keeps Save disabled with nothing defined', async () => {
    getTerminalCommands.mockResolvedValue({ project: [], personal: [], personalAvailable: true })
    render(<TerminalCommandsSection />)
    expect(await screen.findByText(/None yet/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('adds, reorders and saves commands, dropping half-filled rows', async () => {
    getTerminalCommands.mockResolvedValue({
      project: [{ name: 'Dev', command: 'pnpm dev' }],
      personal: [],
      personalAvailable: true,
    })
    setTerminalCommands.mockImplementation(async (body: { commands: unknown[] }) => ({
      project: body.commands,
      personal: [],
      personalAvailable: true,
    }))
    render(<TerminalCommandsSection />)
    await screen.findByDisplayValue('pnpm dev')

    fireEvent.click(screen.getByRole('button', { name: 'Add command' }))
    fireEvent.change(screen.getByLabelText('Name of command 2'), { target: { value: 'Tests' } })
    fireEvent.change(screen.getByLabelText('Command line 2'), { target: { value: ' cargo test ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add command' })) // left empty
    fireEvent.click(screen.getByRole('button', { name: 'Move command 2 up' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(setTerminalCommands).toHaveBeenCalledWith({
        scope: 'project',
        commands: [
          { name: 'Tests', command: 'cargo test' },
          { name: 'Dev', command: 'pnpm dev' },
        ],
      }),
    )
  })

  it('removes a command and saves the shorter list', async () => {
    getTerminalCommands.mockResolvedValue({
      project: [{ name: 'Dev', command: 'pnpm dev' }],
      personal: [],
      personalAvailable: true,
    })
    setTerminalCommands.mockResolvedValue({ project: [], personal: [], personalAvailable: true })
    render(<TerminalCommandsSection />)
    await screen.findByDisplayValue('pnpm dev')
    fireEvent.click(screen.getByRole('button', { name: 'Remove command 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(setTerminalCommands).toHaveBeenCalledWith({ scope: 'project', commands: [] }))
  })

  it('cannot save where the terminal is off', async () => {
    terminal = false
    getTerminalCommands.mockResolvedValue({ project: [{ name: 'a', command: 'b' }], personal: [], personalAvailable: true })
    render(<TerminalCommandsSection />)
    await screen.findByDisplayValue('b')
    fireEvent.change(screen.getByLabelText('Command line 1'), { target: { value: 'c' } })
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('disables the personal scope when the project is not in the registry', async () => {
    getTerminalCommands.mockResolvedValue({ project: [], personal: [], personalAvailable: false })
    render(<TerminalCommandsSection />)
    await screen.findByText(/None yet/)
    expect((screen.getByRole('radio', { name: /Only me/ }) as HTMLButtonElement).disabled).toBe(true)
  })
})
