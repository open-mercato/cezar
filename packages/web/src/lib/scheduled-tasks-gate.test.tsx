import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useScheduledTasksGate } from './scheduled-tasks-gate'

const state = vi.hoisted(() => ({
  off: false,
  data: undefined as { automations: { deferredStart?: unknown }[] } | undefined,
  listeners: new Set<(name: string, payload: unknown) => void>(),
}))
vi.mock('@/routes/automations/use-automations', () => ({
  useAutomationsGate: () => ({ known: true, off: state.off }),
  useAutomationsQuery: () => ({ data: state.data, dataUpdatedAt: state.data ? 1 : 0 }),
}))
vi.mock('@/api/global-events', () => ({
  onWorkspaceEvent: (listener: (name: string, payload: unknown) => void) => {
    state.listeners.add(listener)
    return () => state.listeners.delete(listener)
  },
}))

function Probe() {
  return <output data-testid="gate">{String(useScheduledTasksGate())}</output>
}
const gate = () => screen.getByTestId('gate').textContent
const emit = (name: string, payload: unknown) => act(() => { for (const listener of state.listeners) listener(name, payload) })

beforeEach(() => { state.off = false; state.data = undefined })
afterEach(() => { cleanup() })

it('asks once per session, so a schedule made in another browser or the CLI still shows', () => {
  render(<MemoryRouter initialEntries={['/p/fresh/']}><Probe /></MemoryRouter>)
  expect(gate()).toBe('true')
})

it('closes after a read finds nothing, and reopens live when an automation changes in this project', () => {
  state.data = { automations: [] }
  const view = render(<MemoryRouter initialEntries={['/p/one/']}><Probe /></MemoryRouter>)
  expect(gate()).toBe('false')
  emit('automation-change', { project: 'other' })
  expect(gate()).toBe('false')
  state.data = undefined
  emit('automation-change', { project: 'one' })
  view.rerender(<MemoryRouter initialEntries={['/p/one/']}><Probe /></MemoryRouter>)
  expect(gate()).toBe('true')
})

it('stays closed while automations are off', () => {
  state.off = true
  render(<MemoryRouter initialEntries={['/p/two/']}><Probe /></MemoryRouter>)
  expect(gate()).toBe('false')
})
