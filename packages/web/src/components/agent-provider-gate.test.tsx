import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it } from 'vitest'
import { AgentProviderGate } from './agent-provider-gate'
import type { ResolvedEngine } from './engine-pills'

afterEach(cleanup)
const base: Pick<ResolvedEngine, 'providerPending' | 'providerError' | 'canRun' | 'runners' | 'accessModeError'> = {
  providerPending: false, providerError: false, canRun: false, runners: ['codex'],
}
const show = (over: Partial<typeof base> = {}) => render(<MemoryRouter><AgentProviderGate resolved={{ ...base, ...over }} /></MemoryRouter>)

it('explains incompatible access selection without telling a connected user to sign in again', () => {
  show({ accessModeError: 'Choose an available model or Native default.' })
  expect(screen.getByRole('status').textContent).toContain('Native default')
  expect(screen.queryByText('Configure providers')).toBeNull()
})

it('preserves provider failure guidance when selection metadata is also unavailable', () => {
  show({ providerError: true, accessModeError: 'Choose Native default.' })
  expect(screen.getByText('Provider authentication could not be verified.')).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Configure providers' })).toBeTruthy()
})

it('preserves the disconnected-provider boundary', () => {
  show({ runners: [], accessModeError: 'Choose Native default.' })
  expect(screen.getByText('Connect an agent provider to run this item.')).toBeTruthy()
})

it('stays quiet while providers load or the selection can run', () => {
  const view = show({ providerPending: true })
  expect(view.container.textContent).toBe('')
  view.rerender(<MemoryRouter><AgentProviderGate resolved={{ ...base, canRun: true }} /></MemoryRouter>)
  expect(view.container.textContent).toBe('')
})
