import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { LAST_LOCATION_STORAGE_KEY } from '@/lib/last-location'

import { AppShell, type AppShellProps } from './app-shell'
import { ThemeProvider } from './theme-provider'

function device({ standalone = true, userAgent = 'Mozilla/5.0' } = {}) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(pointer: coarse)' || (query === '(display-mode: standalone)' && standalone),
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
  vi.stubGlobal('screen', { width: 390, height: 844 })
  vi.stubGlobal('navigator', { ...navigator, userAgent })
}

function renderShell(entry: string, props: Partial<AppShellProps> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.health, { bootProject: 'boot', capabilities: { managers: true } })
  client.setQueryData(workspaceQueryKeys.projects, {
    projects: [{ id: 'boot', status: 'ok' }, { id: 'other', status: 'ok' }],
    bootProject: 'boot',
    projectsDir: '',
  })
  render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[entry]}>
          <AppShell managersAvailable {...props}>
            <input aria-label="field" />
          </AppShell>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  )
}

const bar = () => screen.queryByRole('navigation', { name: 'App' })

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('PhoneBottomBar', () => {
  it('leads Now, Tasks, New task and Git into the last project in a phone PWA', () => {
    device()
    localStorage.setItem(LAST_LOCATION_STORAGE_KEY, JSON.stringify({ projectId: 'other', pathname: '/p/other/git' }))
    renderShell('/manager')
    const links = within(bar()!)
    expect(links.getAllByRole('link').map((a) => a.getAttribute('aria-label') ?? a.textContent)).toEqual(['Now', 'Tasks', 'New task', 'Git'])
    expect(links.getByRole('link', { name: 'Now' }).getAttribute('href')).toBe('/p/other/')
    expect(links.getByRole('link', { name: 'Tasks' }).getAttribute('href')).toBe('/p/other/tasks')
    expect(links.getByRole('link', { name: 'New task' }).getAttribute('href')).toBe('/p/other/new')
    expect(links.getByRole('link', { name: 'Git' }).getAttribute('href')).toBe('/p/other/git')
    // Nothing is current on a manager page; Manager itself lives in the drawer's Workspace group.
    expect(links.queryAllByRole('link', { current: 'page' })).toHaveLength(0)
    expect(links.queryByRole('link', { name: 'Manager' })).toBeNull()
  })

  it('points every item at the project on screen, ahead of the stored one, and lights the area', () => {
    device()
    localStorage.setItem(LAST_LOCATION_STORAGE_KEY, JSON.stringify({ projectId: 'other', pathname: '/p/other/git' }))
    renderShell('/p/boot/git')
    const links = within(bar()!)
    expect(links.getByRole('link', { name: 'Now' }).getAttribute('href')).toBe('/p/boot/')
    expect(links.getByRole('link', { name: 'Git' }).getAttribute('aria-current')).toBe('page')
    expect(links.getByRole('link', { name: 'Now' }).getAttribute('aria-current')).toBeNull()
    cleanup()
    renderShell('/p/boot/')
    expect(within(bar()!).getByRole('link', { name: 'Now' }).getAttribute('aria-current')).toBe('page')
    cleanup()
    renderShell('/p/boot/tasks')
    expect(within(bar()!).getByRole('link', { name: 'Tasks' }).getAttribute('aria-current')).toBe('page')
  })

  it('renders New task as the primary centre item', () => {
    device()
    renderShell('/p/boot/')
    const newTask = within(bar()!).getByRole('link', { name: 'New task' })
    expect(newTask.dataset.slot).toBe('bottom-bar-new-task')
    expect(newTask.querySelector('.bg-primary')).not.toBeNull()
    const items = [...bar()!.children]
    expect(items.indexOf(newTask)).toBe(2)
    expect(items).toHaveLength(5)
  })

  it('stays out of a phone browser tab', () => {
    device({ standalone: false })
    renderShell('/manager')
    expect(bar()).toBeNull()
  })

  it('reserves its height for the New-task FAB only while it is there', () => {
    const reserved = () =>
      document.querySelector<HTMLElement>('[data-slot="app-shell"]')!.style.getPropertyValue('--phone-bar')
    device()
    renderShell('/p/boot/')
    expect(bar()).not.toBeNull()
    expect(reserved()).toBe('3.5rem')
    cleanup()
    renderShell('/p/boot/tasks/run-1')
    expect(bar()).toBeNull()
    expect(reserved()).toBe('')
  })

  it('is there in the shell, whose webview is not standalone', () => {
    device({ standalone: false, userAgent: 'x CezarMobile/0.1 (ios)' })
    renderShell('/manager')
    expect(bar()).not.toBeNull()
  })

  it('keeps its Manager-capability gate', () => {
    device()
    renderShell('/p/boot/', { managersAvailable: false })
    expect(bar()).toBeNull()
  })

  it.each(['/p/boot/tasks/run-1', '/p/boot/tasks/run-1/changes', '/settings/global/appearance'])(
    'hides in %s',
    (entry) => {
      device()
      renderShell(entry)
      expect(bar()).toBeNull()
    },
  )

  it('leaves /manager/new its ways out: it has no route of its own to Tasks', () => {
    device()
    renderShell('/manager/new')
    expect(bar()).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Open menu' })).toBeTruthy()
  })

  it('stays on the global Tasks page, which is not a thread, and lights nothing there', () => {
    device()
    renderShell('/tasks')
    expect(bar()).not.toBeNull()
    expect(within(bar()!).queryAllByRole('link', { current: 'page' })).toHaveLength(0)
  })

  it('hides while the keyboard is open', () => {
    device()
    let height = 844
    vi.stubGlobal('innerHeight', height)
    renderShell('/manager')
    expect(bar()).not.toBeNull()
    height = 500
    vi.stubGlobal('innerHeight', height)
    act(() => {
      screen.getByRole('textbox', { name: 'field' }).focus()
      window.dispatchEvent(new Event('resize'))
    })
    expect(bar()).toBeNull()
  })

  it('More opens the drawer, which carries Manager and Settings', () => {
    device({ userAgent: 'x CezarMobile/0.1 (android)' })
    renderShell('/manager', { managerTo: '/manager/m-2' })
    fireEvent.click(within(bar()!).getByRole('button', { name: 'More' }))
    const drawer = document.querySelector<HTMLElement>('[data-slot="mobile-nav-drawer"]')!
    expect(within(drawer).getByRole('link', { name: 'Settings' })).toBeTruthy()
    expect(within(drawer).getByRole('link', { name: 'Manager' }).getAttribute('href')).toBe('/manager/m-2')
  })
})
