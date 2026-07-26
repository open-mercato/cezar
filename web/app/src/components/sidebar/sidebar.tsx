import {
  FolderIcon,
  FolderOpenIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PlusIcon,
  SettingsIcon,
} from 'lucide-react'
import * as React from 'react'
import type { ReactNode } from 'react'
import { Link as RouterLink } from 'react-router'

import { AddProjectDialog } from '@/components/add-project-dialog'
import { CloneProjectDialog } from '@/components/clone-project-dialog'
import { GithubIcon } from '@/components/icons'
import type { NavItem } from '@/components/nav-items'
import { NavRow, UpdateDot } from '@/components/sidebar/nav-row'
import { useSidebarCollapsed } from '@/components/sidebar/sidebar-state'
import { ThemeToggle } from '@/components/theme-toggle'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'
// The Open Mercato brand mark (web/open-mercato.svg), bundled by Vite so it resolves in both
// the dev server and the built cockpit. Its own gradient + rounded corners ARE the tile.
import brandLogoUrl from '../../../../open-mercato.svg'

export type RepoChip = {
  name: string
  branch: string
}

export type SidebarProps = {
  activeTo: string | null
  items: NavItem[]
  repo: RepoChip | null
  inboxCount: number | null
  skillsUpdateAvailable: boolean
  taskQuickList?: ReactNode
  toolsMenu?: ReactNode
  projectGroups?: ReactNode
  singleProject: boolean
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
 * The desktop frame, from `md` up: a fixed `--sidebar-width` column that the header toggle
 * collapses to a 64px icon rail. The preference persists per browser (`useSidebarCollapsed`);
 * the `<md` drawer ignores it — an overlay has no width to save.
 */
export function Sidebar(props: SidebarProps) {
  const [collapsed, toggleCollapsed] = useSidebarCollapsed()
  return (
    <aside
      data-slot="sidebar"
      data-collapsed={collapsed ? '' : undefined}
      className={cn(
        'hidden shrink-0 flex-col border-r border-border bg-sidebar transition-[width] duration-200 md:flex',
        collapsed ? 'w-16' : 'w-(--sidebar-width)'
      )}
    >
      <TooltipProvider delayDuration={350}>
        <SidebarContent {...props} collapsed={collapsed} onToggle={toggleCollapsed} />
      </TooltipProvider>
    </aside>
  )
}

/**
 * Everything inside the sidebar, in both framings: the desktop column (which may be collapsed
 * to the icon rail) and the `<md` overlay drawer (always expanded — the spec's mobile rule is
 * that the sidebar "becomes an overlay drawer", not that mobile gets its own nav). Each section
 * below renders both densities itself, so the rail can never drift out of sync with the column.
 */
export function SidebarContent({
  activeTo,
  items,
  repo,
  inboxCount,
  skillsUpdateAvailable,
  taskQuickList,
  toolsMenu,
  projectGroups,
  singleProject,
  collapsed = false,
  onToggle,
  onNavigate,
  headerAction,
}: SidebarProps & {
  /** Icon-rail mode. Only the desktop frame ever sets it. */
  collapsed?: boolean
  /** The desktop collapse/expand control. Absent in the drawer, which closes instead. */
  onToggle?: () => void
  /** Fires on any in-drawer navigation — see `SidebarNavigateContext`. */
  onNavigate?: () => void
  /** The drawer's close button. Absent on desktop. */
  headerAction?: ReactNode
}) {
  return (
    <div
      data-slot="sidebar-content"
      className="flex min-h-0 flex-1 flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
    >
      <SidebarHeader
        repo={repo}
        showRepoChip={!projectGroups}
        collapsed={collapsed}
        onToggle={onToggle}
        headerAction={headerAction}
      />
      <SidebarCta collapsed={collapsed} singleProject={singleProject} onNavigate={onNavigate} />

      {collapsed ? (
        <>
          <SidebarRailNav
            items={items}
            activeTo={activeTo}
            inboxCount={inboxCount}
            skillsUpdateAvailable={skillsUpdateAvailable}
            onNavigate={onNavigate}
          />
          <div className="min-h-0 flex-1" />
        </>
      ) : (
        <SidebarBody
          items={items}
          activeTo={activeTo}
          inboxCount={inboxCount}
          skillsUpdateAvailable={skillsUpdateAvailable}
          taskQuickList={taskQuickList}
          projectGroups={projectGroups}
          onNavigate={onNavigate}
        />
      )}

      <SidebarFooter collapsed={collapsed} toolsMenu={toolsMenu} onNavigate={onNavigate} />
    </div>
  )
}

/** Brand lockup + repo chip + the desktop toggle (or the drawer's close button). */
function SidebarHeader({
  repo,
  showRepoChip,
  collapsed,
  onToggle,
  headerAction,
}: {
  repo: RepoChip | null
  /** With project groups mounted the boot repo/branch is one group header among many — a chip
   *  repeating it up here would just be the first group's header said twice. */
  showRepoChip: boolean
  collapsed: boolean
  onToggle?: () => void
  headerAction?: ReactNode
}) {
  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1.5 pt-3.5 pb-1">
        <BrandTile />
        {onToggle ? <SidebarToggle collapsed onToggle={onToggle} /> : null}
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2 px-3.5 pt-3.5 pb-2.5">
      <BrandTile />
      <span className="text-base font-semibold">cezar</span>
      {repo && showRepoChip ? (
        <span
          data-slot="repo-chip"
          className="min-w-0 flex-1 truncate text-right font-mono text-2xs font-medium text-muted-foreground"
        >
          {repo.name} / {repo.branch}
        </span>
      ) : (
        <span className="flex-1" aria-hidden="true" />
      )}
      {onToggle ? <SidebarToggle collapsed={false} onToggle={onToggle} /> : null}
      {headerAction ? <div className="shrink-0">{headerAction}</div> : null}
    </div>
  )
}

function SidebarToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const Icon = collapsed ? PanelLeftOpenIcon : PanelLeftCloseIcon
  const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar'
  return (
    <Button
      variant="ghost"
      size="icon"
      data-slot="sidebar-toggle"
      aria-label={label}
      aria-expanded={!collapsed}
      title={label}
      onClick={onToggle}
      className="size-7 shrink-0 text-muted-foreground"
    >
      <Icon className="size-4" aria-hidden="true" />
    </Button>
  )
}

/** The New task CTA + Add project menu, in both densities. */
function SidebarCta({
  collapsed,
  singleProject,
  onNavigate,
}: {
  collapsed: boolean
  singleProject: boolean
  onNavigate?: () => void
}) {
  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1.5 pt-1 pb-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button asChild size="icon">
              <Link to="/new" aria-label="New task" onClick={onNavigate}>
                <PlusIcon aria-hidden="true" />
              </Link>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">New task</TooltipContent>
        </Tooltip>
        {singleProject ? null : <AddProjectMenu collapsed />}
      </div>
    )
  }
  return (
    <div className="flex gap-1.5 px-2.5 pt-1 pb-2">
      <Button asChild className="min-w-0 flex-1 justify-center">
        {/* A Router Link since R4 Step 1.1: the React /new composer is real, so deliberate
            New task affordances stay inside the SPA. Full document loads of /new (the
            bookmarklet contract) land on the shell like any route (static-ui.ts). */}
        <Link to="/new" onClick={onNavigate}>
          <PlusIcon aria-hidden="true" />
          New task
        </Link>
      </Button>
      {singleProject ? null : <AddProjectMenu />}
    </div>
  )
}

/** The expanded middle: flat nav + quick-list, or the multi-project groups replacing both. */
function SidebarBody({
  items,
  activeTo,
  inboxCount,
  skillsUpdateAvailable,
  taskQuickList,
  projectGroups,
  onNavigate,
}: {
  items: NavItem[]
  activeTo: string | null
  inboxCount: number | null
  skillsUpdateAvailable: boolean
  taskQuickList?: ReactNode
  projectGroups?: ReactNode
  onNavigate?: () => void
}) {
  if (projectGroups) {
    return (
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
    )
  }
  return (
    <>
      <nav aria-label="Main" className="px-2.5 py-1.5">
        {items.map((item) => (
          <NavRow
            key={item.to}
            item={item}
            isActive={item.to === activeTo}
            badge={item.badge === 'inbox-count' ? inboxCount : null}
            updateDot={item.badge === 'skills-update' && skillsUpdateAvailable}
            onNavigate={onNavigate}
          />
        ))}
      </nav>

      {/* The single-project quick-list (Needs you / Working / Recent). */}
      <div
        data-slot="task-quick-list"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2.5 pb-2"
      >
        {taskQuickList}
      </div>
    </>
  )
}

/** The icon rail's nav: same items, icon-only rows with a tooltip carrying the label. Badges
 *  compress to a corner dot; the count moves into the accessible name and the tooltip. */
function SidebarRailNav({
  items,
  activeTo,
  inboxCount,
  skillsUpdateAvailable,
  onNavigate,
}: {
  items: NavItem[]
  activeTo: string | null
  inboxCount: number | null
  skillsUpdateAvailable: boolean
  onNavigate?: () => void
}) {
  return (
    <nav aria-label="Main" className="flex flex-col items-center gap-1 py-1.5">
      {items.map((item) => {
        const isActive = item.to === activeTo
        const Icon = item.icon
        const badged =
          (item.badge === 'inbox-count' && Boolean(inboxCount)) ||
          (item.badge === 'skills-update' && skillsUpdateAvailable)
        const label =
          item.badge === 'inbox-count' && inboxCount ? `${item.label} (${inboxCount})` : item.label
        return (
          <Tooltip key={item.to}>
            <TooltipTrigger asChild>
              <Link
                to={item.to}
                onClick={onNavigate}
                aria-current={isActive ? 'page' : undefined}
                aria-label={label}
                className={cn(
                  'relative flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset',
                  isActive && 'bg-muted text-foreground'
                )}
              >
                <Icon className="size-4" aria-hidden="true" />
                {badged ? (
                  <UpdateDot data-slot="nav-badge-dot" className="absolute top-1 right-1" />
                ) : null}
              </Link>
            </TooltipTrigger>
            <TooltipContent side="right">{label}</TooltipContent>
          </Tooltip>
        )
      })}
    </nav>
  )
}

/** Exactly three footer items: Tools / settings / theme. The rail keeps the two icon controls. */
function SidebarFooter({
  collapsed,
  toolsMenu,
  onNavigate,
}: {
  collapsed: boolean
  toolsMenu?: ReactNode
  onNavigate?: () => void
}) {
  if (collapsed) {
    return (
      <div
        data-slot="sidebar-footer"
        className="flex flex-col items-center gap-1 border-t border-border py-2.5"
      >
        <GlobalSettingsLink onNavigate={onNavigate} />
        <ThemeToggle className="size-7" />
      </div>
    )
  }
  return (
    <div
      data-slot="sidebar-footer"
      className="flex items-center gap-2 border-t border-border px-3.5 py-2.5"
    >
      {/* SLOT — Step 4.2 mounts the Tools dropdown (aggregate status dot + tool versions) here. */}
      <div data-slot="tools-menu">{toolsMenu}</div>
      <GlobalSettingsLink onNavigate={onNavigate} className="ml-auto" />
      <ThemeToggle className="size-7" />
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
function AddProjectMenu({ collapsed = false }: { collapsed?: boolean }) {
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
          className={cn('shrink-0', collapsed ? 'size-9' : 'size-11 md:size-9')}
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
