import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { getTrackerItems } from '@/api/client'
import { TrackerLabelSuggestions } from './tracker-label-suggestions'
vi.mock('@/api/client', () => ({ getTrackerItems: vi.fn() }))
afterEach(() => { cleanup(); vi.resetAllMocks() })
const association = { kind: 'jira' as const, source: { id: 'cloud', webUrl: 'https://fixture.atlassian.net' }, externalId: '1', externalName: 'Project', connectionId: 'one' }
const page = (labels: string[], nextCursor?: string) => ({ available: true as const, items: [{ kind: 'issue' as const, author: '', createdAt: '2026-09-19T00:00:00Z', updatedAt: '2026-09-19T00:00:00Z', body: '', bodyTruncated: false, unsupportedContent: false, id: '1', title: 'Task', url: 'https://fixture.atlassian.net/browse/P-1', status: 'Done', labels }], truncated: !!nextCursor, ...(nextCursor ? { nextCursor } : {}) })
it('loads scoped labels including closed tasks, filters locally and paginates on demand', async () => {
  vi.mocked(getTrackerItems).mockImplementation(async query => query?.cursor ? page(['urgent', 'bug']) : page(['bug', 'feature', 'bug'], 'next'))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const choose = vi.fn()
  render(<QueryClientProvider client={client}><TrackerLabelSuggestions association={association} selected={['feature']} onSelect={choose} onRemove={vi.fn()} /></QueryClientProvider>)
  fireEvent.click(await screen.findByRole('button', { name: 'bug' }))
  expect(choose).toHaveBeenCalledWith('bug')
  expect(screen.getByRole('button', { name: 'feature', pressed: true })).not.toBeNull()
  expect(getTrackerItems).toHaveBeenCalledWith(expect.objectContaining({ state: 'all', limit: 50 }), expect.anything())
  fireEvent.click(screen.getByRole('button', { name: 'Load labels from more tasks' }))
  expect(await screen.findByRole('button', { name: 'urgent' })).not.toBeNull()
  expect(screen.queryByText('The provider returned a limited task list. Other labels can be entered manually.')).toBeNull()
  expect(getTrackerItems).toHaveBeenCalledTimes(2)
  client.clear()
})
it('discards old scope suggestions and presents a retry when loading fails', async () => {
  vi.mocked(getTrackerItems).mockResolvedValueOnce(page(['old-project-label'])).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(page(['new-project-label']))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = (externalId: string) => <QueryClientProvider client={client}><TrackerLabelSuggestions association={{ ...association, externalId }} selected={[]} onSelect={vi.fn()} onRemove={vi.fn()} /></QueryClientProvider>
  const { rerender } = render(view('1'))
  await screen.findByRole('button', { name: 'old-project-label' })
  rerender(view('2'))
  expect(screen.queryByRole('button', { name: 'old-project-label' })).toBeNull()
  fireEvent.click(await screen.findByRole('button', { name: 'Retry label suggestions' }))
  await screen.findByRole('button', { name: 'new-project-label' })
  await waitFor(() => expect(getTrackerItems).toHaveBeenCalledTimes(3))
  client.clear()
})

it('offers only clickable toggles and preserves saved labels missing from fetched tasks', async () => {
  vi.mocked(getTrackerItems).mockResolvedValue(page(['bug']))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const select = vi.fn(), remove = vi.fn()
  render(<QueryClientProvider client={client}><TrackerLabelSuggestions association={association} selected={['saved-label']} onSelect={select} onRemove={remove} /></QueryClientProvider>)
  const bug = await screen.findByRole('button', { name: 'bug', pressed: false })
  expect(screen.queryByRole('textbox')).toBeNull()
  fireEvent.click(bug)
  expect(select).toHaveBeenCalledWith('bug')
  fireEvent.click(screen.getByRole('button', { name: 'saved-label', pressed: true }))
  expect(remove).toHaveBeenCalledWith('saved-label')
  client.clear()
})
