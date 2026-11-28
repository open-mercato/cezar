import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'

const getTaskTags = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  getTaskTags: (...args: unknown[]) => getTaskTags(...args),
}))

import { TaskTagPicker } from './task-tag-picker'

/** A tag created in another tab must be offered the next time a picker opens (registry edits
 *  have no live channel). */
describe('TaskTagPicker', () => {
  it('re-reads the registry each time it opens', async () => {
    getTaskTags
      .mockResolvedValueOnce({ tags: [], deletedIds: [] })
      .mockResolvedValue({ tags: [{ id: 'tt-review00001', name: 'Review', projectId: 'p', createdAt: '' }], deletedIds: [] })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5 * 60_000, refetchOnWindowFocus: false } } })
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <TaskTagPicker projectId="p" stateOf={() => 'empty'} onToggle={() => {}}>
            <button type="button">open</button>
          </TaskTagPicker>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await waitFor(() => expect(getTaskTags).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'open' }))
    expect(await screen.findByText('Review')).toBeTruthy()
    expect(getTaskTags).toHaveBeenCalledTimes(2)
  })
})
