import { MenuIcon, XIcon } from 'lucide-react'
import * as React from 'react'
import type { ReactNode } from 'react'
import { useLocation } from 'react-router'

import { activeNavItem, activeNavPath, visibleNavItems } from '@/components/nav-items'
import {
  Sidebar,
  SidebarContent,
  type RepoChip,
  type SidebarProps,
} from '@/components/sidebar/sidebar'
import { Button } from '@/components/ui/button'
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { stripProjectPrefix } from '@/lib/project-router'

export { useSidebarNavigate } from '@/components/sidebar/sidebar'
export type { RepoChip }

/** Tailwind's `md`. The drawer is the `<md` affordance, so this must stay in step with the
 *  `md:hidden` / `md:flex` classes below — they are the same breakpoint expressed twice, once
 *  for CSS and once for the state machine. */
const DESKTOP_MEDIA_QUERY = '(min-width: 768px)'

export type AppShellProps = {
  /** The routed view. Renders into the one scrolling region. */
  children: ReactNode
  /** Repo + branch for the brand chip. Null until Step 3.1/3.2 wires `/api/health` — the chip
   *  is simply absent rather than showing an invented repo name. */
  repo?: RepoChip | null
  /** Inbox badge count. Null/0 renders no badge. Step 3.2 feeds it from the SSE stream. */
  inboxCount?: number | null
  /** A quiet, accessible marker on Skills when a checked update remains actionable. */
  skillsUpdateAvailable?: boolean
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
  /** Single-project capability gating: hides workspace-expansion affordances. Defaults off so
   *  standalone and older callers preserve the multi-project shell. */
  singleProject?: boolean
  /** Global chrome banner, rendered in its own row above the scroller. Absent renders nothing. */
  banner?: ReactNode
  /** Step 3.3's multi-project sidebar: one collapsible group per registered project, each
   *  carrying its own nav + task list. When present it REPLACES the flat nav and the
   *  `taskQuickList` slot (each group brings its own copies of both); absent — the registry
   *  still loading, or unreachable — the shell renders the single-project sidebar it always
   *  did, which is the honest degradation, not a special case. */
  projectGroups?: ReactNode
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
  skillsUpdateAvailable = false,
  taskQuickList,
  toolsMenu,
  forgeAvailable = true,
  inboxAvailable = true,
  singleProject = false,
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

  const nav: SidebarProps = {
    activeTo,
    items: visibleNavItems({ forge: forgeAvailable, inbox: inboxAvailable }),
    repo,
    // The badge belongs to the Inbox item — with the item gone there is nothing to badge.
    inboxCount: inboxAvailable ? inboxCount : null,
    skillsUpdateAvailable,
    taskQuickList,
    toolsMenu,
    projectGroups,
    singleProject,
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

/**
 * The `<md` frame for the *same* `SidebarContent` the desktop column renders — the spec's mobile
 * rule is that the sidebar "becomes an overlay drawer", not that mobile gets its own nav.
 *
 * The Dialog-based Sheet primitive supplies the parts that are easy to get wrong by hand:
 * `role="dialog"`, the accessible name, the focus trap, the Escape handler, the backdrop's
 * dismiss-on-tap, and `aria-hidden` on everything outside the portal — which is how it delivers
 * modality (it does not set `aria-modal`; `hideOthers` is the stronger guarantee).
 */
function MobileNavDrawer({ onNavigate, ...props }: SidebarProps & { onNavigate: () => void }) {
  return (
    <SheetContent
      side="left"
      data-slot="mobile-nav-drawer"
      showCloseButton={false}
      // The drawer is the sidebar: same width, same surface token, and no padding of its own —
      // SidebarContent brings its own. `sm:max-w-none` sheds the primitive's sheet width cap.
      className="w-(--sidebar-width) gap-0 border-border bg-sidebar p-0 sm:max-w-none md:hidden"
      // Nav needs no prose description, and the primitive warns when it cannot find the one it
      // links to.
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
              <XIcon className="size-4" aria-hidden="true" />
            </Button>
          </SheetClose>
        }
      />
    </SheetContent>
  )
}

/** Mobile chrome (<md): the sidebar's replacement. Its menu button opens `MobileNavDrawer`. */
function MobileTopBar({ title }: { title: string }) {
  return (
    <header
      data-slot="mobile-top-bar"
      className="row-start-1 border-b border-border bg-card pt-[env(safe-area-inset-top)] md:hidden"
    >
      <div className="flex h-13 items-center gap-2.5 px-3">
        {/* A real SheetTrigger rather than an onClick that flips our state: it is what registers
            the button as the dialog's trigger, which is what the primitive restores focus to on
            close — with a bare onClick, closing the drawer drops focus on <body>. It also carries
            the aria-haspopup / aria-expanded / aria-controls wiring for free. */}
        <SheetTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open menu"
            // 44px: the minimum touch target, overriding the 36px desktop icon-button size.
            className="-ml-1.5 size-11"
          >
            <MenuIcon className="size-4" aria-hidden="true" />
          </Button>
        </SheetTrigger>
        <span className="truncate text-base font-semibold">{title}</span>
        {/* SLOT — the run status dot / kebab land with the thread view (Step R3). */}
        <div data-slot="mobile-status" className="ml-auto flex items-center gap-2" />
      </div>
    </header>
  )
}
