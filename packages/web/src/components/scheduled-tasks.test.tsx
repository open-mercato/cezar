import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router'
import { ScheduledTasks } from './scheduled-tasks'
const mocks = vi.hoisted(() => ({ data: { automations: [] as unknown[] }, update: vi.fn(async () => {}), copy: vi.fn(async () => {}), cancel: vi.fn(async () => {}), invalidate: vi.fn(async () => {}) }))
vi.mock('@/api/client', async importOriginal => ({ ...(await importOriginal<typeof import('@/api/client')>()), deleteAutomation: mocks.cancel, runAutomationNow: vi.fn(), updateAutomation: mocks.update }))
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: mocks.invalidate }) }))
vi.mock('@/lib/project-router', () => ({ useNavigate: () => vi.fn(), Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a> }))
vi.mock('@/routes/automations/use-automations', () => ({ automationsQueryKey: () => [], useAutomationsGate: () => ({ known: true, off: false }), useAutomationsQuery: () => ({ data: mocks.data }) }))
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals() })
function renderTask(failureKind: 'binding-invalid' | 'transient' | 'ambiguous', runIds: string[] = [], expand = true) {
  vi.stubGlobal('navigator', { clipboard: { writeText: mocks.copy } })
  mocks.data.automations = [{ id: 'later', revision: 2, name: 'Later', task: { prompt: 'Preserve {{literal}}', steps: [{ id: 'task', skill: 'review' }] },
    deferredStart: { notBefore: '2099-01-01T09:00:00Z', timeZone: 'UTC', status: 'failed', failureKind, error: 'Workflow changed. Cancel and submit again.', runIds,
      binding: { accounts: [{ runner: 'claude', id: 'default' }], models: [{ step: 'task', runner: 'claude', model: 'sonnet' }, { step: 'review', runner: 'claude', model: 'opus' }] } } }]
  render(<MemoryRouter initialEntries={['/' + window.location.hash]}><ScheduledTasks /></MemoryRouter>)
  if (expand) fireEvent.click(screen.getByText('Later', { selector: 'span.font-medium' }))
}
it('offers copying/cancellation and a re-check, but no time change, for an invalid binding', async () => {
  renderTask('binding-invalid')
  // Restoring the account or workflow makes Retry succeed (spec), so it stays available.
  expect((screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(false)
  expect((screen.getByRole('button', { name: 'Change time' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }))
  await waitFor(() => expect(mocks.copy).toHaveBeenCalledWith('Preserve {{literal}}'))
  await waitFor(() => expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith('later', 2))
})
it('retains retry for transient failures and displays resolved models and skill label', () => {
  renderTask('transient')
  expect((screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(false)
  expect((screen.getByRole('button', { name: 'Change time' }) as HTMLButtonElement).disabled).toBe(false)
  expect(screen.getByText(/Skills: review/).textContent).toContain('task: claude / sonnet; review: claude / opus')
  expect(screen.queryByText(/Approved plan/)).toBeNull()
})
it('gives an uncertain launch an exit: start only the missing runs, or dismiss', async () => {
  renderTask('ambiguous', ['run-a', 'run-b'])
  expect((screen.getByRole('button', { name: 'Start missing runs' }) as HTMLButtonElement).disabled).toBe(false)
  expect((screen.getByRole('button', { name: 'Change time' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
  await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith('later', 2))
})
it('opens the entry the sidebar links to', () => {
  window.location.hash = '#scheduled-later'
  renderTask('transient', [], false)
  expect((document.getElementById('scheduled-later') as HTMLDetailsElement).open).toBe(true)
  window.location.hash = ''
})

function pendingTask(revision = 1) {
  const refreshed = revision > 1
  return {
    id: 'later', revision, name: 'Later', task: { prompt: 'Task', workflow: 'quick-task' },
    schedule: { type: 'once', date: refreshed ? '2099-02-02' : '2099-01-01', hour: refreshed ? 15 : 9, minute: refreshed ? 30 : 0 },
    deferredStart: { notBefore: refreshed ? '2099-02-02T15:30:00Z' : '2099-01-01T09:00:00Z', timeZone: 'UTC', status: 'pending', runIds: [], binding: { accounts: [] } },
  }
}
it('opens the current schedule after a refresh and saves that revision and time', async () => {
  mocks.data.automations = [pendingTask()]
  const view = render(<MemoryRouter><ScheduledTasks /></MemoryRouter>)
  mocks.data.automations = [pendingTask(2)]
  view.rerender(<MemoryRouter><ScheduledTasks /></MemoryRouter>)
  fireEvent.click(screen.getByText('Later', { selector: 'span.font-medium' }))
  fireEvent.click(screen.getByRole('button', { name: 'Change time' }))
  expect((screen.getByLabelText('Date') as HTMLInputElement).value).toBe('2099-02-02')
  expect((screen.getByLabelText('Time (server time zone)') as HTMLInputElement).value).toBe('15:30')
  fireEvent.click(screen.getByRole('button', { name: 'Save time' }))
  await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('later', expect.objectContaining({
    expectedRevision: 2, schedule: { type: 'once', date: '2099-02-02', hour: 15, minute: 30 },
  })))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Save time' })).toBeNull())
})
it('keeps an active edit tied to its original revision and reloads current values when reopened', async () => {
  mocks.data.automations = [pendingTask()]
  const view = render(<MemoryRouter><ScheduledTasks /></MemoryRouter>)
  fireEvent.click(screen.getByText('Later', { selector: 'span.font-medium' }))
  fireEvent.click(screen.getByRole('button', { name: 'Change time' }))
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2099-03-03' } })
  fireEvent.change(screen.getByLabelText('Time (server time zone)'), { target: { value: '12:45' } })
  mocks.data.automations = [pendingTask(2)]
  view.rerender(<MemoryRouter><ScheduledTasks /></MemoryRouter>)
  expect((screen.getByLabelText('Date') as HTMLInputElement).value).toBe('2099-03-03')
  expect((screen.getByLabelText('Time (server time zone)') as HTMLInputElement).value).toBe('12:45')
  mocks.update.mockRejectedValueOnce(new Error('Schedule changed. Reload and try again.'))
  fireEvent.click(screen.getByRole('button', { name: 'Save time' }))
  await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('later', expect.objectContaining({
    expectedRevision: 1, schedule: { type: 'once', date: '2099-03-03', hour: 12, minute: 45 },
  })))
  expect((await screen.findByRole('alert')).textContent).toBe('Schedule changed. Reload and try again.')
  expect((screen.getByLabelText('Date') as HTMLInputElement).value).toBe('2099-03-03')
  await waitFor(() => expect((screen.getByRole('button', { name: 'Change time' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'Change time' }))
  fireEvent.click(screen.getByRole('button', { name: 'Change time' }))
  expect((screen.getByLabelText('Date') as HTMLInputElement).value).toBe('2099-02-02')
  expect((screen.getByLabelText('Time (server time zone)') as HTMLInputElement).value).toBe('15:30')
  fireEvent.click(screen.getByRole('button', { name: 'Save time' }))
  await waitFor(() => expect(mocks.update).toHaveBeenLastCalledWith('later', expect.objectContaining({
    expectedRevision: 2, schedule: { type: 'once', date: '2099-02-02', hour: 15, minute: 30 },
  })))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Save time' })).toBeNull())
})

it('opens an already mounted entry after router hash navigation', async () => {
  const { Link } = await import('react-router')
  mocks.data.automations = [pendingTask()]
  render(<MemoryRouter><Link to="/#scheduled-later">Sidebar target</Link><ScheduledTasks /></MemoryRouter>)
  expect((document.getElementById('scheduled-later') as HTMLDetailsElement).open).toBe(false)
  fireEvent.click(screen.getByText('Sidebar target'))
  await waitFor(() => expect((document.getElementById('scheduled-later') as HTMLDetailsElement).open).toBe(true))
})

it('keeps links after cancellation loses to launch and the scheduled row disappears', async () => {
  const { ApiError } = await import('@/api/client')
  mocks.data.automations = [pendingTask()]
  const view = render(<MemoryRouter><ScheduledTasks /></MemoryRouter>)
  fireEvent.click(screen.getByText('Later', { selector: 'span.font-medium' }))
  mocks.cancel.mockRejectedValueOnce(new ApiError(409, 'This scheduled task already started.', { runIds: ['run-a', 'run-b'] }))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await screen.findByText('View run 1')
  mocks.data.automations = []
  view.rerender(<MemoryRouter><ScheduledTasks /></MemoryRouter>)
  expect(screen.getByText('View run 1').getAttribute('href')).toBe('/tasks/run-a')
  expect(screen.getByText('View run 2')).toBeTruthy()
})
