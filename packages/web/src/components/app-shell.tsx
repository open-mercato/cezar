import {
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  LayersIcon,
  LayoutDashboardIcon,
  MenuIcon,
  PlusIcon,
  SettingsIcon,
  XIcon,
} from 'lucide-react'
import * as React from 'react'
import type { ReactNode } from 'react'
import { Link as RouterLink, NavLink, matchPath, useLocation } from 'react-router'

import { TRACKER_PROVIDERS } from '@/lib/tracker-providers'
import { AddProjectDialog } from '@/components/add-project-dialog'
import { CloneProjectDialog } from '@/components/clone-project-dialog'
import { CreateProjectDialog } from '@/components/create-project-dialog'
import { DialogErrorBoundary } from '@/components/dialog-error-boundary'
import { trackAddProjectOpened } from '@/lib/telemetry'
import { CommandPaletteHint } from '@/components/command-palette-hint'
import { GithubIcon } from '@/components/icons'
import { Link, stripProjectPrefix } from '@/lib/project-router'
import { isSettingsPathname } from '@/lib/settings-path'
import { CEZAR_REPO_URL, formatStarCount } from '@/lib/star-promo'
import { BrandLockup } from '@/components/brand-mark'
import { SelfUpdateDialog } from '@/components/self-update-dialog'
import { StatusDot } from '@/components/status-dot'
import { ThemeToggle } from '@/components/theme-toggle'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Sheet, SheetTrigger } from '@/components/ui/sheet'
import { activeNavItem, activeNavPath, visibleNavItems, type NavItem } from '@/components/nav-items'
import type { TrackerKind } from '@open-mercato/cezar-api-client'
import { SidebarDrawer, SidebarFrame, useDesktopShell, useSidebarWidth, type SidebarResize } from '@/components/sidebar-frame'
import { cn } from '@/lib/utils'
/** Tailwind's `md`. The drawer is the `<md` affordance, so this must stay in step with the
 *  `md:hidden` / `md:flex` classes below — they are the same breakpoint expressed twice, once
 *  for CSS and once for the state machine. */
const DESKTOP_MEDIA_QUERY = '(min-width: 768px)'

export type RepoChip = {
  name: string
  branch: string
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
  /** Step 3.3's grouped task quick-list. */
  taskQuickList?: ReactNode
  /** The sidebar's machine glance (spec `.ai/specs/2026-09-20-host-telemetry-sidebar-widget.md`):
   *  effective CPU, its sparkline and compact RAM, rendered as the footer's first row. It is a
   *  SLOT because `AppShell` stays presentational and QueryClient-free - the container supplies a
   *  node whose own viewport/transport gate decides whether anything mounts at all. */
  hostWidget?: ReactNode
  /** The footer's "What's new" row (spec 2026-10-26-first-run-onboarding, "Coming back"). */
  whatsNew?: ReactNode
  /** Step 4.2's Tools dropdown trigger. */
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
  /** Step 3.3's multi-project sidebar: one collapsible group per registered project, each
   *  carrying its own nav + task list. When present it REPLACES the flat nav and the
   *  `taskQuickList` slot (each group brings its own copies of both); absent — the registry
   *  still loading, or unreachable — the shell renders the single-project sidebar it always
   *  did, which is the honest degradation, not a special case. */
  projectGroups?: ReactNode
  brandName?: string
  brandLogoUrl?: string | null
}

/**
 * The drawer's close-on-navigate callback, published to whatever renders inside the sidebar's
 * slots (`projectGroups`, `taskQuickList`). The route-change effect already closes the drawer
 * for every *changed* route; this covers re-clicking a link to the CURRENT route (per the spec,
 * Tasks navigates home even when already active), which changes no pathname at all. Undefined
 * on desktop, where there is nothing to close.
 */
const SidebarNavigateContext = React.createContext<(() => void) | undefined>(undefined)

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
  skillsUpdateAvailable = false,
  newNavItems = NO_NEW_NAV_ITEMS,
  version = null,
  latestVersion = null,
  starCount = null,
  taskQuickList,
  hostWidget,
  whatsNew,
  toolsMenu,
  forgeAvailable = true,
  inboxAvailable = true,
  automationsAvailable = true,
  tracker,
  singleProject = false,
  banner,
  footerBanner,
  projectGroups,
  brandName = 'cezar',
  brandLogoUrl = null,
}: AppShellProps) {
  const { pathname } = useLocation()
  // The nav's area rules reason about the flat route map — strip any `/p/:projectId` prefix
  // (multi-project spec, step 3.2) so `/p/cezar/git/commits` still lights Git.
  const areaPathname = stripProjectPrefix(pathname)
  const activeTo = activeNavPath(areaPathname)
  const currentBase = activeNavItem(areaPathname)
  const current = currentBase?.to === '/tracker' && tracker
    ? { ...currentBase, label: TRACKER_PROVIDERS[tracker].label }
    : currentBase
  // Settings is CHROMELESS (spec 2026-10-13-unified-settings): on any settings URL the sidebar
  // column, the drawer and the mobile top bar are not rendered at all — the settings frame
  // supplies its own header, nav and way back. The banner row stays (provider failures link
  // INTO settings, so hiding the banner there would hide the fix from the person about to apply
  // it) and so does the bottom safe-area row. `data-chromeless` marks the mode.
  const chromeless = isSettingsPathname(pathname)
  const [menuOpen, setMenuOpen] = React.useState(false)
  const closeMenu = React.useCallback(() => setMenuOpen(false), [])
  const mainRef = React.useRef<HTMLElement>(null)
  const routeOwnsArrival = routeOwnsScrollArrival(pathname)
  // The desktop column's width (#788) — one preference shared with the settings sidebar.
  const [sidebarWidth, changeSidebarWidth] = useSidebarWidth()

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
    items,
    repo,
    // The badge belongs to the Inbox item — with the item gone there is nothing to badge.
    inboxCount: inboxAvailable ? inboxCount : null,
    unreadCount,
    skillsUpdateAvailable,
    newNavItems,
    version,
    latestVersion,
    starCount,
    taskQuickList,
    hostWidget,
    whatsNew,
    toolsMenu,
    projectGroups,
    singleProject,
    brandName,
    brandLogoUrl,
  }

  const desktop = useDesktopShell()

  return (
    <div
      data-slot="app-shell"
      data-desktop={desktop ?? undefined}
      data-chromeless={chromeless ? '' : undefined}
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
      {chromeless ? null : (
        <Sidebar {...nav} width={sidebarWidth} onWidthChange={changeSidebarWidth} desktop={desktop} />
      )}
      <div
        className={cn(
          'grid min-w-0 flex-1 grid-rows-[auto_auto_1fr_auto] overflow-hidden',
          desktop === 'macos' && 'pt-[28px]',
        )}
      >
        {/* The Sheet root renders no DOM of its own. Keep only the mobile controls inside its
            context so a sidebar update cannot propagate through the routed view. */}
        {/* Row 1 stays EMPTY in chromeless mode — the explicit `row-start-*` placement is what
            keeps the scroller in row 3 either way. */}
        {chromeless ? null : (
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <MobileTopBar title={current?.label ?? brandName} />
            {/* The drawer keeps its fixed 264px: it is a full-height overlay on a phone, where
                there is no second column to trade width with and no pointer to drag a border. */}
            <MobileNavDrawer {...nav} onNavigate={closeMenu} />
          </Sheet>
        )}

        {banner ? (
          <div data-slot="banner-slot" className="row-start-2">
            {banner}
          </div>
        ) : null}

        <AppShellMain mainRef={mainRef}>{children}</AppShellMain>

        {/* Row 4: the composer dock (thread reply, Step R3) — the footer banner above it, and
            the bottom safe-area gutter so the scroller never runs under the home indicator. */}
        <div
          data-slot="composer"
          className="row-start-4 pb-[env(safe-area-inset-bottom)]"
        >
          {footerBanner}
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
        className="inline-flex h-[18px] items-center gap-1 rounded-full border border-primary/40 bg-primary/15 px-2 text-[11px] font-semibold text-foreground transition-colors hover:bg-primary/30"
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
  items: NavItem[]
  repo: RepoChip | null
  inboxCount: number | null
  unreadCount: number | null
  skillsUpdateAvailable: boolean
  newNavItems: ReadonlySet<string>
  version: string | null
  latestVersion: string | null
  starCount: number | null
  taskQuickList?: ReactNode
  hostWidget?: ReactNode
  whatsNew?: ReactNode
  toolsMenu?: ReactNode
  projectGroups?: ReactNode
  brandName: string
  brandLogoUrl: string | null
  singleProject: boolean
}

/** The desktop column: the shared `SidebarFrame` (resizable, #788) around the app's content. */
const Sidebar = React.memo(function Sidebar({
  width,
  onWidthChange,
  desktop = null,
  ...props
}: NavProps & SidebarResize & { desktop?: 'macos' | 'windows' | 'linux' | null }) {
  return (
    <SidebarFrame width={width} onWidthChange={onWidthChange} titlebarInset={desktop === 'macos'}>
      <SidebarContent {...props} compactHeader={desktop === 'macos'} />
    </SidebarFrame>
  )
})

/** The `<md` drawer: the shared `SidebarDrawer` around the SAME content the column renders. */
const MobileNavDrawer = React.memo(function MobileNavDrawer({ onNavigate, ...props }: NavProps & { onNavigate: () => void }) {
  return (
    <SidebarDrawer slot="mobile-nav-drawer" title="Navigation">
      {(closeButton) => <SidebarContent {...props} onNavigate={onNavigate} headerAction={closeButton} />}
    </SidebarDrawer>
  )
})

/**
 * Everything inside the sidebar: brand lockup, New task CTA, nav, quick-list, footer. Framed by
 * `Sidebar` on desktop and by `MobileNavDrawer` below `md` — the two callers differ only in the
 * box around this, which is what keeps the mobile nav from drifting away from the desktop one.
 *
 * The safe-area insets live here rather than on the frames because both need them: the drawer is
 * a full-height overlay under the same notch and home indicator the sidebar sits under.
 */
function SidebarContent({
  activeTo,
  items,
  repo,
  inboxCount,
  unreadCount,
  skillsUpdateAvailable,
  newNavItems,
  version,
  latestVersion,
  starCount,
  taskQuickList,
  hostWidget,
  whatsNew,
  toolsMenu,
  projectGroups,
  singleProject,
  brandName,
  brandLogoUrl,
  onNavigate,
  headerAction,
  compactHeader = false,
}: NavProps & {
  brandName: string
  brandLogoUrl: string | null
  /** Fires on any in-drawer navigation. The route-change effect already closes the drawer for
   *  every *changed* route; this also covers re-clicking the active item (per the spec, Tasks
   *  navigates home even when already active), which changes no pathname at all. */
  onNavigate?: () => void
  /** The drawer's close button. Absent on desktop, which has nothing to close. */
  headerAction?: ReactNode
  /** Under the desktop shell's title strip the brand row already has 28px above it, so it
   *  gives up most of its own top padding — otherwise the logo floats a full toolbar's height
   *  below the traffic lights. */
  compactHeader?: boolean
}) {
  return (
    <div
      data-slot="sidebar-content"
      // `@container/sidebar` (#788): the sidebar is no longer one fixed width, so what its rows
      // can afford to paint is a question about THIS column, not about the viewport. Everything
      // inside that is droppable metadata — the quick-list's diff pair today — hides itself with
      // an `@min-[…]/sidebar:` query and returns when the user drags the column wider.
      className="@container/sidebar flex min-h-0 flex-1 flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
    >
      <div className={cn('flex items-center gap-[9px] px-3.5 pb-2.5', compactHeader ? 'pt-1.5' : 'pt-3.5')}>
        <BrandLockup name={brandName} logoUrl={brandLogoUrl} />
        {/* With project groups mounted the boot repo/branch is one group header among many —
            a chip repeating it up here would just be the first group's header said twice. */}
        {repo && !projectGroups ? (
          <span
            data-slot="repo-chip"
            className="ml-auto truncate font-mono text-[11px] font-medium text-soft-foreground"
          >
            {repo.name} / {repo.branch}
          </span>
        ) : null}
        {headerAction ? (
          <div className={cn('shrink-0', (!repo || projectGroups) && 'ml-auto')}>{headerAction}</div>
        ) : null}
      </div>

      <div className="flex gap-1.5 px-2.5 pt-1 pb-2">
        <Button asChild variant="contrast" className="relative min-w-0 flex-1 justify-center">
          {/* A Router Link since R4 Step 1.1: the React /new composer is real, so deliberate
              New task affordances stay inside the SPA. Full document loads of /new (the
              bookmarklet contract) land on the shell like any route (static-ui.ts) — the
              React composer has owned auto-start parity since R4 Step 1.3. */}
          <Link to="/new" onClick={onNavigate}>
            <PlusIcon className="size-[15px]" aria-hidden="true" />
            New task
            {/* Decorative: the `c`-to-create accelerator is registered in the command palette.
                (⌘N is also bound there, but only the desktop shell receives it — the browser
                reserves ⌘N for a new window — so the chip advertises the one that always works.) */}
            <kbd
              aria-hidden="true"
              className="absolute right-2.5 rounded-[5px] border border-b-2 border-contrast-foreground/25 bg-transparent px-[5px] py-px font-mono text-[10.5px] font-medium text-contrast-foreground/60"
            >
              C
            </kbd>
          </Link>
        </Button>
        {singleProject ? null : <AddProjectMenu />}
      </div>

      {/* The first of the two top-level doors; `AllTasksLink` is the other. They share one skin
          (SIDEBAR_SECTION_LINK_CLASS) because they stack directly against each other. */}
      <div className="shrink-0 px-1.5">
        <DashboardLink onNavigate={onNavigate} />
      </div>
      {projectGroups ? (
        <>
          {/* PINNED above the scroller, not the first row inside it. It is about every group
              rather than a peer of them, and a workspace with enough projects to want this page
              is exactly the workspace that scrolls it out of sight. Its own bordered band is
              what stops it reading as an unusually-worded project. Only in a multi-project
              workspace: with one project the page would be that project's own Tasks table
              wearing a second name. */}
          <div className="shrink-0 border-b border-border px-1.5 pt-0.5 pb-2">
            <AllTasksLink onNavigate={onNavigate} />
          </div>
          {/* Step 3.3: one collapsible group per registered project — nav + task list per group.
              The whole area scrolls as one (per the sidebar mockup); collapsed groups are one row. */}
          <div
            data-slot="project-groups"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pt-1.5 pb-2"
          >
            <SidebarNavigateContext.Provider value={onNavigate}>
              {projectGroups}
            </SidebarNavigateContext.Provider>
          </div>
        </>
      ) : (
        <>
          <nav aria-label="Main" className="px-2.5 py-1.5">
            {items.map((item) => {
              const isActive = item.to === activeTo
              const Icon = item.icon
              // Link, not NavLink, on purpose. NavLink derives `aria-current` from its own prefix
              // match against `to`, and that rule is wrong here: it would *not* light Tasks on
              // /tasks/:id — which the spec requires. `aria-current` cannot be forced past NavLink's
              // own matching, so the area rule lives in `activeNavPath` and this is a plain Link.
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  onClick={onNavigate}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    // h-[34px] is the mockup's desktop row. In the drawer these are touch targets, so
                    // they relax to 44px — the one place the two framings legitimately differ.
                    'flex h-11 w-full items-center gap-2.5 rounded-md px-2.5 text-[13.5px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:h-[34px]',
                    isActive && 'bg-muted font-semibold text-foreground'
                  )}
                >
                  <Icon className="size-4 shrink-0" aria-hidden="true" />
                  {item.label}
                  {item.badge === 'inbox-count' && inboxCount ? (
                    <span
                      data-slot="nav-badge"
                      className="ml-auto rounded-full bg-violet px-1.5 py-px text-[10.5px] font-semibold text-violet-foreground"
                    >
                      {inboxCount}
                    </span>
                  ) : null}
                  {/* Unread done items (#unread-done-items): same violet count grammar as the
                      Inbox badge — the two share the "needs a human" hue. */}
                  {item.badge === 'tasks-unread' && unreadCount ? (
                    <span
                      data-slot="nav-unread-badge"
                      title={`${unreadCount} unread finished ${unreadCount === 1 ? 'task' : 'tasks'}`}
                      className="ml-auto rounded-full bg-violet px-1.5 py-px text-[10.5px] font-semibold text-violet-foreground"
                    >
                      {unreadCount}
                    </span>
                  ) : null}
                  {item.badge === 'skills-update' && skillsUpdateAvailable ? (
                    <span
                      data-slot="nav-update-marker"
                      className="ml-auto flex items-center"
                    >
                      <span className="size-1.5 rounded-full bg-violet" aria-hidden="true" />
                      <span className="sr-only">Skills update available</span>
                    </span>
                  ) : null}
                  {newNavItems.has(item.to) ? (
                    <span data-slot="nav-new-marker" className="ml-auto flex items-center">
                      <span className="size-1.5 rounded-full bg-violet" aria-hidden="true" />
                      <span className="sr-only">New</span>
                    </span>
                  ) : null}
                </Link>
              )
            })}
          </nav>

          {/* The single-project quick-list (Needs you / Working / Recent). */}
          <div
            data-slot="task-quick-list"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2.5 pb-2"
          >
            {taskQuickList}
          </div>
        </>
      )}

      {/* Deliberate rows, never a wrap (#702): the machine glance (when one is mounted), then the
       *  search bar, then the chrome controls. `flex-col` rather than `flex-wrap` on purpose — the
       *  previous single wrapping row overflowed the 264px column and silently stranded the theme
       *  toggle on a line of its own, and a column cannot regress into that no matter what a future
       *  control's width is. The slot renders nothing at all when its own gate says no (below `md`
       *  and in remote), so the count of rows is a property of the viewport, not of the markup. */}
      <div
        data-slot="sidebar-footer"
        className="flex flex-col gap-1.5 border-t border-border px-3.5 py-2.5"
      >
        {whatsNew}
        {hostWidget}
        <CommandPaletteHint />
        <div data-slot="sidebar-footer-controls" className="flex items-center gap-2">
          {/* SLOT — Step 4.2 mounts the Tools dropdown (aggregate status dot + tool versions) here. */}
          <div data-slot="tools-menu" className="shrink-0">
            {toolsMenu}
          </div>
          {version ? <VersionChip version={version} latestVersion={latestVersion} brandName={brandName} /> : null}
          {starCount === null ? null : <StarChip count={starCount} />}
          <GlobalSettingsLink onNavigate={onNavigate} className="ml-auto" />
          <ThemeToggle />
        </div>
      </div>
    </div>
  )
}

/**
 * The shared skin of the sidebar's two top-level doors — Dashboard and All tasks. They stack
 * directly on top of each other, so they are peers and must be painted as one: the same row
 * height, the same type scale, the same violet icon.
 *
 * ONE constant rather than two copies on purpose. Dashboard shipped as its own inline class
 * string and drifted to `min-h-11`/`text-sm`/no icon colour, which read on desktop as an 8px
 * taller row with the only grey icon of the pair. A shared string is what makes the next tweak
 * land on both rows or on neither.
 *
 * Not the per-project nav rows below them: those are a lower tier (muted foreground, semibold
 * only when active, `md:h-[34px]`) and are deliberately NOT peers of these two.
 */
const SIDEBAR_SECTION_LINK_CLASS =
  'flex h-11 w-full items-center gap-2.5 rounded-md px-2.5 text-[13.5px] font-semibold text-foreground transition-colors hover:bg-muted md:h-9'

/**
 * The accent icon of a top-level door — violet, the same hue the tag chips and the Tasks page's
 * own selected filters use, so the door and the room match. Full strength once the row is the
 * current page.
 */
function sidebarSectionIconClass(isActive: boolean) {
  return cn('size-4 shrink-0', isActive ? 'text-violet' : 'text-violet/70')
}

/**
 * The way into the cross-project Dashboard (`/dashboard`).
 *
 * A `NavLink`, unlike its `AllTasksLink` neighbour: `/dashboard` carries its own view and period
 * query strings (`?view=costs`, `?period=30d`), and NavLink's path-only matching keeps the row
 * lit across all of them where a `pathname ===` check on a full location would not.
 */
function DashboardLink({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <NavLink
      to="/dashboard"
      data-slot="dashboard-link"
      onClick={onNavigate}
      className={({ isActive }) => cn(SIDEBAR_SECTION_LINK_CLASS, isActive && 'bg-muted')}
    >
      {({ isActive }) => (
        <>
          <LayoutDashboardIcon className={sidebarSectionIconClass(isActive)} aria-hidden="true" />
          Dashboard
        </>
      )}
    </NavLink>
  )
}

/**
 * The way into the global Tasks page (`/tasks`) — every project's work in one table, filtered
 * and grouped by project, tag, status or workflow.
 *
 * A PLAIN router Link, like the footer's global-settings one and for the same reason: the page
 * sits outside every project, and the scoped `Link` this file otherwise uses would prefix it
 * with the active `/p/<id>`, which is not a route. Its own icon (layers, not the per-project
 * checklist) so the two Tasks surfaces never read as the same button.
 */
function AllTasksLink({ onNavigate }: { onNavigate?: () => void }) {
  const { pathname } = useLocation()
  const isActive = pathname === '/tasks'
  return (
    <RouterLink
      to="/tasks"
      data-slot="all-tasks-link"
      onClick={onNavigate}
      aria-current={isActive ? 'page' : undefined}
      // Reads at the weight of a section header rather than a nav row: full-strength foreground
      // and semibold, where the project groups below it are semibold-on-default and their nav
      // rows are muted.
      className={cn(SIDEBAR_SECTION_LINK_CLASS, isActive && 'bg-muted')}
    >
      <LayersIcon className={sidebarSectionIconClass(isActive)} aria-hidden="true" />
      All tasks
    </RouterLink>
  )
}

/**
 * The footer's way into `/settings/global/*` (multi-project spec, "Sidebar → Footer").
 *
 * A PLAIN router Link, deliberately: global settings sit outside every project, and the scoped
 * `Link` this file otherwise uses would prefix the target with the active `/p/<id>` — a path
 * that is not a route. Icon-only to keep the footer's one row intact; the accessible name and
 * the tooltip both carry the label.
 */
function GlobalSettingsLink({
  className,
  onNavigate,
}: {
  className?: string
  onNavigate?: () => void
}) {
  return (
    <Button asChild variant="ghost" size="icon" className={cn('size-7', className)}>
      <RouterLink
        to="/settings/global"
        data-slot="global-settings-link"
        aria-label="Global settings"
        title="Global settings"
        onClick={onNavigate}
      >
        <SettingsIcon className="size-4" aria-hidden="true" />
      </RouterLink>
    </Button>
  )
}

/**
 * The "Add project" dropdown beside the New task CTA (multi-project spec, "Sidebar → Header").
 *
 * "Open local folder…" opens the folder-browser dialog (step 4.2); "Clone from GitHub…" opens
 * the checkout dialog (step 4.3); "New project…" opens the create dialog (spec
 * 2026-09-29-create-new-project) — a fresh git repo, optionally a new private GitHub repo.
 *
 * Neither item is gh-gated here, deliberately. The spec's "disabled with a reason when `gh` is
 * unavailable" would mean reading `GET /api/health` from this component — and the dialogs are
 * mounted only while open precisely BECAUSE this shell must keep rendering where no QueryClient
 * is provided. So the degradation lands one click later instead, in the dialog, which shows the
 * server's own `gh CLI not found — install it and run 'gh auth login'` verbatim: the same
 * information, at the moment it is actionable, without a query in the shell.
 *
 * The dialogs are mounted only while open, ON PURPOSE: they are the one part of this shell that
 * talks to the API (queries + a mutation), and the shell itself must keep rendering in the
 * places that mount it without a QueryClient. The cost is no close animation, which is the
 * cheaper half of the trade.
 */
function AddProjectMenu() {
  const [browsing, setBrowsing] = React.useState(false)
  const [cloning, setCloning] = React.useState(false)
  const [creating, setCreating] = React.useState(false)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* size-11 in the drawer (touch target), the CTA's height on desktop. */}
        <Button
          variant="outline"
          size="icon"
          aria-label="Add project"
          title="Add project"
          className="size-11 shrink-0 md:size-9"
        >
          <FolderOpenIcon className="size-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="text-xs text-soft-foreground">Add project</DropdownMenuLabel>
        <DropdownMenuItem
          data-slot="add-project-local"
          onSelect={() => {
            setBrowsing(true)
            trackAddProjectOpened('folder')
          }}
        >
          <FolderIcon aria-hidden="true" />
          Open local folder…
        </DropdownMenuItem>
        <DropdownMenuItem
          data-slot="add-project-clone"
          onSelect={() => {
            setCloning(true)
            trackAddProjectOpened('clone')
          }}
        >
          <GithubIcon aria-hidden="true" />
          Clone from GitHub…
        </DropdownMenuItem>
        <DropdownMenuItem
          data-slot="add-project-create"
          onSelect={() => {
            setCreating(true)
            trackAddProjectOpened('new')
          }}
        >
          <FolderPlusIcon aria-hidden="true" />
          New project…
        </DropdownMenuItem>
      </DropdownMenuContent>
      {browsing ? (
        <DialogErrorBoundary label="Open local folder" onError={() => setBrowsing(false)}>
          <AddProjectDialog open onOpenChange={setBrowsing} />
        </DialogErrorBoundary>
      ) : null}
      {cloning ? (
        <DialogErrorBoundary label="Clone from GitHub" onError={() => setCloning(false)}>
          <CloneProjectDialog open onOpenChange={setCloning} />
        </DialogErrorBoundary>
      ) : null}
      {creating ? (
        <DialogErrorBoundary label="New project" onError={() => setCreating(false)}>
          <CreateProjectDialog open onOpenChange={setCreating} />
        </DialogErrorBoundary>
      ) : null}
    </DropdownMenu>
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
        className="flex min-w-0 cursor-pointer items-center gap-1 rounded-full border border-border px-1.5 py-px font-mono text-[10px] font-medium text-soft-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
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
      className="flex shrink-0 items-center gap-1 rounded-full border border-border px-1.5 py-px font-mono text-[10px] font-medium text-soft-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <span aria-hidden="true">⭐</span>
      <span>{formatted}</span>
    </a>
  )
}

/** Mobile chrome (<md): the sidebar's replacement. Its menu button opens `MobileNavDrawer`. */
function MobileTopBar({ title }: { title: string }) {
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
            className="-ml-1.5 size-11"
          >
            <MenuIcon className="size-[17px]" aria-hidden="true" />
          </Button>
        </SheetTrigger>
        <span className="truncate text-[14.5px] font-semibold">{title}</span>
        {/* SLOT — the run status dot / kebab land with the thread view (Step R3). */}
        <div data-slot="mobile-status" className="ml-auto flex items-center gap-2" />
      </div>
    </header>
  )
}
