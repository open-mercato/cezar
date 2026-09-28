import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { EditorTrackerFields } from './editor-tracker-fields'
import { getTrackerItems, getTrackerAutomationOptions } from '@/api/client'

vi.mock('@/api/client', () => ({ getTrackerAutomationOptions: vi.fn(), getTrackerItems: vi.fn() }))
beforeEach(() => { vi.mocked(getTrackerItems).mockResolvedValue({ available: true, items: [], truncated: false }) })
afterEach(() => { cleanup(); vi.resetAllMocks() })
const association = { kind: 'jira' as const, source: { id: 'cloud', webUrl: 'https://fixture.atlassian.net' }, externalId: '1', externalName: 'Project', connectionId: 'connection' }
const data = { available: true as const, association, events: ['issue.status_changed' as const], statuses: [{ id: 'todo', name: 'To Do' }], labels: [], limitations: [] }

it('keeps the search field and focus during a pending search and explains empty results', async () => {
  let resolve!: (value: typeof data) => void
  vi.mocked(getTrackerAutomationOptions).mockImplementation(async query => query?.search ? new Promise(r => { resolve = r }) : data)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><EditorTrackerFields trigger={{ association, events: ['issue.status_changed'], targetStatusIds: ['todo'] }} intervalSeconds={1800} onChange={vi.fn()} onValid={vi.fn()} /></QueryClientProvider>)
  const input = await screen.findByRole('textbox', { name: 'Search tracker statuses' })
  input.focus()
  fireEvent.change(input, { target: { value: 'missing' } })
  await waitFor(() => expect(resolve).toBeDefined())
  expect(screen.getByRole('textbox', { name: 'Search tracker statuses' })).toBe(input)
  expect(document.activeElement).toBe(input)
  expect(input.getAttribute('aria-label')).toBe('Search tracker statuses')
  await act(async () => resolve({ ...data, statuses: [] }))
  expect(await screen.findByText('No matching statuses.')).not.toBeNull()
  expect(screen.getByRole('textbox', { name: 'Search tracker statuses' })).toBe(input)
  fireEvent.change(input, { target: { value: '' } })
  expect(await screen.findByRole('button', { name: 'To Do' })).not.toBeNull()
  client.clear()
})

it('keeps the search editable after failure and retries without losing the selected event', async () => {
  let fail = true
  vi.mocked(getTrackerAutomationOptions).mockImplementation(async query => {
    if (query?.search && fail) throw new Error('offline')
    return data
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onValid = vi.fn()
  render(<QueryClientProvider client={client}><EditorTrackerFields trigger={{ association, events: ['issue.status_changed'], targetStatusIds: ['todo'] }} intervalSeconds={1800} onChange={vi.fn()} onValid={onValid} /></QueryClientProvider>)
  const input = await screen.findByRole('textbox', { name: 'Search tracker statuses' })
  fireEvent.change(input, { target: { value: 'To' } })
  const retry = await screen.findByRole('button', { name: 'Retry search' })
  expect(screen.getByRole('textbox', { name: 'Search tracker statuses' })).toBe(input)
  expect(onValid).toHaveBeenLastCalledWith(true)
  fail = false
  fireEvent.click(retry)
  expect(await screen.findByRole('button', { name: 'To Do' })).not.toBeNull()
  expect((screen.getByRole('textbox', { name: 'Search tracker statuses' }) as HTMLInputElement).value).toBe('To')
  client.clear()
})

it('edits all required label names for creation events without requiring label history support', async () => {
  vi.mocked(getTrackerAutomationOptions).mockResolvedValue({ ...data, events: ['issue.opened'] })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onChange = vi.fn()
  render(<QueryClientProvider client={client}><EditorTrackerFields trigger={{ association, events: ['issue.opened'], requiredLabels: ['bug'] }} intervalSeconds={1800} onChange={onChange} onValid={vi.fn()} /></QueryClientProvider>)
  const bug = await screen.findByRole('button', { name: 'bug', pressed: true })
  expect(screen.queryByRole('textbox')).toBeNull()
  fireEvent.click(bug)
  expect(onChange).toHaveBeenLastCalledWith({ trackerTrigger: { association, events: ['issue.opened'], requiredLabels: [] } })
  client.clear()
})

it.each(['not_configured', 'credentials_missing', 'source_changed'] as const)('handles %s without loading label suggestions or allowing save', async code => {
  vi.mocked(getTrackerAutomationOptions).mockResolvedValue({ available: false, code, reason: 'Connect a tracker in project Settings.' })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onValid = vi.fn()
  render(<QueryClientProvider client={client}><EditorTrackerFields trigger={{ association, events: ['issue.opened'] }} intervalSeconds={1800} onChange={vi.fn()} onValid={onValid} /></QueryClientProvider>)
  expect((await screen.findByRole('alert')).textContent).toContain('project Settings')
  expect(onValid).toHaveBeenLastCalledWith(false)
  expect(getTrackerItems).not.toHaveBeenCalled()
  expect(screen.queryByRole('group', { name: 'Required labels' })).toBeNull()
  client.clear()
})


it('keeps a saved status absent from tracker options visible and removable', async () => {
  vi.mocked(getTrackerAutomationOptions).mockResolvedValue(data)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onChange = vi.fn()
  render(<QueryClientProvider client={client}><EditorTrackerFields trigger={{ association, events: ['issue.status_changed'], targetStatusIds: ['removed', 'todo'], requiredLabels: ['bug'] }} intervalSeconds={1800} onChange={onChange} onValid={vi.fn()} /></QueryClientProvider>)
  fireEvent.click(await screen.findByRole('button', { name: /removed.*not in current results/i, pressed: true }))
  expect(onChange).toHaveBeenLastCalledWith({ trackerTrigger: { association, events: ['issue.status_changed'], targetStatusIds: ['todo'], requiredLabels: ['bug'] } })
  client.clear()
})

it('keeps selected statuses removable while searches are pending or exclude them', async () => {
  let resolve!: (value: typeof data) => void
  vi.mocked(getTrackerAutomationOptions).mockImplementation(async query => query?.search ? new Promise(r => { resolve = r }) : data)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onChange = vi.fn()
  render(<QueryClientProvider client={client}><EditorTrackerFields trigger={{ association, events: ['issue.status_changed'], targetStatusIds: ['todo'] }} intervalSeconds={1800} onChange={onChange} onValid={vi.fn()} /></QueryClientProvider>)
  fireEvent.change(await screen.findByRole('textbox', { name: 'Search tracker statuses' }), { target: { value: 'other' } })
  await waitFor(() => expect(resolve).toBeDefined())
  expect(screen.getByRole('button', { name: /To Do/, pressed: true })).not.toBeNull()
  await act(async () => resolve({ ...data, statuses: [] }))
  fireEvent.click(await screen.findByRole('button', { name: /To Do/, pressed: true }))
  expect(onChange).toHaveBeenLastCalledWith({ trackerTrigger: { association, events: ['issue.status_changed'], targetStatusIds: [] } })
  expect(screen.queryByText(/deleted|unavailable/i)).toBeNull()
  client.clear()
})

it('clears hidden status filters when removing the status event while preserving the rest of the draft', async () => {
  vi.mocked(getTrackerAutomationOptions).mockResolvedValue({ ...data, events: ['issue.opened', 'issue.status_changed'] })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onChange = vi.fn()
  render(<QueryClientProvider client={client}><EditorTrackerFields trigger={{ association, events: ['issue.opened', 'issue.status_changed'], targetStatusIds: ['removed'], requiredLabels: ['bug'] }} intervalSeconds={1800} onChange={onChange} onValid={vi.fn()} /></QueryClientProvider>)
  fireEvent.click(await screen.findByRole('button', { name: 'issue.status_changed', pressed: true }))
  expect(onChange).toHaveBeenLastCalledWith({ trackerTrigger: { association, events: ['issue.opened'], requiredLabels: ['bug'] } })
  client.clear()
})
