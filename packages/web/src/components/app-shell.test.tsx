import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { Link as RouterLink, MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProjectListEntry } from '@open-mercato/cezar-api-client'
import { ShellProviders } from '@/test/shell-providers'
import { AppShell, routeOwnsScrollArrival, type AppShellProps } from './app-shell'
import { ContextSidebar } from './context-sidebar'
import { useGlobalSettings } from './global-settings'
import { NAV_ITEMS, visibleNavItems } from './nav-items'
import { ThemeProvider } from './theme-provider'

/**
 * The cockpit shell: an icon RAIL on the canvas (the cockpit's own menu, New task, the two
 * workspace pages, the project's areas, the project switcher) beside one PANEL (a collapsible
 * contextual sidebar the screen fills, the top bar with the breadcrumb, the one scroller).
 * Below `md` the rail is hidden and the contextual sidebar becomes a sheet that carries the same
 * areas as labelled rows.
 *
 * jsdom has no layout engine. What it does have is `window.innerWidth` and a `matchMedia` we
 * supply, and those two are exactly what the shell's breakpoint hooks read — so a "phone" here is
 * a width, not a guess. Whether the result actually reflows at 390px stays with the e2e suite.
 */

type MediaListener = (event: MediaQueryListEvent) => void
const mediaListeners = new Set<{ query: string; listener: MediaListener }>()

const DESKTOP = 1280
/** At or above `md`, but narrower than the width the contextual sidebar wants to stay open at. */
const TABLET = 900
const PHONE = 390

function mediaMatches(query: string): boolean {
  const min = /\(min-width:\s*(\d+)px\)/.exec(query)
  if (min) return window.innerWidth >= Number(min[1])
  const max = /\(max-width:\s*(\d+)px\)/.exec(query)
  if (max) return window.innerWidth <= Number(max[1])
  return false
}

function setViewport(width: number) {
  ;(window as { innerWidth: number }).innerWidth = width
}

/** A rotation or a window drag: the new width, announced to everything listening for it. */
function resizeTo(width: number) {
  setViewport(width)
  act(() => {
    for (const { query, listener } of [...mediaListeners]) {
      listener({ matches: mediaMatches(query), media: query } as MediaQueryListEvent)
    }
  })
}

beforeEach(() => {
  setViewport(DESKTOP)
  vi.stubGlobal('matchMedia', (query: string) => {
    const entries = new Map<MediaListener, { query: string; listener: MediaListener }>()
    return {
      get matches() {
        return mediaMatches(query)
      },
      media: query,
      addEventListener: (_: string, listener: MediaListener) => {
        const entry = { query, listener }
        entries.set(listener, entry)
        mediaListeners.add(entry)
      },
      removeEventListener: (_: string, listener: MediaListener) => {
        const entry = entries.get(listener)
        if (entry) mediaListeners.delete(entry)
      },
    }
  })
  // Radix positions menus and tooltips with floating-ui, which observes the trigger's size.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  cleanup()
  mediaListeners.clear()
  vi.unstubAllGlobals()
  setViewport(1024)
  // The contextual sidebar's open state is a real localStorage preference — one test's toggle
  // must not be the next test's starting state.
  localStorage.clear()
  document.documentElement.classList.remove('light')
})

/** Makes the current URL assertable, so a "the sheet closed" test can also prove the click it
 *  fired actually navigated rather than merely dismissing the sheet. */
function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>
}

/** Global settings are a dialog now; this is whether (and where) something asked for it. */
function SettingsProbe() {
  const settings = useGlobalSettings()
  return <output data-testid="global-settings" data-open={String(settings.isOpen)} data-section={settings.section ?? ''} />
}

/** Mount the shell at a URL, exactly as a cold-loaded deep link would. */
function renderShell(entry = '/', props: Partial<AppShellProps> = {}, children: ReactNode = <p>route content</p>) {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[entry]}>
        <ShellProviders>
          <AppShell {...props}>
            {children}
            <LocationProbe />
          </AppShell>
          <SettingsProbe />
        </ShellProviders>
      </MemoryRouter>
    </ThemeProvider>,
  )
}

function renderPhone(entry = '/', props: Partial<AppShellProps> = {}, children?: ReactNode) {
  setViewport(PHONE)
  return renderShell(entry, props, children)
}

const project = (over: Partial<ProjectListEntry> & Pick<ProjectListEntry, 'id'>): ProjectListEntry => ({
  name: over.id,
  root: `/home/me/${over.id}`,
  addedAt: '2026-07-01T00:00:00.000Z',
  lastOpenedAt: '2026-07-20T12:00:00.000Z',
  source: 'local',
  status: 'ok',
  branch: 'main',
  forge: 'github',
  ...over,
})

const slot = (name: string, within_: ParentNode = document) =>
  within_.querySelector(`[data-slot="${name}"]`) as HTMLElement | null
const rail = () => slot('rail') as HTMLElement
const panel = () => slot('panel') as HTMLElement
const topBar = () => slot('top-bar') as HTMLElement
const nav = () => within(rail()).getByRole('navigation', { name: 'Main' })
/** The contextual sidebar as the desktop renders it (a sheet below `md` — see `sheet()`). */
const contextSidebar = () => panel().querySelector('[data-slot="sidebar"][data-state]') as HTMLElement
const sidebarTrigger = () => within(topBar()).getByRole('button', { name: 'Toggle Sidebar' })
const settingsProbe = () => screen.getByTestId('global-settings')
/** A rail link names itself with `aria-label` (it is an icon), a sheet row with its text. */
const nameOf = (link: HTMLElement) => link.getAttribute('aria-label') ?? link.textContent

/** Radix opens a menu on pointerdown, not click. */
async function openMenu(trigger: HTMLElement): Promise<HTMLElement> {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
  return await screen.findByRole('menu')
}
/** The cockpit's own menu, at the head of the rail: version, updates, global settings, theme, ⭐. */
const openCockpitMenu = (scope: ParentNode = rail()) => openMenu(slot('footer-menu', scope) as HTMLElement)
const openSwitcher = (scope: ParentNode = rail()) => openMenu(slot('project-switcher', scope) as HTMLElement)

describe('AppShell', () => {
  it('renders the routed view in the main region', () => {
    renderShell('/', {}, <p>route content</p>)
    expect(within(screen.getByRole('main')).getByText('route content')).toBeTruthy()
  })

  // Brand guideline ("Znak z nazwą"): the mark WITHOUT its tile, in the text colour. On the rail
  // the mark alone is the face of the cockpit's menu; the lowercase name in the brand face sits
  // inside that menu, where there is room for a word.
  it('renders the brand: the tile-less mark on the rail, the lowercase name in its menu', async () => {
    renderShell('/')
    const trigger = slot('footer-menu', rail()) as HTMLElement
    expect(trigger.getAttribute('aria-label')).toBe('cezar menu')

    const mark = slot('brand-mark', trigger) as unknown as SVGElement | null
    expect(mark).toBeTruthy()
    expect(mark!.getAttribute('height')).toBe('25')
    expect(mark!.getAttribute('fill')).toBe('currentColor')
    // No tile: polygons only, no rect behind them and no <img> of the tiled icon.
    expect(mark!.querySelectorAll('polygon')).toHaveLength(4)
    expect(mark!.querySelector('rect')).toBeNull()
    expect(rail().querySelector('img')).toBeNull()

    const menu = await openCockpitMenu()
    const name = within(menu).getByText('cezar')
    expect(name.style.fontFamily).toBe('var(--brand)')
    expect(name.classList.contains('lowercase')).toBe(true)
  })

  it('renders a workspace name and uploaded logo when supplied', async () => {
    renderShell('/', { brandName: 'Acme Studio', brandLogoUrl: '/api/v1/workspace/branding-logo?v=abc' })
    const trigger = slot('footer-menu', rail()) as HTMLElement
    expect(trigger.getAttribute('aria-label')).toBe('Acme Studio menu')
    expect(trigger.querySelector('img')?.getAttribute('src')).toBe('/api/v1/workspace/branding-logo?v=abc')
    expect(slot('brand-mark', trigger)).toBeNull()

    const menu = await openCockpitMenu()
    const name = within(menu).getByText('Acme Studio')
    // A workspace's own name keeps its own capitalisation — only `cezar` is set lowercase.
    expect(name.classList.contains('lowercase')).toBe(false)
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

  it('renders the whole nav as real router links', () => {
    renderShell()
    const links = within(nav()).getAllByRole('link')
    // Icons, so each names itself — and the project's own settings say whose they are, now that
    // global settings are a different thing (a dialog in the cockpit menu).
    expect(links.map(nameOf)).toEqual([
      'Tasks',
      'Inbox',
      'Git',
      'GitHub',
      'Automations',
      'Skills',
      'Workflows',
      'Project settings',
    ])
    // Deep-linkable per Step 2.1: every nav row is an <a href>, not a button with an onClick.
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/',
      '/inbox',
      '/git',
      '/github',
      '/automations',
      '/skills',
      '/workflows',
      '/settings',
    ])
  })

  it('names every rail icon in a tooltip, since none of them carries a visible word', async () => {
    renderShell()
    fireEvent.focus(within(nav()).getByRole('link', { name: 'Git' }))
    expect((await screen.findByRole('tooltip')).textContent).toBe('Git')
  })

  // R6 Step 1.1: no forge, no GitHub tab — the nav item disappears entirely (spec's
  // degradation table), it does not render disabled.
  it('drops the GitHub item when the forge is unavailable', () => {
    renderShell('/', { forgeAvailable: false })
    const links = within(nav()).getAllByRole('link')
    expect(links.map((a) => a.getAttribute('href'))).not.toContain('/github')
    expect(links).toHaveLength(NAV_ITEMS.filter((item) => !item.forge && !item.tracker).length)
  })

  // #801: same degradation for the opt-in automations capability — the item disappears, it does
  // not render disabled. The two gates on that item are independent: a forge alone is not enough.
  it('drops the Automations item when the capability is off', () => {
    renderShell('/', { automationsAvailable: false })
    const links = within(nav()).getAllByRole('link')
    expect(links.map((a) => a.getAttribute('href'))).not.toContain('/automations')
    expect(links).toHaveLength(NAV_ITEMS.filter((item) => !item.automations && !item.tracker).length)
  })

  it('shows the Automations item once the capability is on', () => {
    renderShell('/', { automationsAvailable: true })
    expect(within(nav()).getAllByRole('link').map((a) => a.getAttribute('href')))
      .toContain('/automations')
  })

  describe('active nav state follows the current route', () => {
    const SHOP = { activeProjectId: 'shop', projects: [project({ id: 'shop' })] }
    const cases: Array<[entry: string, active: string]> = [
      ['/p/shop/', 'Tasks'],
      ['/p/shop/git', 'Git'],
      ['/p/shop/skills', 'Skills'],
      // Tasks stays lit while a task thread is open (spec's "Task list & table").
      ['/p/shop/tasks/abc123', 'Tasks'],
      ['/p/shop/settings/agents', 'Project settings'],
    ]

    for (const [entry, active] of cases) {
      it(`${entry} → ${active}`, () => {
        renderShell(entry, SHOP)
        const current = within(nav()).getAllByRole('link', { current: 'page' })
        // Exactly one — two lit rows is as wrong as none.
        expect(current).toHaveLength(1)
        expect(nameOf(current[0]!)).toBe(active)
        expect(current[0]!.getAttribute('data-active')).toBe('true')
      })
    }

    it('lights nothing on a full-screen surface like /new', () => {
      renderShell('/p/shop/new', SHOP)
      expect(within(nav()).queryAllByRole('link', { current: 'page' })).toHaveLength(0)
    })

    // The areas are the PROJECT's. A page that belongs to no project (Dashboard, All tasks,
    // global settings) still offers them — pointed at the boot project — but stands in none.
    it('lights nothing on a page that belongs to no project, while still leading into the boot one', () => {
      renderShell('/tasks', { activeProjectId: null, bootProjectId: 'cezar', projects: [project({ id: 'cezar' })] })
      expect(within(nav()).queryAllByRole('link', { current: 'page' })).toHaveLength(0)
      expect(within(nav()).getByRole('link', { name: 'Git' }).getAttribute('href')).toBe('/p/cezar/git')
    })

    it('points every area at the project the URL names', () => {
      renderShell('/p/shop/git', {
        activeProjectId: 'shop',
        bootProjectId: 'cezar',
        projects: [project({ id: 'cezar' }), project({ id: 'shop' })],
      })
      const hrefs = within(nav()).getAllByRole('link').map((a) => a.getAttribute('href'))
      expect(hrefs).toContain('/p/shop/git')
      expect(hrefs.every((href) => href?.startsWith('/p/shop/'))).toBe(true)
    })
  })

  describe('New task button', () => {
    it('links to /new', () => {
      renderShell()
      expect(within(rail()).getByRole('link', { name: /New task/ }).getAttribute('href')).toBe('/new')
    })

    it('carries the C hint in its tooltip (the browser-usable accelerator; ⌘N only fires in the desktop shell)', async () => {
      renderShell()
      fireEvent.focus(within(rail()).getByRole('link', { name: /New task/ }))
      expect((await screen.findByRole('tooltip')).textContent).toBe('New task · C')
    })
  })

  /** The project switcher at the foot of the rail: which project you are in, the way to another
   *  one, and the ways to add one. It replaced the sidebar's per-project groups and its own
   *  "Add project" button. */
  describe('project switcher', () => {
    const PROJECTS = [
      project({ id: 'cezar', branch: 'main' }),
      project({ id: 'shop', name: 'Storefront', branch: 'feat/cart' }),
      project({ id: 'gone', name: 'Old one', status: 'missing', root: '/home/me/gone' }),
    ]
    const items = (menu: HTMLElement) =>
      [...menu.querySelectorAll<HTMLElement>('[data-slot="project-group"]')]

    it('names the project it stands in', () => {
      renderShell('/p/shop/', { projects: PROJECTS, activeProjectId: 'shop' })
      const switcher = slot('project-switcher', rail()) as HTMLElement
      expect(switcher.getAttribute('aria-label')).toBe('Project: Storefront. Switch project')
      expect(slot('repo-chip', switcher)?.textContent).toBe('S')
    })

    it('lists every project with its branch and marks the current one', async () => {
      renderShell('/p/shop/', { projects: PROJECTS, activeProjectId: 'shop' })
      const menu = await openSwitcher()
      expect(items(menu).map((item) => item.dataset.project)).toEqual(['cezar', 'shop', 'gone'])
      expect(items(menu).map((item) => item.textContent)).toEqual([
        'cezarmain',
        'Storefrontfeat/cart',
        'Old onefolder not found',
      ])
      expect(items(menu).map((item) => item.hasAttribute('data-active'))).toEqual([false, true, false])
    })

    it('switches project in place', async () => {
      renderShell('/p/shop/git', { projects: PROJECTS, activeProjectId: 'shop' })
      const menu = await openSwitcher()
      fireEvent.click(items(menu)[0]!)
      expect(screen.getByTestId('location').textContent).toBe('/p/cezar/')
    })

    it('lists a missing folder but refuses to navigate into it', async () => {
      renderShell('/p/shop/', { projects: PROJECTS, activeProjectId: 'shop' })
      const menu = await openSwitcher()
      const gone = items(menu)[2]!
      expect(gone.getAttribute('aria-disabled')).toBe('true')
      expect(gone.getAttribute('title')).toContain('/home/me/gone is gone')
      fireEvent.click(gone)
      expect(screen.getByTestId('location').textContent).toBe('/p/shop/')
    })

    it('offers the ways to add a project by default', async () => {
      renderShell()
      const menu = await openSwitcher()
      expect(slot('add-project-local', menu)?.textContent).toBe('Open local folder…')
      expect(slot('add-project-clone', menu)?.textContent).toBe('Clone from GitHub…')
      expect(within(menu).getByRole('menuitem', { name: 'Manage projects' })).toBeTruthy()
    })

    it('omits them in single-project mode while normal navigation remains', async () => {
      renderShell('/', { singleProject: true, projects: [project({ id: 'cezar' })], bootProjectId: 'cezar' })
      expect(within(nav()).getByRole('link', { name: 'Tasks' })).toBeTruthy()
      expect(within(rail()).getByRole('link', { name: /New task/ })).toBeTruthy()
      const menu = await openSwitcher()
      expect(slot('add-project-local', menu)).toBeNull()
      expect(slot('add-project-clone', menu)).toBeNull()
      expect(within(menu).queryByRole('menuitem', { name: 'Manage projects' })).toBeNull()
      // The one project is still listed — the menu is not empty, just closed to expansion.
      expect(items(menu)).toHaveLength(1)
    })

    it('opens global settings on Projects from "Manage projects"', async () => {
      renderShell('/p/shop/', { projects: PROJECTS, activeProjectId: 'shop' })
      const menu = await openSwitcher()
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Manage projects' }))
      expect(settingsProbe().getAttribute('data-open')).toBe('true')
      expect(settingsProbe().getAttribute('data-section')).toBe('projects')
      expect(screen.getByTestId('location').textContent).toBe('/p/shop/')
    })
  })

  /* The footer used to be a row of small controls that overflowed the 264px column, so the theme
   * toggle silently fell onto a line of its own (#702), and a long nightly version pushed the gear
   * out of it (#876). The redesign ended that class of bug by construction: everything about the
   * cockpit itself lives in ONE menu at the head of the rail, and search and the tools status sit
   * in the top bar. These pin that arrangement. */
  describe('the cockpit menu holds the cockpit controls (#702)', () => {
    it('puts the theme choice in the cockpit menu, and picking one keeps the menu open', async () => {
      renderShell()
      const menu = await openCockpitMenu()
      const group = slot('theme-toggle', menu) as HTMLElement
      const radios = within(group).getAllByRole('menuitemradio')
      expect(radios.map((radio) => radio.textContent)).toEqual(['Light', 'Dark', 'System'])
      expect(group.getAttribute('data-theme-pref')).toBe('dark')
      expect(document.documentElement.classList.contains('light')).toBe(false)

      fireEvent.click(radios[0]!)

      expect(document.documentElement.classList.contains('light')).toBe(true)
      expect(slot('theme-toggle', menu)?.getAttribute('data-theme-pref')).toBe('light')
      expect(within(menu).getByRole('menuitemradio', { name: 'Light' }).getAttribute('aria-checked')).toBe('true')
      // A theme is something you try on: the menu stays so the next one is a single click away.
      expect(screen.queryByRole('menu')).not.toBeNull()
    })

    it('keeps the version, global settings and the theme together in that one menu', async () => {
      renderShell('/', { version: '1.2.3', toolsMenu: <button type="button">Tools</button> })
      // The tools status is about the whole cockpit too, but it is a glance, so it stays in view.
      expect(within(slot('tools-menu', topBar()) as HTMLElement).getByRole('button', { name: 'Tools' })).toBeTruthy()
      // The gear and the toggle are the pair that came apart in #702 — they now share a menu,
      // and nothing about the cockpit is left stranded on the rail itself.
      const menu = await openCockpitMenu()
      expect(slot('global-settings-link', menu)).not.toBeNull()
      expect(slot('theme-toggle', menu)).not.toBeNull()
      expect(slot('version-chip', menu)).not.toBeNull()
      expect(slot('tools-menu', menu)).toBeNull()
    })

    it('opens global settings as a dialog — the menu item navigates nowhere', async () => {
      renderShell('/p/shop/git', { projects: [project({ id: 'shop' })], activeProjectId: 'shop' })
      const menu = await openCockpitMenu()
      const item = slot('global-settings-link', menu) as HTMLElement
      expect(item.tagName).not.toBe('A')
      expect(item.textContent).toBe('Global settings')

      fireEvent.click(item)

      expect(settingsProbe().getAttribute('data-open')).toBe('true')
      expect(screen.getByTestId('location').textContent).toBe('/p/shop/git')
    })

    it('puts the machine glance at the top of the menu, above every item', async () => {
      renderShell('/', { version: '1.2.3', hostWidget: <span data-slot="host-widget-stub" /> })
      // Nothing is mounted until the menu opens: a glance nobody is looking at samples nothing.
      expect(slot('host-widget-stub')).toBeNull()
      const menu = await openCockpitMenu()
      const widget = slot('host-widget-stub', menu) as HTMLElement
      const firstItem = within(menu).getAllByRole('menuitem')[0]!
      expect(widget.compareDocumentPosition(firstItem) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it('renders search in the top bar as a launcher that still opens the palette', () => {
      renderShell()
      // Named by its own visible label, not by an aria-label that would diverge from it
      // (WCAG 2.5.3) — jsdom reports no `navigator.platform`, so the chord reads Ctrl+K.
      const search = within(topBar()).getByRole('button', { name: 'Search' })
      expect(search.dataset.slot).toBe('command-palette-hint')
      expect(search.querySelector('kbd')?.textContent).toBe('Ctrl+K')
      // The chord is decoration for the eye: read aloud it would rename the button.
      expect(search.querySelector('kbd')?.getAttribute('aria-hidden')).toBe('true')

      const opened = vi.fn()
      window.addEventListener('cezar:open-command-palette', opened)
      fireEvent.click(search)
      window.removeEventListener('cezar:open-command-palette', opened)
      expect(opened).toHaveBeenCalledTimes(1)
    })

    it('shows a long nightly version whole — the menu grows, nothing is pushed out of a row', async () => {
      renderShell('/', { version: '0.9.2-nightly.20260813.1' })
      const menu = await openCockpitMenu()
      expect(slot('version-chip', menu)?.textContent).toBe('v0.9.2-nightly.20260813.1')
      expect(slot('global-settings-link', menu)).not.toBeNull()
      expect(slot('theme-toggle', menu)).not.toBeNull()
    })
  })

  describe('data slots stay empty rather than showing invented data', () => {
    it('renders no badge, version chip or ⭐ ask when unfed, and names the brand rather than a project', async () => {
      renderShell()
      expect(slot('nav-badge')).toBeNull()
      expect(slot('nav-unread-badge')).toBeNull()
      // With no registry and no repo there is no project to name — the switcher falls back to
      // the brand, it does not make a project up.
      expect(slot('project-switcher', rail())?.getAttribute('aria-label')).toBe('Project: cezar. Switch project')
      const menu = await openCockpitMenu()
      expect(slot('version-chip', menu)).toBeNull()
      expect(slot('star-chip', menu)).toBeNull()
      expect(within(menu).queryByRole('menuitem', { name: /update/i })).toBeNull()
    })

    it('renders the repo and version from props', async () => {
      renderShell('/', { repo: { name: 'storefront', branch: 'main' }, version: '1.2.3' })
      const switcher = slot('project-switcher', rail()) as HTMLElement
      expect(switcher.getAttribute('aria-label')).toBe('Project: storefront. Switch project')
      expect(slot('repo-chip', switcher)?.textContent).toBe('s')
      // The branch has no room on a 36px tile: it rides the tooltip.
      fireEvent.focus(switcher)
      expect((await screen.findByRole('tooltip')).textContent).toBe('storefront · main')
      // The chip prefixes the raw semver from /api/v1/health — `v1.2.3`, mono, muted.
      const menu = await openCockpitMenu()
      expect(within(menu).getByText('v1.2.3')).toBe(slot('version-chip', menu))
    })

    describe('the ⭐ ask', () => {
      const chip = () => slot('star-chip') as HTMLAnchorElement | null

      it('renders the count in the cockpit menu, beside the ask', async () => {
        renderShell('/', { version: '1.2.3', starCount: 1234 })
        const menu = await openCockpitMenu()
        expect(slot('star-chip', menu)).not.toBeNull()
        expect(within(chip()!).getByText('1.2k')).toBeTruthy()
        expect(chip()!.textContent).toContain('Star on GitHub')
      })

      it('is absent — not empty — when the count is unavailable', async () => {
        // Offline, a rate-limited IP, or `CEZ_NO_BANNER=1`. An ask advertising a number it
        // cannot produce is worse than no ask.
        renderShell('/', { version: '1.2.3', starCount: null })
        await openCockpitMenu()
        expect(chip()).toBeNull()
      })

      it('still renders at zero — a real count, not a missing one', async () => {
        renderShell('/', { version: '1.2.3', starCount: 0 })
        await openCockpitMenu()
        expect(chip()).not.toBeNull()
        expect(within(chip()!).getByText('0')).toBeTruthy()
      })

      it('links to cezar, in a new tab, leaking neither opener nor referrer', async () => {
        renderShell('/', { starCount: 42 })
        await openCockpitMenu()
        expect(chip()?.getAttribute('href')).toBe('https://github.com/open-mercato/cezar')
        expect(chip()?.getAttribute('target')).toBe('_blank')
        expect(chip()?.getAttribute('rel')).toContain('noopener')
        expect(chip()?.getAttribute('rel')).toContain('noreferrer')
      })

      it('names itself for a screen reader with the exact count, not the abbreviation', async () => {
        renderShell('/', { starCount: 12_345 })
        await openCockpitMenu()
        // The visible count abbreviates; the accessible name must not — "12.3k stars" is a
        // worse answer to "how many" than the number itself.
        const label = chip()?.getAttribute('aria-label') ?? ''
        expect(label).toMatch(/star cezar on github/i)
        // Formatted for the reader's own locale, so assert it the same way rather than pinning
        // `12,345` — that spelling is a property of the test machine, not of this component.
        expect(label).toContain(new Intl.NumberFormat().format(12_345))
        expect(label).not.toContain('12.3k')
      })

      it('offers no reward and blocks nothing — the ask is a link and only a link', async () => {
        renderShell('/', { starCount: 1000 })
        await openCockpitMenu()
        expect(chip()?.tagName).toBe('A')
        expect(chip()?.textContent ?? '').not.toMatch(/\b(unlock|reward|free|upgrade|pro|premium)\b/i)
      })
    })

    describe('version chip update affordance (#368)', () => {
      const trigger = () => slot('footer-menu', rail()) as HTMLElement
      const chip = () => slot('version-chip') as HTMLElement

      it('stays plain while the registry has nothing newer', async () => {
        renderShell('/', { version: '1.2.3' })
        expect(slot('status-dot', trigger())).toBeNull()
        const menu = await openCockpitMenu()
        expect(chip().getAttribute('data-update-available')).toBeNull()
        expect(slot('status-dot', menu)).toBeNull()
        // The way to look for one is still there; it just claims nothing.
        expect(within(menu).getByRole('menuitem', { name: 'Check for updates' })).toBeTruthy()
      })

      it('stays plain when latestVersion equals the running version', async () => {
        renderShell('/', { version: '1.2.3', latestVersion: '1.2.3' })
        expect(slot('status-dot', trigger())).toBeNull()
        const menu = await openCockpitMenu()
        expect(chip().getAttribute('data-update-available')).toBeNull()
        expect(slot('status-dot', menu)).toBeNull()
      })

      it('pulses on the rail and names the newer version in the menu when one exists', async () => {
        renderShell('/', { version: '1.2.3', latestVersion: '1.3.0' })
        // On the rail, where it can be seen without opening anything.
        const dot = slot('status-dot', trigger()) as HTMLElement
        expect(dot.getAttribute('data-tone')).toBe('pending')
        expect(dot.className).toContain('animate-pulse')

        const menu = await openCockpitMenu()
        expect(chip().getAttribute('data-update-available')).toBe('true')
        const update = within(menu).getByRole('menuitem', { name: 'Update to v1.3.0' })
        expect(slot('status-dot', update)?.getAttribute('data-tone')).toBe('pending')
        // The version shown is still the one actually running.
        expect(chip().textContent).toBe('v1.2.3')
      })
    })

    it('renders the Inbox badge only for a non-zero count', () => {
      renderShell('/', { inboxCount: 2 })
      const inbox = within(nav()).getByRole('link', { name: 'Inbox' })
      const badge = slot('nav-badge', inbox.closest('li')!) as HTMLElement
      expect(badge.textContent).toBe('2')

      cleanup()
      renderShell('/', { inboxCount: 0 })
      expect(slot('nav-badge')).toBeNull()
    })

    it('renders no Inbox badge without an Inbox to badge', () => {
      renderShell('/', { inboxCount: 2, inboxAvailable: false })
      expect(within(nav()).queryByRole('link', { name: 'Inbox' })).toBeNull()
      expect(slot('nav-badge')).toBeNull()
    })

    it('badges Tasks with the unread finished count, capped at 99+', () => {
      renderShell('/', { unreadCount: 3 })
      const tasks = within(nav()).getByRole('link', { name: 'Tasks' })
      const badge = slot('nav-unread-badge', tasks.closest('li')!) as HTMLElement
      expect(badge.textContent).toBe('3')
      expect(badge.getAttribute('title')).toBe('3 unread finished tasks')

      cleanup()
      renderShell('/', { unreadCount: 140 })
      expect(slot('nav-unread-badge')?.textContent).toBe('99+')

      cleanup()
      renderShell('/', { unreadCount: 0 })
      expect(slot('nav-unread-badge')).toBeNull()
    })

    it('renders a quiet accessible Skills update marker on the rail and in the phone sheet', async () => {
      renderPhone('/', { skillsUpdateAvailable: true })
      // The rail is in the tree at every width (CSS hides it below `md`), so its marker is too.
      expect(document.querySelectorAll('[data-slot="nav-update-marker"]')).toHaveLength(1)
      fireEvent.click(sidebarTrigger())
      const drawer = await screen.findByRole('dialog', { name: 'Sidebar' })
      const markers = document.querySelectorAll('[data-slot="nav-update-marker"]')
      expect(markers).toHaveLength(2)
      for (const marker of markers) {
        expect(marker.textContent).toBe('Skills update available')
        expect(marker.innerHTML).not.toContain('animate-')
      }
      // …and the sheet's own copy sits on the Skills row.
      const skills = within(drawer).getByRole('link', { name: 'Skills' })
      expect(slot('nav-update-marker', skills.closest('li')!)).not.toBeNull()
    })

    it('renders no Skills marker without an actionable update', () => {
      renderShell()
      expect(slot('nav-update-marker')).toBeNull()
    })

    it('reserves the contextual-sidebar, tools and composer slots', () => {
      renderShell()
      for (const name of ['context-sidebar-body', 'tools-menu', 'composer']) {
        expect(slot(name)).not.toBeNull()
      }
    })
  })

  /** The workspace's two pages — about every project, so they sit above the project's areas. */
  describe('All tasks link', () => {
    const allTasks = () => slot('all-tasks-link', rail()) as HTMLElement | null

    it('is on the rail above the project areas, not among them', () => {
      renderShell()
      expect(allTasks()).not.toBeNull()
      expect(nav().contains(allTasks())).toBe(false)
      expect(allTasks()!.compareDocumentPosition(nav()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it('links out of every project scope', () => {
      renderShell('/p/shop/git', { activeProjectId: 'shop', projects: [project({ id: 'shop' })] })
      // A PLAIN target: the scope-aware Link would prefix it with `/p/shop`, which is no route.
      expect(allTasks()!.getAttribute('href')).toBe('/tasks')
      expect(slot('dashboard-link', rail())!.getAttribute('href')).toBe('/dashboard')
    })

    it('marks itself the current page only on /tasks', () => {
      renderShell('/tasks')
      expect(allTasks()!.getAttribute('aria-current')).toBe('page')
      cleanup()
      renderShell('/p/shop/', { activeProjectId: 'shop', projects: [project({ id: 'shop' })] })
      expect(allTasks()!.getAttribute('aria-current')).toBeNull()
    })
  })

  /**
   * Dashboard and All tasks stack directly against each other, so they are peers: one size, one
   * icon treatment. Dashboard once shipped with its own inline class string and drifted to a
   * taller row with a differently coloured icon; these pin the pair together.
   */
  describe('top-level doors read as peers', () => {
    const dashboard = () => slot('dashboard-link', rail()) as HTMLElement
    const allTasks = () => slot('all-tasks-link', rail()) as HTMLElement

    it('paints both from the same class string', () => {
      renderShell()
      expect([...dashboard().classList].sort()).toEqual([...allTasks().classList].sort())
    })

    it('gives both the same 36px square the project areas use', () => {
      renderShell()
      const area = within(nav()).getByRole('link', { name: 'Git' })
      for (const door of [dashboard(), allTasks()]) {
        expect(door.classList.contains('size-9')).toBe(true)
        expect([...door.classList].sort()).toEqual([...area.classList].sort())
      }
    })

    it('gives both icons the same treatment — neither brings a colour of its own', () => {
      renderShell()
      const classes = [dashboard(), allTasks()].map((door) => door.querySelector('svg')?.getAttribute('class'))
      expect(classes[0]).toBeTruthy()
      expect(classes[0]?.replace(/lucide-[\w-]+/g, '')).toBe(classes[1]?.replace(/lucide-[\w-]+/g, ''))
      for (const cls of classes) expect(cls).not.toMatch(/\btext-/)
    })

    it('lights only itself on its own page', () => {
      renderShell('/dashboard')
      expect(dashboard().getAttribute('data-active')).toBe('true')
      expect(allTasks().getAttribute('data-active')).toBe('false')
      cleanup()
      renderShell('/tasks')
      expect(dashboard().getAttribute('data-active')).toBe('false')
      expect(allTasks().getAttribute('data-active')).toBe('true')
    })
  })

  /** The top bar: where you are, and the things that are about the whole cockpit. */
  describe('top bar', () => {
    it('renders the trail the container built: links back, then the page you are on', () => {
      renderShell('/p/shop/tasks/abc', {
        crumbs: [{ label: 'Storefront', to: '/p/shop/' }, { label: 'Tasks', to: '/p/shop/' }, { label: 'Fix the cart' }],
      })
      const trail = within(topBar()).getByRole('navigation', { name: 'breadcrumb' })
      const links = within(trail).getAllByRole('link')
      expect(links.map((link) => link.textContent)).toEqual(['Storefront', 'Tasks', 'Fix the cart'])
      expect(links.slice(0, 2).map((link) => link.getAttribute('href'))).toEqual(['/p/shop/', '/p/shop/'])
      // The last crumb is the page, not a way to it.
      expect(links[2]!.getAttribute('aria-current')).toBe('page')
      expect(links[2]!.hasAttribute('href')).toBe(false)
    })

    it('titles a phone from the page alone — the steps back are hidden below sm', () => {
      renderShell('/p/shop/skills', { crumbs: [{ label: 'Storefront', to: '/p/shop/' }, { label: 'Skills' }] })
      const items = [...topBar().querySelectorAll<HTMLElement>('[data-slot="breadcrumb-item"]')]
      expect(items.map((item) => item.textContent)).toEqual(['Storefront', 'Skills'])
      expect(items[0]!.classList.contains('hidden')).toBe(true)
      expect(items[0]!.classList.contains('sm:inline-flex')).toBe(true)
      expect(items[1]!.classList.contains('hidden')).toBe(false)
    })

    it('renders an empty trail rather than an invented one', () => {
      renderShell()
      expect(topBar().querySelectorAll('[data-slot="breadcrumb-item"]')).toHaveLength(0)
    })
  })

  describe('banner slot', () => {
    it('renders the banner when one is passed', () => {
      renderShell('/', { banner: <p>banner content</p> })
      const banner = slot('banner-slot') as HTMLElement
      expect(banner).not.toBeNull()
      expect(within(banner).getByText('banner content')).toBeTruthy()
    })

    it('renders nothing when absent — no empty slot to push the scroller down', () => {
      renderShell()
      expect(slot('banner-slot')).toBeNull()
    })

    // The regression the slot was born with (#391): as the first child of <main>, a sticky banner
    // sat in the same scrollport as every routed view's own `sticky top-0` header, which parked
    // over it (opaque, later in DOM, equal-or-higher z-index) and swallowed the clicks on its
    // dismiss X. Its own row instead — so the banner is chrome, above the scroller, not content.
    it('sits outside the scrolling main region, not inside it', () => {
      renderShell('/', { banner: <p>banner content</p> })
      const banner = slot('banner-slot') as HTMLElement
      expect(screen.getByRole('main').contains(banner)).toBe(false)
      expect(banner.className).not.toContain('sticky')
    })

    it('is its own row, a peer of the scroller: below the top bar and above the routed view', () => {
      renderShell('/', { banner: <p>banner content</p> })
      const banner = slot('banner-slot') as HTMLElement
      const main = screen.getByRole('main')
      const column = main.parentElement as HTMLElement
      expect(banner.parentElement).toBe(column)
      expect([...column.children].map((child) => (child as HTMLElement).dataset.slot)).toEqual([
        'top-bar',
        'banner-slot',
        'main',
        'composer',
      ])
      expect(column.classList.contains('flex-col')).toBe(true)
      // The scroller is the one row that gives, so the banner's height comes out of the shell's
      // own budget rather than making every `min-h-full` route overflow by exactly the banner.
      expect(main.classList.contains('flex-1')).toBe(true)
      expect(main.classList.contains('min-h-0')).toBe(true)
      expect(banner.classList.contains('flex-1')).toBe(false)
    })
  })

  /** jsdom cannot evaluate `md:` — so assert the structure and the responsive classes that
   *  encode it, and leave "does it actually reflow at 390px" to the e2e iPhone screenshot. */
  describe('responsive skeleton', () => {
    it('hides the rail below md and shows it from md up', () => {
      renderShell()
      expect(rail().classList.contains('hidden')).toBe(true)
      expect(rail().classList.contains('md:flex')).toBe(true)
    })

    it('keeps one top bar at every width — there is no separate mobile bar to drift from it', () => {
      renderShell()
      expect(document.querySelectorAll('[data-slot="top-bar"]')).toHaveLength(1)
      expect(topBar().tagName).toBe('HEADER')
      expect(topBar().className).not.toMatch(/\b(?:md:)?hidden\b/)
    })

    it('shows the sidebar button below md only, while no screen has filled the contextual sidebar', () => {
      renderShell()
      // On a phone it opens the sheet with the areas; on a desktop there is nothing to toggle.
      expect(sidebarTrigger().classList.contains('md:hidden')).toBe(true)
    })

    it('shows the sidebar button at every width once a screen fills the contextual sidebar', () => {
      renderShell('/', {}, <ContextSidebar><p>the task list</p></ContextSidebar>)
      expect(sidebarTrigger().classList.contains('md:hidden')).toBe(false)
    })
  })

  /**
   * The contextual sidebar: the collapsible column inside the panel that the SCREEN fills (the
   * task list on Tasks, the file tree on Git…). It replaced the hand-resizable 264–420px column
   * (#788): the width is fixed now and what the browser remembers is whether it is open.
   */
  describe('contextual sidebar', () => {
    const filled = <ContextSidebar><p>the task list</p></ContextSidebar>
    const STORAGE_KEY = 'cez-context-sidebar-open'

    it('portals what the screen renders into the shell’s sidebar, keeping it out of the scroller', () => {
      renderShell('/', {}, filled)
      const body = slot('context-sidebar-body') as HTMLElement
      expect(within(body).getByText('the task list')).toBeTruthy()
      expect(screen.getByRole('main').contains(body)).toBe(false)
      expect(panel().contains(body)).toBe(true)
    })

    it('stays collapsed — whatever the browser remembers — while no screen fills it', () => {
      localStorage.setItem(STORAGE_KEY, 'true')
      renderShell()
      expect(contextSidebar().getAttribute('data-state')).toBe('collapsed')
      // …and offers no edge to drag it open by.
      expect(slot('sidebar-rail', panel())).toBeNull()
    })

    it('starts open on a roomy window when nothing has been stored', () => {
      renderShell('/', {}, filled)
      expect(contextSidebar().getAttribute('data-state')).toBe('expanded')
      expect(slot('sidebar-rail', panel())).not.toBeNull()
    })

    it('collapses from the top bar button and persists the choice', () => {
      renderShell('/', {}, filled)
      fireEvent.click(sidebarTrigger())
      expect(contextSidebar().getAttribute('data-state')).toBe('collapsed')
      expect(contextSidebar().getAttribute('data-collapsible')).toBe('offcanvas')
      expect(localStorage.getItem(STORAGE_KEY)).toBe('false')

      fireEvent.click(sidebarTrigger())
      expect(contextSidebar().getAttribute('data-state')).toBe('expanded')
      expect(localStorage.getItem(STORAGE_KEY)).toBe('true')
    })

    it('restores the state the browser remembers', () => {
      localStorage.setItem(STORAGE_KEY, 'false')
      renderShell('/', {}, filled)
      // First paint, not an effect: a sidebar that slid shut on every load would be visible.
      expect(contextSidebar().getAttribute('data-state')).toBe('collapsed')
    })

    it('toggles on ⌘B / Ctrl+B', () => {
      renderShell('/', {}, filled)
      fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
      expect(contextSidebar().getAttribute('data-state')).toBe('collapsed')
      fireEvent.keyDown(window, { key: 'b', metaKey: true })
      expect(contextSidebar().getAttribute('data-state')).toBe('expanded')
    })

    it('leaves every other key to the browser — a bare B must still type', () => {
      renderShell('/', {}, filled)
      fireEvent.keyDown(window, { key: 'b' })
      expect(contextSidebar().getAttribute('data-state')).toBe('expanded')
    })

    it('starts closed between a phone and a roomy window, and a glance there is not remembered', () => {
      // At ~820px an open 18rem sidebar left the screen itself under half the panel.
      localStorage.setItem(STORAGE_KEY, 'true')
      setViewport(TABLET)
      renderShell('/', {}, filled)
      expect(contextSidebar().getAttribute('data-state')).toBe('collapsed')

      fireEvent.click(sidebarTrigger())
      expect(contextSidebar().getAttribute('data-state')).toBe('expanded')
      // Opening it here is a glance: it must not overwrite what a wide window remembers…
      expect(localStorage.getItem(STORAGE_KEY)).toBe('true')
      fireEvent.click(sidebarTrigger())
      expect(localStorage.getItem(STORAGE_KEY)).toBe('true')
    })

    it('goes back to the remembered state when the window grows roomy again', () => {
      localStorage.setItem(STORAGE_KEY, 'true')
      setViewport(TABLET)
      renderShell('/', {}, filled)
      expect(contextSidebar().getAttribute('data-state')).toBe('collapsed')
      resizeTo(DESKTOP)
      expect(contextSidebar().getAttribute('data-state')).toBe('expanded')
    })

    it('is a fixed 18rem column, with no resize handle left behind', () => {
      renderShell('/', {}, filled)
      const wrapper = contextSidebar().closest('[data-slot="sidebar-wrapper"]') as HTMLElement
      expect(wrapper.style.getPropertyValue('--sidebar-width')).toBe('18rem')
      expect(slot('sidebar-resize-handle')).toBeNull()
      expect(screen.queryByRole('separator', { name: 'Resize the sidebar' })).toBeNull()
    })

    it('lives inside the panel, not pinned to the window', () => {
      renderShell('/', {}, filled)
      // The stock shadcn container is `fixed` and viewport-tall; inside the rounded panel it has
      // to be the panel's own child so the panel's clipping hides it when it slides out.
      const container = slot('context-sidebar', panel()) as HTMLElement
      expect(container.classList.contains('absolute')).toBe(true)
      expect(container.classList.contains('fixed')).toBe(false)
      expect(panel().classList.contains('overflow-hidden')).toBe(true)
    })
  })

  /** The layout contract from the spec. These classes are the whole reason the cockpit does not
   *  scroll its document or clip its composer on an iPhone — a refactor that drops one is a
   *  regression no visual test would catch on a desktop viewport. */
  describe('layout contract', () => {
    it('is exactly one viewport tall and never scrolls the document', () => {
      renderShell()
      const shell = slot('app-shell') as HTMLElement
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
      // The thread, the diff views and the commit list all resolve their scroll owner through it.
      expect(main.dataset.slot).toBe('main')
    })

    it('pads for the safe-area insets', () => {
      renderShell()
      const shell = slot('app-shell') as HTMLElement
      expect(shell.className).toContain('pl-[env(safe-area-inset-left)]')
      expect(shell.className).toContain('pr-[env(safe-area-inset-right)]')

      expect(topBar().className).toContain('pt-[env(safe-area-inset-top)]')

      // The composer row keeps the home-indicator gutter even while it is empty.
      const composer = slot('composer') as HTMLElement
      expect(composer.className).toContain('pb-[env(safe-area-inset-bottom)]')
    })
  })

  /** The `<md` sheet (spec: "Sidebar becomes an overlay drawer … backdrop"): the contextual
   *  sidebar as a modal sheet, with the rail's content at its top — the project, the cockpit
   *  menu and the areas as labelled rows.
   *
   *  What these tests own is the state machine and the semantics, which no screenshot can check.
   */
  describe('mobile nav sheet', () => {
    const sheet = () => screen.queryByRole('dialog', { name: 'Sidebar' })
    const openSheet = () => fireEvent.click(sidebarTrigger())

    /** Radix arms its outside-pointer listener in a `setTimeout(…, 0)`, so a backdrop press fired
     *  in the same tick as the open would land before anything is listening. */
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

    it('is closed until the sidebar button is pressed', () => {
      renderPhone()
      expect(sheet()).toBeNull()
      openSheet()
      expect(sheet()).not.toBeNull()
    })

    it('is a dialog with an accessible name', () => {
      renderPhone()
      openSheet()
      // A real dialog, not a div styled to look like one — the focus trap and the Escape
      // handling below are only meaningful because the role underneath them is real.
      expect(sheet()?.getAttribute('role')).toBe('dialog')
      // `getByRole('dialog', { name: 'Sidebar' })` already proves the name resolves; this
      // pins down *how*, so dropping the sr-only SheetTitle fails here loudly.
      expect(sheet()?.getAttribute('aria-labelledby')).toBeTruthy()
    })

    it('advertises the sheet from the button that opens it', () => {
      renderPhone()
      const button = sidebarTrigger()
      expect(button.getAttribute('aria-expanded')).toBe('false')

      openSheet()
      expect(button.getAttribute('aria-expanded')).toBe('true')
    })

    it('hides the rest of the tree from assistive tech while open', () => {
      renderPhone()
      openSheet()

      // This is the modality, and it is worth asserting precisely because it is NOT spelled
      // `aria-modal`: Radix's Dialog does not set that attribute at all. It marks every sibling
      // of the portal `aria-hidden` instead (the `hideOthers` approach), which is the stronger
      // of the two and what actually makes AT ignore the shell behind the sheet.
      const shell = slot('app-shell') as HTMLElement
      expect(shell.closest('[aria-hidden="true"]')).not.toBeNull()
      expect(sheet()?.closest('[aria-hidden="true"]')).toBeNull()
    })

    it('moves focus into the sheet and restores it to the button on close', async () => {
      renderPhone()
      const button = sidebarTrigger()
      // A real pointer click focuses the button it hits; fireEvent.click does not. Without this
      // the sheet opens while focus is on <body>, and "restore" would restore to <body> — the
      // test would pass or fail on a jsdom artifact rather than on Radix's focus scope.
      button.focus()
      openSheet()

      await waitFor(() => expect(sheet()?.contains(document.activeElement)).toBe(true))
      await settle()

      // Dismissed the way a phone dismisses it: a tap on the backdrop (both halves — see below).
      const overlay = slot('sheet-overlay') as Element
      fireEvent.pointerDown(overlay)
      fireEvent.click(overlay)
      await waitFor(() => expect(sheet()).toBeNull())
      await waitFor(() => expect(document.activeElement).toBe(button))
    })

    it('closes on Escape', async () => {
      renderPhone()
      openSheet()
      fireEvent.keyDown(document, { key: 'Escape' })
      await waitFor(() => expect(sheet()).toBeNull())
    })

    it('closes when the backdrop is tapped', async () => {
      renderPhone()
      openSheet()
      await settle()

      const overlay = slot('sheet-overlay')
      expect(overlay).not.toBeNull()

      // A whole tap, both halves. Radix defers a left-button dismissal from `pointerdown` to the
      // following `click` (so a drag that starts inside the sheet and releases over the backdrop
      // does not dismiss it), so a lone pointerDown here would assert nothing.
      fireEvent.pointerDown(overlay as Element)
      fireEvent.click(overlay as Element)
      await waitFor(() => expect(sheet()).toBeNull())
    })

    it('carries the same areas as the rail, as labelled rows', () => {
      renderPhone()
      openSheet()

      const links = within(sheet() as HTMLElement).getAllByRole('link')

      // Asserted against NAV_ITEMS, not a copy of it: the point of this test is that the sheet
      // lists what the rail lists, so adding a nav item must not need a second edit here.
      const visible = visibleNavItems({ forge: true, inbox: true, automations: true })
      expect(links.map((a) => a.getAttribute('href'))).toEqual([
        '/new',
        ...visible.map((item) => item.to),
        '/dashboard',
        '/tasks',
      ])
      expect(links.map((a) => a.textContent)).toEqual([
        'New task',
        ...visible.map((item) => item.label),
        'Dashboard',
        'All tasks',
      ])

      // …and the two ends of the rail came along, not just the areas: the project and the way to
      // another one, and the cockpit's own menu (theme, updates, global settings).
      const identity = slot('mobile-identity', sheet() as HTMLElement) as HTMLElement
      expect(slot('project-switcher', identity)).not.toBeNull()
      expect(slot('footer-menu', identity)).not.toBeNull()
      expect(within(sheet() as HTMLElement).getByRole('button', { name: 'Global settings' })).toBeTruthy()
    })

    it('names the project and its branch at the top of the sheet', () => {
      renderPhone('/p/shop/', {
        projects: [project({ id: 'shop', name: 'Storefront' })],
        activeProjectId: 'shop',
        repo: { name: 'cezar', branch: 'feat/cart' },
      })
      openSheet()
      const identity = slot('mobile-identity', sheet() as HTMLElement) as HTMLElement
      expect(within(identity).getByText('Storefront')).toBeTruthy()
      expect(within(identity).getByText('feat/cart')).toBeTruthy()
    })

    it('puts the areas above whatever the screen filled the sidebar with', () => {
      renderPhone('/', {}, <ContextSidebar><p>the task list</p></ContextSidebar>)
      openSheet()
      const body = slot('context-sidebar-body', sheet() as HTMLElement) as HTMLElement
      expect(within(body).getByText('the task list')).toBeTruthy()
      const areas = within(sheet() as HTMLElement).getByRole('link', { name: 'Git' })
      expect(areas.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it('marks the active nav item inside the sheet too', () => {
      renderPhone('/p/shop/skills', { projects: [project({ id: 'shop' })], activeProjectId: 'shop' })
      openSheet()
      const current = within(sheet() as HTMLElement).getAllByRole('link', { current: 'page' })
      expect(current).toHaveLength(1)
      expect(current[0]?.textContent).toBe('Skills')
    })

    it('closes when a nav item inside it navigates', async () => {
      renderPhone('/')
      openSheet()

      fireEvent.click(within(sheet() as HTMLElement).getByRole('link', { name: 'Git' }))

      // Both halves matter: an open sheet sitting on top of the newly routed view is the whole
      // bug this guards, and a sheet that closed without navigating would be just as wrong.
      await waitFor(() => expect(sheet()).toBeNull())
      expect(screen.getByTestId('location').textContent).toBe('/git')
    })

    it('closes when the already-active nav item is re-clicked', async () => {
      // No pathname change, so the route-change effect cannot fire — the link's own onClick
      // is what has to close it. Tasks navigating home while already active is a spec behavior.
      renderPhone('/')
      openSheet()
      fireEvent.click(within(sheet() as HTMLElement).getByRole('link', { name: 'Tasks' }))
      await waitFor(() => expect(sheet()).toBeNull())
      expect(screen.getByTestId('location').textContent).toBe('/')
    })

    it('closes when New task navigates', async () => {
      renderPhone('/')
      openSheet()
      const link = within(sheet() as HTMLElement).getByRole('link', { name: /New task/ })
      expect(link.getAttribute('href')).toBe('/new')
      fireEvent.click(link)
      await waitFor(() => expect(sheet()).toBeNull())
      expect(screen.getByTestId('location').textContent).toBe('/new')
    })

    it('closes on a navigation that went through none of its links (back/forward, the ⌘K palette)', async () => {
      renderPhone('/', {}, <RouterLink to="/git">elsewhere</RouterLink>)
      openSheet()
      // The routed view is behind the modal sheet, hence `hidden: true` — what matters is that
      // the path changed without any of the sheet's own links being the one clicked.
      fireEvent.click(screen.getByRole('link', { name: 'elsewhere', hidden: true }))
      expect(screen.getByTestId('location').textContent).toBe('/git')
      await waitFor(() => expect(sheet()).toBeNull())
    })

    it('stays open when merely opened — mounting inside the sheet must not close it', async () => {
      // The sheet's own areas mount when it opens; an effect that closed on every run closed the
      // sheet in the same breath it opened, leaving a phone with no way to reach the navigation.
      renderPhone('/')
      openSheet()
      await settle()
      expect(sheet()).not.toBeNull()
    })

    it('steps aside for global settings, which opens as a dialog', async () => {
      renderPhone('/git')
      openSheet()
      fireEvent.click(within(sheet() as HTMLElement).getByRole('button', { name: 'Global settings' }))
      await waitFor(() => expect(sheet()).toBeNull())
      expect(settingsProbe().getAttribute('data-open')).toBe('true')
      expect(screen.getByTestId('location').textContent).toBe('/git')
    })

    it('closes when the viewport widens past md, where the rail takes over', async () => {
      // Otherwise an open sheet survives a rotation into a desktop-width layout and traps focus
      // in a modal copy of navigation that is now visible right next to it.
      renderPhone()
      openSheet()
      expect(sheet()).not.toBeNull()

      resizeTo(DESKTOP)
      await waitFor(() => expect(sheet()).toBeNull())
      // …and the areas are not left in the desktop column either: the rail has them.
      expect(slot('mobile-identity')).toBeNull()
    })

    it('pads the sheet for the safe-area insets', () => {
      renderPhone()
      openSheet()
      // The sheet is a full-height overlay under the same notch and home indicator as the page —
      // its first row is the project switcher and the cockpit menu, which a notch would cover.
      const html = (sheet() as HTMLElement).outerHTML
      expect(html).toContain('pt-[env(safe-area-inset-top)]')
      expect(html).toContain('pb-[env(safe-area-inset-bottom)]')
    })
  })
})

describe('Dashboard active navigation', () => {
  const dashboard = () => within(rail()).getByRole('link', { name: 'Dashboard' })

  it.each(['/dashboard', '/dashboard?view=costs', '/dashboard?period=30d'])('highlights %s beyond hover', entry => {
    renderShell(entry)
    expect(dashboard().getAttribute('data-active')).toBe('true')
    expect(dashboard().getAttribute('aria-current')).toBe('page')
  })
  it('does not remain highlighted on another page', () => {
    renderShell('/tasks')
    expect(dashboard().getAttribute('aria-current')).toBeNull()
    expect(dashboard().getAttribute('data-active')).toBe('false')
  })
})
