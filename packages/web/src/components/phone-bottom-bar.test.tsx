import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import * as React from 'react'
import { Link, MemoryRouter, useLocation, useNavigate, type InitialEntry } from 'react-router'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { LAST_LOCATION_STORAGE_KEY } from '@/lib/last-location'

import { AppShell, useShellTasksTab, type AppShellProps } from './app-shell'
import { useHideShellTopBar } from '@/routes/manager/manager-loading'
import { ThemeProvider } from './theme-provider'

function device({ standalone = true, userAgent = 'Mozilla/5.0', width = 390, height = 844 } = {}) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(pointer: coarse)' || (query === '(display-mode: standalone)' && standalone),
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
  vi.stubGlobal('screen', { width, height })
  vi.stubGlobal('innerWidth', width)
  vi.stubGlobal('navigator', { ...navigator, userAgent })
}

function At() {
  const { pathname, search } = useLocation()
  const navigate = useNavigate()
  return (
    <>
      <span data-testid="at">{pathname + search}</span>
      {/* The system Back (Android Back, the iOS swipe). */}
      <button type="button" hidden data-testid="history-back" onClick={() => void navigate(-1)} />
    </>
  )
}

function renderShell(entry: InitialEntry | InitialEntry[], props: Partial<AppShellProps> = {}) {
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
        <MemoryRouter initialEntries={Array.isArray(entry) ? entry : [entry]}>
          <At />
          <AppShell managersAvailable {...props}>
            {props.children ?? <input aria-label="field" />}
          </AppShell>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  )
}

const bar = () => screen.queryByRole('navigation', { name: 'App' })

/** Stands in for the manager chat, which hides the shell's top bar for its own header. */
function HidesTopBar() {
  useHideShellTopBar()
  return null
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('PhoneBottomBar', () => {
  it('in Manager mode leads Now to the managers\' Now and Tasks into the last project, then Manager', () => {
    device()
    localStorage.setItem(LAST_LOCATION_STORAGE_KEY, JSON.stringify({ projectId: 'other', pathname: '/p/other/git' }))
    renderShell('/manager/m-1')
    const links = within(bar()!)
    expect(links.getAllByRole('link').map((a) => a.getAttribute('aria-label') ?? a.textContent)).toEqual(['Now', 'Tasks', 'Manager'])
    // Manager mode's own Now (spec 2026-11-23-needs-you-triage), never a project's.
    expect(links.getByRole('link', { name: 'Now' }).getAttribute('href')).toBe('/manager/now')
    expect(links.getByRole('link', { name: 'Tasks' }).getAttribute('href')).toBe('/p/other/tasks')
    expect(links.queryByRole('link', { name: 'New task' })).toBeNull()
    // Inside Manager the tab is current and leads back to the list, like a tab bar.
    const manager = links.getByRole('link', { name: 'Manager' })
    expect(manager.getAttribute('aria-current')).toBe('page')
    expect(manager.getAttribute('href')).toBe('/manager?all=1')
    expect(links.queryByRole('link', { name: 'Git' })).toBeNull()
  })

  it('on Manager mode\'s Now, Now is the current tab, not Manager', () => {
    device()
    renderShell('/manager/now')
    const links = within(bar()!)
    expect(links.getByRole('link', { name: 'Now' }).getAttribute('aria-current')).toBe('page')
    expect(links.getByRole('link', { name: 'Manager' }).getAttribute('aria-current')).toBeNull()
  })

  it('in a project, Now stays the project\'s Now', () => {
    device()
    renderShell('/p/boot/')
    expect(within(bar()!).getByRole('link', { name: 'Now' }).getAttribute('href')).toBe('/p/boot/')
  })

  it('leads Manager to the remembered chat from a project, with its attention dot', () => {
    device()
    renderShell('/p/boot/', { managerTo: '/manager/m-2', managerAttention: 'needs-you' })
    const manager = within(bar()!).getByRole('link', { name: /^Manager/ })
    expect(manager.getAttribute('href')).toBe('/manager/m-2')
    expect(manager.getAttribute('aria-current')).toBeNull()
    expect(manager.querySelector('[data-slot="bottom-bar-attention"]')?.textContent).toBe(', needs you')
    cleanup()
    renderShell('/p/boot/', { managerTo: '/manager/m-2' })
    expect(bar()!.querySelector('[data-slot="bottom-bar-attention"]')).toBeNull()
  })

  it('points every item at the project on screen, ahead of the stored one, and lights the area', () => {
    device()
    localStorage.setItem(LAST_LOCATION_STORAGE_KEY, JSON.stringify({ projectId: 'other', pathname: '/p/other/git' }))
    renderShell('/p/boot/tasks/')
    const links = within(bar()!)
    expect(links.getByRole('link', { name: 'Now' }).getAttribute('href')).toBe('/p/boot/')
    expect(links.getByRole('link', { name: 'Now' }).getAttribute('aria-current')).toBeNull()
    expect(links.getByRole('link', { name: 'Manager' }).getAttribute('aria-current')).toBeNull()
    cleanup()
    renderShell('/p/boot/')
    expect(within(bar()!).getByRole('link', { name: 'Now' }).getAttribute('aria-current')).toBe('page')
    cleanup()
    renderShell('/p/boot/tasks')
    expect(within(bar()!).getByRole('link', { name: 'Tasks' }).getAttribute('aria-current')).toBe('page')
  })

  // Spec 2026-11-20-phone-notifications-inbox: Now is the one list, and its tab carries the count.
  it('badges Now with what needs you on this computer, and names it for screen readers', () => {
    device()
    renderShell('/p/boot/tasks', { nowCount: 3 })
    const now = within(bar()!).getByRole('link', { name: 'Now, 3 things need you' })
    expect(now.querySelector('[data-slot="bottom-bar-now-count"]')?.textContent).toBe('3')
    cleanup()
    renderShell('/p/boot/tasks', { nowCount: 0 })
    expect(within(bar()!).getByRole('link', { name: 'Now' }).querySelector('[data-slot="bottom-bar-now-count"]')).toBeNull()
  })

  it('has four destinations without manual task creation', () => {
    device()
    renderShell('/p/boot/')
    expect(within(bar()!).queryByRole('link', { name: 'New task' })).toBeNull()
    expect([...bar()!.children]).toHaveLength(4)
  })

  it('returns to a clean manager from a consumed direct sheet link without popping unrelated history', async () => {
    device()
    renderShell(['/dashboard', { pathname: '/p/boot/tasks/run-1', state: { manager: { id: 'm-1', name: 'Ops' }, managerHistoryBack: false } }])
    fireEvent.click(within(bar()!).getByRole('link', { name: 'Manager' }))
    await waitFor(() => expect(screen.getByTestId('at').textContent).toBe('/manager/m-1'))
  })

  it('appears in a narrow browser tab', () => {
    device({ standalone: false })
    renderShell('/manager')
    expect(bar()).not.toBeNull()
  })

  it('reserves its height for the New-task FAB only while it is there', () => {
    const reserved = () =>
      document.querySelector<HTMLElement>('[data-slot="app-shell"]')!.style.getPropertyValue('--phone-bar')
    device()
    renderShell('/p/boot/')
    expect(bar()).not.toBeNull()
    expect(reserved()).toBe('3.5rem')
    cleanup()
    renderShell('/settings/global/appearance')
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

  it('hides in settings', () => {
    device()
    renderShell('/settings/global/appearance')
    expect(bar()).toBeNull()
  })

  describe('in a task thread', () => {
    const FROM_MANAGER = { manager: { id: 'm-1', name: 'Ops' } }
    const at = () => screen.getByTestId('at').textContent
    const tab = (name: string) => within(bar()!).getByRole('link', { name })

    it('stays, in place of the top menu bar, with Manager current when the task came from one', () => {
      device()
      renderShell(['/manager/m-1', { pathname: '/p/boot/tasks/run-1', state: FROM_MANAGER }])
      expect(document.querySelector('[data-slot="mobile-top-bar"]')).toBeNull()
      expect(tab('Manager').getAttribute('aria-current')).toBe('page')
      expect(tab('Manager').getAttribute('href')).toBe('/manager/m-1')
      expect(tab('Tasks').getAttribute('aria-current')).toBeNull()
      // No shell header above the run's own: the column pads the status bar at every width.
      expect(document.querySelector('[data-slot="main-column"]')!.className).toContain(' pt-[env(safe-area-inset-top)]')
      // The drawer stays one tap away.
      fireEvent.click(within(bar()!).getByRole('button', { name: 'More' }))
      expect(document.querySelector('[data-slot="mobile-nav-drawer"]')).not.toBeNull()
    })

    it('lights Tasks for a task opened from anywhere else, and Tasks leads to the list', () => {
      device()
      renderShell(['/p/boot/tasks', '/p/boot/tasks/run-1'])
      expect(tab('Tasks').getAttribute('aria-current')).toBe('page')
      expect(tab('Manager').getAttribute('aria-current')).toBeNull()
      fireEvent.click(tab('Tasks'))
      expect(at()).toBe('/p/boot/tasks')
    })

    it('Manager goes back to the chat it came from; tapped again there, to the managers list', () => {
      device()
      renderShell(['/manager/m-1', { pathname: '/p/boot/tasks/run-1', state: FROM_MANAGER }])
      fireEvent.click(tab('Manager'))
      expect(at()).toBe('/manager/m-1')
      expect(tab('Manager').getAttribute('aria-current')).toBe('page')
      fireEvent.click(tab('Manager'))
      expect(at()).toBe('/manager?all=1')
    })

    it('Back goes from the task to the manager, and Manager is that same Back', () => {
      device()
      const entries: InitialEntry[] = ['/p/boot/', '/manager/m-1', { pathname: '/p/boot/tasks/run-1', state: FROM_MANAGER }]
      renderShell(entries)
      fireEvent.click(screen.getByTestId('history-back'))
      expect(at()).toBe('/manager/m-1')
      cleanup()
      renderShell(entries)
      fireEvent.click(tab('Manager'))
      expect(at()).toBe('/manager/m-1')
      // No task pushed on top of the chat: Back from it leaves Manager, rather than reopening the task.
      fireEvent.click(screen.getByTestId('history-back'))
      expect(at()).toBe('/p/boot/')
    })

    it('keeps Manager current across the task\'s own tabs, whose links carry no state', () => {
      device()
      renderShell(['/manager/m-1', { pathname: '/p/boot/tasks/run-1', state: FROM_MANAGER }], {
        children: <Link to="/p/boot/tasks/run-1/changes">changes</Link>,
      })
      fireEvent.click(screen.getByRole('link', { name: 'changes' }))
      expect(at()).toBe('/p/boot/tasks/run-1/changes')
      expect(tab('Manager').getAttribute('aria-current')).toBe('page')
      // Not straight from the chat any more: the tab links to it rather than going Back.
      fireEvent.click(tab('Manager'))
      expect(at()).toBe('/manager/m-1')
    })

    it('a task deep-linked with that state but no history behind it links to the chat', () => {
      device()
      renderShell({ pathname: '/p/boot/tasks/run-1', state: FROM_MANAGER })
      fireEvent.click(tab('Manager'))
      expect(at()).toBe('/manager/m-1')
    })

    it('still hides while the keyboard is open', () => {
      device()
      vi.stubGlobal('innerHeight', 844)
      renderShell({ pathname: '/p/boot/tasks/run-1', state: FROM_MANAGER })
      expect(bar()).not.toBeNull()
      vi.stubGlobal('innerHeight', 500)
      act(() => {
        screen.getByRole('textbox', { name: 'field' }).focus()
        window.dispatchEvent(new Event('resize'))
      })
      expect(bar()).toBeNull()
    })
  })

  it('leaves /manager/new its ways out: it has no route of its own to Tasks', () => {
    device()
    renderShell('/manager/new')
    expect(bar()).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Open menu' })).toBeTruthy()
  })

  it('stays on the global Tasks page, which is not a thread, and keeps Tasks lit there', () => {
    device()
    renderShell('/tasks?manager=mobile')
    expect(bar()).not.toBeNull()
    expect(within(bar()!).getAllByRole('link', { current: 'page' }).map((link) => link.textContent)).toEqual(['Tasks'])
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

  it('More opens the drawer, which carries Git, Settings, the Projects | Manager switch and the computer chip in the shell', () => {
    device({ userAgent: 'x CezarMobile/0.1 (android)' })
    renderShell('/p/boot/', { managerTo: '/manager/m-2' })
    fireEvent.click(within(bar()!).getByRole('button', { name: 'More' }))
    const drawer = document.querySelector<HTMLElement>('[data-slot="mobile-nav-drawer"]')!
    expect(within(drawer).getByRole('link', { name: 'Settings' })).toBeTruthy()
    expect(within(drawer).getByRole('link', { name: 'Git' })).toBeTruthy()
    const modes = within(drawer.querySelector<HTMLElement>('[data-slot="mode-switch"]')!)
    expect(modes.getByRole('link', { name: 'Manager' }).getAttribute('href')).toBe('/manager/m-2')
    expect(modes.getByRole('link', { name: 'Projects' }).getAttribute('aria-current')).toBe('page')
    expect(within(drawer).getByRole('link', { name: 'Switch computer' }).getAttribute('href')).toBe('cezar://servers')
  })

  it('shows no computer chip without the User-Agent token', () => {
    device()
    renderShell('/manager')
    fireEvent.click(within(bar()!).getByRole('button', { name: 'More' }))
    const drawer = document.querySelector<HTMLElement>('[data-slot="mobile-nav-drawer"]')!
    expect(within(drawer).queryByRole('link', { name: /Switch computer/ })).toBeNull()
  })

  it('in Manager, the drawer leads with the switch and lists the managers, while the tab stays', () => {
    device({ userAgent: 'x CezarMobile/0.1 (android)' })
    renderShell('/manager/m-1', { managerSidebar: <p>manager rows</p> })
    expect(within(bar()!).getByRole('link', { name: 'Manager' }).getAttribute('aria-current')).toBe('page')
    fireEvent.click(within(bar()!).getByRole('button', { name: 'More' }))
    const drawer = document.querySelector<HTMLElement>('[data-slot="mobile-nav-drawer"]')!
    const modes = within(drawer.querySelector<HTMLElement>('[data-slot="mode-switch"]')!)
    expect(modes.getByRole('link', { name: 'Manager' }).getAttribute('aria-current')).toBe('page')
    expect(within(drawer).getByText('manager rows')).toBeTruthy()
    expect(within(drawer).queryByRole('link', { name: 'Git' })).toBeNull()
  })

  it('paints the tab dot in the attention grammar: blue needs you, violet unread', () => {
    device()
    renderShell('/p/boot/', { managerAttention: 'needs-you' })
    expect(bar()!.querySelector('[data-slot="bottom-bar-attention"] span')?.className).toContain('bg-info')
    cleanup()
    renderShell('/p/boot/', { managerAttention: 'unread' })
    expect(bar()!.querySelector('[data-slot="bottom-bar-attention"] span')?.className).toContain('bg-violet')
  })

  describe('on an iPad in CezarBot', () => {
    const IPAD = { standalone: false, userAgent: 'x CezarMobile/0.1 (ios)', width: 834, height: 1194 }
    const sidebar = () => document.querySelector('[data-slot="sidebar"], [data-slot="sidebar-rail"]')
    const column = () => document.querySelector<HTMLElement>('[data-slot="main-column"]')!

    it('is the navigation at every width: no sidebar, and More opens the drawer', () => {
      device(IPAD)
      renderShell('/manager/m-1', { managerSidebar: <p>manager rows</p> })
      expect(bar()).not.toBeNull()
      expect(bar()!.className).not.toContain('md:hidden')
      expect(sidebar()).toBeNull()
      expect(document.querySelector('[data-slot="app-shell"]')!.hasAttribute('data-phone-nav')).toBe(true)
      fireEvent.click(within(bar()!).getByRole('button', { name: 'More' }))
      const drawer = document.querySelector<HTMLElement>('[data-slot="mobile-nav-drawer"]')!
      expect(drawer.className).not.toContain('md:hidden')
      expect(within(drawer).getByText('manager rows')).toBeTruthy()
    })

    it('pads the status bar once in the visible top header', () => {
      device(IPAD)
      renderShell('/manager/m-1')
      expect(column().className).not.toMatch(/(^| )md:pt-\[env\(safe-area-inset-top\)\]/)
      expect(document.querySelector('[data-slot="mobile-top-bar"]')!.className).not.toContain('md:hidden')
    })

    it('pads the status bar in the column when a manager chat hides the top bar', () => {
      // The chat's header pads the inset only below `md` (manager-chat.tsx), so the column must.
      device(IPAD)
      renderShell('/manager/m-1', { children: <HidesTopBar /> })
      const bar = document.querySelector<HTMLElement>('[data-slot="mobile-top-bar"]')!
      expect(bar.hidden).toBe(true)
      expect(bar.parentElement).toBe(column())
      expect(column().className).toContain('md:has-[>[data-slot=mobile-top-bar][hidden]]:pt-[env(safe-area-inset-top)]')
    })

    it('keeps the bar in a thread, with no top menu bar', () => {
      device(IPAD)
      renderShell(['/manager/m-1', { pathname: '/p/boot/tasks/run-1', state: { manager: { id: 'm-1', name: 'Ops' } } }])
      expect(bar()).not.toBeNull()
      expect(within(bar()!).getByRole('link', { name: 'Manager' }).getAttribute('aria-current')).toBe('page')
      expect(document.querySelector('[data-slot="mobile-top-bar"]')).toBeNull()
      expect(column().className).toContain(' pt-[env(safe-area-inset-top)]')
    })

    it("a manager chat's Tasks opens its own tasks, with the count", () => {
      device(IPAD)
      const open = vi.fn()
      function Chat() {
        const publish = useShellTasksTab()
        React.useEffect(() => {
          publish?.publish({ count: 4, expanded: false, open })
          return () => publish?.publish(null)
        }, [publish])
        return null
      }
      renderShell('/manager/m-1', { children: <Chat /> })
      const tasks = within(bar()!).getByRole('button', { name: 'Tasks, 4 started by this manager' })
      expect(tasks.textContent).toContain('4')
      expect(within(bar()!).queryByRole('link', { name: 'Tasks' })).toBeNull()
      fireEvent.click(tasks)
      expect(open).toHaveBeenCalledOnce()
    })
  })

  it.each([600, 834, 1023])('uses mobile navigation with a fine pointer at %spx', (width) => {
    device({ width, standalone: false })
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
    renderShell('/manager')
    expect(bar()).not.toBeNull()
    expect(document.querySelector('[data-slot="sidebar"]')).toBeNull()
  })

  it('responds to container resizing inside a wide viewport', () => {
    onTestFinished(() => { vi.restoreAllMocks() })
    device({ width: 1440, standalone: false })
    let width = 700
    let observeResize = () => {}
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width }) as DOMRect)
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { observeResize = callback }
      observe() {}
      disconnect() {}
    })
    renderShell('/manager')
    expect(bar()).not.toBeNull()
    act(() => { width = 1024; observeResize() })
    expect(bar()).toBeNull()
    expect(document.querySelector('[data-slot="sidebar"]')).not.toBeNull()
    act(() => { width = 800; observeResize() })
    expect(bar()).not.toBeNull()
    expect(document.querySelector('[data-slot="sidebar"]')).toBeNull()
  })

  it('a desktop browser keeps the sidebar and no bar', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }))
    vi.stubGlobal('screen', { width: 1280, height: 800 })
    renderShell('/manager/m-1')
    expect(bar()).toBeNull()
    expect(document.querySelector('[data-slot="sidebar"], [data-slot="sidebar-rail"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="app-shell"]')!.hasAttribute('data-phone-nav')).toBe(false)
  })
})
