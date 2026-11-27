import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** The project workspace (#1608): Preview + project terminal, no run. */

let terminalAllowed = true
const api = { getRunTerminal: vi.fn(), createRunTerminal: vi.fn(), getProjectTerminal: vi.fn() }

vi.mock('@/api/client', () => ({
  getRunTerminal: (...a: unknown[]) => api.getRunTerminal(...(a as [])),
  createRunTerminal: (...a: unknown[]) => api.createRunTerminal(...(a as [])),
  getProjectTerminal: (...a: unknown[]) => api.getProjectTerminal(...(a as [])),
}))
vi.mock('@/api/queries', () => ({
  useHealth: () => ({ data: { capabilities: { terminal: terminalAllowed, localHandoff: true, designMode: false } } }),
}))
vi.mock('@/lib/project-router', () => ({ useActiveProjectId: () => 'cezar' }))
vi.mock('../task-workspace/terminal-drawer', () => ({
  TerminalDrawer: ({ scope }: { scope: { runId?: string; key: string } }) => (
    <div data-testid="drawer" data-run={scope.runId ?? ''} data-key={scope.key} />
  ),
}))

const { ProjectWorkspaceRoute } = await import('./project-workspace')

const mount = (search: string) =>
  render(
    <MemoryRouter initialEntries={[`/p/cezar/workspace${search}`]}>
      <ProjectWorkspaceRoute />
    </MemoryRouter>,
  )

beforeEach(() => {
  terminalAllowed = true
  for (const fn of Object.values(api)) fn.mockClear()
})
afterEach(cleanup)

describe('ProjectWorkspaceRoute', () => {
  it('frames the exact address, keeping port and path, beside a project-scoped terminal', async () => {
    const { container } = mount(`?preview=${encodeURIComponent('http://127.0.0.1:3456/backend?x=1')}`)
    const frame = container.querySelector('iframe')
    expect(frame?.getAttribute('src')).toBe('http://127.0.0.1:3456/backend?x=1')
    const drawer = await screen.findByTestId('drawer')
    expect(drawer.getAttribute('data-run')).toBe('')
    expect(drawer.getAttribute('data-key')).toContain('cezar')
    // No run exists: no task terminal is read or created.
    expect(api.getRunTerminal).not.toHaveBeenCalled()
    expect(api.createRunTerminal).not.toHaveBeenCalled()
  })

  it.each(['javascript:void(0)', 'file:///etc/passwd'])('refuses %s in the address', (bad) => {
    const { container } = mount(`?preview=${encodeURIComponent(bad)}`)
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.querySelector('[data-slot="preview-rejected"]')?.textContent).toContain('http://')
  })

  it('opens an empty preview when no address was given', () => {
    const { container } = mount('')
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.querySelector('[data-slot="preview-rejected"]')).toBeNull()
  })

  it('keeps the terminal off where the policy is off, preview untouched', () => {
    terminalAllowed = false
    const { container } = mount('?preview=http%3A%2F%2F127.0.0.1%3A3000%2F')
    expect(screen.getByText('Terminal disabled')).not.toBeNull()
    expect(screen.queryByTestId('drawer')).toBeNull()
    expect(container.querySelector('iframe')).not.toBeNull()
  })
})
