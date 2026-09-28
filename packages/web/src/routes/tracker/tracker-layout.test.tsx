import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { TrackerRoute } from './tracker'
const desktop = vi.hoisted(() => ({ value: true }))
vi.mock('@/lib/use-desktop', () => ({ useIsDesktop: () => desktop.value }))
vi.mock('@/components/engine-pills', () => ({ EnginePills: () => null, engineRunBody: () => ({}), useResolvedEngine: () => ({ canRun: true }) }))
beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }) })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); desktop.value = true })
const association = { kind: 'jira', source: { id: 's', webUrl: 'https://jira.example.com' }, externalId: '1', externalName: 'OPS' }
const item = (id: string) => ({ kind: 'issue', id, title: `Title ${id}`, body: `Full description ${id}`, author: 'Ada', createdAt: '2026-09-19T00:00:00Z', updatedAt: '2026-09-19T00:00:00Z', status: 'In progress', labels: ['bug'], bodyTruncated: false, unsupportedContent: false, url: `https://jira.example.com/${id}` })
function mount(path = '/tracker', missing = false) {
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input); requests.push(url)
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 })
    if (url.endsWith('/tracker/association')) return json({ association })
    if (new URL(url, 'http://localhost').pathname.endsWith('/tracker/OPS-1')) return json({ available: true, item: item('OPS-1') })
    if (new URL(url, 'http://localhost').pathname.endsWith('/tracker/OPS-2')) return json(missing ? { available: false, code: 'unavailable', reason: 'Offline' } : { available: true, item: item('OPS-2') })
    if (url.endsWith('/workflows')) return json({ workflows: [{ name: 'review', description: 'Review the task', steps: [] }] })
    if (url.includes('/tracker?') || url.includes('/tracker/search?')) return json({ available: true, items: url.includes('nothing') ? [] : [item('OPS-1'), item('OPS-2')], truncated: false })
    return new Promise<never>(() => {})
  }))
  render(<MemoryRouter initialEntries={[path]}><QueryClientProvider client={createQueryClient()}><Routes><Route path="/tracker/:id?" element={<TrackerRoute />} /></Routes></QueryClientProvider></MemoryRouter>)
  return requests
}
it('shows compact list beside detail on desktop and retains search draft when opening another issue', async () => {
  mount()
  expect(await screen.findByText('Full description OPS-1')).toBeTruthy()
  const list = document.querySelector('[data-slot="tracker-list"]') as HTMLElement
  expect(list).toBeTruthy()
  expect(within(list).queryByText('Full description OPS-1')).toBeNull()
  fireEvent.change(screen.getByLabelText('Search tracker'), { target: { value: 'Unsubmitted filter' } })
  fireEvent.click(within(list).getByText('Title OPS-2'))
  expect(await screen.findByText('Full description OPS-2')).toBeTruthy()
  expect((screen.getByLabelText('Search tracker') as HTMLInputElement).value).toBe('Unsubmitted filter')
  expect(within(list).getByText('Title OPS-2').closest('a')?.getAttribute('aria-current')).toBe('page')
})
it('mobile deep link loads detail without starting list demand and exposes back navigation', async () => {
  desktop.value = false
  const requests = mount('/tracker/OPS-2')
  expect(await screen.findByText('Full description OPS-2')).toBeTruthy()
  expect(requests.some(url => url.includes('/tracker?') || url.includes('/tracker/watch'))).toBe(false)
  fireEvent.click(screen.getByRole('link', { name: /Back to the list/ }))
  await waitFor(() => expect(requests.some(url => url.includes('/tracker?'))).toBe(true))
  expect(screen.queryByText('Full description OPS-2')).toBeNull()
})

it('retains per-issue draft and shared workflow choice while switching rows', async () => {
  mount()
  await screen.findByText('Full description OPS-1')
  fireEvent.change(screen.getByLabelText('Custom instruction'), { target: { value: 'Keep issue one draft' } })
  fireEvent.click(screen.getByRole('button', { name: 'Choose a workflow' }))
  fireEvent.click(await screen.findByRole('option', { name: /review/i }))
  const list = document.querySelector('[data-slot="tracker-list"]') as HTMLElement
  fireEvent.click(within(list).getByText('Title OPS-2'))
  await screen.findByText('Full description OPS-2')
  expect((screen.getByLabelText('Custom instruction') as HTMLTextAreaElement).value).toBe('')
  expect(screen.getByRole('button', { name: 'Choose a workflow' }).textContent).toBe('review')
  fireEvent.click(within(list).getByText('Title OPS-1'))
  await screen.findByText('Full description OPS-1')
  expect((screen.getByLabelText('Custom instruction') as HTMLTextAreaElement).value).toBe('Keep issue one draft')
})
it('retains mobile back navigation when a deep-linked issue cannot load', async () => {
  desktop.value = false
  mount('/tracker/OPS-2', true)
  await screen.findByText('Offline')
  expect(screen.getByRole('link', { name: /Back to the list/ })).toBeTruthy()
})
it('filters using an arbitrary label beyond the loaded suggestions', async () => {
  const requests = mount()
  await screen.findByText('Full description OPS-1')
  fireEvent.click(screen.getByRole('button', { name: 'Filter labels' }))
  fireEvent.change(screen.getByRole('combobox', { name: 'Find or add label' }), { target: { value: 'not-loaded' } })
  fireEvent.click(screen.getByRole('option', { name: /Use label/ }))
  await waitFor(() => expect(requests.some(url => new URL(url, 'http://localhost').searchParams.get('labels') === '["not-loaded"]')).toBe(true))
})

it('clears implicit detail for an explicit search with no matches', async () => {
  mount()
  await screen.findByText('Full description OPS-1')
  fireEvent.change(screen.getByLabelText('Search tracker'), { target: { value: 'nothing' } })
  fireEvent.click(screen.getByRole('button', { name: 'Search' }))
  await screen.findByText('No issues match this search.')
  expect(screen.queryByText('Full description OPS-1')).toBeNull()
  expect(screen.getByText('Nothing selected')).toBeTruthy()
})
