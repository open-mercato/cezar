import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation, type InitialEntry } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import * as client from '@/api/client'
import { managerKeys } from '@/api/managers'
import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { questionKeys } from '@/api/questions'
import * as phoneApp from '@/lib/phone-app'
import { TASK_ORIGIN_STORAGE_KEY } from '@/lib/task-origin'
import { nowScopeFromState } from '@/routes/now/now'

import { AppShell } from './app-shell'
import { LONG_PRESS_MS } from './tab-quick-actions'
import { ThemeProvider } from './theme-provider'

function device(userAgent = 'Mozilla/5.0') {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(pointer: coarse)' || query === '(display-mode: standalone)',
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
  vi.stubGlobal('screen', { width: 390, height: 844 })
  vi.stubGlobal('innerWidth', 390)
  vi.stubGlobal('navigator', { ...navigator, userAgent, vibrate: vi.fn() })
}

let seen: { path: string; state: unknown } = { path: '', state: null }
function At() {
  const location = useLocation()
  seen = { path: location.pathname + location.search, state: location.state }
  return <span data-testid="at">{location.pathname + location.search}</span>
}

const run = (id: string, status: string, createdAt: string, extra: Record<string, unknown> = {}) =>
  ({ id, status, title: `task ${id}`, task: `task ${id}`, createdAt, archived: false, steps: [], ...extra })

function renderShell(entry: InitialEntry = '/p/boot/', { unknownBoot = false } = {}) {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  queries.setQueryData(queryKeys.health, unknownBoot ? { capabilities: { managers: true } } : { bootProject: 'boot', capabilities: { managers: true } })
  if (!unknownBoot) queries.setQueryData(workspaceQueryKeys.projects, {
    projects: [{ id: 'boot', name: 'Boot', status: 'ok' }, { id: 'other', name: 'Other', status: 'ok' }],
    bootProject: 'boot',
    projectsDir: '',
  })
  queries.setQueryData(['default', 'runs', 'list'], [
    run('r1', 'running', '2026-11-24T10:00:00Z'),
    run('r2', 'done', '2026-11-24T09:00:00Z'),
    run('r3', 'review', '2026-11-24T08:00:00Z'),
    run('r4', 'failed', '2026-11-24T07:00:00Z'),
    run('r5', 'done', '2026-11-24T11:00:00Z', { archived: true }),
    // Newest of all, but an automation's: the Tasks table hides it by default.
    run('r6', 'running', '2026-11-24T12:00:00Z', {
      automationTrigger: { automationId: 'nightly', automationRevision: 1, receiptId: 'rc', trigger: 'schedule', occurrenceAt: '2026-11-24T00:00:00.000Z' },
    }),
  ])
  queries.setQueryData(managerKeys.list, {
    managers: [
      { id: 'ops', name: 'Ops', unread: 0, pendingActions: 0, pendingQuestions: 1, updatedAt: '2026-11-20T00:00:00Z', lastActivityAt: '2026-11-24T00:00:00Z' },
      { id: 'old', name: 'Old', unread: 0, pendingActions: 0, pendingQuestions: 0, updatedAt: '2026-11-01T00:00:00Z', inactive: { since: '2026-11-02T00:00:00Z' } },
    ],
  })
  queries.setQueryData(questionKeys.all, { open: [], closed: [], counts: { live: 2, older: 0 } })
  render(
    <QueryClientProvider client={queries}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[entry]}>
          <At />
          <AppShell managersAvailable>
            <div />
          </AppShell>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  )
}

const bar = () => within(screen.getByRole('navigation', { name: 'App' }))
const menu = () => screen.findByRole('menu')

function longPress(target: HTMLElement) {
  vi.useFakeTimers()
  fireEvent.pointerDown(target, { pointerType: 'touch', isPrimary: true, clientX: 10, clientY: 10 })
  act(() => vi.advanceTimersByTime(LONG_PRESS_MS))
  fireEvent.pointerUp(target, { pointerType: 'touch' })
  vi.useRealTimers()
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('bottom bar quick actions', () => {
  it('cancels the native link menu and opens the tab\'s shortcuts on right-click', async () => {
    device()
    renderShell()
    const tasks = bar().getByRole('link', { name: 'Tasks' })
    expect(fireEvent.contextMenu(tasks)).toBe(false)
    const items = within(await menu()).getAllByRole('menuitem').map((item) => item.textContent)
    // Newest first; the archived run is not "recent".
    expect(items).toEqual(['New task', 'task r1', 'task r2', 'task r3', 'running1', 'review1', 'failed1', 'All projects’ tasks'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'New task' }))
    await waitFor(() => expect(seen.path).toBe('/p/boot/new'))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('opens on a touch long-press, ticks the shell\'s haptic and swallows the click that follows', async () => {
    device('Mozilla/5.0 CezarMobile/1.0')
    const haptic = vi.spyOn(phoneApp.shellRequest, 'open').mockImplementation(() => {})
    renderShell('/p/boot/tasks')
    const now = bar().getByRole('link', { name: 'Now' })
    longPress(now)
    expect(haptic).toHaveBeenCalledWith('cezar://haptic')
    // The touch's own click carries a tap count.
    expect(fireEvent.click(now, { detail: 1 })).toBe(false)
    expect(seen.path).toBe('/p/boot/tasks')
    expect(within(await menu()).getByRole('menuitem', { name: /Archive all finished/ })).toBeTruthy()
  })

  it('outside the shell, vibrates where the browser can', async () => {
    device()
    renderShell()
    longPress(bar().getByRole('button', { name: 'More' }))
    expect(navigator.vibrate).toHaveBeenCalledWith(10)
    expect(within(await menu()).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Settings', 'Assets', 'Workflows'])
  })

  it('Shift+F10 after a touch is a keyboard menu: no haptic, no swallowed click', async () => {
    device('Mozilla/5.0 CezarMobile/1.0')
    const haptic = vi.spyOn(phoneApp.shellRequest, 'open').mockImplementation(() => {})
    renderShell('/p/boot/tasks')
    const tasks = bar().getByRole('link', { name: 'Tasks' })
    fireEvent.pointerDown(tasks, { pointerType: 'touch', clientX: 10, clientY: 10 })
    fireEvent.pointerUp(tasks, { pointerType: 'touch' })
    fireEvent.click(tasks, { detail: 1 })
    // The keyboard's context-menu event: no pointer type, no press in flight.
    fireEvent.keyDown(tasks, { key: 'F10', shiftKey: true })
    fireEvent.contextMenu(tasks)
    await menu()
    expect(haptic).not.toHaveBeenCalled()
    fireEvent.keyDown(await menu(), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    fireEvent.click(bar().getByRole('link', { name: 'Now' }), { detail: 1 })
    expect(seen.path).toBe('/p/boot/')
  })

  it('a long-press with no tap after it does not eat the next Enter', async () => {
    device()
    renderShell('/p/boot/tasks')
    const now = bar().getByRole('link', { name: 'Now' })
    longPress(now)
    fireEvent.keyDown(await menu(), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    // Enter on a link: a click with no tap count.
    fireEvent.click(now, { detail: 0 })
    expect(seen.path).toBe('/p/boot/')
  })

  it('a long-press, then a key, then a later tap: the tap navigates', async () => {
    device()
    renderShell('/p/boot/tasks')
    const now = bar().getByRole('link', { name: 'Now' })
    longPress(now)
    fireEvent.keyDown(await menu(), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    fireEvent.keyDown(now, { key: 'Tab' })
    fireEvent.click(now, { detail: 1 })
    expect(seen.path).toBe('/p/boot/')
  })

  it('Needs you — all projects hands the scope over even before the boot project is known', async () => {
    device()
    renderShell('/manager', { unknownBoot: true })
    fireEvent.contextMenu(bar().getByRole('link', { name: 'Now' }))
    fireEvent.click(within(await menu()).getByRole('menuitem', { name: 'Needs you — all projects' }))
    // `/` hops into the project once it is known; routes.test pins that the state rides along.
    await waitFor(() => expect(seen.path).toBe('/'))
    expect(nowScopeFromState(seen.state)).toBe('all')
  })

  it('Tasks counts what the table shows: automation runs only when the remembered origin includes them', async () => {
    device()
    localStorage.setItem(TASK_ORIGIN_STORAGE_KEY, 'all')
    renderShell()
    fireEvent.contextMenu(bar().getByRole('link', { name: 'Tasks' }))
    const items = within(await menu()).getAllByRole('menuitem').map((item) => item.textContent)
    expect(items.slice(0, 2)).toEqual(['New task', 'task r6'])
    expect(items).toContain('running2')
  })

  for (const [name, key] of [['Shift+F10', { key: 'F10', shiftKey: true }], ['the Menu key', { key: 'ContextMenu' }]] as const) {
    it(`${name} opens the menu by itself (macOS sends no contextmenu), without a haptic`, async () => {
      device('Mozilla/5.0 CezarMobile/1.0')
      const haptic = vi.spyOn(phoneApp.shellRequest, 'open').mockImplementation(() => {})
      renderShell()
      const tasks = bar().getByRole('link', { name: 'Tasks' })
      expect(fireEvent.keyDown(tasks, key)).toBe(false)
      expect(within(await menu()).getByRole('menuitem', { name: 'New task' })).toBeTruthy()
      // Windows and Linux still follow up with `contextmenu`: no second open, no haptic.
      fireEvent.contextMenu(tasks)
      expect(screen.getAllByRole('menu')).toHaveLength(1)
      expect(haptic).not.toHaveBeenCalled()
    })
  }

  it('a short tap still navigates and opens nothing', () => {
    device()
    renderShell('/p/boot/tasks')
    const now = bar().getByRole('link', { name: 'Now' })
    vi.useFakeTimers()
    fireEvent.pointerDown(now, { pointerType: 'touch', clientX: 10, clientY: 10 })
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS - 100))
    fireEvent.pointerUp(now, { pointerType: 'touch' })
    fireEvent.click(now)
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS))
    vi.useRealTimers()
    expect(seen.path).toBe('/p/boot/')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('a press that moves (a scroll) is not a long-press', () => {
    device()
    renderShell()
    const tasks = bar().getByRole('link', { name: 'Tasks' })
    vi.useFakeTimers()
    fireEvent.pointerDown(tasks, { pointerType: 'touch', clientX: 10, clientY: 10 })
    fireEvent.pointerMove(tasks, { pointerType: 'touch', clientX: 10, clientY: 40 })
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS * 2))
    vi.useRealTimers()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('Now: hands the all-projects scope over, switches project and archives the finished tasks of its project', async () => {
    device()
    const archive = vi.spyOn(client, 'archiveFinished').mockResolvedValue({ archived: 1 })
    renderShell('/p/boot/tasks')
    const now = bar().getByRole('link', { name: 'Now' })
    fireEvent.contextMenu(now)
    fireEvent.click(within(await menu()).getByRole('menuitem', { name: 'Needs you — all projects' }))
    await waitFor(() => expect(seen.path).toBe('/p/boot/'))
    expect(nowScopeFromState(seen.state)).toBe('all')

    fireEvent.contextMenu(now)
    fireEvent.click(within(await menu()).getByRole('menuitem', { name: 'Other' }))
    await waitFor(() => expect(seen.path).toBe('/p/other/'))

    fireEvent.contextMenu(bar().getByRole('link', { name: 'Now' }))
    // `other` has no runs cached: no count, so no archive row.
    expect(within(await menu()).queryByRole('menuitem', { name: /Archive all finished/ })).toBeNull()
    fireEvent.keyDown(await menu(), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    cleanup()
    renderShell('/p/boot/tasks')
    fireEvent.contextMenu(bar().getByRole('link', { name: 'Now' }))
    fireEvent.click(within(await menu()).getByRole('menuitem', { name: /Archive all finished/ }))
    await waitFor(() => expect(archive).toHaveBeenCalledWith('boot'))
  })

  it('Tasks: a status shortcut opens Tasks filtered by it', async () => {
    device()
    renderShell()
    fireEvent.contextMenu(bar().getByRole('link', { name: 'Tasks' }))
    fireEvent.click(within(await menu()).getByRole('menuitem', { name: /review/ }))
    await waitFor(() => expect(seen.path).toBe('/p/boot/tasks?status=review'))
  })

  it('Manager: active managers by recent activity, Questions with its count, New manager', async () => {
    device()
    renderShell()
    fireEvent.contextMenu(bar().getByRole('link', { name: 'Manager' }))
    const items = within(await menu()).getAllByRole('menuitem').map((item) => item.textContent)
    expect(items).toEqual(['Ops', 'Questions2', 'New manager'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Ops' }))
    await waitFor(() => expect(seen.path).toBe('/manager/ops'))
  })

  it('describes the shortcut to screen readers and returns focus to the tab on close', async () => {
    device()
    renderShell()
    const more = bar().getByRole('button', { name: 'More' })
    expect(document.getElementById(more.getAttribute('aria-describedby')!)?.textContent).toMatch(/hold/)
    fireEvent.contextMenu(more)
    fireEvent.keyDown(await menu(), { key: 'Escape' })
    await waitFor(() => expect(document.activeElement).toBe(more))
  })
})

describe('nowScopeFromState', () => {
  it('reads only the two scopes', () => {
    expect(nowScopeFromState({ nowScope: 'all' })).toBe('all')
    expect(nowScopeFromState({ nowScope: 'project' })).toBe('project')
    expect(nowScopeFromState({ nowScope: 'nope' })).toBeUndefined()
    expect(nowScopeFromState(null)).toBeUndefined()
  })
})
