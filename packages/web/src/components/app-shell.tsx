import {
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  LayersIcon,
  MenuIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  XIcon,
} from 'lucide-react'
import * as React from 'react'
import type { ReactNode } from 'react'
import { Link as RouterLink, matchPath, useLocation } from 'react-router'

import { AddProjectDialog } from '@/components/add-project-dialog'
import { CloneProjectDialog } from '@/components/clone-project-dialog'
import { openCommandPalette } from '@/components/command-palette'
import { GithubIcon } from '@/components/icons'
import { commandShortcutHint } from '@/lib/use-command-shortcut'
import { Link, stripProjectPrefix } from '@/lib/project-router'
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
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { activeNavItem, activeNavPath, visibleNavItems, type NavItem } from '@/components/nav-items'
import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  SIDEBAR_WIDTH_STEP,
  clampSidebarWidth,
  readStoredSidebarWidth,
  writeStoredSidebarWidth,
} from '@/lib/sidebar-width'
import { cn } from '@/lib/utils'
// The Open Mercato brand mark. A `public/` asset, not a bundled import: the service serves the
// same file at this exact path (`GET /open-mercato.svg` — the favicon index.html points at), so
// a second, hashed URL for the same picture would be one cache entry too many. Vite serves
// `public/` at the root in dev and copies it into the build, so the path holds in both.
// Its own gradient + rounded corners ARE the tile.
/** The cezar mark (public/cezar-logo.svg): the Open Mercato brand-gradient tile (lime→violet)
 *  with the dark hexagonal C glyph. Also the favicon. */
const brandLogoUrl = '/cezar-logo.svg'

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
  /** cezar version for the footer chip. Null until Step 3.1 reads it from `/api/health`. */
  version?: string | null
  /** The npm registry's newer version, when the server's update check found one (#368). The
   *  chip grows a pulsing pending dot + tooltip; absent or equal to `version`, it stays plain. */
  latestVersion?: string | null
  /** Step 3.3's grouped task quick-list. */
  taskQuickList?: ReactNode
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
  /** Single-project capability gating: hides workspace-expansion affordances. Defaults off so
   *  standalone and older callers preserve the multi-project shell. */
  singleProject?: boolean
  /** Global chrome banner, rendered in its own row above the scroller. Absent renders nothing —
   *  the slot is generic and currently unused (the #391 skills promo it once held is gone,
   *  replaced by the opt-in Import panel on the Skills page). */
  banner?: ReactNode
  /** Step 3.3's multi-project sidebar: one collapsible group per registered project, each
   *  carrying its own nav + task list. When present it REPLACES the flat nav and the
   *  `taskQuickList` slot (each group brings its own copies of both); absent — the registry
   *  still loading, or unreachable — the shell renders the single-project sidebar it always
   *  did, which is the honest degradation, not a special case. */
  projectGroups?: ReactNode
  /** More than one registered project (user decision, 25-repo review): the sidebar keeps the
   *  flat ACTIVE-project layout and only pins the All-tasks door above it — the other projects
   *  live in the switcher, not in a list of groups to scroll past. */
  multiProject?: boolean
  /** The ACTIVE project's display name for the project bar above the content (the container
   *  resolves it from the registry; falls back to `repo.name`). Null hides the bar. */
  projectName?: string | null
  /** The registry-backed project SWITCHER for the bar's left side; when absent the bar falls
   *  back to the static name chip (registry unknown / single project). */
  projectSwitcher?: ReactNode
  /** The bar's second breadcrumb step: the open task's title, else the view's name. */
  crumb?: string | null
  /** The Projects nav row (user decision): the same project menu as the bar's switcher, as the
   *  nav's last row — the list, add, manage — never a page of its own. */
  projectsMenu?: ReactNode
}

/**
 * The drawer's close-on-navigate callback, published to whatever renders inside the sidebar's
 * slots (`projectGroups`, `taskQuickList`). The route-change effect already closes the drawer
 * for every *changed* route; this covers re-clicking a link to the CURRENT route (per the spec,
 * Tasks navigates home even when already active), which changes no pathname at all. Undefined
 * on desktop, where there is nothing to close.
 */
const SidebarNavigateContext = React.createContext<(() => void) | undefined>(undefined)

export function useSidebarNavigate(): (() => void) | undefined {
  return React.useContext(SidebarNavigateContext)
}

/** The main transcript owns cached/tail arrival; every other routed surface uses shell-top. */
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
export function AppShell({
  children,
  repo = null,
  inboxCount = null,
  unreadCount = null,
  skillsUpdateAvailable = false,
  version = null,
  latestVersion = null,
  taskQuickList,
  toolsMenu,
  forgeAvailable = true,
  inboxAvailable = true,
  automationsAvailable = true,
  singleProject = false,
  banner,
  projectGroups,
  multiProject = false,
  projectName = null,
  projectSwitcher,
  crumb = null,
  projectsMenu,
}: AppShellProps) {
  const { pathname } = useLocation()
  // The nav's area rules reason about the flat route map — strip any `/p/:projectId` prefix
  // (multi-project spec, step 3.2) so `/p/cezar/git/commits` still lights Git.
  const areaPathname = stripProjectPrefix(pathname)
  // ONE Tasks row (user decision): the global `/tasks` page is the same list at workspace
  // scope, so it lights Tasks too; the page header's scope switch is where the scope lives.
  const activeTo = activeNavPath(areaPathname)
  const current = activeNavItem(areaPathname)
  const [menuOpen, setMenuOpen] = React.useState(false)
  const mainRef = React.useRef<HTMLElement>(null)
  const routeOwnsArrival = routeOwnsScrollArrival(pathname)
  // The desktop column's width (#788). Read once, lazily, from `localStorage` — it is a
  // browser-local preference like the theme, so there is nothing to fetch and nothing to wait
  // for, and the first paint is already the user's width rather than a default that jumps.
  const [sidebarWidth, setSidebarWidth] = React.useState(readStoredSidebarWidth)
  const changeSidebarWidth = React.useCallback((next: number) => {
    const width = clampSidebarWidth(next)
    setSidebarWidth(width)
    // Persist on every change rather than on drag end: a drag is a stream of small writes to one
    // key, which localStorage is fine with, and it means a tab closed mid-drag still remembers.
    writeStoredSidebarWidth(width)
  }, [])

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

  const nav = {
    activeTo,
    items: visibleNavItems({ forge: forgeAvailable, inbox: inboxAvailable, automations: automationsAvailable, singleProject }),
    repo,
    // The badge belongs to the Inbox item — with the item gone there is nothing to badge.
    inboxCount: inboxAvailable ? inboxCount : null,
    unreadCount,
    skillsUpdateAvailable,
    version,
    latestVersion,
    taskQuickList,
    toolsMenu,
    projectGroups,
    multiProject,
    singleProject,
    projectName,
    projectsMenu,
  }

  return (
    // The Sheet root renders no DOM of its own — it is the context that lets the top bar's menu
    // button be a real SheetTrigger while the open state stays ours to close on navigation.
    <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
      <div
        data-slot="app-shell"
        className="flex h-dvh overflow-hidden bg-background text-foreground pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
      >
        {/* WCAG 2.4.1: the sidebar is 7+ tab stops of repeated chrome on every page — keyboard
            users get one jump past it. Visible only while focused. */}
        <a
          href="#main"
          // Explicit focus: the SPA layer swallows same-page fragment navigation, so the
          // native jump-to-target never fires (verified with a real keyboard).
          onClick={(event) => {
            event.preventDefault()
            mainRef.current?.focus()
          }}
          className="sr-only focus-visible:not-sr-only focus-visible:absolute focus-visible:left-2 focus-visible:top-2 focus-visible:z-50 focus-visible:rounded-md focus-visible:bg-contrast focus-visible:px-3 focus-visible:py-2 focus-visible:text-sm focus-visible:font-medium focus-visible:text-contrast-foreground"
        >
          Skip to content
        </a>
        <Sidebar {...nav} width={sidebarWidth} onWidthChange={changeSidebarWidth} />
        {/* The drawer keeps its fixed 264px: it is a full-height overlay on a phone, where
            there is no second column to trade width with and no pointer to drag a border. */}
        <MobileNavDrawer {...nav} onNavigate={() => setMenuOpen(false)} />

        <div className="grid min-w-0 flex-1 grid-rows-[auto_auto_1fr_auto] overflow-hidden">
          <MobileTopBar title={current?.label ?? 'cezar'} />
          {/* Same grid row as the mobile top bar — the two are breakpoint-exclusive, so they
              never render together. The bar is where the ACTIVE PROJECT lives now: above the
              content on every route, instead of buried in the sidebar lockup. */}
          <ProjectBar
            name={projectName ?? repo?.name ?? null}
            crumb={crumb}
            projectSwitcher={projectSwitcher}
          />

          {banner ? (
            <div data-slot="banner-slot" className="row-start-2">
              {banner}
            </div>
          ) : null}

          <main
            ref={mainRef}
            id="main"
            tabIndex={-1}
            data-slot="main"
            className="row-start-3 min-h-0 overflow-y-auto overscroll-contain outline-none"
          >
            {children}
          </main>

          {/* Row 4: the composer dock (thread reply, Step R3). Empty today, but it still carries
              the bottom safe-area gutter so the scroller never runs under the home indicator. */}
          <div
            data-slot="composer"
            className="row-start-4 pb-[env(safe-area-inset-bottom)]"
          />
        </div>
      </div>
    </Sheet>
  )
}

type NavProps = {
  activeTo: string | null
  items: NavItem[]
  repo: RepoChip | null
  inboxCount: number | null
  unreadCount: number | null
  skillsUpdateAvailable: boolean
  version: string | null
  latestVersion: string | null
  taskQuickList?: ReactNode
  toolsMenu?: ReactNode
  projectGroups?: ReactNode
  /** The active project's name — the task list's label. */
  projectName?: string | null
  projectsMenu?: ReactNode
  /** More than one registered project: pins the All-tasks door above the flat sidebar. The
   *  sidebar itself stays the ACTIVE project's (user decision, 25-repo review) — other
   *  projects are the switcher's job, not a list to scroll past. */
  multiProject?: boolean
  singleProject: boolean
}

/**
 * The desktop frame, from `md` up — 264px by default and draggable up to 420px (#788).
 *
 * The width is the user's, not the layout's: the sidebar is the app's primary navigation and its
 * rows carry task names, so the right column width depends on the screen someone is sitting at.
 * It lives in `localStorage` rather than in the workspace config for exactly that reason — see
 * `lib/sidebar-width.ts`.
 *
 * An inline `width` rather than a Tailwind class because the value is a number from state, and
 * the class is left off entirely below `md`, where `hidden` takes the element out of flow and the
 * drawer (a fixed 264px) is the sidebar instead.
 */
function Sidebar({ width, onWidthChange, ...props }: NavProps & SidebarResize) {
  return (
    <aside
      data-slot="sidebar"
      style={{ width }}
      className="relative hidden shrink-0 flex-col border-r border-border bg-sidebar md:flex"
    >
      <SidebarContent {...props} />
      <SidebarResizeHandle width={width} onWidthChange={onWidthChange} />
    </aside>
  )
}

type SidebarResize = {
  width: number
  onWidthChange: (width: number) => void
}

/**
 * The drag handle on the sidebar's right border (#788).
 *
 * A `separator` with `aria-orientation="vertical"` — the ARIA window-splitter pattern — which is
 * the one role that is BOTH focusable and carries a value range, so the same affordance serves a
 * pointer and a keyboard. Arrow keys step it, Home/End go to the bounds, and a double-click puts
 * it back to the default, which is the cheap way out of a width you dragged by accident.
 *
 * Pointer capture rather than window listeners: the drag must survive the pointer leaving a 5px
 * hit area (it will, immediately, on any real drag), and capture is how the browser keeps
 * delivering the moves to this element without us installing and remembering to remove global
 * handlers. `touch-none` stops a touch-drag from scrolling the page instead of resizing — the
 * handle is `md`-only, but `md` includes touch laptops and tablets.
 *
 * Rendered inside the `<aside>` and absolutely positioned over its border, so it inherits the
 * column's height without a second element having to track it.
 */
function SidebarResizeHandle({ width, onWidthChange }: SidebarResize) {
  // The width the drag started from, plus the pointer x it started at. Refs, not state: they
  // change on every pointermove and nothing renders from them.
  const origin = React.useRef<{ x: number; width: number } | null>(null)

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    // Primary button only — a right-click on the border must not start a resize.
    if (event.button !== 0) return
    origin.current = { x: event.clientX, width }
    event.currentTarget.setPointerCapture(event.pointerId)
    // Without this the drag selects the sidebar's text as it passes over it.
    event.preventDefault()
    // …but preventing the default also suppresses the focus the press would have given a
    // `tabIndex=0` element, which would leave someone who grabbed the handle with a mouse unable
    // to fine-tune with the arrow keys immediately afterwards. Focus it explicitly instead.
    event.currentTarget.focus()
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = origin.current
    if (!start) return
    onWidthChange(clampSidebarWidth(start.width + (event.clientX - start.x)))
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!origin.current) return
    origin.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const next =
      event.key === 'ArrowLeft'
        ? width - SIDEBAR_WIDTH_STEP
        : event.key === 'ArrowRight'
          ? width + SIDEBAR_WIDTH_STEP
          : event.key === 'Home'
            ? MIN_SIDEBAR_WIDTH
            : event.key === 'End'
              ? MAX_SIDEBAR_WIDTH
              : null
    if (next === null) return
    // Only for the keys we handled: Tab, Escape and the rest stay the browser's.
    event.preventDefault()
    onWidthChange(clampSidebarWidth(next))
  }

  return (
    <div
      data-slot="sidebar-resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the sidebar"
      aria-valuenow={width}
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={MAX_SIDEBAR_WIDTH}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onWidthChange(DEFAULT_SIDEBAR_WIDTH)}
      title="Drag to resize the sidebar — double-click to reset"
      // A 5px grab strip straddling the border, invisible until you reach for it. `touch-none`
      // is load-bearing rather than decorative: without it a touch drag is claimed by the
      // browser's own panning and scrolls the page instead of resizing the column.
      className="absolute inset-y-0 -right-[2px] z-20 w-[5px] cursor-col-resize touch-none bg-transparent transition-colors hover:bg-violet/40 focus-visible:bg-violet/60 focus-visible:outline-none"
    />
  )
}

/**
 * The `<md` frame for the *same* `SidebarContent` the desktop column renders — the spec's mobile
 * rule is that the sidebar "becomes an overlay drawer", not that mobile gets its own nav.
 *
 * Radix's Dialog (via the Sheet primitive) supplies the parts that are easy to get wrong by hand:
 * `role="dialog"`, the accessible name, the focus trap, the Escape handler, the backdrop's
 * dismiss-on-tap, and `aria-hidden` on everything outside the portal — which is how it delivers
 * modality (it does not set `aria-modal`; `hideOthers` is the stronger guarantee).
 */
function MobileNavDrawer({ onNavigate, ...props }: NavProps & { onNavigate: () => void }) {
  return (
    <SheetContent
      side="left"
      data-slot="mobile-nav-drawer"
      showCloseButton={false}
      // The drawer is the sidebar: same width, same surface token, and no padding of its own —
      // SidebarContent brings its own. `sm:max-w-none` sheds the primitive's sheet width cap.
      className="w-[264px] gap-0 border-border bg-sidebar p-0 sm:max-w-none md:hidden"
      // Nav needs no prose description, and Radix warns when it cannot find the one it links to.
      aria-describedby={undefined}
    >
      {/* The dialog's accessible name. Visually redundant with the brand lockup below. */}
      <SheetTitle className="sr-only">Navigation</SheetTitle>
      <SidebarContent
        {...props}
        onNavigate={onNavigate}
        headerAction={
          <SheetClose asChild>
            {/* size-11: the ≥44px touch target the spec's mobile rules require. */}
            <Button variant="ghost" size="icon" aria-label="Close menu" className="-mr-2 size-11">
              <XIcon className="size-[17px]" aria-hidden="true" />
            </Button>
          </SheetClose>
        }
      />
    </SheetContent>
  )
}

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
  version,
  latestVersion,
  taskQuickList,
  toolsMenu,
  projectGroups,
  multiProject,
  singleProject,
  projectName = null,
  projectsMenu,
  onNavigate,
  headerAction,
}: NavProps & {
  /** Fires on any in-drawer navigation. The route-change effect already closes the drawer for
   *  every *changed* route; this also covers re-clicking the active item (per the spec, Tasks
   *  navigates home even when already active), which changes no pathname at all. */
  onNavigate?: () => void
  /** The drawer's close button. Absent on desktop, which has nothing to close. */
  headerAction?: ReactNode
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
      {/* Two-line lockup (sidebar redesign): the product name on top, the motto beneath — the
          ACTIVE PROJECT moved out of here onto the project bar above the content, where it stays
          in view on every route instead of hiding in a drawer on mobile. */}
      <div className="flex items-center gap-[9px] px-3.5 pt-3.5 pb-2.5">
        <BrandTile />
        <span className="flex min-w-0 flex-col leading-tight">
          {/* The wordmark in Press Start 2P — the 80s-arcade face that matches the pixel cat.
              One step smaller than the old Inter title so its wide fixed grid doesn't stretch
              the lockup. */}
          <span className="font-['Press_Start_2P'] text-[12px] leading-[1.2]">cezar</span>
          {/* No truncate: the motto is short and fixed — clipping it to "divide et imp…" would
              undercut the whole joke. nowrap keeps it one line at every sidebar width. */}
          <span
            data-slot="brand-motto"
            className="text-[12px] whitespace-nowrap italic text-soft-foreground"
          >
            divide et impera
          </span>
        </span>
        {/* Add-project moved to the project bar, beside the repo context it actually concerns —
            next to the brand it read as part of Cezar's profile. */}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {/* Search at the sidebar's top (user decision, Replit reference) — an icon opening
              the ⌘K palette. The drawer keeps its full-width copy below md instead. */}
          <button
            type="button"
            data-slot="sidebar-search"
            title="Search — command palette (⌘K / Ctrl+K)"
            aria-label="Search"
            onClick={() => openCommandPalette()}
            className="hidden size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:flex"
          >
            <SearchIcon className="size-4" aria-hidden="true" />
          </button>
          {headerAction ? <div className="shrink-0">{headerAction}</div> : null}
        </span>
      </div>

      {/* No New-task slab here any more (user decision, Devin reference): the action is the
          small + in the Recent header — one quiet row of verbs beside the list they act on. */}


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
          {/* Multi-project, but the sidebar stays the ACTIVE project's (user decision, 25-repo
              review): only the All-tasks door is pinned above the flat column — the same band
              the groups view pins it in, so the two framings agree on where "everything" lives. */}
        {/* Devin-style order (user decision): the PLACES first (one quiet nav, no section
            label, Tasks back as a real row with its unread badge), then the WORK beneath as a
            Recent list with its own header actions. The navigate context reaches the quick-list
            rows so a same-path click still closes the mobile drawer (the route-change effect
            cannot fire without a pathname change). */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div data-slot="task-quick-list" className="px-2.5">
            <SidebarNavigateContext.Provider value={onNavigate}>
              {taskQuickList}
            </SidebarNavigateContext.Provider>
          </div>

          {/* The group divider: the work above, the places below (user decision — nav first
              read as the sidebar's subject, and it is not; the tasks are). */}
          <hr aria-hidden="true" className="mx-5 mt-2 mb-1 border-border" />

          {/* The workspace nav is the Projects SECTION (user decision): recent projects as rows,
              load-more, and the section's verbs as header icons. Git / Skills / Workflows are a
              project's and ride the app bar as tabs. */}
          <nav aria-label="Main" className="flex flex-col gap-0.5 px-2.5 pt-1 pb-2">
            {projectsMenu}
          </nav>
        </div>
        </>
      )}

      {/* Two deliberate rows, never a wrap (#702): the search bar owns line 1, the chrome controls
       *  line 2. `flex-col` rather than `flex-wrap` on purpose — the previous single wrapping row
       *  overflowed the 264px column and silently stranded the theme toggle on a line of its own,
       *  and a column cannot regress into that no matter what a future control's width is. */}
      {/* Search moved to the app bar on desktop; the drawer (no app bar below md) keeps it. */}
      <div className="px-3.5 pb-2 md:hidden">
        <CommandPaletteHint />
      </div>

      {/* The sidebar's bottom (user decision): Settings and Tools as MENU ROWS — the same row
          grammar as the nav above — pinned under the scroll column; the version and the theme
          toggle keep a slim utility line beneath them. */}
      <div
        data-slot="sidebar-footer"
        className="flex flex-col gap-0.5 border-t border-border px-2.5 pt-1.5 pb-2"
      >
    {/* Workspace LIBRARIES (Skills) as rows above Settings (user decision): the sidebar's
        top is the projects' alone; the workspace's own doors gather at the bottom. */}
        {items
          .filter((item) => item.library)
          .map((item) => {
            const isActive = item.to === activeTo
            const Icon = item.icon
            // A global row (All tasks) is never `/p/<id>`-prefixed.
            const RowLink = item.global ? RouterLink : Link
            return (
              <RowLink
                key={item.to}
                to={item.to}
                onClick={onNavigate}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'relative flex h-11 w-full items-center gap-2.5 rounded-md px-3 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:h-9',
                  isActive && 'bg-muted font-semibold text-foreground hover:bg-muted',
                )}
              >
                {isActive ? (
                  <span
                    aria-hidden="true"
                    className="absolute top-1/2 -left-2.5 -translate-y-1/2 border-y-[5px] border-l-[6px] border-y-transparent border-l-primary"
                  />
                ) : null}
                <Icon className="size-4 shrink-0" aria-hidden="true" />
                {item.label}
                {item.badge === 'skills-update' && skillsUpdateAvailable ? (
                  <span data-slot="nav-update-marker" className="ml-auto flex items-center">
                    <span className="size-1.5 rounded-full bg-violet" aria-hidden="true" />
                    <span className="sr-only">Skills update available</span>
                  </span>
                ) : null}
              </RowLink>
            )
          })}
        <RouterLink
          to="/settings/global"
          data-slot="footer-settings"
          onClick={onNavigate}
          className="flex h-11 w-full items-center gap-2.5 rounded-md px-3 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:h-9"
        >
          <SettingsIcon className="size-4 shrink-0" aria-hidden="true" />
          Settings
        </RouterLink>
        <div data-slot="tools-menu">{toolsMenu}</div>
        <div data-slot="sidebar-footer-controls" className="flex items-center gap-1.5 px-3 pt-1">
          {version ? <VersionChip version={version} latestVersion={latestVersion} /> : null}
          <ThemeToggle className="ml-auto shrink-0" />
        </div>
      </div>
    </div>
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
      // The same row grammar as the WORKSPACE nav (sidebar redesign): muted ink at rest, GRAY
      // surface on hover and when current (user decision: no white rows in the sidebar), the
      // purple edge caret marking the active page. Purple is a signal, never a surface — so
      // no tinted icon.
      className={cn(
        'relative flex h-11 w-full items-center gap-2.5 rounded-md px-3 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:h-9',
        isActive && 'bg-muted font-semibold text-foreground hover:bg-muted',
      )}
    >
      {isActive ? (
        <span
          aria-hidden="true"
          className="absolute top-1/2 -left-2.5 -translate-y-1/2 border-y-[5px] border-l-[6px] border-y-transparent border-l-primary"
        />
      ) : null}
      <LayersIcon className="size-4 shrink-0" aria-hidden="true" />
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
 * The ⌘K discoverability affordance (Step 4.3): the footer's first row, shaped like a search
 * input — magnifier, a muted `Search…` label, the chord parked on the right. It was a chip
 * cut from the version chip's cloth until #702, where the footer's five chips overflowed the
 * 264px column; giving search the whole line is what makes the remaining controls fit on one
 * row, and it reads as the launcher it is rather than as a keyboard-shortcut footnote.
 *
 * Still a button, not an input: there is no search *here*: clicking opens the palette through
 * the same programmatic seam anything else would, and the palette owns the real input.
 *
 * No `aria-label`: the visible `Search…` already names it, and an override that merely drops
 * the ellipsis would make the accessible name diverge from the label a speech user reads
 * aloud (WCAG 2.5.3). The chord rides `commandShortcutHint` so the kbd shows Ctrl+K off Apple
 * hardware, per the spec's platform-symbol rule.
 */
function CommandPaletteHint() {
  return (
    // A BUTTON that looks like one (user feedback): the input costume promised in-place typing,
    // but the control opens the ⌘K palette — so it dresses like its neighbours (Settings, Tools).
    <button
      type="button"
      data-slot="command-palette-hint"
      title="Search — command palette (⌘K / Ctrl+K)"
      onClick={() => openCommandPalette()}
      className="flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:w-auto"
    >
      <SearchIcon className="size-3.5 shrink-0" aria-hidden="true" />
      Search
      <kbd
        aria-hidden="true"
        className="ml-auto shrink-0 rounded-[5px] border border-b-2 border-border bg-card px-[5px] py-px font-mono text-[10.5px] font-medium text-muted-foreground md:ml-0.5"
      >
        {commandShortcutHint('k')}
      </kbd>
    </button>
  )
}

/**
 * The footer's `v{version}` label. Plain quiet text — a border made it read as a button that
 * goes nowhere. When the server's npm-registry check found something newer (`latestVersion`,
 * #368) the label turns violet and the tooltip names the version — an affordance, not an alert:
 * updating is optional, so the chrome stays quiet.
 *
 * The label is the controls row's ONE elastic item, and that is load-bearing (#876): every other
 * control there is `shrink-0`, so a nightly dist-tag version (~173px of it) used to shove the
 * neighbouring controls clean outside the sidebar. Truncating from the tail keeps the half that
 * carries meaning, the semver, and the `title` keeps the whole string — which is why the tooltip
 * is there even with no update to announce.
 */
function VersionChip({ version, latestVersion }: { version: string; latestVersion: string | null }) {
  const updateAvailable = Boolean(latestVersion && latestVersion !== version)
  return (
    <span
      data-slot="version-chip"
      data-update-available={updateAvailable ? 'true' : undefined}
      title={updateAvailable ? `v${version} (update available: v${latestVersion})` : `v${version}`}
      className={cn(
        'min-w-0 truncate font-mono text-[10.5px] font-medium',
        updateAvailable ? 'text-violet' : 'text-soft-foreground',
      )}
    >
      v{version}
    </span>
  )
}

/** The Open Mercato brand mark. The SVG carries its own gradient and rounded corners, so it is
 *  the tile — no wrapper background. */
function BrandTile() {
  return (
    // No plate: the artwork carries its own gradient tile and rounded corners. The rounded-md
    // clip only backstops the SVG's own radius at this size.
    <img
      src={brandLogoUrl}
      alt=""
      aria-hidden="true"
      data-slot="brand-tile"
      className="size-9 shrink-0 rounded-md object-contain"
    />
  )
}

/**
 * The desktop project bar (sidebar redesign): a slim breadcrumb strip above the content naming
 * the ACTIVE project — always in view on every route, which is what a workspace identity needs
 * and what the sidebar lockup (now brand + motto) could not give it on mobile. Shares grid row 1
 * with the mobile top bar; the two are breakpoint-exclusive.
 */
function ProjectBar({
  name,
  crumb,
  projectSwitcher,
}: {
  name: string | null
  /** What the page is about, after the project: the open task's title, or the view's name. */
  crumb?: string | null
  projectSwitcher?: ReactNode
}) {
  if (!name && !projectSwitcher && !crumb) return null
  return (
    <div
      data-slot="project-bar"
      // Identity on the LEFT (where a breadcrumb reads) — the registry-backed switcher when the
      // container provides one, the static chip otherwise — with add-project right beside it;
      // utilities — Settings, Tools, theme — on the right.
      className="row-start-1 hidden h-11 items-center gap-2.5 border-b border-border bg-background px-4 md:flex"
    >
      {projectSwitcher ??
        (name ? (
          <span className="flex min-w-0 items-center gap-2">
            <FolderOpenIcon aria-hidden="true" className="size-3.5 shrink-0 text-soft-foreground" />
            <span data-slot="repo-chip" className="truncate font-mono text-[12px] font-medium text-muted-foreground">
              {name}
            </span>
          </span>
        ) : null)}
      {/* The breadcrumb's second step (user decision: "project and task, here"): the open
          task's title, or the view's name. Quiet, truncating, never a link — the page IS it. */}
      {crumb ? (
        <span className="flex min-w-0 items-center gap-2 text-[12.5px]">
          {/* The chevron separates a crumb FROM a project; with no project on the bar (the
              workspace-wide Tasks page) the crumb stands alone. */}
          {projectSwitcher || name ? (
            <ChevronRightIcon aria-hidden="true" className="size-3.5 shrink-0 text-soft-foreground" />
          ) : null}
          <span data-slot="project-bar-crumb" className="truncate font-medium text-foreground" title={crumb}>
            {crumb}
          </span>
        </span>
      ) : null}
      {/* The bar's right side hosts the OPEN PAGE's actions (user decision): a page with verbs
          on its whole subject — today the task thread — portals its buttons here, where they
          stay in view on every tab. No workspace utilities: those live in the sidebar. */}
      <span data-slot="bar-actions" className="ml-auto flex min-w-0 shrink-0 items-center gap-2.5" />
    </div>
  )
}

/** Mobile chrome (<md): the sidebar's replacement. Its menu button opens `MobileNavDrawer`. */
function MobileTopBar({ title }: { title: string }) {
  return (
    <header
      data-slot="mobile-top-bar"
      className="row-start-1 border-b border-border bg-card pt-[env(safe-area-inset-top)] md:hidden"
    >
      <div className="flex h-[52px] items-center gap-2.5 px-3">
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
