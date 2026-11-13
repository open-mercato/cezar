import {
  CheckIcon,
  ChevronDownIcon,
  LayersIcon,
  LayoutDashboardIcon,
  MenuIcon,
  PanelLeftOpenIcon,
  PlusIcon,
} from 'lucide-react'
import * as React from 'react'
import type { ReactNode } from 'react'
import { Link as RouterLink, NavLink, matchPath, useLocation } from 'react-router'

import { TRACKER_PROVIDERS } from '@/lib/tracker-providers'
import { Link, LinkScope, pathnameProjectId, stripProjectPrefix } from '@/lib/project-router'
import { formatChord, shortcutsBlocked } from '@/lib/keybindings'
import { useCommandShortcut } from '@/lib/use-command-shortcut'
import { isManagerPathname, MANAGER_ATTENTION_DOT, type ManagerAttention } from '@/lib/managers'
import { rememberTasksLocation, tasksHref } from '@/lib/manager-location'
import { showsBottomBar } from '@/lib/phone-app'
import { isSettingsPathname } from '@/lib/settings-path'
import { CEZAR_REPO_URL, formatStarCount } from '@/lib/star-promo'
import { AddProjectMenu } from '@/components/add-project-menu'
import { BrandLockup, BrandMark } from '@/components/brand-mark'
import { ModeRailSwitch, ModeSwitch, type ModeSwitchProps } from '@/components/mode-switch'
import { PhoneBottomBar } from '@/components/phone-bottom-bar'
import { SelfUpdateDialog } from '@/components/self-update-dialog'
import { SidebarStatusLine, type SidebarHealth } from '@/components/sidebar-status-line'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Sheet, SheetTrigger } from '@/components/ui/sheet'
import { activeNavItem, activeNavPath, visibleNavItems, type NavItem } from '@/components/nav-items'
import type { TrackerKind } from '@open-mercato/cezar-api-client'
import { FOLD_ARIA_KEYS, SidebarDrawer, SidebarFoldButton, SidebarFrame, useDesktopShell, useSidebarFolded, useSidebarWidth, type SidebarResize } from '@/components/sidebar-frame'
import { cn } from '@/lib/utils'
import { exitSidebarRail, useSidebarRail } from '@/lib/sidebar-rail'
/** Tailwind's `md`. The drawer is the `<md` affordance, so this must stay in step with the
 *  `md:hidden` / `md:flex` classes below — they are the same breakpoint expressed twice, once
 *  for CSS and once for the state machine. */
const DESKTOP_MEDIA_QUERY = '(min-width: 768px)'

export type RepoChip = {
  name: string
  branch: string
}

/** The rail-mode header's project switcher: the registry's projects and the selected one. */
export type ProjectSwitcher = {
  activeId: string | null
  activeName: string | null
  projects: ReadonlyArray<{ id: string; name: string }>
}

export type AppShellProps = {
  /** The routed view. Renders into the one scrolling region. */
  children: ReactNode
  /** Repo + branch for the brand chip. Null until Step 3.1/3.2 wires `/api/health` — the chip
   *  is simply absent rather than showing an invented repo name. */
  repo?: RepoChip | null
  /** Inbox badge count. Null/0 renders no badge. Step 3.2 feeds it from the SSE stream. */
  inboxCount?: number | null
  /** Unread done-items count for the Tasks badge (#unread-done-items). Null/0 renders no badge;
   *  the container derives it from the run list via `unreadDoneCount`. */
  unreadCount?: number | null
  /** Tasks that need you in the active project — the Now badge. Null/0 renders no badge. */
  nowCount?: number | null
  /** Running tasks in the active project — the footer's `· N running`. */
  runningCount?: number | null
  /** The footer dot: `healthy`, `attention`, or null while health is unknown. */
  healthStatus?: SidebarHealth
  /** A quiet, accessible marker on Skills when a checked update remains actionable. */
  skillsUpdateAvailable?: boolean
  /** Nav items (`to`) whose feature shipped since the user started and is not opened yet. */
  newNavItems?: ReadonlySet<string>
  /** cezar version for the footer chip. Null until Step 3.1 reads it from `/api/health`. */
  version?: string | null
  /** The npm registry's newer version, when the server's update check found one (#368). The
   *  chip grows a pulsing pending dot + tooltip; absent or equal to `version`, it stays plain. */
  latestVersion?: string | null
  /** cezar's own GitHub star count for the footer's ⭐ ask. `null` — offline, rate-limited, or
   *  promos silenced with `CEZ_NO_BANNER=1` — renders NO chip at all rather than an empty one:
   *  a button asking to be clicked while admitting it cannot count is worse than no button. */
  starCount?: number | null
  /** The active project's "Current tasks" (`CurrentTasksContainer`). */
  currentTasks?: ReactNode
  /** The project switcher control under the brand (`ProjectSwitcher`). Absent — the registry
   *  still loading, or a bare shell — the plain repo chip stands in. */
  switcher?: ReactNode
  /** The sidebar's machine glance (spec `.ai/specs/2026-09-20-host-telemetry-sidebar-widget.md`):
   *  effective CPU, its sparkline and compact RAM, rendered as the footer's first row. It is a
   *  SLOT because `AppShell` stays presentational and QueryClient-free - the container supplies a
   *  node whose own viewport/transport gate decides whether anything mounts at all. */
  hostWidget?: ReactNode
  /** The "What's new" menu item (spec 2026-10-26-first-run-onboarding, "Coming back"). */
  whatsNew?: ReactNode
  /** What's new holds items the user has not opened — dots the footer's ⋯ button. */
  whatsNewUnseen?: boolean
  /** Why health needs attention, the footer status's tooltip (`toolsTooltip`). */
  healthReason?: string | null
  /** The project the sidebar's project links lead into on an UNSCOPED page (`/dashboard`, the
   *  global `/tasks`, `/manager/*`): the last one this tab was in, else the boot project. */
  linkProjectId?: string | null
  /** No registry to switch between (its query failed): Add project sits under the repo chip. */
  offerAddProject?: boolean
  /** The Tools submenu's body (`ToolsMenuItems`). */
  toolsMenu?: ReactNode
  /** Forge gating (R6 Step 1.1): `false` drops the GitHub nav item — see `visibleNavItems`.
   *  Defaults to shown so the presentational shell stays renderable alone; the container
   *  passes the health payload's truth. */
  forgeAvailable?: boolean
  /** Inbox gating (#471): `false` drops the Inbox nav item and its badge — the global inbox is
   *  opt-in via `CEZ_FOLLOWUPS=1`. Defaults to shown for the same reason as `forgeAvailable`. */
  inboxAvailable?: boolean
  /** Automations gating (#801): `false` drops the Automations nav item — GitHub automations are
   *  opt-in via `CEZ_AUTOMATIONS=1`. Defaults to shown for the same reason as `forgeAvailable`;
   *  the container passes the health payload's truth. */
  automationsAvailable?: boolean
  tracker?: TrackerKind
  /** Single-project capability gating: hides workspace-expansion affordances. Defaults off so
   *  standalone and older callers preserve the multi-project shell. */
  singleProject?: boolean
  /** Global chrome banner, rendered in its own row above the scroller. Absent renders nothing —
   *  the slot is generic and currently unused (the #391 skills promo it once held is gone,
   *  replaced by the opt-in Import panel on the Skills page). */
  banner?: ReactNode
  /** The bottom edge of the main column, above the composer row: the telemetry consent bar
   *  (docs/telemetry.md) lives here, so it never covers the view or interrupts a flow. */
  footerBanner?: ReactNode
  /** The active project's sidebar extension panels (spec 2026-11-07-extension-placements),
   *  under its area nav. Built by the container (it needs the query client); absent renders nothing. */
  extensionPanels?: ReactNode
  brandName?: string
  brandLogoUrl?: string | null
  /** Managers gating (spec 2026-10-31-managers): the Projects | Manager switch exists only when
   *  health says so. Defaults off, unlike the nav gates: it is new chrome, not a nav item. */
  managersAvailable?: boolean
  /** Any manager unread or holding an approval: the switch's dot and the phone menu's. */
  managerAttention?: ManagerAttention | null
  /** Where Manager leads: the chat or list this tab left. */
  managerTo?: string
  /** Manager mode's sidebar body (`ManagerSidebar`) — a slot, because it reads the query cache. */
  managerSidebar?: ReactNode
  /** Manager mode's slice of the folded rail (`ManagerRail`). */
  managerRail?: ReactNode
  /** The manager heads overlay (`ManagerHeads`), mounted in the main column in Projects mode only. */
  managerHeads?: ReactNode
  /** Feeds the header shown while the sidebar is an icon rail. Absent: the header names the repo
   *  and offers no switch. */
  projectSwitcher?: ProjectSwitcher | null
}

/**
 * The drawer's close-on-navigate callback, published to whatever renders inside the sidebar's
 * slots (`switcher`, `currentTasks`). The route-change effect already closes the drawer
 * for every *changed* route; this covers re-clicking a link to the CURRENT route (per the spec,
 * Tasks navigates home even when already active), which changes no pathname at all. Undefined
 * on desktop, where there is nothing to close.
 */
const SidebarNavigateContext = React.createContext<(() => void) | undefined>(undefined)

/** True while the shell's sidebar lists the managers: the chat page drops its own list then. */
const ShellManagerModeContext = React.createContext(false)

export function useShellManagerMode(): boolean {
  return React.useContext(ShellManagerModeContext)
}

const AppShellMain = React.memo(function AppShellMain({
  children,
  mainRef,
}: {
  children: ReactNode
  mainRef: React.RefObject<HTMLElement | null>
}) {
  return (
    <main
      ref={mainRef}
      data-slot="main"
      className="row-start-3 min-h-0 overflow-y-auto overscroll-contain"
    >
      {children}
    </main>
  )
})

export function useSidebarNavigate(): (() => void) | undefined {
  return React.useContext(SidebarNavigateContext)
}

/** The main transcript owns cached/tail arrival; every other routed surface uses shell-top. */
const NO_NEW_NAV_ITEMS: ReadonlySet<string> = new Set()

export function routeOwnsScrollArrival(pathname: string): boolean {
  return matchPath({ path: '/tasks/:id', end: true }, stripProjectPrefix(pathname)) !== null
}

/**
 * The cockpit's app shell: a fixed sidebar plus a single scrolling main region.
 *
 * Layout contract (spec, "App shell & navigation"):
 *  - `h-dvh` (never `100vh` — that ignores mobile browser chrome and clips the composer).
 *  - The main column is a `auto auto 1fr auto` grid — top bar / banner / scroller / composer
 *    dock. Rows are placed explicitly (`row-start-*`) so hiding the mobile bar at `md`, or
 *    passing no `banner`, leaves that row empty instead of promoting the scroller into the
 *    `auto` row and collapsing it.
 *  - The banner is a peer row of the scroller, never a child of it: routed views own
 *    `sticky top-0` headers (at both `z-10` and `z-20`), so a banner sticking to the same edge
 *    inside `main` would tie with them in the stacking order and be painted over. Its own row
 *    keeps it visible while the view scrolls under it, with no z-index coupling to any route.
 *  - `overflow-hidden` here and on `body` means the document never scrolls; only the main
 *    region does, with `overscroll-contain` so a thread at its end doesn't rubber-band the page.
 *  - Safe-area insets are the shell's job, not each view's: left/right on the root, top on the
 *    mobile bar, bottom on the composer row (which stays mounted, so the home indicator always
 *    has its gutter even before Step R4 puts a composer in it).
 *  - Below `md` the sidebar is gone and its content moves, unchanged, into an overlay drawer
 *    (`MobileNavDrawer`). Same components, only the framing changes.
 */
export const AppShell = React.memo(function AppShell({
  children,
  repo = null,
  inboxCount = null,
  unreadCount = null,
  nowCount = null,
  runningCount = null,
  healthStatus = null,
  skillsUpdateAvailable = false,
  newNavItems = NO_NEW_NAV_ITEMS,
  version = null,
  latestVersion = null,
  starCount = null,
  currentTasks,
  switcher,
  hostWidget,
  whatsNew,
  whatsNewUnseen = false,
  healthReason = null,
  linkProjectId = null,
  offerAddProject = false,
  toolsMenu,
  forgeAvailable = true,
  inboxAvailable = true,
  automationsAvailable = true,
  tracker,
  singleProject = false,
  banner,
  footerBanner,
  extensionPanels,
  brandName = 'cezar',
  brandLogoUrl = null,
  managersAvailable = false,
  managerAttention = null,
  managerTo = '/manager',
  managerSidebar,
  managerRail,
  managerHeads,
  projectSwitcher = null,
}: AppShellProps) {
  const { pathname, search } = useLocation()
  // The nav's area rules reason about the flat route map — strip any `/p/:projectId` prefix
  // (multi-project spec, step 3.2) so `/p/cezar/git/commits` still lights Git.
  const areaPathname = stripProjectPrefix(pathname)
  // The unscoped `/tasks` is the global All-tasks page, not a project's Tasks area.
  const globalTasks = pathname === '/tasks'
  const activeTo = globalTasks ? null : activeNavPath(areaPathname)
  const currentBase = globalTasks ? null : activeNavItem(areaPathname)
  const current = currentBase?.to === '/tracker' && tracker
    ? { ...currentBase, label: TRACKER_PROVIDERS[tracker].label }
    : currentBase
  // Settings is CHROMELESS (spec 2026-10-13-unified-settings): on any settings URL the sidebar
  // column, the drawer and the mobile top bar are not rendered at all — the settings frame
  // supplies its own header, nav and way back. The banner row stays (provider failures link
  // INTO settings, so hiding the banner there would hide the fix from the person about to apply
  // it) and so does the bottom safe-area row. `data-chromeless` marks the mode.
  const chromeless = isSettingsPathname(pathname)
  const managerMode = managersAvailable && isManagerPathname(pathname)
  // The Back to manager link is the way home from here (spec 2026-10-31-managers, Phones).
  const inTaskThread = matchPath({ path: '/tasks/:id/*', end: true }, areaPathname) !== null
  const [menuOpen, setMenuOpen] = React.useState(false)
  const closeMenu = React.useCallback(() => setMenuOpen(false), [])
  const openMenu = React.useCallback(() => setMenuOpen(true), [])
  const [phoneApp] = React.useState(showsBottomBar)
  const bottomBar = phoneApp && managersAvailable && !chromeless && !inTaskThread
  const mainRef = React.useRef<HTMLElement>(null)
  const routeOwnsArrival = routeOwnsScrollArrival(pathname)
  // The desktop column's width (#788) — one preference shared with the settings sidebar.
  const [sidebarWidth, changeSidebarWidth] = useSidebarWidth()

  // The Projects half's destination (design 2026-11 "Manager mode"): the project page this tab left.
  React.useEffect(() => {
    if (!managerMode && !chromeless) rememberTasksLocation(`${pathname}${search}`)
  }, [managerMode, chromeless, pathname, search])

  // The scroller PERSISTS across routes (it is the shell's, not the view's), so without this
  // a deep scroll on one page carries into the next — most visibly on mobile, where Tasks or
  // GitHub opened mid-list. Layout effect: the reset lands before the new view paints. The main
  // task transcript is the exception: its own layout effect restores the cached offset or live
  // tail before paint, so a competing shell reset would expose the exact top-to-tail jump it is
  // responsible for preventing.
  React.useLayoutEffect(() => {
    if (routeOwnsArrival) return
    const main = mainRef.current
    if (main) main.scrollTop = 0
  }, [pathname, routeOwnsArrival])

  // Close on route change. Without this the drawer survives the navigation it triggered and sits
  // on top of the view the user just asked for — and back/forward and the ⌘K palette (Step 4.3)
  // navigate without going through the drawer's own links at all.
  React.useEffect(() => {
    setMenuOpen(false)
  }, [pathname])

  // The drawer must not outlive its breakpoint: widening past `md` reveals the real sidebar, and
  // an open drawer would leave a focus-trapping modal over an already-visible nav.
  React.useEffect(() => {
    const query = window.matchMedia?.(DESKTOP_MEDIA_QUERY)
    if (!query) return
    if (query.matches) setMenuOpen(false)
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) setMenuOpen(false)
    }
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  const items = React.useMemo(
    () => visibleNavItems({ forge: forgeAvailable, inbox: inboxAvailable, automations: automationsAvailable, tracker }),
    [forgeAvailable, inboxAvailable, automationsAvailable, tracker],
  )

  const nav = {
    activeTo,
    globalTasks,
    items,
    repo,
    // The badge belongs to the Inbox item — with the item gone there is nothing to badge.
    inboxCount: inboxAvailable ? inboxCount : null,
    unreadCount,
    nowCount,
    runningCount,
    healthStatus,
    skillsUpdateAvailable,
    newNavItems,
    version,
    latestVersion,
    starCount,
    currentTasks,
    switcher,
    hostWidget,
    whatsNew,
    whatsNewUnseen,
    healthReason,
    offerAddProject: offerAddProject && !singleProject,
    toolsMenu,
    extensionPanels,
    singleProject,
    brandName,
    brandLogoUrl,
    managersAvailable,
    managerMode,
    managerAttention,
    managerTo,
    // The active half stays put; the other reads during render what the effect above stored.
    projectsTo: managerMode ? managerReturn(tasksHref(), projectSwitcher, repo?.name ?? brandName).to : `${pathname}${search}`,
    managerSwitchTo: managerMode ? `${pathname}${search}` : managerTo,
    managerSidebar,
    managerRail,
  }

  const desktop = useDesktopShell()
  // Focus (spec 2026-10-22-html-artifacts-and-impact, R2): a view on screen folded the sidebar.
  const railed = useSidebarRail()
  const [folded] = useSidebarFolded()
  // Folded by the user or held by a Focus view: either way the sidebar is the icon rail, and the
  // project it is about moves into the main column's header.
  const rail = !chromeless && (railed || folded)
  // Off-project pages keep the sidebar inside the project the user came from (parity with main).
  const linkScope = pathnameProjectId(pathname) === null ? linkProjectId : null

  return (
    <div
      data-slot="app-shell"
      data-desktop={desktop ?? undefined}
      data-chromeless={chromeless ? '' : undefined}
      // The New-task FAB is fixed to the viewport: this lifts it off the bar's More item.
      style={bottomBar ? ({ '--phone-bar': '3.5rem' } as React.CSSProperties) : undefined}
      className="flex h-dvh overflow-hidden bg-background text-foreground pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
    >
      {/* Desktop shell (packages/desktop, macOS): the native title bar is a transparent overlay
          with no title, 28px tall (a title bar's native height), and the traffic lights sit at
          their native offset. Nothing is PAINTED for it — each column carries 28px of top
          padding so its own colour runs to the window's edge, the way Finder's sidebar does —
          and this transparent strip on top is what Tauri's injected handler drags the window by
          (double-click zooms). Only the shell's init script sets `desktop`; a browser tab never
          gets any of it. */}
      {desktop === 'macos' ? (
        <div
          data-slot="desktop-titlebar"
          data-tauri-drag-region=""
          className="fixed inset-x-0 top-0 z-[60] flex h-[28px] select-none items-center pl-[80px]"
        >
          {version && latestVersion && latestVersion !== version ? (
            <TitlebarUpdateButton latestVersion={latestVersion} brandName={brandName} />
          ) : null}
        </div>
      ) : null}
      <LinkScope projectId={linkScope}>
        {chromeless ? null : railed ? (
          <FocusSidebarRail {...nav} desktop={desktop} />
        ) : (
          <Sidebar {...nav} width={sidebarWidth} onWidthChange={changeSidebarWidth} desktop={desktop} />
        )}
      </LinkScope>
      <div
        data-slot="main-column"
        className={cn(
          'relative grid min-w-0 flex-1 grid-rows-[auto_auto_1fr_auto] overflow-hidden',
          desktop === 'macos' && 'pt-[28px]',
        )}
      >
        {/* The Sheet root renders no DOM of its own. Keep only the mobile controls inside its
            context so a sidebar update cannot propagate through the routed view. */}
        {/* Row 1 stays EMPTY in chromeless mode — the explicit `row-start-*` placement is what
            keeps the scroller in row 3 either way. */}
        {chromeless ? null : (
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <MobileTopBar
              title={managerMode ? 'Manager' : globalTasks ? 'All tasks' : (current?.label ?? brandName)}
              attention={managersAvailable && !managerMode ? managerAttention : null}
            />
            {/* The drawer keeps its fixed 264px: it is a full-height overlay on a phone, where
                there is no second column to trade width with and no pointer to drag a border. */}
            <LinkScope projectId={linkScope}>
              <MobileNavDrawer {...nav} onNavigate={closeMenu} />
            </LinkScope>
          </Sheet>
        )}
        {rail && !managerMode ? (
          <ProjectHeader
            switcher={projectSwitcher}
            fallbackName={repo?.name ?? brandName}
            activeTo={activeTo}
          />
        ) : null}

        {banner ? (
          <div data-slot="banner-slot" className="row-start-2">
            {banner}
          </div>
        ) : null}

        <ShellManagerModeContext.Provider value={managerMode}>
          <AppShellMain mainRef={mainRef}>{children}</AppShellMain>
        </ShellManagerModeContext.Provider>
        {/* Out of flow (it positions itself against this column); never in manager mode. */}
        {managersAvailable && !managerMode ? managerHeads : null}

        {/* Row 4: the composer dock (thread reply, Step R3) — the footer banner above it, and
            the bottom safe-area gutter so the scroller never runs under the home indicator. */}
        <div
          data-slot="composer"
          className="row-start-4 pb-[env(safe-area-inset-bottom)]"
        >
          {footerBanner}
          {bottomBar ? (
            <PhoneBottomBar
              menuOpen={menuOpen}
              onMore={openMenu}
              manager={managerMode}
              attention={managerAttention}
              managerTo={managerTo}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
})

/**
 * The title strip's "Update cezar" button (desktop shell only): shown whenever the channel the
 * cockpit follows has something newer than what is running, sitting right after the traffic
 * lights where the native title would be. With nothing running, one click starts the update and
 * the dialog shows the install log and the restart. With tasks in flight the dialog opens to its
 * warning instead and waits for "Update & restart": a restart interrupts them.
 */
function TitlebarUpdateButton({ latestVersion, brandName }: { latestVersion: string; brandName: string }) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <button
        type="button"
        data-slot="titlebar-update"
        onClick={() => setOpen(true)}
        title={`Update ${brandName} to v${latestVersion} and restart`}
        className="inline-flex h-[18px] items-center gap-1 rounded-full border border-primary/40 bg-primary/15 px-2 text-meta font-semibold text-foreground transition-colors hover:bg-primary/30"
      >
        <StatusDot tone="pending" pulse className="size-[5px] shrink-0" />
        Update {brandName}
        <span className="font-mono font-medium text-muted-foreground">v{latestVersion}</span>
      </button>
      {open ? <SelfUpdateDialog open={open} onOpenChange={setOpen} autoApply={latestVersion} brandName={brandName} /> : null}
    </>
  )
}

type NavProps = {
  activeTo: string | null
  /** On the unscoped `/tasks` — the Workspace → All tasks row is the current page. */
  globalTasks: boolean
  items: NavItem[]
  repo: RepoChip | null
  inboxCount: number | null
  unreadCount: number | null
  nowCount: number | null
  runningCount: number | null
  healthStatus: SidebarHealth
  skillsUpdateAvailable: boolean
  newNavItems: ReadonlySet<string>
  version: string | null
  latestVersion: string | null
  starCount: number | null
  currentTasks?: ReactNode
  switcher?: ReactNode
  hostWidget?: ReactNode
  whatsNew?: ReactNode
  whatsNewUnseen: boolean
  healthReason: string | null
  offerAddProject: boolean
  toolsMenu?: ReactNode
  extensionPanels?: ReactNode
  brandName: string
  brandLogoUrl: string | null
  singleProject: boolean
  managersAvailable: boolean
  managerMode: boolean
  managerAttention: ManagerAttention | null
  managerTo: string
  /** Where the switch's halves lead: the current page for the active one, else the remembered one. */
  projectsTo: string
  managerSwitchTo: string
  managerSidebar?: ReactNode
  managerRail?: ReactNode
}

/** The switch's props from the nav's: one place decides what each half carries. */
function modeSwitchProps(props: NavProps, onNavigate?: () => void): ModeSwitchProps {
  return {
    managerMode: props.managerMode,
    projectsTo: props.projectsTo,
    managerTo: props.managerSwitchTo,
    projectsAttention: Boolean(props.nowCount),
    managerAttention: props.managerAttention,
    onNavigate,
  }
}

/** The desktop column: the shared `SidebarFrame` (resizable, #788) around the app's content,
 *  foldable into a rail. Focus follows a fold the user makes, so the keyboard is never dropped. */
const Sidebar = React.memo(function Sidebar({
  width,
  onWidthChange,
  desktop = null,
  ...props
}: NavProps & SidebarResize & { desktop?: 'macos' | 'windows' | 'linux' | null }) {
  const [folded, setFolded] = useSidebarFolded()
  const [toggled, setToggled] = React.useState(false)
  const foldButton = React.useRef<HTMLButtonElement>(null)
  React.useEffect(() => {
    if (toggled && !folded) foldButton.current?.focus()
  }, [toggled, folded])
  const toggle = (next: boolean) => {
    setToggled(true)
    setFolded(next)
  }
  // ⌘B / Ctrl+B, the editor convention for the side bar. Reserved in `lib/keybindings.ts`.
  // Focus follows only when it sat in the column being swapped out (or nowhere): ⌘B from the
  // composer must leave the caret where it is.
  useCommandShortcut(
    'b',
    () => {
      if (shortcutsBlocked()) return
      const active = document.activeElement
      setToggled(!active || active === document.body || active.closest('[data-slot="sidebar"], [data-slot="sidebar-rail"]') !== null)
      setFolded(!folded)
    },
    { inEditable: true },
  )
  if (folded) {
    return (
      <SidebarIconRail
        {...props}
        slot="sidebar-rail"
        onExpand={() => toggle(false)}
        expandTitle={`Show sidebar (${formatChord('Mod+B')})`}
        expandShortcut={FOLD_ARIA_KEYS}
        autoFocus={toggled}
        desktop={desktop}
      />
    )
  }
  return (
    <SidebarFrame width={width} onWidthChange={onWidthChange} titlebarInset={desktop === 'macos'}>
      <SidebarContent
        {...props}
        compactHeader={desktop === 'macos'}
        headerAction={<SidebarFoldButton ref={foldButton} onFold={() => toggle(true)} />}
      />
    </SidebarFrame>
  )
})

/** The rail a Focus view holds. ⌘B lives on `Sidebar`, which is unmounted here, so the rail
 *  carries its own: same chord as its expand button, which turns Focus off. */
function FocusSidebarRail({ desktop, ...props }: NavProps & { desktop: 'macos' | 'windows' | 'linux' | null }) {
  useCommandShortcut(
    'b',
    () => {
      if (shortcutsBlocked()) return
      exitSidebarRail()
    },
    { inEditable: true },
  )
  return (
    <SidebarIconRail
      {...props}
      slot="focus-sidebar-rail"
      onExpand={exitSidebarRail}
      expandTitle={`Show sidebar (${formatChord('Mod+B')}, turns Focus off)`}
      expandShortcut={FOLD_ARIA_KEYS}
      desktop={desktop}
    />
  )
}

/**
 * The sidebar folded to icons — by the user (⌘B, `slot="sidebar-rail"`) or by a view holding
 * Focus (`focus-sidebar-rail`, spec 2026-10-22-html-artifacts-and-impact R2). One rail for both:
 * the mark, the New task `+`, every project area as an icon, Manager when there is one, and the
 * expand button at the foot. Desktop only — below `md` the drawer is the sidebar.
 */
function SidebarIconRail({
  slot,
  onExpand,
  expandTitle,
  expandShortcut,
  autoFocus = false,
  desktop,
  ...props
}: NavProps & {
  slot: 'sidebar-rail' | 'focus-sidebar-rail'
  onExpand: () => void
  expandTitle: string
  expandShortcut?: string
  /** Only after a fold the user just made, never on a page that loads folded. */
  autoFocus?: boolean
  desktop: 'macos' | 'windows' | 'linux' | null
}) {
  const { items, activeTo, inboxCount, unreadCount, nowCount, skillsUpdateAvailable, newNavItems, brandName, brandLogoUrl, managersAvailable, managerMode } = props
  return (
    <aside
      data-slot={slot}
      className={cn(
        'hidden w-12 shrink-0 flex-col items-center gap-1 border-r border-border bg-sidebar pt-[max(env(safe-area-inset-top),0.75rem)] pb-[max(env(safe-area-inset-bottom),0.5rem)] md:flex',
        desktop === 'macos' && 'pt-[36px]',
      )}
    >
      <span data-slot="rail-brand" role="img" aria-label={brandName} title={brandName} className="flex h-8 items-center text-foreground">
        {brandLogoUrl ? <img src={brandLogoUrl} alt="" className="size-[22px] object-contain" /> : <BrandMark height={22} />}
      </span>
      {/* The folded Projects | Manager switch: two stacked icons above the nav, each with its dot. */}
      {managersAvailable ? <ModeRailSwitch {...modeSwitchProps(props)} /> : null}
      {managerMode ? (
        // Manager mode mirrors its expanded sidebar: the way to add one, then the managers.
        <>
          <Button asChild variant="contrast" size="icon-sm" className="mt-1">
            <RouterLink to="/manager/new" data-slot="rail-new-manager" aria-label="New manager" title="New manager">
              <PlusIcon className="size-4" aria-hidden="true" />
            </RouterLink>
          </Button>
          {props.managerRail}
        </>
      ) : (
        <>
          <Button asChild variant="contrast" size="icon-sm" className="mt-1">
            <Link to="/new" data-slot="rail-new-task" aria-label="New task" title="New task (C)">
              <PlusIcon className="size-4" aria-hidden="true" />
            </Link>
          </Button>
          <nav aria-label="Main" className="flex min-h-0 flex-col items-center gap-1 overflow-y-auto pt-2">
            {items.filter((item) => item.group !== 'workspace').map((item) => {
              const Icon = item.icon
              const isActive = item.to === activeTo
              const marked =
                (item.badge === 'tasks-unread' && Boolean(unreadCount))
                || (item.badge === 'needs-you' && Boolean(nowCount))
                || (item.badge === 'skills-update' && skillsUpdateAvailable)
                || newNavItems.has(item.to)
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  aria-label={item.label}
                  title={item.label}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'relative flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
                    isActive && 'bg-muted text-foreground',
                  )}
                >
                  <Icon className="size-4" aria-hidden="true" />
                  {marked ? (
                    <span data-slot="rail-marker" aria-hidden="true" className="absolute top-1 right-1 size-1.5 rounded-full bg-violet" />
                  ) : null}
                </Link>
              )
            })}
            {items.filter((item) => item.group === 'workspace').map((item) => {
              const Icon = item.icon
              const isActive = item.to === activeTo
              const marked = (item.badge === 'inbox-count' && Boolean(inboxCount)) || newNavItems.has(item.to)
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  aria-label={item.label}
                  title={item.label}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'relative flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
                    isActive && 'bg-muted text-foreground',
                  )}
                >
                  <Icon className="size-4" aria-hidden="true" />
                  {marked ? (
                    <span data-slot="rail-marker" aria-hidden="true" className="absolute top-1 right-1 size-1.5 rounded-full bg-violet" />
                  ) : null}
                </Link>
              )
            })}
          </nav>
        </>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        data-slot={slot === 'sidebar-rail' ? 'sidebar-unfold' : undefined}
        data-action={slot === 'focus-sidebar-rail' ? 'expand-sidebar' : undefined}
        aria-label="Show sidebar"
        aria-keyshortcuts={expandShortcut}
        title={expandTitle}
        autoFocus={autoFocus}
        onClick={onExpand}
        className="mt-auto shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <PanelLeftOpenIcon className="size-4" aria-hidden="true" />
      </Button>
    </aside>
  )
}

/**
 * The main column's header while the sidebar is a rail: the selected project's name, and a
 * dropdown to switch to another one, landing on the same area (Git stays Git). Desktop only —
 * below `md` the mobile top bar owns row 1.
 */
function ProjectHeader({
  switcher,
  fallbackName,
  activeTo,
}: {
  switcher: ProjectSwitcher | null
  fallbackName: string
  activeTo: string | null
}) {
  const name = switcher?.activeName ?? fallbackName
  const projects = switcher?.projects ?? []
  return (
    <header
      data-slot="project-header"
      className="row-start-1 hidden h-11 shrink-0 items-center border-b border-border bg-card px-3 md:flex"
    >
      {projects.length === 0 ? (
        <span data-slot="project-header-name" className="truncate px-2 text-body font-semibold">{name}</span>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              data-slot="project-switcher"
              aria-label={`Project: ${name} — switch project`}
              className="min-w-0 gap-1.5 px-2 text-body font-semibold"
            >
              <span className="truncate">{name}</span>
              <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60">
            <DropdownMenuLabel className="text-xs text-soft-foreground">Projects</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {projects.map((project) => {
              const current = project.id === switcher?.activeId
              return (
                <DropdownMenuItem key={project.id} asChild>
                  {/* A plain router Link: the target names its own project, so the scoped `Link`
                      would prefix it with the current one. */}
                  <RouterLink
                    to={`/p/${encodeURIComponent(project.id)}${activeTo && activeTo !== '/' ? activeTo : '/'}`}
                    data-slot="project-switcher-item"
                    aria-current={current ? 'true' : undefined}
                  >
                    <span className="min-w-0 flex-1 truncate">{project.name}</span>
                    {current ? <CheckIcon className="size-4" aria-hidden="true" /> : null}
                  </RouterLink>
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </header>
  )
}

/**
 * Where the switch's Projects half leads from Manager: the page this tab left, while the registry
 * still lists its project; else the active project's Now. Exported for the tests.
 */
export function managerReturn(
  remembered: string | null,
  switcher: ProjectSwitcher | null,
  fallbackName: string,
): { to: string; name: string } {
  const projects = switcher?.projects ?? []
  const activeName = switcher?.activeName ?? fallbackName
  if (remembered !== null) {
    const id = pathnameProjectId(remembered)
    const known = id === null ? undefined : projects.find((project) => project.id === id)
    // A page of a project the registry no longer lists is not a place to send anyone back to.
    if (id === null || known || projects.length === 0) return { to: remembered, name: known?.name ?? activeName }
  }
  const activeId = switcher?.activeId ?? null
  return { to: activeId === null ? '/' : `/p/${encodeURIComponent(activeId)}/`, name: activeName }
}

/** The `<md` drawer: the shared `SidebarDrawer` around the SAME content the column renders. */
const MobileNavDrawer = React.memo(function MobileNavDrawer({ onNavigate, ...props }: NavProps & { onNavigate: () => void }) {
  return (
    <SidebarDrawer slot="mobile-nav-drawer" title="Navigation">
      {(closeButton) => <SidebarContent {...props} onNavigate={onNavigate} headerAction={closeButton} />}
    </SidebarDrawer>
  )
})

/**
 * Everything inside the sidebar (redesign, Proposal 1 "One sidebar, one project"): brand, the
 * project switcher, the New task CTA, ONE area list for the active project, its current tasks,
 * the Workspace group and the one-line status footer. Framed by `Sidebar` on desktop and by
 * `MobileNavDrawer` below `md` — the two callers differ only in the box around this.
 *
 * The safe-area insets live here rather than on the frames because both need them: the drawer is
 * a full-height overlay under the same notch and home indicator the sidebar sits under.
 */
function SidebarContent({
  onNavigate,
  headerAction,
  compactHeader = false,
  ...props
}: NavProps & {
  brandName: string
  brandLogoUrl: string | null
  /** Fires on any in-drawer navigation. The route-change effect already closes the drawer for
   *  every *changed* route; this also covers re-clicking the active item, which changes no
   *  pathname at all. */
  onNavigate?: () => void
  /** The drawer's close button. Absent on desktop, which has nothing to close. */
  headerAction?: ReactNode
  /** Under the desktop shell's title strip the brand row already has 28px above it. */
  compactHeader?: boolean
}) {
  const {
    activeTo, globalTasks, items, repo, inboxCount, unreadCount, nowCount, runningCount, healthStatus, skillsUpdateAvailable,
    newNavItems, version, latestVersion, starCount, currentTasks, switcher, hostWidget, whatsNew, whatsNewUnseen, healthReason,
    offerAddProject, toolsMenu, extensionPanels, brandName, brandLogoUrl, managersAvailable, managerMode, managerSidebar,
  } = props
  const areas = items.filter((item) => item.group !== 'workspace')
  const workspace = items.filter((item) => item.group === 'workspace')
  return (
    <div
      data-slot="sidebar-content"
      // `@container/sidebar` (#788): rows hide droppable metadata by THIS column's width.
      className="@container/sidebar flex min-h-0 flex-1 flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
    >
      <div className={cn('flex items-center gap-[9px] px-3.5 pb-2', compactHeader ? 'pt-1.5' : 'pt-3.5')}>
        <BrandLockup name={brandName} logoUrl={brandLogoUrl} />
        {headerAction ? <div className="ml-auto shrink-0">{headerAction}</div> : null}
      </div>

      {/* Above the project switcher (design 2026-11 "Manager mode", § 1); replaces the Manager row. */}
      {managersAvailable ? <ModeSwitch {...modeSwitchProps(props, onNavigate)} /> : null}

      {managerMode ? (
        // Manager mode: managers replace the project areas; the footer stays.
        <SidebarNavigateContext.Provider value={onNavigate}>{managerSidebar}</SidebarNavigateContext.Provider>
      ) : (
        <>
          {/* The switcher names the project; without a registry the repo chip says what health knows. */}
          <SidebarNavigateContext.Provider value={onNavigate}>{switcher}</SidebarNavigateContext.Provider>
          {!switcher && repo ? (
            <div data-slot="repo-chip" className="mx-3 mb-2 flex h-9 items-center gap-2 rounded-md border border-border bg-card px-2.5 text-ui font-semibold">
              <span className="min-w-0 truncate">{repo.name}</span>
              <span className="ml-auto min-w-0 truncate font-mono text-micro font-medium text-soft-foreground">{repo.branch}</span>
            </div>
          ) : null}
          {/* Main offered Add project whatever the registry did; a failed one must not take it away. */}
          {!switcher && offerAddProject ? (
            <div data-slot="sidebar-add-project" className="mx-3 mb-2">
              <AddProjectMenu className="w-full justify-start" />
            </div>
          ) : null}

          <div className="px-3 pb-2">
            <Button asChild variant="primary" className="relative w-full justify-center">
              {/* A Router Link since R4 Step 1.1: the React /new composer is real. */}
              <Link to="/new" onClick={onNavigate}>
                <PlusIcon className="size-[15px]" aria-hidden="true" />
                New task
                {/* Decorative: the `c`-to-create accelerator is registered in the command palette. */}
                <kbd
                  aria-hidden="true"
                  className="absolute right-2.5 rounded-[5px] border border-b-2 border-primary-foreground/25 bg-transparent px-[5px] py-px font-mono text-micro font-medium text-primary-foreground/70"
                >
                  C
                </kbd>
              </Link>
            </Button>
          </div>

          <div data-slot="sidebar-scroll" className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2">
            <nav aria-label="Main" className="px-2.5">
              {areas.map((item) => (
                <SidebarNavRow
                  key={item.to}
                  item={item}
                  isActive={item.to === activeTo}
                  onNavigate={onNavigate}
                  count={item.badge === 'needs-you' ? nowCount : item.badge === 'tasks-unread' ? unreadCount : null}
                  countSlot={item.badge === 'needs-you' ? 'nav-needs-you-badge' : 'nav-unread-badge'}
                  countTitle={areaCountTitle(item, item.badge === 'needs-you' ? nowCount : unreadCount)}
                  marker={item.badge === 'skills-update' && skillsUpdateAvailable ? 'Skills update available' : newNavItems.has(item.to) ? 'New' : null}
                  markerSlot={item.badge === 'skills-update' && skillsUpdateAvailable ? 'nav-update-marker' : 'nav-new-marker'}
                />
              ))}
            </nav>
            {/* The active project's extension sidebar panels, under its areas — nothing when none. */}
            {extensionPanels}

            <div data-slot="current-tasks-slot" className="px-2.5">
              <SidebarNavigateContext.Provider value={onNavigate}>{currentTasks}</SidebarNavigateContext.Provider>
            </div>

            <nav aria-label="Workspace" className="px-2.5">
              <h2 className="px-3 pt-3 pb-1 eyebrow text-soft-foreground">Workspace</h2>
              <DashboardLink onNavigate={onNavigate} />
              <AllTasksLink active={globalTasks} onNavigate={onNavigate} />
              {workspace.map((item) => (
                <SidebarNavRow
                  key={item.to}
                  item={item}
                  isActive={item.to === activeTo}
                  onNavigate={onNavigate}
                  count={item.badge === 'inbox-count' ? inboxCount : null}
                  countSlot="nav-badge"
                  marker={newNavItems.has(item.to) ? 'New' : null}
                  markerSlot="nav-new-marker"
                />
              ))}
            </nav>
          </div>
        </>
      )}

      <SidebarStatusLine
        health={healthStatus}
        runningCount={runningCount}
        brandName={brandName}
        version={version}
        latestVersion={latestVersion}
        starCount={starCount}
        hostWidget={hostWidget}
        toolsMenu={toolsMenu}
        whatsNew={whatsNew}
        whatsNewUnseen={whatsNewUnseen}
        healthReason={healthReason}
      />
    </div>
  )
}

/** The tooltip behind an area badge: what the number counts. */
function areaCountTitle(item: NavItem, count: number | null): string | undefined {
  if (!count) return undefined
  const one = count === 1
  if (item.badge === 'tasks-unread') return `${count} unread finished ${one ? 'task' : 'tasks'}`
  if (item.badge === 'needs-you') return `${count} ${one ? 'task needs' : 'tasks need'} you`
  return undefined
}

// 44px touch targets in the drawer, the mockup's 34px row on desktop. Exported for the manager
// sidebar's Workspace rows, which must read as peers of these.
export const NAV_ROW_CLASS =
  'flex h-11 w-full items-center gap-2.5 rounded-md px-2.5 text-ui font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:h-[34px]'
export const NAV_ROW_ACTIVE_CLASS = 'bg-muted font-semibold text-foreground'
const NAV_BADGE_CLASS = 'ml-auto rounded-full bg-violet px-1.5 py-px text-micro font-semibold text-violet-foreground tabular-nums'

/**
 * One nav row. A plain Link, not NavLink: NavLink derives `aria-current` from its own prefix
 * match, which would not light Tasks on `/tasks/:id` — the area rule lives in `activeNavPath`.
 */
function SidebarNavRow({
  item,
  isActive,
  onNavigate,
  count,
  countSlot,
  countTitle,
  marker,
  markerSlot,
}: {
  item: NavItem
  isActive: boolean
  onNavigate?: () => void
  count: number | null
  countSlot: string
  countTitle?: string
  marker: string | null
  markerSlot: string
}) {
  const Icon = item.icon
  return (
    <Link
      to={item.to}
      onClick={onNavigate}
      aria-current={isActive ? 'page' : undefined}
      className={cn(NAV_ROW_CLASS, isActive && NAV_ROW_ACTIVE_CLASS)}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      {item.label}
      {count ? (
        <span data-slot={countSlot} title={countTitle} className={NAV_BADGE_CLASS}>
          {count}
        </span>
      ) : marker ? (
        <span data-slot={markerSlot} className="ml-auto flex items-center">
          <span className="size-1.5 rounded-full bg-violet" aria-hidden="true" />
          <span className="sr-only">{marker}</span>
        </span>
      ) : null}
    </Link>
  )
}

/**
 * The way into the cross-project Dashboard (`/dashboard`). A `NavLink`, unlike its neighbours:
 * `/dashboard` carries view and period query strings, and NavLink's path-only matching keeps
 * the row lit across all of them.
 */
function DashboardLink({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <NavLink
      to="/dashboard"
      data-slot="dashboard-link"
      onClick={onNavigate}
      className={({ isActive }) => cn(NAV_ROW_CLASS, isActive && NAV_ROW_ACTIVE_CLASS)}
    >
      <LayoutDashboardIcon className="size-4 shrink-0" aria-hidden="true" />
      Dashboard
    </NavLink>
  )
}

/**
 * The global Tasks page (`/tasks`) — every project's work in one table. A PLAIN router Link: the
 * page sits outside every project, and the scoped `Link` would prefix it with `/p/<id>`.
 */
function AllTasksLink({ active, onNavigate }: { active: boolean; onNavigate?: () => void }) {
  return (
    <RouterLink
      to="/tasks"
      data-slot="all-tasks-link"
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cn(NAV_ROW_CLASS, active && NAV_ROW_ACTIVE_CLASS)}
    >
      <LayersIcon className="size-4 shrink-0" aria-hidden="true" />
      All tasks
    </RouterLink>
  )
}

/**
 * The footer's `v{version}` chip — exported, with `StarChip`, for the settings sidebar's footer,
 * which mirrors this one (spec 2026-10-13-unified-settings). When the server's npm-registry check found something newer
 * (`latestVersion`, #368), the chip grows a pulsing pending-tone dot and names the version in
 * its tooltip — an affordance, not an alert: updating is optional, so the chrome stays quiet.
 *
 * The chip is the controls row's ONE elastic item, and that is load-bearing. Every other control
 * there is `shrink-0` (the icon buttons inherit it from the button base class), so whatever a
 * version string costs beyond the column's width has to come out of somewhere — and while this
 * chip was `shrink-0` too, there was nowhere for it to come from: a nightly version (#876's
 * dist-tag, some 173px of it) shoved the gear and the theme toggle clean outside the sidebar
 * rather than clipping anything. Truncating from the tail keeps the half that carries meaning,
 * the semver, and the `title` keeps the whole string — which is why the tooltip is now there
 * even with no update to announce.
 */
export function VersionChip({ version, latestVersion, brandName }: { version: string; latestVersion: string | null; brandName: string }) {
  const updateAvailable = Boolean(latestVersion && latestVersion !== version)
  // The chip opens the self-update dialog (PoC): channel, latest, and a version picker.
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <button
        type="button"
        data-slot="version-chip"
        data-update-available={updateAvailable ? 'true' : undefined}
        title={updateAvailable ? `v${version} — update available: v${latestVersion}` : `v${version}`}
        aria-label={updateAvailable ? `${brandName} v${version}, update to v${latestVersion} available — open updater` : `${brandName} v${version} — open updater`}
        onClick={() => setOpen(true)}
        className="flex min-w-0 cursor-pointer items-center gap-1 rounded-full border border-border px-1.5 py-px font-mono text-micro font-medium text-soft-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {updateAvailable ? <StatusDot tone="pending" pulse className="size-[5px] shrink-0" /> : null}
        <span className="truncate">v{version}</span>
      </button>
      {open ? <SelfUpdateDialog open={open} onOpenChange={setOpen} brandName={brandName} /> : null}
    </>
  )
}

/**
 * The footer's ⭐ ask: a link to cezar's repository with its current star count.
 *
 * It is a request and only a request. Nothing about cezar behaves differently for someone who
 * never clicks it, there is no reward on the other side, and it cannot be "completed" — which is
 * also why it has no dismiss control: a chip the size of the version chip, sitting quietly in the
 * chrome, has nothing to dismiss.
 *
 * `shrink-0`, unlike `VersionChip`. That chip is the controls row's ONE elastic item on purpose
 * (#876: a long nightly version string has to come out of somewhere), and a second elastic
 * control would give the row two ways to lose — this one is at most six characters wide
 * (`⭐ 12.3k`), so it can afford to be rigid and let the version string keep the give.
 *
 * `rel="noreferrer"` alongside `noopener`: a local cockpit's URL is nobody's business, and the
 * whole point of the ask is that github.com learns nothing about the person making it.
 */
export function StarChip({ count }: { count: number }) {
  const formatted = formatStarCount(count)
  return (
    <a
      data-slot="star-chip"
      href={CEZAR_REPO_URL}
      target="_blank"
      rel="noopener noreferrer"
      title={`Star cezar on GitHub — ${count.toLocaleString()} stars`}
      aria-label={`Star cezar on GitHub — ${count.toLocaleString()} stars`}
      className="flex shrink-0 items-center gap-1 rounded-full border border-border px-1.5 py-px font-mono text-micro font-medium text-soft-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <span aria-hidden="true">⭐</span>
      <span>{formatted}</span>
    </a>
  )
}

/** Mobile chrome (<md): the sidebar's replacement. Its menu button opens `MobileNavDrawer`. */
function MobileTopBar({ title, attention = null }: { title: string; attention?: ManagerAttention | null }) {
  return (
    <header
      data-slot="mobile-top-bar"
      className="row-start-1 border-b border-border bg-card pt-[env(safe-area-inset-top)] md:hidden"
    >
      <div className="flex h-11 items-center gap-2.5 px-3">
        {/* A real SheetTrigger rather than an onClick that flips our state: it is what registers
            the button as the dialog's trigger, which is what Radix restores focus to on close —
            with a bare onClick, closing the drawer drops focus on <body>. It also carries the
            aria-haspopup / aria-expanded / aria-controls wiring for free. */}
        <SheetTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open menu"
            // 44px: the minimum touch target, overriding the 36px desktop icon-button size.
            className="relative -ml-1.5 size-11"
          >
            <MenuIcon className="size-[17px]" aria-hidden="true" />
            {attention ? (
              <span data-slot="mobile-manager-attention" className="absolute top-2.5 right-2.5 flex">
                <span className={cn('size-1.5 rounded-full', MANAGER_ATTENTION_DOT[attention])} aria-hidden="true" />
                <span className="sr-only">{attention === 'needs-you' ? 'A manager needs you' : 'A manager has news'}</span>
              </span>
            ) : null}
          </Button>
        </SheetTrigger>
        <span className="truncate text-body font-semibold">{title}</span>
        {/* SLOT — the run status dot / kebab land with the thread view (Step R3). */}
        <div data-slot="mobile-status" className="ml-auto flex items-center gap-2" />
      </div>
    </header>
  )
}
