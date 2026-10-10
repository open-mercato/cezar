import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { ShellProviders } from '@/test/shell-providers'
import { ShellWithSidebar } from '@/test/shell-with-sidebar'
import { TrackerRoute } from './tracker'
vi.mock('@/components/engine-pills', () => ({ EnginePills: () => null, engineRunBody: () => ({}), useResolvedEngine: () => ({ canRun: true }) }))
beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const association = { kind: 'jira', source: { id: 's', webUrl: 'https://jira.example.com' }, externalId: '1', externalName: 'OPS' }
const item = (id: string) => ({ kind: 'issue', id, title: `Title ${id}`, body: `Full description ${id}`, author: 'Ada', createdAt: '2026-09-19T00:00:00Z', updatedAt: '2026-09-19T00:00:00Z', status: 'In progress', labels: ['bug'], bodyTruncated: false, unsupportedContent: false, url: `https://jira.example.com/${id}` })
/** A phone. The layout follows `useSidebar().isMobile`, which reads the window width behind a
 *  `matchMedia` listener (it used to follow `useIsDesktop`). */
function asPhone() {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('innerWidth', 390)
}
/** The issue list lives in the shell's contextual sidebar: a column on desktop — hosted here by
 *  `ShellWithSidebar` — and a sheet on a phone, which is closed until asked for, so a phone gets
 *  the shell contexts without a mounted sidebar. */
function mount(path = '/tracker', { missing = false, phone = false }: { missing?: boolean; phone?: boolean } = {}) {
  if (phone) asPhone()
  const Shell = phone ? ShellProviders : ShellWithSidebar
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
  render(<MemoryRouter initialEntries={[path]}><QueryClientProvider client={createQueryClient()}><Shell><Routes><Route path="/tracker/:id?" element={<TrackerRoute />} /></Routes></Shell></QueryClientProvider></MemoryRouter>)
  return requests
}
const sidebarList = () => document.querySelector('[data-slot="context-sidebar-body"] [data-slot="tracker-list"]') as HTMLElement
/** The hand-off composer is a dialog over the issue, opened from its header. */
async function openHand() {
  fireEvent.click(await screen.findByRole('button', { name: 'Hand to agent' }))
  return screen.findByLabelText('Custom instruction')
}
async function closeHand() {
  fireEvent.click(document.querySelector('[data-slot="tracker-hand-dialog"] [data-slot="dialog-close"]')!)
  await waitFor(() => expect(document.querySelector('[data-slot="tracker-hand-dialog"]')).toBeNull())
}
it('shows compact list beside detail on desktop and retains search draft when opening another issue', async () => {
  mount('/tracker/OPS-1')
  expect(await screen.findByText('Full description OPS-1')).toBeTruthy()
  const list = sidebarList()
  expect(list).toBeTruthy()
  expect(within(list).queryByText('Full description OPS-1')).toBeNull()
  fireEvent.change(screen.getByLabelText('Search tracker'), { target: { value: 'Unsubmitted filter' } })
  fireEvent.click(within(list).getByText('Title OPS-2'))
  expect(await screen.findByText('Full description OPS-2')).toBeTruthy()
  expect((screen.getByLabelText('Search tracker') as HTMLInputElement).value).toBe('Unsubmitted filter')
  expect(within(list).getByText('Title OPS-2').closest('a')?.getAttribute('aria-current')).toBe('page')
})
it('mobile deep link loads detail without starting list demand and exposes back navigation', async () => {
  const requests = mount('/tracker/OPS-2', { phone: true })
  expect(await screen.findByText('Full description OPS-2')).toBeTruthy()
  expect(requests.some(url => url.includes('/tracker?') || url.includes('/tracker/watch'))).toBe(false)
  fireEvent.click(screen.getByRole('link', { name: /Back to the list/ }))
  await waitFor(() => expect(requests.some(url => url.includes('/tracker?'))).toBe(true))
  expect(screen.queryByText('Full description OPS-2')).toBeNull()
  // With the sidebar sheet closed, the bare `/tracker` renders the list in main.
  expect(await within(document.querySelector('[data-route="tracker"] [data-slot="tracker-list"]') as HTMLElement).findByText('Title OPS-2')).toBeTruthy()
})

it('retains per-issue draft and shared workflow choice while switching rows', async () => {
  mount('/tracker/OPS-1')
  await screen.findByText('Full description OPS-1')
  fireEvent.change(await openHand(), { target: { value: 'Keep issue one draft' } })
  fireEvent.click(screen.getByRole('button', { name: 'Choose a workflow' }))
  fireEvent.click(await screen.findByRole('option', { name: /review/i }))
  // The composer is modal, so a hop to another row is: close it, pick the row, open it there.
  await closeHand()
  const list = sidebarList()
  fireEvent.click(within(list).getByText('Title OPS-2'))
  await screen.findByText('Full description OPS-2')
  expect(((await openHand()) as HTMLTextAreaElement).value).toBe('')
  expect(screen.getByRole('button', { name: 'Choose a workflow' }).textContent).toBe('review')
  await closeHand()
  fireEvent.click(within(list).getByText('Title OPS-1'))
  await screen.findByText('Full description OPS-1')
  expect(((await openHand()) as HTMLTextAreaElement).value).toBe('Keep issue one draft')
})
it('retains mobile back navigation when a deep-linked issue cannot load', async () => {
  mount('/tracker/OPS-2', { missing: true, phone: true })
  await screen.findByText('Offline')
  expect(screen.getByRole('link', { name: /Back to the list/ })).toBeTruthy()
})
it('filters using an arbitrary label beyond the loaded suggestions', async () => {
  const requests = mount('/tracker/OPS-1')
  await screen.findByText('Full description OPS-1')
  fireEvent.click(screen.getByRole('button', { name: 'Filter labels' }))
  fireEvent.change(screen.getByRole('combobox', { name: 'Find or add label' }), { target: { value: 'not-loaded' } })
  fireEvent.click(screen.getByRole('option', { name: /Use label/ }))
  await waitFor(() => expect(requests.some(url => new URL(url, 'http://localhost').searchParams.get('labels') === '["not-loaded"]')).toBe(true))
})

// The legacy tab opened the first listed issue when the URL named none, and this case pinned that
// such an IMPLICIT detail went away with the rows that implied it. The redesign has no implicit
// detail at all — the list sits in the sidebar and main asks for a pick — so what is left to pin
// is that nothing is ever opened on the user's behalf, with matches on screen or without.
it('never opens an issue implicitly, with or without matches for an explicit search', async () => {
  const requests = mount()
  expect(await within(await waitFor(() => { expect(sidebarList()).toBeTruthy(); return sidebarList() })).findByText('Title OPS-1')).toBeTruthy()
  expect(screen.getByText('Pick an issue')).toBeTruthy()
  expect(screen.queryByText('Full description OPS-1')).toBeNull()
  fireEvent.change(screen.getByLabelText('Search tracker'), { target: { value: 'nothing' } })
  fireEvent.click(screen.getByRole('button', { name: 'Search' }))
  await screen.findByText('No issues match this search.')
  expect(screen.queryByText('Full description OPS-1')).toBeNull()
  expect(screen.getByText('Pick an issue')).toBeTruthy()
  expect(requests.some(url => /\/tracker\/OPS-\d$/.test(new URL(url, 'http://localhost').pathname))).toBe(false)
})
