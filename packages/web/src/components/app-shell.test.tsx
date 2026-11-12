import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { Link as RouterLink, MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AppShell, routeOwnsScrollArrival, type AppShellProps } from './app-shell'
import { NAV_ITEMS, visibleNavItems } from './nav-items'
import { ThemeProvider } from './theme-provider'

afterEach(() => {
  cleanup()
  // The sidebar width is a real localStorage preference (#788) — one test's drag must not be the
  // next test's starting width.
  localStorage.clear()
})

// jsdom ships no `matchMedia`; the ThemeProvider wrapping the footer toggle needs one.
beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })
  )
})

/** Mount the shell at a URL, exactly as a cold-loaded deep link would.
 *
 *  jsdom has no layout engine and no media queries: nothing here can (or pretends to) measure a
 *  breakpoint. Responsive behavior is asserted structurally — the elements and the responsive
 *  classes that carry them — and verified for real in the e2e suite at an iPhone viewport.
 */
function renderShell(entry = '/', props: Partial<AppShellProps> = {}, children: ReactNode = <p>route content</p>) {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[entry]}>
        <AppShell {...props}>
          {children}
          <LocationProbe />
        </AppShell>
      </MemoryRouter>
    </ThemeProvider>
  )
}

/** Makes the current URL assertable, so a "the drawer closed" test can also prove the click it
 *  fired actually navigated rather than merely dismissing the drawer. */
function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>
}

const nav = () => screen.getByRole('navigation', { name: 'Main' })
const sidebar = () => document.querySelector('[data-slot="sidebar"]') as HTMLElement
const footer = () => document.querySelector('[data-slot="sidebar-footer"]') as HTMLElement

describe('AppShell', () => {
  it('renders the routed view in the main region', () => {
    renderShell('/', {}, <p>route content</p>)
    expect(within(screen.getByRole('main')).getByText('route content')).toBeTruthy()
  })

  // Brand guideline ("Znak z nazwą"): the mark WITHOUT its tile, in the text colour, beside the
  // lowercase name in Chakra Petch SemiBold — 26px over 19px with a gap of 0.6 × the type size.
  it('renders the brand lockup: the tile-less mark beside the lowercase name', () => {
    renderShell('/')
    const lockup = sidebar().querySelector('[data-slot="brand-lockup"]') as HTMLElement | null
    expect(lockup).toBeTruthy()
    expect(lockup!.style.gap).toBe('11.4px')

    const mark = lockup!.querySelector('[data-slot="brand-mark"]') as SVGElement | null
    expect(mark).toBeTruthy()
    expect(mark!.getAttribute('height')).toBe('26')
    expect(mark!.getAttribute('fill')).toBe('currentColor')
    // No tile: polygons only, no rect behind them and no <img> of the tiled icon.
    expect(mark!.querySelectorAll('polygon')).toHaveLength(4)
    expect(mark!.querySelector('rect')).toBeNull()
    expect(sidebar().querySelector('img[src="/icon.svg"]')).toBeNull()

    const name = lockup!.querySelector('[data-slot="brand-name"]') as HTMLElement | null
    expect(name?.textContent).toBe('cezar')
    expect(name!.style.fontSize).toBe('19px')
    expect(name!.style.fontFamily).toBe('var(--brand)')
    expect(name!.className).toContain('font-semibold')
    expect(name!.className).toContain('tracking-normal')
  })

  it('renders a workspace name and uploaded logo when supplied', () => {
    renderShell('/', { brandName: 'Acme Studio', brandLogoUrl: '/api/v1/workspace/branding-logo?v=abc' })
    const lockup = sidebar().querySelector('[data-slot="brand-lockup"]') as HTMLElement
    expect(lockup.querySelector('[data-slot="brand-name"]')?.textContent).toBe('Acme Studio')
    expect(lockup.querySelector('[data-slot="brand-logo"]')?.getAttribute('src')).toBe('/api/v1/workspace/branding-logo?v=abc')
    expect(lockup.querySelector('[data-slot="brand-mark"]')).toBeNull()
  })

  it('resets the main scroller to the top on navigation (#mobile-scroll-top)', () => {
    renderShell('/')
    const main = screen.getByRole('main')
    main.scrollTop = 640
    expect(main.scrollTop).toBe(640) // jsdom kept the write — the reset below is the effect's
    fireEvent.click(within(nav()).getByRole('link', { name: 'GitHub' }))
    expect(screen.getByTestId('location').textContent).toBe('/github')
    expect(main.scrollTop).toBe(0)
  })

  it('leaves task-to-task arrival to the destination transcript owner (#761)', () => {
    renderShell(
      '/tasks/source',
      {},
      <RouterLink to="/tasks/destination">Switch task</RouterLink>,
    )
    const main = screen.getByRole('main')
    main.scrollTop = 640

    fireEvent.click(within(main).getByRole('link', { name: 'Switch task' }))

    expect(screen.getByTestId('location').textContent).toBe('/tasks/destination')
    expect(main.scrollTop).toBe(640)
  })

  it('restores the generic top reset when leaving a task thread (#761)', () => {
    renderShell('/tasks/source')
    const main = screen.getByRole('main')
    main.scrollTop = 640

    fireEvent.click(within(nav()).getByRole('link', { name: 'GitHub' }))

    expect(screen.getByTestId('location').textContent).toBe('/github')
    expect(main.scrollTop).toBe(0)
  })

  it('grants scroll ownership only to exact scoped and unscoped main task routes', () => {
    expect(routeOwnsScrollArrival('/tasks/run-1')).toBe(true)
    expect(routeOwnsScrollArrival('/p/cezar/tasks/run-1')).toBe(true)
    expect(routeOwnsScrollArrival('/tasks/run-1/changes')).toBe(false)
    expect(routeOwnsScrollArrival('/p/cezar/tasks/run-1/files')).toBe(false)
    expect(routeOwnsScrollArrival('/tasks')).toBe(false)
  })

  it("renders the active project's areas as real router links, in mockup order", () => {
    renderShell()
    const links = within(nav()).getAllByRole('link')
    expect(links.map((a) => a.textContent)).toEqual([
      'Now',
      'Tasks',
      'Git',
      'GitHub',
      'Automations',
      'Skills',
      'Workflows',
    ])
    // Deep-linkable per Step 2.1: every nav row is an <a href>, not a button with an onClick.
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/',
      '/tasks',
      '/git',
      '/github',
      '/automations',
      '/skills',
      '/workflows',
    ])
    // Assets left the sidebar (it stays a task / git tab); Inbox and Settings moved to Workspace.
    expect(within(nav()).queryByRole('link', { name: 'Assets' })).toBeNull()
    expect(within(nav()).queryByRole('link', { name: 'Settings' })).toBeNull()
  })

  it('renders the Workspace group: Dashboard, All tasks, Inbox and Settings — Manager only when health says so', () => {
    renderShell()
    const workspace = () => screen.getByRole('navigation', { name: 'Workspace' })
    expect(within(workspace()).getAllByRole('link').map((a) => a.textContent)).toEqual([
      'Dashboard',
      'All tasks',
      'Inbox',
      'Settings',
    ])
    expect(within(workspace()).getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe('/settings')
    expect(within(workspace()).getByRole('link', { name: 'All tasks' }).getAttribute('href')).toBe('/tasks')
    cleanup()
    renderShell('/', { managersAvailable: true, managerTo: '/manager/m-2' })
    expect(within(workspace()).getAllByRole('link').map((a) => a.textContent)).toEqual([
      'Manager',
      'Dashboard',
      'All tasks',
      'Inbox',
      'Settings',
    ])
    expect(within(workspace()).getByRole('link', { name: 'Manager' }).getAttribute('href')).toBe('/manager/m-2')
  })

  it('does not render the Tasks | Manager mode switch — the sidebar is the same everywhere', () => {
    renderShell('/manager', { managersAvailable: true })
    expect(document.querySelector('[data-slot="mode-switch"]')).toBeNull()
    expect(screen.getAllByText('New task').length).toBeGreaterThan(0)
    expect(within(nav()).getByRole('link', { name: 'Now' })).toBeTruthy()
  })

  // R6 Step 1.1: no forge, no GitHub tab — the nav item disappears entirely (spec's
  // degradation table), it does not render disabled.
  it('drops the GitHub item when the forge is unavailable', () => {
    renderShell('/', { forgeAvailable: false })
    const links = within(nav()).getAllByRole('link')
    expect(links.map((a) => a.getAttribute('href'))).not.toContain('/github')
    expect(links).toHaveLength(NAV_ITEMS.filter((item) => !item.group && !item.forge && !item.tracker).length)
  })

  // #801: same degradation for the opt-in automations capability — the item disappears, it does
  // not render disabled. The two gates on that item are independent: a forge alone is not enough.
  it('drops the Automations item when the capability is off', () => {
    renderShell('/', { automationsAvailable: false })
    const links = within(nav()).getAllByRole('link')
    expect(links.map((a) => a.getAttribute('href'))).not.toContain('/automations')
    expect(links).toHaveLength(NAV_ITEMS.filter((item) => !item.group && !item.automations && !item.tracker).length)
  })

  it('shows the Automations item once the capability is on', () => {
    renderShell('/', { automationsAvailable: true })
    expect(within(nav()).getAllByRole('link').map((a) => a.getAttribute('href')))
      .toContain('/automations')
  })

  describe('active nav state follows the current route', () => {
    const cases: Array<[entry: string, active: string]> = [
      ['/', 'Now'],
      ['/p/shop/', 'Now'],
      ['/p/shop/tasks', 'Tasks'],
      ['/git', 'Git'],
      ['/skills', 'Skills'],
      // Tasks stays lit while a task thread is open (spec's "Task list & table").
      ['/tasks/abc123', 'Tasks'],
      ['/p/shop/tasks/abc123/changes', 'Tasks'],
      ['/compare/g1', 'Tasks'],
    ]

    for (const [entry, active] of cases) {
      it(`${entry} → ${active}`, () => {
        renderShell(entry)
        const current = within(nav()).getAllByRole('link', { current: 'page' })
        // Exactly one — two lit rows is as wrong as none.
        expect(current).toHaveLength(1)
        expect(current[0]?.textContent).toBe(active)
      })
    }

    it('Now is active only at the project root, never on a task or the table', () => {
      renderShell('/')
      expect(within(nav()).getByRole('link', { name: 'Now' }).getAttribute('aria-current')).toBe('page')
      for (const entry of ['/tasks/abc123', '/p/shop/tasks', '/git']) {
        cleanup()
        renderShell(entry)
        expect(within(nav()).getByRole('link', { name: 'Now' }).getAttribute('aria-current')).toBeNull()
      }
    })

    it("the unscoped /tasks is the global All tasks page, not the project's Tasks area", () => {
      renderShell('/tasks')
      expect(within(nav()).queryAllByRole('link', { current: 'page' })).toHaveLength(0)
      const allTasks = within(screen.getByRole('navigation', { name: 'Workspace' })).getByRole('link', { name: 'All tasks' })
      expect(allTasks.getAttribute('aria-current')).toBe('page')
    })

    it('lights nothing on a full-screen surface like /new', () => {
      renderShell('/new')
      expect(within(nav()).queryAllByRole('link', { current: 'page' })).toHaveLength(0)
    })
  })

  describe('New task button', () => {
    it('links to /new', () => {
      renderShell()
      expect(within(sidebar()).getByRole('link', { name: /New task/ }).getAttribute('href')).toBe('/new')
    })

    it('renders the C hint (the browser-usable accelerator; ⌘N only fires in the desktop shell)', () => {
      renderShell()
      const link = within(sidebar()).getByRole('link', { name: /New task/ })
      expect(within(link).getByText('C').tagName).toBe('KBD')
    })

    it('sits under the switcher slot, as the primary action', () => {
      renderShell('/', { switcher: <button type="button" data-slot="project-switcher">cezar</button> })
      const switcher = within(sidebar()).getByRole('button', { name: 'cezar' })
      const link = within(sidebar()).getByRole('link', { name: /New task/ })
      expect(switcher.compareDocumentPosition(link)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
      expect(link.getAttribute('data-variant')).toBe('primary')
    })
  })

  describe('project switcher slot', () => {
    it('renders the switcher when supplied and no repo chip beside it', () => {
      renderShell('/', { repo: { name: 'cezar', branch: 'main' }, switcher: <button type="button" data-slot="project-switcher">cezar</button> })
      expect(within(sidebar()).getByRole('button', { name: 'cezar' })).toBeTruthy()
      expect(document.querySelector('[data-slot="repo-chip"]')).toBeNull()
    })

    it('falls back to the repo chip while there is no registry to switch between', () => {
      renderShell('/', { repo: { name: 'cezar', branch: 'main' } })
      const chip = sidebar().querySelector('[data-slot="repo-chip"]') as HTMLElement
      expect(chip.textContent).toBe('cezarmain')
      expect(chip.querySelector('.font-mono')?.textContent).toBe('main')
    })
  })
  /* The footer is ONE line now (redesign, Proposal 1): the health dot and running count, the ⌘K
   * launcher, and a "⋯" menu that holds everything the old footer stacked in rows. jsdom cannot
   * measure a line, but it can pin that every former control is still reachable from it. */
  describe('status line footer', () => {
    const more = () => within(footer()).getByRole('button', { name: 'More' })
    const openMore = () => {
      fireEvent.pointerDown(more(), { button: 0, ctrlKey: false })
      return screen.getByRole('menu')
    }

    it('is a single row: dot, status, search chord, more', () => {
      renderShell('/', { healthStatus: 'healthy', runningCount: 2 })
      expect(footer().className).not.toContain('flex-col')
      expect(footer().querySelector('[data-slot="sidebar-health-dot"]')?.getAttribute('data-tone')).toBe('success')
      expect(footer().querySelector('[data-slot="sidebar-status"]')?.textContent).toBe('Healthy · 2 running')
    })

    it('renders the running count from the shell props, and nothing for zero', () => {
      renderShell('/', { healthStatus: 'healthy', runningCount: 3 })
      expect(footer().querySelector('[data-slot="sidebar-status"]')?.textContent).toBe('Healthy · 3 running')
      cleanup()
      renderShell('/', { healthStatus: 'healthy', runningCount: 0 })
      expect(footer().querySelector('[data-slot="sidebar-status"]')?.textContent).toBe('Healthy')
    })

    it('says so while health is unknown or needs attention', () => {
      renderShell('/')
      expect(footer().querySelector('[data-slot="sidebar-status"]')?.textContent).toBe('Connecting…')
      expect(footer().querySelector('[data-slot="sidebar-health-dot"]')?.getAttribute('data-tone')).toBe('neutral')
      cleanup()
      renderShell('/', { healthStatus: 'attention', runningCount: 1 })
      expect(footer().querySelector('[data-slot="sidebar-status"]')?.textContent).toBe('Needs attention · 1 running')
      expect(footer().querySelector('[data-slot="sidebar-health-dot"]')?.getAttribute('data-tone')).toBe('pending')
    })

    it('renders the ⌘K chord as a launcher that still opens the palette', () => {
      renderShell()
      // jsdom reports no `navigator.platform`, so the chord reads Ctrl+K.
      const search = within(footer()).getByRole('button', { name: 'Search' })
      expect(search.dataset.slot).toBe('command-palette-hint')
      expect(search.querySelector('kbd')?.textContent).toBe('Ctrl+K')

      const opened = vi.fn()
      window.addEventListener('cezar:open-command-palette', opened)
      fireEvent.click(search)
      window.removeEventListener('cezar:open-command-palette', opened)
      expect(opened).toHaveBeenCalledTimes(1)
    })

    it('keeps the machine glance, Tools, What\u2019s new, version, star and theme under the ⋯ menu', () => {
      renderShell('/', {
        version: '1.2.3',
        latestVersion: '1.3.0',
        starCount: 1234,
        hostWidget: <span data-slot="host-widget-stub">host glance</span>,
        toolsMenu: <span data-slot="tools-stub">tool rows</span>,
        whatsNew: <span data-slot="whats-new">What’s new</span>,
      })
      // None of it costs the column a row.
      expect(footer().querySelector('[data-slot="host-widget-stub"]')).toBeNull()
      expect(footer().querySelector('[data-slot="version-chip"]')).toBeNull()
      const menu = openMore()
      expect(within(menu).getByText('host glance')).toBeTruthy()
      expect(within(menu).getByRole('menuitem', { name: 'Tools' })).toBeTruthy()
      expect(menu.querySelector('[data-slot="whats-new"]')).not.toBeNull()
      const version = menu.querySelector('[data-slot="version-chip"]') as HTMLElement
      expect(version.textContent).toContain('v1.2.3')
      expect(version.getAttribute('data-update-available')).toBe('true')
      expect(version.getAttribute('title')).toBe('v1.2.3 — update available: v1.3.0')
      expect(menu.querySelector('[data-slot="star-chip"]')?.textContent).toContain('1.2k')
      // The theme is a three-way choice, not a cycling icon.
      const theme = menu.querySelector('[data-slot="theme-toggle"]') as HTMLElement
      expect(within(theme).getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual(['System', 'Dark', 'Light'])
    })

    it('changes the theme from the menu', () => {
      renderShell()
      const menu = openMore()
      fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Light' }))
      expect(localStorage.getItem('cez-theme')).toBe('light')
    })

    it('flags a pending update on the ⋯ button itself', () => {
      renderShell('/', { version: '1.2.3', latestVersion: '1.3.0' })
      expect(footer().querySelector('[data-slot="sidebar-more-update"]')).not.toBeNull()
      cleanup()
      renderShell('/', { version: '1.2.3', latestVersion: '1.2.3' })
      expect(footer().querySelector('[data-slot="sidebar-more-update"]')).toBeNull()
    })
  })

  describe('data slots stay empty rather than showing invented data', () => {
    const openMore = () => {
      fireEvent.pointerDown(within(footer()).getByRole('button', { name: 'More' }), { button: 0, ctrlKey: false })
      return screen.getByRole('menu')
    }

    it('renders no repo chip, badge or version item when unfed', () => {
      renderShell()
      expect(document.querySelector('[data-slot="repo-chip"]')).toBeNull()
      expect(document.querySelector('[data-slot="nav-badge"]')).toBeNull()
      const menu = openMore()
      expect(menu.querySelector('[data-slot="version-chip"]')).toBeNull()
      expect(menu.querySelector('[data-slot="star-chip"]')).toBeNull()
    })

    it('renders the repo chip and version item from props', () => {
      renderShell('/', { repo: { name: 'cezar', branch: 'main' }, version: '1.2.3' })
      expect(document.querySelector('[data-slot="repo-chip"]')?.textContent).toBe('cezarmain')
      // The item prefixes the raw semver from /api/v1/health — `v1.2.3`, mono, muted.
      expect(within(openMore()).getByText('v1.2.3')).toBeTruthy()
    })

    describe('the ⭐ ask', () => {
      const chip = () => document.querySelector('[data-slot="star-chip"]') as HTMLAnchorElement | null

      it('is absent — not empty — when the count is unavailable', () => {
        // Offline, a rate-limited IP, or `CEZ_NO_BANNER=1`. A button advertising a number it
        // cannot produce is worse than no button.
        renderShell('/', { version: '1.2.3', starCount: null })
        openMore()
        expect(chip()).toBeNull()
      })

      it('still renders at zero — a real count, not a missing one', () => {
        renderShell('/', { version: '1.2.3', starCount: 0 })
        openMore()
        expect(chip()).not.toBeNull()
        expect(chip()?.textContent).toContain('0')
      })

      it('links to cezar, in a new tab, leaking neither opener nor referrer', () => {
        renderShell('/', { starCount: 42 })
        openMore()
        expect(chip()?.getAttribute('href')).toBe('https://github.com/open-mercato/cezar')
        expect(chip()?.getAttribute('target')).toBe('_blank')
        expect(chip()?.getAttribute('rel')).toContain('noopener')
        expect(chip()?.getAttribute('rel')).toContain('noreferrer')
      })

      it('names itself for a screen reader with the exact count, not the abbreviation', () => {
        renderShell('/', { starCount: 12_345 })
        openMore()
        const label = chip()?.getAttribute('aria-label') ?? ''
        expect(label).toMatch(/star cezar on github/i)
        expect(label).toContain(new Intl.NumberFormat().format(12_345))
        expect(label).not.toContain('12.3k')
      })

      it('offers no reward and blocks nothing — the item is a link and only a link', () => {
        renderShell('/', { starCount: 1000 })
        openMore()
        expect(chip()?.tagName).toBe('A')
        expect(chip()?.textContent ?? '').not.toMatch(/\b(unlock|reward|free|upgrade|pro|premium)\b/i)
      })
    })

    describe('version item update affordance (#368)', () => {
      const chip = () => document.querySelector('[data-slot="version-chip"]') as HTMLElement

      it('stays plain while the registry has nothing newer', () => {
        renderShell('/', { version: '1.2.3' })
        openMore()
        expect(chip().getAttribute('data-update-available')).toBeNull()
        expect(chip().getAttribute('title')).toBe('v1.2.3')
        expect(chip().querySelector('[data-slot="status-dot"]')).toBeNull()
      })

      it('stays plain when latestVersion equals the running version', () => {
        renderShell('/', { version: '1.2.3', latestVersion: '1.2.3' })
        openMore()
        expect(chip().getAttribute('data-update-available')).toBeNull()
      })

      it('pulses and names the newer version when one exists', () => {
        renderShell('/', { version: '1.2.3', latestVersion: '1.3.0' })
        openMore()
        expect(chip().getAttribute('data-update-available')).toBe('true')
        const dot = chip().querySelector('[data-slot="status-dot"]') as HTMLElement
        expect(dot.getAttribute('data-tone')).toBe('pending')
        expect(dot.className).toContain('animate-pulse')
        // The version shown is still the one actually running.
        expect(chip().textContent).toContain('v1.2.3')
      })
    })

    it('renders the Inbox badge only for a non-zero count, in the Workspace group', () => {
      renderShell('/', { inboxCount: 2 })
      const inbox = within(screen.getByRole('navigation', { name: 'Workspace' })).getByRole('link', { name: /Inbox/ })
      expect(within(inbox).getByText('2')).toBeTruthy()

      cleanup()
      renderShell('/', { inboxCount: 0 })
      expect(document.querySelector('[data-slot="nav-badge"]')).toBeNull()
    })

    it('renders the Now badge from the needs-you count and the Tasks badge from the unread count', () => {
      renderShell('/', { nowCount: 3, unreadCount: 2 })
      const now = within(nav()).getByRole('link', { name: /Now/ })
      expect(now.querySelector('[data-slot="nav-needs-you-badge"]')?.textContent).toBe('3')
      const tasks = within(nav()).getByRole('link', { name: /Tasks/ })
      expect(tasks.querySelector('[data-slot="nav-unread-badge"]')?.textContent).toBe('2')
      cleanup()
      renderShell('/', { nowCount: 0, unreadCount: null })
      expect(document.querySelector('[data-slot="nav-needs-you-badge"]')).toBeNull()
      expect(document.querySelector('[data-slot="nav-unread-badge"]')).toBeNull()
    })

    it('renders a quiet accessible Skills update marker in desktop and mobile navigation', () => {
      renderShell('/', { skillsUpdateAvailable: true })
      expect(document.querySelectorAll('[data-slot="nav-update-marker"]')).toHaveLength(1)
      fireEvent.click(screen.getByRole('button', { name: 'Open menu' }))
      const markers = document.querySelectorAll('[data-slot="nav-update-marker"]')
      expect(markers).toHaveLength(2)
      for (const marker of markers) {
        expect(marker.textContent).toBe('Skills update available')
        expect(marker.innerHTML).not.toContain('animate-')
      }
      // Radix hides the desktop app from the accessibility tree while the mobile drawer is modal.
      expect(screen.getAllByRole('link', { name: /Skills update available/ })).toHaveLength(1)
    })

    it('dots a nav item whose feature shipped since the user started (spec 2026-10-26, "Coming back")', () => {
      renderShell('/', { newNavItems: new Set(['/workflows', '/settings']) })
      const markers = [...document.querySelectorAll('[data-slot="nav-new-marker"]')]
      expect(markers).toHaveLength(2)
      expect(markers.map((marker) => marker.closest('a')?.getAttribute('href'))).toEqual(['/workflows', '/settings'])
      expect(screen.getByRole('link', { name: /Workflows\s*New/ })).toBeDefined()
    })

    it('renders no Skills marker without an actionable update', () => {
      renderShell()
      expect(document.querySelector('[data-slot="nav-update-marker"]')).toBeNull()
    })

    it('reserves the current-tasks and composer slots', () => {
      renderShell('/', { currentTasks: <p data-slot="current-tasks-stub">rows</p> })
      for (const slot of ['current-tasks-slot', 'composer']) {
        expect(document.querySelector(`[data-slot="${slot}"]`)).not.toBeNull()
      }
      // Between the area list and the Workspace group, inside the one scroller.
      const stub = document.querySelector('[data-slot="current-tasks-stub"]') as HTMLElement
      expect(nav().compareDocumentPosition(stub)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
      expect(stub.compareDocumentPosition(screen.getByRole('navigation', { name: 'Workspace' }))).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
      expect(stub.closest('[data-slot="sidebar-scroll"]')).not.toBeNull()
    })
  })

  describe('All tasks link', () => {
    const allTasks = () => document.querySelector('[data-slot="all-tasks-link"]') as HTMLElement | null

    it('links out of every project scope', () => {
      renderShell('/p/shop/git')
      // A PLAIN target: the scope-aware Link would prefix it with `/p/shop`, which is no route.
      expect(allTasks()!.getAttribute('href')).toBe('/tasks')
    })

    it('marks itself the current page only on the unscoped /tasks', () => {
      renderShell('/tasks')
      expect(allTasks()!.getAttribute('aria-current')).toBe('page')
      cleanup()
      renderShell('/p/shop/tasks')
      expect(allTasks()!.getAttribute('aria-current')).toBeNull()
    })
  })

  /** Every Workspace row — Manager, Dashboard, All tasks, Inbox, Settings — paints from the same
   *  row class as the area list, so nothing in the sidebar reads as a second tier. */
  describe('workspace rows read as peers of the area rows', () => {
    const skin = (el: HTMLElement) => [...el.classList].filter((c) => c !== 'bg-muted' && c !== 'font-semibold' && c !== 'text-foreground').sort()

    it('paints Dashboard, All tasks, Manager and Git from one class string', () => {
      renderShell('/', { managersAvailable: true })
      const dashboard = document.querySelector('[data-slot="dashboard-link"]') as HTMLElement
      const allTasks = document.querySelector('[data-slot="all-tasks-link"]') as HTMLElement
      const manager = document.querySelector('[data-slot="manager-link"]') as HTMLElement
      const git = within(nav()).getByRole('link', { name: 'Git' })
      expect(skin(dashboard)).toEqual(skin(git))
      expect(skin(allTasks)).toEqual(skin(git))
      expect(skin(manager)).toEqual(skin(git))
    })
  })

  describe('banner slot', () => {
    it('renders the banner when one is passed', () => {
      renderShell('/', { banner: <p>banner content</p> })
      const slot = document.querySelector('[data-slot="banner-slot"]') as HTMLElement
      expect(slot).not.toBeNull()
      expect(within(slot).getByText('banner content')).toBeTruthy()
    })

    it('renders nothing when absent — no empty slot to push the scroller down', () => {
      renderShell()
      expect(document.querySelector('[data-slot="banner-slot"]')).toBeNull()
    })

    // The regression the slot was born with: as the first child of <main>, a sticky banner sat in
    // the same scrollport as every routed view's own `sticky top-0` header, which parked over it
    // (opaque, later in DOM, equal-or-higher z-index) and swallowed the clicks on its dismiss X.
    // Its own row instead — so the banner is chrome, above the scroller, not scrolled content.
    it('sits outside the scrolling main region, not inside it', () => {
      renderShell('/', { banner: <p>banner content</p> })
      const slot = document.querySelector('[data-slot="banner-slot"]') as HTMLElement
      expect(screen.getByRole('main').contains(slot)).toBe(false)
      expect(slot.className).not.toContain('sticky')
    })

    it('is its own grid row, above the scroller and below the mobile bar', () => {
      renderShell('/', { banner: <p>banner content</p> })
      const slot = document.querySelector('[data-slot="banner-slot"]') as HTMLElement
      const main = screen.getByRole('main')
      const column = main.parentElement as HTMLElement
      expect(column.className).toContain('grid-rows-[auto_auto_1fr_auto]')
      expect(slot.parentElement).toBe(column)
      expect(slot.className).toContain('row-start-2')
      // The scroller keeps the 1fr row, so the banner's height comes out of the shell's own
      // budget rather than making every `min-h-full` route overflow by exactly the banner.
      expect(main.className).toContain('row-start-3')
    })
  })

  /** jsdom cannot evaluate `md:` — so assert the structure and the responsive classes that
   *  encode it, and leave "does it actually reflow at 390px" to the e2e iPhone screenshot. */
  /** Settings is full-screen (spec 2026-10-13-unified-settings): the shell renders none of its
   *  chrome on a settings URL — the settings frame brings its own header, nav and way back. */
  describe('chromeless settings', () => {
    for (const entry of ['/p/boot/settings/agents', '/p/boot/settings', '/settings/global/appearance', '/settings/global']) {
      it(`${entry} renders no sidebar, no drawer trigger and no mobile top bar`, () => {
        renderShell(entry)
        const shell = document.querySelector('[data-slot="app-shell"]') as HTMLElement
        expect(shell.hasAttribute('data-chromeless')).toBe(true)
        expect(document.querySelector('[data-slot="sidebar"]')).toBeNull()
        expect(document.querySelector('[data-slot="mobile-top-bar"]')).toBeNull()
        expect(screen.queryByRole('button', { name: 'Open menu' })).toBeNull()
        // The routed view still renders in the one scrolling region.
        expect(within(document.querySelector('[data-slot="main"]') as HTMLElement).getByText('route content')).toBeTruthy()
      })
    }

    it('keeps the banner row — provider failures link INTO settings, so the fix stays visible', () => {
      renderShell('/p/boot/settings/agents', { banner: <div data-testid="banner">auth failed</div> })
      expect(screen.getByTestId('banner')).toBeTruthy()
      expect(document.querySelector('[data-slot="banner-slot"]')?.className).toContain('row-start-2')
    })

    it('is NOT chromeless on a look-alike path, or on the Skills page that /settings/skills redirects to', () => {
      renderShell('/p/boot/settingsfoo')
      expect(document.querySelector('[data-slot="app-shell"]')?.hasAttribute('data-chromeless')).toBe(false)
      expect(sidebar()).not.toBeNull()
      cleanup()
      renderShell('/p/boot/skills')
      expect(sidebar()).not.toBeNull()
    })
  })

  describe('responsive skeleton', () => {
    it('hides the sidebar below md and shows it from md up', () => {
      renderShell()
      expect(sidebar().className).toContain('hidden')
      expect(sidebar().className).toContain('md:flex')
    })

    it('shows the mobile top bar below md only', () => {
      renderShell()
      const bar = document.querySelector('[data-slot="mobile-top-bar"]') as HTMLElement
      expect(bar).not.toBeNull()
      expect(bar.className).toContain('md:hidden')
      // The row is exactly the 44px touch baseline; its menu button keeps that same target.
      expect(bar.firstElementChild?.className).toContain('h-11')
      expect(within(bar).getByRole('button', { name: 'Open menu' }).className).toContain('size-11')
    })

    it('titles the mobile bar from the active route', () => {
      renderShell('/skills')
      const bar = document.querySelector('[data-slot="mobile-top-bar"]') as HTMLElement
      expect(within(bar).getByText('Skills')).toBeTruthy()
    })

  })

  describe('foldable sidebar', () => {
    it('folds into a rail, remembers it, and unfolds with focus on the fold button', () => {
      renderShell()
      fireEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }))
      expect(document.querySelector('[data-slot="sidebar"]')).toBeNull()
      const unfold = screen.getByRole('button', { name: 'Show sidebar' })
      expect(document.activeElement).toBe(unfold)
      expect(localStorage.getItem('cez-sidebar-folded')).toBe('1')

      fireEvent.click(unfold)
      expect(sidebar()).toBeTruthy()
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Hide sidebar' }))
      expect(localStorage.getItem('cez-sidebar-folded')).toBeNull()
    })

    it('toggles with Mod+B', () => {
      renderShell()
      const mod = /mac/i.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }
      fireEvent.keyDown(window, { key: 'b', code: 'KeyB', ...mod })
      expect(document.querySelector('[data-slot="sidebar"]')).toBeNull()
      fireEvent.keyDown(window, { key: 'b', code: 'KeyB', ...mod })
      expect(sidebar()).toBeTruthy()
    })

    it('Mod+B from a focused textarea keeps focus there', () => {
      renderShell('/', {}, <textarea aria-label="composer" />)
      const composer = screen.getByRole('textbox', { name: 'composer' })
      composer.focus()
      const mod = /mac/i.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }
      fireEvent.keyDown(composer, { key: 'b', code: 'KeyB', ...mod })
      expect(document.querySelector('[data-slot="sidebar"]')).toBeNull()
      expect(document.activeElement).toBe(composer)
      fireEvent.keyDown(composer, { key: 'b', code: 'KeyB', ...mod })
      expect(sidebar()).toBeTruthy()
      expect(document.activeElement).toBe(composer)
    })

    it('ignores a held Mod+B and one pressed behind a dialog', () => {
      renderShell()
      const mod = /mac/i.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }
      fireEvent.keyDown(window, { key: 'b', code: 'KeyB', repeat: true, ...mod })
      expect(sidebar()).toBeTruthy()
      const dialog = document.createElement('div')
      dialog.setAttribute('role', 'dialog')
      document.body.append(dialog)
      fireEvent.keyDown(window, { key: 'b', code: 'KeyB', ...mod })
      expect(sidebar()).toBeTruthy()
      dialog.remove()
    })

    it('folds into an icon rail: mark, New task +, every project area, and the project header', () => {
      localStorage.setItem('cez-sidebar-folded', '1')
      renderShell('/git', {
        repo: { name: 'cezar', branch: 'main' },
        projectSwitcher: {
          activeId: 'cezar',
          activeName: 'cezar',
          projects: [{ id: 'cezar', name: 'cezar' }, { id: 'shop', name: 'shop' }],
        },
      })
      const rail = document.querySelector('[data-slot="sidebar-rail"]') as HTMLElement
      expect(rail).toBeTruthy()
      // The mark without its name, then the white + CTA into the composer.
      expect(within(rail).getByRole('img', { name: 'cezar' })).toBeTruthy()
      expect(rail.querySelector('[data-slot="brand-name"]')).toBeNull()
      const plus = within(rail).getByRole('link', { name: 'New task' })
      expect(plus.getAttribute('href')).toBe('/new')
      expect(plus.getAttribute('data-variant')).toBe('contrast')
      for (const label of ['Now', 'Tasks', 'Git', 'GitHub', 'Automations', 'Skills', 'Workflows', 'Inbox', 'Settings']) {
        expect(within(rail).getByRole('link', { name: label })).toBeTruthy()
      }
      expect(within(rail).queryByRole('link', { name: 'Assets' })).toBeNull()
      expect(within(rail).getByRole('link', { name: 'Git' }).getAttribute('aria-current')).toBe('page')

      // The header names the project and switches to another one, keeping the area.
      const header = document.querySelector('[data-slot="project-header"]') as HTMLElement
      const trigger = within(header).getByRole('button', { name: /Project: cezar/ })
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
      const item = screen.getByRole('menuitem', { name: 'shop' })
      expect(item.getAttribute('href')).toBe('/p/shop/git')
      expect(screen.getByRole('menuitem', { name: 'cezar' }).getAttribute('aria-current')).toBe('true')
    })

    it('keeps Manager in the rail with its dot, lit on a manager page', () => {
      localStorage.setItem('cez-sidebar-folded', '1')
      renderShell('/git', { managersAvailable: true, managerAttention: 'needs-you', managerTo: '/manager/m-2' })
      const rail = () => document.querySelector('[data-slot="sidebar-rail"]') as HTMLElement
      const toManager = within(rail()).getByRole('link', { name: 'Manager, needs you' })
      expect(toManager.getAttribute('href')).toBe('/manager/m-2')
      expect(toManager.getAttribute('aria-current')).toBeNull()
      cleanup()
      renderShell('/manager/m-2', { managersAvailable: true, managerAttention: 'needs-you' })
      expect(within(rail()).getByRole('link', { name: 'Manager, needs you' }).getAttribute('aria-current')).toBe('page')
      // The rail is the same everywhere: the Tasks nav stays beside Manager.
      expect(within(rail()).getByRole('link', { name: 'Tasks' }).getAttribute('href')).toBe('/tasks')
      cleanup()
      renderShell('/git')
      expect(rail().querySelector('[data-slot="rail-manager"]')).toBeNull()
      cleanup()
      renderShell('/git', { managersAvailable: true, managerAttention: 'unread', managerTo: '/manager/m-2' })
      expect(within(rail()).getByRole('link', { name: 'Manager, unread' })).toBeTruthy()
      expect(rail().querySelector('[data-slot="rail-manager-attention"]')?.className).toContain('bg-info')
    })

    it('shows no project header while the sidebar is open', () => {
      renderShell('/', { projectSwitcher: { activeId: 'a', activeName: 'a', projects: [{ id: 'a', name: 'a' }] } })
      expect(document.querySelector('[data-slot="project-header"]')).toBeNull()
    })

    it('names the repo in the rail header when no project registry is known', () => {
      localStorage.setItem('cez-sidebar-folded', '1')
      renderShell('/', { repo: { name: 'solo', branch: 'main' } })
      const header = document.querySelector('[data-slot="project-header"]') as HTMLElement
      expect(within(header).getByText('solo')).toBeTruthy()
      expect(within(header).queryByRole('button')).toBeNull()
    })

    it('loads folded without stealing focus', () => {
      localStorage.setItem('cez-sidebar-folded', '1')
      renderShell()
      expect(document.querySelector('[data-slot="sidebar"]')).toBeNull()
      expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'Show sidebar' }))
    })
  })

  /** The resizable desktop column (#788, option C). jsdom has no layout engine, so these assert
   *  the state machine and the accessibility contract; the drag itself is exercised for real in
   *  `e2e/sidebar-resize.e2e.ts`. */
  describe('resizable sidebar', () => {
    const handle = () => document.querySelector('[data-slot="sidebar-resize-handle"]') as HTMLElement

    /** jsdom implements neither pointer capture nor `PointerEvent`'s coordinates on the synthetic
     *  events React dispatches, so the capture calls are stubbed and the moves are fired as the
     *  mouse events jsdom does construct — React routes `onPointerDown`/`onPointerMove` from
     *  them, which is exactly what a real pointer produces. */
    function drag(from: number, to: number) {
      const el = handle()
      el.setPointerCapture = vi.fn()
      el.releasePointerCapture = vi.fn()
      el.hasPointerCapture = vi.fn(() => true)
      fireEvent.pointerDown(el, { button: 0, pointerId: 1, clientX: from })
      fireEvent.pointerMove(el, { pointerId: 1, clientX: to })
      fireEvent.pointerUp(el, { pointerId: 1, clientX: to })
    }

    it('starts at the shipped 264px when nothing has been stored', () => {
      renderShell()
      expect(sidebar().style.width).toBe('264px')
      // No Tailwind width class left behind to fight the inline one.
      expect(sidebar().className).not.toContain('w-[264px]')
    })

    it('restores the width the browser remembers', () => {
      localStorage.setItem('cez-sidebar-width', '350')
      renderShell()
      // First paint, not an effect: a jump from 264 to 350 would be visible on every load.
      expect(sidebar().style.width).toBe('350px')
    })

    it('is a keyboard-operable separator that reports its range', () => {
      renderShell()
      const el = handle()
      expect(el.getAttribute('role')).toBe('separator')
      expect(el.getAttribute('aria-orientation')).toBe('vertical')
      expect(el.getAttribute('aria-label')).toBe('Resize the sidebar')
      expect(el.tabIndex).toBe(0)
      expect(el.getAttribute('aria-valuenow')).toBe('264')
      expect(el.getAttribute('aria-valuemin')).toBe('264')
      expect(el.getAttribute('aria-valuemax')).toBe('420')
    })

    it('widens on drag and persists what it landed on', () => {
      renderShell()
      drag(264, 344)
      expect(sidebar().style.width).toBe('344px')
      expect(handle().getAttribute('aria-valuenow')).toBe('344')
      expect(localStorage.getItem('cez-sidebar-width')).toBe('344')
    })

    it('clamps a drag at both bounds rather than letting the column collapse or take over', () => {
      renderShell()
      drag(264, 3000)
      expect(sidebar().style.width).toBe('420px')
      drag(420, -3000)
      expect(sidebar().style.width).toBe('264px')
    })

    it('takes focus on grab, so the arrow keys work right after a mouse drag', () => {
      // `preventDefault()` on pointerdown (which stops the drag selecting the sidebar's text)
      // also suppresses the focus a press would otherwise give a tabIndex=0 element.
      renderShell()
      drag(264, 320)
      expect(document.activeElement).toBe(handle())
      fireEvent.keyDown(handle(), { key: 'ArrowRight' })
      expect(sidebar().style.width).toBe('336px')
    })

    it('opts out of browser touch panning, so a touch drag resizes instead of scrolling', () => {
      renderShell()
      expect(handle().className).toContain('touch-none')
    })

    it('ignores a non-primary button, so a right-click on the border resizes nothing', () => {
      renderShell()
      const el = handle()
      el.setPointerCapture = vi.fn()
      fireEvent.pointerDown(el, { button: 2, pointerId: 1, clientX: 264 })
      fireEvent.pointerMove(el, { pointerId: 1, clientX: 400 })
      expect(sidebar().style.width).toBe('264px')
      expect(el.setPointerCapture).not.toHaveBeenCalled()
    })

    it('steps with the arrow keys and jumps to the bounds with Home/End', () => {
      renderShell()
      fireEvent.keyDown(handle(), { key: 'ArrowRight' })
      expect(sidebar().style.width).toBe('280px')
      fireEvent.keyDown(handle(), { key: 'ArrowLeft' })
      expect(sidebar().style.width).toBe('264px')
      fireEvent.keyDown(handle(), { key: 'End' })
      expect(sidebar().style.width).toBe('420px')
      fireEvent.keyDown(handle(), { key: 'Home' })
      expect(sidebar().style.width).toBe('264px')
      expect(localStorage.getItem('cez-sidebar-width')).toBe('264')
    })

    it('leaves every other key to the browser — Tab must still move focus', () => {
      renderShell()
      const event = createEvent.keyDown(handle(), { key: 'Tab' })
      fireEvent(handle(), event)
      expect(event.defaultPrevented).toBe(false)
      expect(sidebar().style.width).toBe('264px')
    })

    it('resets to the default on double-click', () => {
      localStorage.setItem('cez-sidebar-width', '400')
      renderShell()
      expect(sidebar().style.width).toBe('400px')
      fireEvent.doubleClick(handle())
      expect(sidebar().style.width).toBe('264px')
      expect(localStorage.getItem('cez-sidebar-width')).toBe('264')
    })

    it('does not follow the drawer: the `<md` overlay keeps its fixed 264px and no handle', () => {
      localStorage.setItem('cez-sidebar-width', '400')
      renderShell('/', { currentTasks: <p>list</p> })
      fireEvent.click(screen.getByRole('button', { name: 'Open menu' }))
      const drawer = document.querySelector('[data-slot="mobile-nav-drawer"]') as HTMLElement
      expect(drawer.className).toContain('w-[264px]')
      expect(drawer.style.width).toBe('')
      expect(within(drawer).queryByRole('separator', { name: 'Resize the sidebar' })).toBeNull()
    })

    it('declares the container the rows size their metadata against', () => {
      // The width-priority rule in `task-quick-list.tsx` drops metadata with an
      // `@min-[…]/sidebar:` query; without this container it has nothing to query.
      renderShell()
      const content = sidebar().querySelector('[data-slot="sidebar-content"]') as HTMLElement
      expect(content.className).toContain('@container/sidebar')
    })
  })

  /** The layout contract from the spec. These classes are the whole reason the cockpit does not
   *  scroll its document or clip its composer on an iPhone — a refactor that drops one is a
   *  regression no visual test would catch on a desktop viewport. */
  describe('layout contract', () => {
    it('is exactly one viewport tall and never scrolls the document', () => {
      renderShell()
      const shell = document.querySelector('[data-slot="app-shell"]') as HTMLElement
      // h-dvh, not h-screen: 100vh ignores mobile browser chrome.
      expect(shell.className).toContain('h-dvh')
      expect(shell.className).not.toContain('h-screen')
      expect(shell.className).toContain('overflow-hidden')
    })

    it('makes the main region the only scroller, and contains its overscroll', () => {
      renderShell()
      const main = screen.getByRole('main')
      expect(main.className).toContain('overflow-y-auto')
      expect(main.className).toContain('overscroll-contain')
    })

    it('pads for the safe-area insets', () => {
      renderShell()
      const shell = document.querySelector('[data-slot="app-shell"]') as HTMLElement
      expect(shell.className).toContain('pl-[env(safe-area-inset-left)]')

      const bar = document.querySelector('[data-slot="mobile-top-bar"]') as HTMLElement
      expect(bar.className).toContain('pt-[env(safe-area-inset-top)]')

      // The composer row keeps the home-indicator gutter even while it is empty.
      const composer = document.querySelector('[data-slot="composer"]') as HTMLElement
      expect(composer.className).toContain('pb-[env(safe-area-inset-bottom)]')
    })
  })

  describe('banner slot', () => {
    const bannerSlot = () => document.querySelector('[data-slot="banner-slot"]')

    it('renders nothing when no banner is passed', () => {
      renderShell()
      expect(bannerSlot()).toBeNull()
    })

    it('renders the banner above the routed view', () => {
      renderShell('/', { banner: <p>promo</p> })
      expect(screen.getByText('promo')).not.toBeNull()
    })

    // The regression guard for the #391 QA defect: the banner first shipped as `sticky top-0
    // z-10` *inside* `main`, where routed views' own `sticky top-0` headers (z-10 and z-20) sit
    // later in the DOM and painted over it — the banner vanished on scroll and its dismiss
    // button stopped being clickable on every route. Keeping the slot a sibling of the scroller
    // is what makes that unrepresentable; nesting it back inside `main` fails here.
    it('is a peer of the scroller, not a child of it, so route headers cannot paint over it', () => {
      renderShell('/', { banner: <p>promo</p> })
      const slot = bannerSlot() as HTMLElement
      const main = screen.getByRole('main')

      expect(main.contains(slot)).toBe(false)
      expect(slot.parentElement).toBe(main.parentElement)

      // Its own grid row, so it holds its space instead of sticking to the scroller's edge.
      expect(slot.className).toContain('row-start-2')
      expect(main.className).toContain('row-start-3')
      expect(slot.className).not.toContain('sticky')
    })
  })

  /** The `<md` drawer (spec: "Sidebar becomes an overlay drawer … backdrop").
   *
   *  jsdom still cannot evaluate `md:`, so the drawer is always openable here — the button that
   *  opens it is what CSS hides on desktop, and the e2e suite proves that at 390px for real. What
   *  these tests do own is the state machine and the semantics, which no screenshot can check.
   */
  describe('mobile nav drawer', () => {
    const drawer = () => screen.queryByRole('dialog', { name: 'Navigation' })
    const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'Open menu' }))

    /** Radix arms its outside-pointer listener in a `setTimeout(…, 0)`, so a backdrop press fired
     *  in the same tick as the open would land before anything is listening. */
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

    it('is closed until the menu button is pressed', () => {
      renderShell()
      expect(drawer()).toBeNull()
      openMenu()
      expect(drawer()).not.toBeNull()
    })

    it('is a dialog with an accessible name', () => {
      renderShell()
      openMenu()
      // A real dialog, not a div styled to look like one — the focus trap and the Escape
      // handling below are only meaningful because the role underneath them is real.
      expect(drawer()?.getAttribute('role')).toBe('dialog')
      // `getByRole('dialog', { name: 'Navigation' })` already proves the name resolves; this
      // pins down *how*, so dropping the sr-only SheetTitle fails here loudly.
      expect(drawer()?.getAttribute('aria-labelledby')).toBeTruthy()
    })

    it('advertises the drawer from the menu button', () => {
      renderShell()
      const menuButton = screen.getByRole('button', { name: 'Open menu' })
      expect(menuButton.getAttribute('aria-haspopup')).toBe('dialog')
      expect(menuButton.getAttribute('aria-expanded')).toBe('false')

      openMenu()
      expect(menuButton.getAttribute('aria-expanded')).toBe('true')
      expect(menuButton.getAttribute('aria-controls')).toBe(drawer()?.id)
    })

    it('hides the rest of the tree from assistive tech while open', () => {
      renderShell()
      openMenu()

      // This is the modality, and it is worth asserting precisely because it is NOT spelled
      // `aria-modal`: Radix's Dialog does not set that attribute at all. It marks every sibling
      // of the portal `aria-hidden` instead (the `hideOthers` approach), which is the stronger
      // of the two and what actually makes AT ignore the shell behind the drawer.
      const shell = document.querySelector('[data-slot="app-shell"]') as HTMLElement
      expect(shell.closest('[aria-hidden="true"]')).not.toBeNull()
      expect(drawer()?.closest('[aria-hidden="true"]')).toBeNull()
    })

    it('moves focus into the drawer and restores it to the menu button on close', async () => {
      renderShell()
      const menuButton = screen.getByRole('button', { name: 'Open menu' })
      // A real pointer click focuses the button it hits; fireEvent.click does not. Without this
      // the drawer opens while focus is on <body>, and "restore" would restore to <body> — the
      // test would pass or fail on a jsdom artifact rather than on Radix's focus scope.
      menuButton.focus()
      openMenu()

      await waitFor(() => expect(drawer()?.contains(document.activeElement)).toBe(true))

      fireEvent.click(within(drawer() as HTMLElement).getByRole('button', { name: 'Close menu' }))
      await waitFor(() => expect(drawer()).toBeNull())
      await waitFor(() => expect(document.activeElement).toBe(menuButton))
    })

    it('closes on Escape', async () => {
      renderShell()
      openMenu()
      fireEvent.keyDown(document, { key: 'Escape' })
      await waitFor(() => expect(drawer()).toBeNull())
    })

    it('closes when the backdrop is tapped', async () => {
      renderShell()
      openMenu()
      await settle()

      const overlay = document.querySelector('[data-slot="sheet-overlay"]')
      expect(overlay).not.toBeNull()

      // A whole tap, both halves. Radix defers a left-button dismissal from `pointerdown` to the
      // following `click` (so a drag that starts inside the drawer and releases over the backdrop
      // does not dismiss it), so a lone pointerDown here would assert nothing.
      fireEvent.pointerDown(overlay as Element)
      fireEvent.click(overlay as Element)
      await waitFor(() => expect(drawer()).toBeNull())
    })

    it('renders the same nav as the desktop sidebar', () => {
      renderShell()
      openMenu()

      const inDrawer = within(drawer() as HTMLElement)
        .getByRole('navigation', { name: 'Main' })
      const links = within(inDrawer).getAllByRole('link')

      // Asserted against NAV_ITEMS, not a copy of it: the point of this test is that the drawer
      // reuses the sidebar's content, so adding a nav item must not need a second edit here.
      const visible = visibleNavItems({ forge: true, inbox: true, automations: true }).filter((item) => !item.group)
      expect(links.map((a) => a.getAttribute('href'))).toEqual(visible.map((item) => item.to))
      expect(links.map((a) => a.textContent)).toEqual(visible.map((item) => item.label))

      // …and the rest of the sidebar came along, not just the nav.
      expect(within(drawer() as HTMLElement).getByRole('link', { name: /New task/ })).toBeTruthy()
      expect(within(drawer() as HTMLElement).getByRole('navigation', { name: 'Workspace' })).toBeTruthy()
      expect(within(drawer() as HTMLElement).getByRole('button', { name: 'More' })).toBeTruthy()
    })

    it('marks the active nav item inside the drawer too', () => {
      renderShell('/skills')
      openMenu()
      const current = within(drawer() as HTMLElement).getAllByRole('link', { current: 'page' })
      expect(current).toHaveLength(1)
      expect(current[0]?.textContent).toBe('Skills')
    })

    it('closes when a nav item inside it navigates', async () => {
      renderShell('/')
      openMenu()

      fireEvent.click(within(drawer() as HTMLElement).getByRole('link', { name: 'Git' }))

      // Both halves matter: an open drawer sitting on top of the newly routed view is the whole
      // bug this guards, and a drawer that closed without navigating would be just as wrong.
      await waitFor(() => expect(drawer()).toBeNull())
      expect(screen.getByTestId('location').textContent).toBe('/git')
    })

    it('closes when the already-active nav item is re-clicked', async () => {
      // No pathname change, so the route-change effect cannot fire — the link's own onNavigate
      // is what has to close it. Now navigating home while already active is a spec behavior.
      renderShell('/')
      openMenu()
      fireEvent.click(within(drawer() as HTMLElement).getByRole('link', { name: 'Now' }))
      await waitFor(() => expect(drawer()).toBeNull())
      expect(screen.getByTestId('location').textContent).toBe('/')
    })

    it('closes before the New task anchor hands off to the legacy document', async () => {
      renderShell('/')
      openMenu()
      const link = within(drawer() as HTMLElement).getByRole('link', { name: /New task/ })
      // jsdom does not implement full document navigation; suppress only that browser default.
      link.addEventListener('click', (event) => event.preventDefault(), { once: true })
      fireEvent.click(link)
      await waitFor(() => expect(drawer()).toBeNull())
      expect(link.getAttribute('href')).toBe('/new')
      expect(screen.getByTestId('location').textContent).toBe('/')
    })

    it('closes when the viewport widens past md, where the real sidebar takes over', async () => {
      // Otherwise an open drawer survives a rotation into a desktop-width layout and traps focus
      // in a modal copy of a sidebar that is now visible right next to it.
      const listeners = new Set<(event: MediaQueryListEvent) => void>()
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: false,
        media: query,
        addEventListener: (_: string, fn: (event: MediaQueryListEvent) => void) => listeners.add(fn),
        removeEventListener: (_: string, fn: (event: MediaQueryListEvent) => void) => listeners.delete(fn),
      }))

      renderShell()
      openMenu()
      expect(drawer()).not.toBeNull()

      // Every registered listener gets the event; only the shell's breakpoint one acts on it.
      for (const fn of listeners) fn({ matches: true } as MediaQueryListEvent)
      await waitFor(() => expect(drawer()).toBeNull())
    })

    it('pads the drawer for the safe-area insets', () => {
      renderShell()
      openMenu()
      const content = within(drawer() as HTMLElement)
        .getByRole('navigation', { name: 'Main' })
        .closest('[data-slot="sidebar-content"]') as HTMLElement

      // The drawer is a full-height overlay under the same notch and home indicator as the
      // sidebar — which is exactly why these insets live on the shared content, not on a frame.
      expect(content.className).toContain('pt-[env(safe-area-inset-top)]')
      expect(content.className).toContain('pb-[env(safe-area-inset-bottom)]')
    })
  })
})


describe('Dashboard active navigation', () => {
  it.each(['/dashboard', '/dashboard?view=costs', '/dashboard?period=30d'])('highlights %s beyond hover', entry => {
    renderShell(entry)
    const link = screen.getByRole('link', { name: 'Dashboard' })
    expect(link.getAttribute('aria-current')).toBe('page')
    expect(link.classList.contains('bg-muted')).toBe(true)
  })
  it('does not remain highlighted on another page', () => {
    renderShell('/tasks')
    const link = screen.getByRole('link', { name: 'Dashboard' })
    expect(link.getAttribute('aria-current')).toBeNull()
    expect(link.classList.contains('bg-muted')).toBe(false)
  })
})

describe('AppShell with managers (spec 2026-10-31-managers, one sidebar)', () => {
  const manager = { managersAvailable: true, currentTasks: <p>current rows</p> }
  const managerLink = () => document.querySelector('[data-slot="manager-link"]') as HTMLElement | null

  it('has no Manager row while health says no', () => {
    renderShell('/manager', { currentTasks: <p>current rows</p> })
    expect(managerLink()).toBeNull()
    expect(screen.getAllByText('current rows').length).toBeGreaterThan(0)
  })

  it('keeps the same sidebar on a manager URL and lights the Manager row', () => {
    renderShell('/manager/global', manager)
    expect(managerLink()?.getAttribute('aria-current')).toBe('page')
    expect(screen.getAllByText('New task').length).toBeGreaterThan(0)
    expect(screen.getAllByText('current rows').length).toBeGreaterThan(0)
    expect(within(nav()).queryAllByRole('link', { current: 'page' })).toHaveLength(0)
    cleanup()
    renderShell('/p/alpha/', manager)
    expect(managerLink()?.getAttribute('aria-current')).toBeNull()
  })

  it('badges the row with the waiting count, else carries the attention dot', () => {
    renderShell('/p/alpha/', { ...manager, managerCount: 2, managerAttention: 'needs-you' })
    expect(managerLink()?.querySelector('[data-slot="manager-badge"]')?.textContent).toBe('2')
    expect(managerLink()?.querySelector('[data-slot="manager-attention"]')).toBeNull()
    cleanup()
    renderShell('/p/alpha/', { ...manager, managerCount: 0, managerAttention: 'unread' })
    expect(managerLink()?.querySelector('[data-slot="manager-badge"]')).toBeNull()
    expect(managerLink()?.querySelector('[data-slot="manager-attention"] span')?.className).toContain('bg-info')
    // …and the phone menu button carries the dot outside Manager.
    expect(document.querySelector('[data-slot="mobile-manager-attention"] span')?.className).toContain('bg-info')
  })

  it('titles the phone bar', () => {
    renderShell('/manager', manager)
    expect(within(document.querySelector('[data-slot="mobile-top-bar"]') as HTMLElement).getByText('Manager')).toBeTruthy()
    cleanup()
    renderShell('/tasks', manager)
    expect(within(document.querySelector('[data-slot="mobile-top-bar"]') as HTMLElement).getByText('All tasks')).toBeTruthy()
    cleanup()
    renderShell('/p/alpha/', manager)
    expect(within(document.querySelector('[data-slot="mobile-top-bar"]') as HTMLElement).getByText('Now')).toBeTruthy()
  })
})

describe('AppShell — Focus rail (spec 2026-10-22-html-artifacts-and-impact, R2)', () => {
  it('folds the sidebar to an icon rail while a view holds it, and the rail asks the holder to let go', async () => {
    const { holdSidebarRail } = await import('@/lib/sidebar-rail')
    renderShell('/tasks/r1/assets')
    expect(sidebar()).toBeTruthy()

    const onExit = vi.fn()
    let release = () => {}
    act(() => {
      release = holdSidebarRail(onExit)
    })
    expect(document.querySelector('[data-slot="sidebar"]')).toBeNull()
    const rail = document.querySelector('[data-slot="focus-sidebar-rail"]') as HTMLElement
    expect(rail).toBeTruthy()
    // The rail still navigates: every nav item as an icon link, Tasks lit for a task URL.
    expect(within(rail).getByRole('link', { name: 'Tasks' }).getAttribute('aria-current')).toBe('page')
    // Every project area is in the rail as well as the expanded nav.
    expect(within(rail).getByRole('link', { name: 'Git' }).getAttribute('href')).toBe('/git')

    fireEvent.click(within(rail).getByRole('button', { name: 'Show sidebar' }))
    expect(onExit).toHaveBeenCalledTimes(1)

    act(() => release())
    expect(sidebar()).toBeTruthy()
    expect(document.querySelector('[data-slot="focus-sidebar-rail"]')).toBeNull()
  })

  it('Mod+B on the Focus rail asks the holder to let go, like its expand button', async () => {
    const { holdSidebarRail } = await import('@/lib/sidebar-rail')
    renderShell('/tasks/r1/assets')
    const onExit = vi.fn()
    let release = () => {}
    act(() => {
      release = holdSidebarRail(onExit)
    })
    const mod = /mac/i.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }
    fireEvent.keyDown(window, { key: 'b', code: 'KeyB', ...mod })
    expect(onExit).toHaveBeenCalledTimes(1)
    // The user's own fold preference is untouched: Focus off returns the sidebar they had.
    expect(localStorage.getItem('cez-sidebar-folded')).toBeNull()
    act(() => release())
  })
})
