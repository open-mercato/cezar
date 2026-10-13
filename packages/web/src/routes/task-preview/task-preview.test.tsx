import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PREVIEW_TABS_STORAGE_PREFIX, TaskPreviewRoute } from './task-preview'

/** `/tasks/:id/preview` — the route hosting the Preview tab: its header, and tabs kept per task. */

const run = { id: 'r1', status: 'waiting' }
vi.mock('@/api/queries', () => ({
  useRun: () => ({ isPending: false, isError: false, data: run }),
  useRunDrafts: () => ({ isSuccess: true, data: { surfaces: {} } }),
  useHealth: () => ({ data: { capabilities: { localHandoff: true, designMode: true } } }),
}))
vi.mock('@/api/client', () => ({ openDesignProxy: vi.fn(() => new Promise(() => {})), putRunDraft: vi.fn(), sendMessage: vi.fn(), continueRun: vi.fn(), ApiError: Error }))
vi.mock('../task-thread/run-header', () => ({
  RunHeader: ({ tab }: { tab: string }) => <div data-testid="run-header" data-tab={tab} />,
}))

function renderRoute() {
  return render(
    <MemoryRouter initialEntries={['/tasks/r1/preview']}>
      <Routes>
        <Route path="/tasks/:id/preview" element={<TaskPreviewRoute />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe('TaskPreviewRoute', () => {
  it('renders under the run header with the Preview tab active, on an empty tab', () => {
    renderRoute()
    expect(screen.getByTestId('run-header').getAttribute('data-tab')).toBe('preview')
    expect(screen.getByText('Empty tab')).toBeTruthy()
    expect(document.querySelector('[data-slot=browser-design-toggle]')).not.toBeNull()
  })

  it('reopens on the tabs this browser saved for the task', () => {
    localStorage.setItem(PREVIEW_TABS_STORAGE_PREFIX + 'r1', JSON.stringify({ tabs: ['http://localhost:5173/'], active: 0 }))
    renderRoute()
    expect((screen.getByLabelText('Address') as HTMLInputElement).value).toBe('http://localhost:5173/')
    expect(document.querySelector('iframe')?.getAttribute('src')).toBe('http://localhost:5173/')
  })

  it('treats a corrupt saved value as a blank tab', () => {
    localStorage.setItem(PREVIEW_TABS_STORAGE_PREFIX + 'r1', '{nope')
    renderRoute()
    expect(screen.getByText('Empty tab')).toBeTruthy()
  })
})
