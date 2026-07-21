import {
  FolderIcon,
  FolderOpenIcon,
  MenuIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  XIcon,
} from 'lucide-react'
import * as React from 'react'
import type { ReactNode } from 'react'
import { Link as RouterLink, useLocation } from 'react-router'

import { AddProjectDialog } from '@/components/add-project-dialog'
import { CloneProjectDialog } from '@/components/clone-project-dialog'
import { openCommandPalette } from '@/components/command-palette'
import { GithubIcon } from '@/components/icons'
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
import { cn } from '@/lib/utils'
// The Open Mercato brand mark (web/open-mercato.svg), bundled by Vite so it resolves in both
// the dev server and the built cockpit. Its own gradient + rounded corners ARE the tile.
import brandLogoUrl from '../../../open-mercato.svg'

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
  version = null,
  latestVersion = null,
  taskQuickList,
  toolsMenu,
  forgeAvailable = true,
  inboxAvailable = true,
  banner,
  projectGroups,
}: AppShellProps) {
  const { pathname } = useLocation()
  // The nav's area rules reason about the flat route map — strip any `/p/:projectId` prefix
  // (multi-project spec, step 3.2) so `/p/cezar/git/commits` still lights Git.
  const areaPathname = stripProjectPrefix(pathname)
  const activeTo = activeNavPath(areaPathname)
  const current = activeNavItem(areaPathname)
  const [menuOpen, setMenuOpen] = React.useState(false)
  const mainRef = React.useRef<HTMLElement>(null)

  // The scroller PERSISTS across routes (it is the shell's, not the view's), so without this
  // a deep scroll on one page carries into the next — most visibly on mobile, where Tasks or
  // GitHub opened mid-list. Layout effect: the reset lands before the new view paints. Routes
  // that own their arrival position (the task thread's cached-restore / stick-to-bottom) set
  // it later, in their own effects once their content ref lands, so they still win.
  React.useLayoutEffect(() => {
    const main = mainRef.current
    if (main) main.scrollTop = 0
  }, [pathname])

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
    items: visibleNavItems({ forge: forgeAvailable, inbox: inboxAvailable }),
    repo,
    // The badge belongs to the Inbox item — with the item gone there is nothing to badge.
    inboxCount: inboxAvailable ? inboxCount : null,
    version,
    latestVersion,
    taskQuickList,
    toolsMenu,
    projectGroups,
  }

  return (
    // The Sheet root renders no DOM of its own — it is the context that lets the top bar's menu
    // button be a real SheetTrigger while the open state stays ours to close on navigation.
    <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
      <div
        data-slot="app-shell"
        className="flex h-dvh overflow-hidden bg-background text-foreground pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
      >
        <Sidebar {...nav} />
        <MobileNavDrawer {...nav} onNavigate={() => setMenuOpen(false)} />

        <div className="grid min-w-0 flex-1 grid-rows-[auto_auto_1fr_auto] overflow-hidden">
          <MobileTopBar title={current?.label ?? 'cezar'} />

          {banner ? (
            <div data-slot="banner-slot" className="row-start-2">
              {banner}
            </div>
          ) : null}

          <main
            ref={mainRef}
            data-slot="main"
            className="row-start-3 min-h-0 overflow-y-auto overscroll-contain"
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
  version: string | null
  latestVersion: string | null
  taskQuickList?: ReactNode
  toolsMenu?: ReactNode
  projectGroups?: ReactNode
}

/** The desktop frame: a fixed 264px column, from `md` up. */
function Sidebar(props: NavProps) {
  return (
    <aside
      data-slot="sidebar"
      className="hidden w-[264px] shrink-0 flex-col border-r border-border bg-sidebar md:flex"
    >
      <SidebarContent {...props} />
    </aside>
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
  version,
  latestVersion,
  taskQuickList,
  toolsMenu,
  projectGroups,
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
      className="flex min-h-0 flex-1 flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
    >
      <div className="flex items-center gap-[9px] px-3.5 pt-3.5 pb-2.5">
        <BrandTile />
        <span className="text-[15px] font-semibold">cezar</span>
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
        <AddProjectMenu />
      </div>

      {projectGroups ? (
        // Step 3.3: one collapsible group per registered project — nav + task list per group.
        // The whole area scrolls as one (per the sidebar mockup); collapsed groups are one row.
        <div
          data-slot="project-groups"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-2"
        >
          <SidebarNavigateContext.Provider value={onNavigate}>
            {projectGroups}
          </SidebarNavigateContext.Provider>
        </div>
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
                  {item.badge && inboxCount ? (
                    <span
                      data-slot="nav-badge"
                      className="ml-auto rounded-full bg-violet px-1.5 py-px text-[10.5px] font-semibold text-violet-foreground"
                    >
                      {inboxCount}
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

      <div
        data-slot="sidebar-footer"
        className="flex flex-wrap items-center gap-2 gap-y-1.5 border-t border-border px-3.5 py-2.5"
      >
        {/* SLOT — Step 4.2 mounts the Tools dropdown (aggregate status dot + tool versions) here. */}
        <div data-slot="tools-menu">{toolsMenu}</div>
        {version ? <VersionChip version={version} latestVersion={latestVersion} /> : null}
        <CommandPaletteHint />
        <GlobalSettingsLink onNavigate={onNavigate} className="ml-auto" />
        <ThemeToggle />
      </div>
    </div>
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
 * the checkout dialog (step 4.3).
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
        <DropdownMenuItem data-slot="add-project-local" onSelect={() => setBrowsing(true)}>
          <FolderIcon aria-hidden="true" />
          Open local folder…
        </DropdownMenuItem>
        <DropdownMenuItem data-slot="add-project-clone" onSelect={() => setCloning(true)}>
          <GithubIcon aria-hidden="true" />
          Clone from GitHub…
        </DropdownMenuItem>
      </DropdownMenuContent>
      {browsing ? <AddProjectDialog open onOpenChange={setBrowsing} /> : null}
      {cloning ? <CloneProjectDialog open onOpenChange={setCloning} /> : null}
    </DropdownMenu>
  )
}

/**
 * The ⌘K discoverability affordance (Step 4.3): a quiet chip-shaped button in the footer, cut
 * from the same cloth as the version chip — the palette is chrome, not a feature to shout
 * about. Clicking it opens the palette through the same programmatic seam anything else would.
 */
function CommandPaletteHint() {
  return (
    <button
      type="button"
      data-slot="command-palette-hint"
      title="Command palette (⌘K / Ctrl+K)"
      aria-label="Open the command palette"
      onClick={() => openCommandPalette()}
      className="flex items-center gap-1 rounded-full border border-border px-1.5 py-px font-mono text-[10px] font-medium text-soft-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <SearchIcon className="size-[9px]" aria-hidden="true" />
      ⌘K
    </button>
  )
}

/**
 * The footer's `v{version}` chip. When the server's npm-registry check found something newer
 * (`latestVersion`, #368), the chip grows a pulsing pending-tone dot and names the version in
 * its tooltip — an affordance, not an alert: updating is optional, so the chrome stays quiet.
 */
function VersionChip({ version, latestVersion }: { version: string; latestVersion: string | null }) {
  const updateAvailable = Boolean(latestVersion && latestVersion !== version)
  return (
    <span
      data-slot="version-chip"
      data-update-available={updateAvailable ? 'true' : undefined}
      title={updateAvailable ? `update available: v${latestVersion}` : undefined}
      className="flex items-center gap-1 rounded-full border border-border px-1.5 py-px font-mono text-[10px] font-medium text-soft-foreground"
    >
      {updateAvailable ? <StatusDot tone="pending" pulse className="size-[5px]" /> : null}
      v{version}
    </span>
  )
}

/** The Open Mercato brand mark. The SVG carries its own gradient and rounded corners, so it is
 *  the tile — no wrapper background. */
function BrandTile() {
  return (
    <img
      src={brandLogoUrl}
      alt=""
      aria-hidden="true"
      data-slot="brand-tile"
      className="size-[26px] shrink-0 rounded-sm"
    />
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
