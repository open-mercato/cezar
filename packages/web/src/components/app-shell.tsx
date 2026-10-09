import {
  ArrowUpCircleIcon,
  CheckIcon,
  ChevronsUpDownIcon,
  FolderGit2Icon,
  FolderIcon,
  LayersIcon,
  LayoutDashboardIcon,
  MonitorIcon,
  MoonIcon,
  PlusIcon,
  SearchIcon,
  Settings2Icon,
  SettingsIcon,
  StarIcon,
  SunIcon,
} from 'lucide-react'
import * as React from 'react'
import type { ReactNode } from 'react'
import { Link as RouterLink, matchPath, useLocation, useNavigate } from 'react-router'

import type { ProjectListEntry, TrackerKind } from '@open-mercato/cezar-api-client'
import { AddProjectDialog } from '@/components/add-project-dialog'
import { BrandMark } from '@/components/brand-mark'
import { ContextSidebarContext } from '@/components/context-sidebar'
import { useGlobalSettings } from '@/components/global-settings'
import { CloneProjectDialog } from '@/components/clone-project-dialog'
import { openCommandPalette } from '@/components/command-palette'
import { GithubIcon } from '@/components/icons'
import { activeNavPath, visibleNavItems, type NavItem } from '@/components/nav-items'
import { SelfUpdateDialog } from '@/components/self-update-dialog'
import { StatusDot } from '@/components/status-dot'
import { useTheme } from '@/components/theme-provider'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Kbd } from '@/components/ui/kbd'
import { Separator } from '@/components/ui/separator'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar'
import { Link, scopeTo, stripProjectPrefix } from '@/lib/project-router'
import { CEZAR_REPO_URL, formatStarCount } from '@/lib/star-promo'
import type { Theme } from '@/lib/theme'
import { commandShortcutHint } from '@/lib/use-command-shortcut'
import { cn } from '@/lib/utils'

export type RepoChip = {
  name: string
  branch: string
}

/** One step of the top bar's trail. A crumb without `to` is the page you are on. */
export type Crumb = {
  label: string
  /** An absolute cockpit path (`/p/<id>/`, `/tasks`). Never scoped again by the shell. */
  to?: string
}

export type AppShellProps = {
  /** The routed view. Renders into the one scrolling region. */
  children: ReactNode
  /** Repo + branch of the boot checkout — the switcher's fallback when the registry is silent. */
  repo?: RepoChip | null
  /** Every registered project, already in the user's order. Empty while the registry loads. */
  projects?: readonly ProjectListEntry[]
  /** The project the URL names; null on the pages that belong to none (Dashboard, All tasks). */
  activeProjectId?: string | null
  /** The project a flat URL resolves to — what the project nav falls back to on a global page. */
  bootProjectId?: string | null
  /** The top bar's trail, built by the container from the route. */
  crumbs?: readonly Crumb[]
  inboxCount?: number | null
  unreadCount?: number | null
  skillsUpdateAvailable?: boolean
  version?: string | null
  latestVersion?: string | null
  /** cezar's own GitHub star count; `null` renders no ask at all. */
  starCount?: number | null
  /** The active project's task list (Needs you / Working / Recent). */
  taskQuickList?: ReactNode
  /** The machine glance (CPU / RAM), shown above the footer menu while the sidebar is open. */
  hostWidget?: ReactNode
  /** The tools status menu, mounted in the top bar. */
  toolsMenu?: ReactNode
  forgeAvailable?: boolean
  inboxAvailable?: boolean
  automationsAvailable?: boolean
  tracker?: TrackerKind
  /** Single-project capability gating: hides the workspace-expansion affordances. */
  singleProject?: boolean
  /** Global chrome banner, in its own row between the top bar and the scroller. */
  banner?: ReactNode
  brandName?: string
  brandLogoUrl?: string | null
}

/**
 * Closes the mobile sheet. Published to whatever renders inside the sidebar's slots so a link to
 * the CURRENT route — which changes no pathname, and so never trips the route-change effect —
 * still dismisses the sheet. Undefined on desktop, where there is nothing to close.
 */
const SidebarNavigateContext = React.createContext<(() => void) | undefined>(undefined)

export function useSidebarNavigate(): (() => void) | undefined {
  return React.useContext(SidebarNavigateContext)
}

/** The main transcript owns cached/tail arrival; every other routed surface uses shell-top. */
export function routeOwnsScrollArrival(pathname: string): boolean {
  return matchPath({ path: '/tasks/:id', end: true }, stripProjectPrefix(pathname)) !== null
}

const SIDEBAR_OPEN_KEY = 'cez-context-sidebar-open'

function readSidebarOpen(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_OPEN_KEY) !== 'false'
  } catch {
    return true
  }
}

const NOOP = () => {}

/**
 * The cockpit's app shell: an icon rail on the canvas, and one rounded panel beside it.
 *
 *  - The RAIL is the app's navigation — which project, which area, the cockpit's own menu. It
 *    is always there and never grows: icons with tooltips, built from the shadcn sidebar parts.
 *  - The PANEL holds everything about the area you picked: a collapsible CONTEXTUAL sidebar
 *    (filled by the screen through `<ContextSidebar>` — the task list, the file tree, the pull
 *    requests, the settings sections), a top bar with the breadcrumb, and the one scroller.
 *
 * Two nested `SidebarProvider`s on purpose. The outer one only gives the rail's buttons their
 * context (held "collapsed" so their tooltips show); the inner one owns the contextual sidebar's
 * open state, its ⌘B shortcut and its mobile sheet. Below `md` the rail is gone and the sheet
 * carries the area list above whatever the screen put in it.
 *
 * Only the scroller scrolls, and it keeps `data-slot="main"`, which the thread, the diff views
 * and the commit list all resolve their scroll owner through.
 */
export const AppShell = React.memo(function AppShell({ children, banner, ...props }: AppShellProps) {
  const [open, setOpen] = React.useState(readSidebarOpen)
  const onOpenChange = React.useCallback((next: boolean) => {
    setOpen(next)
    try {
      window.localStorage.setItem(SIDEBAR_OPEN_KEY, String(next))
    } catch {
      // A browser that refuses storage still gets a sidebar; it just forgets the answer.
    }
  }, [])
  const desktop = useDesktopShell()

  // The contextual sidebar's portal target, and how many screens are currently filling it.
  const [node, setNode] = React.useState<HTMLElement | null>(null)
  const [fillers, setFillers] = React.useState(0)
  const register = React.useCallback(() => {
    setFillers((count) => count + 1)
    return () => setFillers((count) => count - 1)
  }, [])
  const contextSidebar = React.useMemo(() => ({ node, register }), [node, register])
  const hasContext = fillers > 0

  return (
    <SidebarProvider
      data-slot="app-shell"
      data-desktop={desktop ?? undefined}
      open={false}
      onOpenChange={NOOP}
      className={cn(
        'h-dvh min-h-0 overflow-hidden bg-sidebar pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]',
        desktop === 'macos' && 'pt-[28px]',
      )}
    >
      {desktop === 'macos' ? (
        <div
          data-slot="desktop-titlebar"
          data-tauri-drag-region=""
          className="fixed inset-x-0 top-0 z-[60] flex h-[28px] select-none items-center pl-[80px]"
        />
      ) : null}
      <AppRail {...props} />
      <div
        data-slot="panel"
        className="relative m-0 flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background md:my-2 md:mr-2 md:rounded-xl md:border md:border-border/70 md:shadow-xs"
      >
        <SidebarProvider
          open={open && hasContext}
          onOpenChange={onOpenChange}
          className="relative h-full min-h-0"
          style={{ '--sidebar-width': '18rem' } as React.CSSProperties}
        >
          <ContextSidebarContext.Provider value={contextSidebar}>
            <Sidebar
              collapsible="offcanvas"
              data-slot="context-sidebar"
              // Inside the panel, not pinned to the window: the stock container is `fixed` and
              // viewport-tall, so both are overridden and the panel's own clipping hides it when
              // it slides out.
              className="absolute h-full border-r border-border/70 [--sidebar:color-mix(in_oklab,var(--background)_55%,var(--muted))]"
            >
              <MobileAreas {...props} />
              <div ref={setNode} data-slot="context-sidebar-body" className="flex min-h-0 flex-1 flex-col" />
              {hasContext ? <SidebarRail /> : null}
            </Sidebar>
            <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
              <TopBar crumbs={props.crumbs ?? []} toolsMenu={props.toolsMenu} hasContext={hasContext} />
              {banner ? <div data-slot="banner-slot">{banner}</div> : null}
              <ShellMain>{children}</ShellMain>
              <div data-slot="composer" className="pb-[env(safe-area-inset-bottom)]" />
            </SidebarInset>
          </ContextSidebarContext.Provider>
        </SidebarProvider>
      </div>
    </SidebarProvider>
  )
})

/** The one scroller. Resets to the top on every route change except the task transcript, whose
 *  own layout effect restores its cached offset before paint. */
const ShellMain = React.memo(function ShellMain({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const ref = React.useRef<HTMLElement>(null)
  const routeOwnsArrival = routeOwnsScrollArrival(pathname)
  React.useLayoutEffect(() => {
    if (routeOwnsArrival) return
    if (ref.current) ref.current.scrollTop = 0
  }, [pathname, routeOwnsArrival])
  return (
    <main ref={ref} data-slot="main" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      {children}
    </main>
  )
})

/** Which desktop shell hosts this page, read once from the init script's `data-cez-desktop`
 *  (packages/desktop). Null in every browser. */
function useDesktopShell(): 'macos' | 'windows' | 'linux' | null {
  const [platform] = React.useState<'macos' | 'windows' | 'linux' | null>(() => {
    if (typeof document === 'undefined') return null
    const value = document.documentElement.dataset.cezDesktop
    return value === 'macos' || value === 'windows' || value === 'linux' ? value : null
  })
  return platform
}

/**
 * The panel's top bar: where you are, and the three things that are about the whole cockpit
 * rather than about the page — search, the tools status, nothing else. Page actions stay with
 * the page.
 */
function TopBar({
  crumbs,
  toolsMenu,
  hasContext,
}: {
  crumbs: readonly Crumb[]
  toolsMenu?: ReactNode
  /** Whether the screen filled the contextual sidebar; without it there is nothing to toggle
   *  on desktop (the sheet still carries the areas on a phone). */
  hasContext: boolean
}) {
  return (
    <header
      data-slot="top-bar"
      className="flex h-12 shrink-0 items-center gap-2 border-b border-border/70 px-3 pt-[env(safe-area-inset-top)]"
    >
      <SidebarTrigger className={cn('size-8 text-muted-foreground', !hasContext && 'md:hidden')} />
      <Separator
        orientation="vertical"
        className={cn('mr-1 data-[orientation=vertical]:h-4', !hasContext && 'md:hidden')}
      />
      <Breadcrumb className="min-w-0 flex-1">
        <BreadcrumbList className="flex-nowrap text-[13px]">
          {crumbs.map((crumb, index) => {
            const last = index === crumbs.length - 1
            return (
              <React.Fragment key={`${index}:${crumb.label}`}>
                <BreadcrumbItem className={cn('min-w-0', !last && 'hidden sm:inline-flex')}>
                  {last || !crumb.to ? (
                    <BreadcrumbPage className={cn('truncate', last ? 'font-medium' : 'text-muted-foreground')}>
                      {crumb.label}
                    </BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink asChild className="truncate">
                      <RouterLink to={crumb.to}>{crumb.label}</RouterLink>
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
                {last ? null : <BreadcrumbSeparator className="hidden sm:list-item" />}
              </React.Fragment>
            )
          })}
        </BreadcrumbList>
      </Breadcrumb>
      <div data-slot="tools-menu" className="shrink-0">
        {toolsMenu}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-slot="command-palette-hint"
        title="Search — command palette"
        onClick={() => openCommandPalette()}
        className="gap-2 pr-1.5 font-normal text-muted-foreground max-sm:size-8 max-sm:px-0"
      >
        <SearchIcon className="size-3.5" aria-hidden="true" />
        <span className="max-sm:sr-only">Search</span>
        <Kbd aria-hidden="true" className="max-sm:hidden">
          {commandShortcutHint('k')}
        </Kbd>
      </Button>
    </header>
  )
}

type RailProps = Omit<AppShellProps, 'children' | 'banner' | 'crumbs' | 'toolsMenu'>

/** The areas the rail and the phone sheet both list, resolved once from the same props. */
function useAreas({
  projects = [],
  activeProjectId = null,
  bootProjectId = null,
  forgeAvailable = true,
  inboxAvailable = true,
  automationsAvailable = true,
  tracker,
}: RailProps) {
  const { pathname } = useLocation()
  // The project the areas are about: the one the URL names, else the boot project — a global
  // page still has to offer a way into a project's Git or Settings.
  const navProjectId = activeProjectId ?? bootProjectId
  const navProject = projects.find((project) => project.id === navProjectId)
  const activeTo = activeProjectId === null ? null : activeNavPath(stripProjectPrefix(pathname))
  const items = React.useMemo(
    () =>
      visibleNavItems({
        forge: navProject ? navProject.forge === 'github' : forgeAvailable,
        inbox: inboxAvailable,
        automations: automationsAvailable,
        tracker: navProject?.tracker ?? tracker,
      }),
    [navProject, forgeAvailable, inboxAvailable, automationsAvailable, tracker],
  )
  return { pathname, navProjectId, activeTo, items }
}

/** The dot or count a rail icon wears: violet, because all three mean "something for you". */
function AreaBadge({
  item,
  inboxCount,
  unreadCount,
  skillsUpdateAvailable,
  className,
}: {
  item: NavItem
  inboxCount: number | null
  unreadCount: number | null
  skillsUpdateAvailable: boolean
  className?: string
}) {
  const count =
    item.badge === 'inbox-count' ? inboxCount : item.badge === 'tasks-unread' ? unreadCount : null
  if (count) {
    return (
      <span
        data-slot={item.badge === 'inbox-count' ? 'nav-badge' : 'nav-unread-badge'}
        title={item.badge === 'tasks-unread' ? `${count} unread finished ${count === 1 ? 'task' : 'tasks'}` : undefined}
        className={cn(
          'pointer-events-none flex h-4 min-w-4 items-center justify-center rounded-full bg-violet px-1 text-[10px] font-semibold text-violet-foreground tabular-nums',
          className,
        )}
      >
        {count > 99 ? '99+' : count}
      </span>
    )
  }
  if (item.badge === 'skills-update' && skillsUpdateAvailable) {
    return (
      <span data-slot="nav-update-marker" className={cn('pointer-events-none flex', className)}>
        <span className="size-2 rounded-full bg-violet ring-2 ring-sidebar" aria-hidden="true" />
        <span className="sr-only">Skills update available</span>
      </span>
    )
  }
  return null
}

const RAIL_BUTTON = 'size-9 justify-center p-0 text-muted-foreground [&>svg]:size-[18px]'

/**
 * The icon rail (desktop): project, New task, the project's areas, the workspace's two pages,
 * and the cockpit's own menu at the foot. Icons only — every button names itself in a tooltip.
 */
function AppRail(props: RailProps) {
  const {
    repo = null,
    projects = [],
    inboxCount = null,
    unreadCount = null,
    skillsUpdateAvailable = false,
    version = null,
    latestVersion = null,
    starCount = null,
    hostWidget,
    inboxAvailable = true,
    singleProject = false,
    brandName = 'cezar',
    brandLogoUrl = null,
  } = props
  const { pathname, navProjectId, activeTo, items } = useAreas(props)
  const workItems = items.filter((item) => item.to !== '/settings')
  const settingsItem = items.find((item) => item.to === '/settings')

  return (
    <Sidebar
      collapsible="none"
      data-slot="rail"
      className="hidden w-[calc(var(--sidebar-width-icon)+0.75rem)] shrink-0 bg-transparent md:flex"
    >
      <SidebarHeader className="items-center gap-3 px-0 pt-3 pb-0">
        <ProjectSwitcher
          projects={projects}
          activeProjectId={navProjectId}
          repo={repo}
          singleProject={singleProject}
          brandName={brandName}
        />
        <div aria-hidden="true" className="mx-auto h-px w-5 shrink-0 bg-foreground/12" />
        <SidebarMenu className="items-center">
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              tooltip={{ children: 'New task · C', hidden: false }}
              className={cn(
                RAIL_BUTTON,
                'bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 hover:text-primary-foreground active:bg-primary/90 active:text-primary-foreground',
              )}
            >
              <Link to="/new" data-slot="new-task-link" aria-label="New task">
                <PlusIcon aria-hidden="true" />
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div aria-hidden="true" className="mx-auto h-px w-5 shrink-0 bg-foreground/12" />
      </SidebarHeader>

      <SidebarContent className="items-center gap-0 [scrollbar-width:none]">
        {/* The workspace's two pages first: they are about every project, like the tile above. */}
        <SidebarMenu className="items-center py-3">
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={pathname === '/dashboard'}
              tooltip={{ children: 'Dashboard', hidden: false }}
              className={RAIL_BUTTON}
            >
              <RouterLink to="/dashboard" data-slot="dashboard-link" aria-label="Dashboard">
                <LayoutDashboardIcon aria-hidden="true" />
              </RouterLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={pathname === '/tasks'}
              tooltip={{ children: 'All tasks', hidden: false }}
              className={RAIL_BUTTON}
            >
              <RouterLink
                to="/tasks"
                data-slot="all-tasks-link"
                aria-label="All tasks"
                aria-current={pathname === '/tasks' ? 'page' : undefined}
              >
                <LayersIcon aria-hidden="true" />
              </RouterLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div aria-hidden="true" className="mx-auto h-px w-5 shrink-0 bg-foreground/12" />
        {/* Then the project: its areas, and its settings last. */}
        <nav aria-label="Main">
          <SidebarMenu className="items-center py-3">
            {workItems.map((item) => {
              const Icon = item.icon
              const active = item.to === activeTo
              return (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton
                    asChild
                    isActive={active}
                    tooltip={{ children: item.label, hidden: false }}
                    className={RAIL_BUTTON}
                  >
                    <Link
                      to={scopeTo(navProjectId, item.to)}
                      aria-label={item.label}
                      aria-current={active ? 'page' : undefined}
                      data-slot="rail-item"
                    >
                      <Icon aria-hidden="true" />
                    </Link>
                  </SidebarMenuButton>
                  <AreaBadge
                    item={item}
                    inboxCount={inboxAvailable ? inboxCount : null}
                    unreadCount={unreadCount}
                    skillsUpdateAvailable={skillsUpdateAvailable}
                    className="absolute -top-1 -right-1"
                  />
                </SidebarMenuItem>
              )
            })}
            {settingsItem ? (
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={settingsItem.to === activeTo}
                  tooltip={{ children: 'Project settings', hidden: false }}
                  className={RAIL_BUTTON}
                >
                  <Link
                    to={scopeTo(navProjectId, settingsItem.to)}
                    aria-label="Project settings"
                    aria-current={settingsItem.to === activeTo ? 'page' : undefined}
                    data-slot="rail-item"
                  >
                    <SettingsIcon aria-hidden="true" />
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ) : null}
          </SidebarMenu>
        </nav>
      </SidebarContent>

      <SidebarFooter data-slot="sidebar-footer" className="items-center px-0 pb-3">
        <FooterMenu
          version={version}
          latestVersion={latestVersion}
          starCount={starCount}
          brandName={brandName}
          brandLogoUrl={brandLogoUrl}
          hostWidget={hostWidget}
        />
      </SidebarFooter>
    </Sidebar>
  )
}

/**
 * The phone's copy of the rail: the same areas as labelled rows, at the top of the contextual
 * sidebar's sheet. Hidden from `md` up, where the rail itself is on screen.
 */
function MobileAreas(props: RailProps) {
  const { inboxCount = null, unreadCount = null, skillsUpdateAvailable = false, inboxAvailable = true } = props
  const { pathname, navProjectId, activeTo, items } = useAreas(props)
  const { isMobile, setOpenMobile } = useSidebar()
  const close = React.useCallback(() => setOpenMobile(false), [setOpenMobile])
  const globalSettings = useGlobalSettings()

  // The sheet must not outlive the navigation it triggered — back/forward and the ⌘K palette
  // navigate without going through any of its links.
  React.useEffect(() => {
    setOpenMobile(false)
  }, [pathname, setOpenMobile])

  if (!isMobile) return null
  return (
    <SidebarNavigateContext.Provider value={close}>
      <SidebarGroup className="border-b border-border/70">
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild className="bg-primary font-medium text-primary-foreground">
                <Link to="/new" onClick={close}>
                  <PlusIcon aria-hidden="true" />
                  <span>New task</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            {items.map((item) => {
              const Icon = item.icon
              const active = item.to === activeTo
              return (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton asChild isActive={active}>
                    <Link to={scopeTo(navProjectId, item.to)} onClick={close} aria-current={active ? 'page' : undefined}>
                      <Icon aria-hidden="true" />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                  <AreaBadge
                    item={item}
                    inboxCount={inboxAvailable ? inboxCount : null}
                    unreadCount={unreadCount}
                    skillsUpdateAvailable={skillsUpdateAvailable}
                    className="absolute top-2 right-2"
                  />
                </SidebarMenuItem>
              )
            })}
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={pathname === '/dashboard'}>
                <RouterLink to="/dashboard" onClick={close}>
                  <LayoutDashboardIcon aria-hidden="true" />
                  <span>Dashboard</span>
                </RouterLink>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={pathname === '/tasks'}>
                <RouterLink to="/tasks" onClick={close}>
                  <LayersIcon aria-hidden="true" />
                  <span>All tasks</span>
                </RouterLink>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => {
                  close()
                  globalSettings.open()
                }}
              >
                <Settings2Icon aria-hidden="true" />
                <span>Global settings</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarNavigateContext.Provider>
  )
}

/**
 * The sidebar's header: which project you are in, and the way to another one.
 *
 * One project is on screen at a time. The switcher lists the rest with their branch, so the
 * sidebar below it never has to repeat a navigation per project — that repetition was most of
 * what made the old sidebar long.
 */
function ProjectSwitcher({
  projects,
  activeProjectId,
  repo,
  singleProject,
  brandName,
}: {
  projects: readonly ProjectListEntry[]
  activeProjectId: string | null
  repo: RepoChip | null
  singleProject: boolean
  brandName: string
}) {
  const { isMobile } = useSidebar()
  const globalSettings = useGlobalSettings()
  const navigate = useNavigate()
  const [browsing, setBrowsing] = React.useState(false)
  const [cloning, setCloning] = React.useState(false)
  const active = projects.find((project) => project.id === activeProjectId)
  const name = active?.name ?? repo?.name ?? brandName
  const branch = active?.branch ?? repo?.branch ?? null

  return (
    <SidebarMenu className="items-center">
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              data-slot="project-switcher"
              tooltip={{ children: branch ? `${name} · ${branch}` : name, hidden: false }}
              aria-label={`Project: ${name}. Switch project`}
              className="size-9 justify-center rounded-md border bg-card p-0 text-[13px] font-semibold text-foreground uppercase shadow-xs data-[state=open]:bg-sidebar-accent"
            >
              <span aria-hidden="true" data-slot="repo-chip">
                {name.trim().charAt(0) || '·'}
              </span>
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="min-w-64 rounded-lg"
            align="start"
            side={isMobile ? 'bottom' : 'right'}
            sideOffset={6}
          >
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Projects</DropdownMenuLabel>
            <DropdownMenuGroup data-slot="project-group-list">
              {projects.map((project) => {
                const missing = project.status === 'missing'
                const current = project.id === activeProjectId
                return (
                  <DropdownMenuItem
                    key={project.id}
                    data-slot="project-group"
                    data-project={project.id}
                    data-status={project.status}
                    data-active={current ? '' : undefined}
                    disabled={missing}
                    title={missing ? `${project.root} is gone — remove it in Global settings → Projects` : project.root}
                    onSelect={() => navigate(`/p/${encodeURIComponent(project.id)}/`)}
                    className="gap-2.5 py-2"
                  >
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-md border bg-card text-muted-foreground">
                      <FolderGit2Icon className="size-3.5" aria-hidden="true" />
                    </span>
                    <span className="grid min-w-0 flex-1 leading-tight">
                      <span className="truncate text-[13px] font-medium">{project.name}</span>
                      <span className="truncate font-mono text-[11px] text-muted-foreground">
                        {missing ? 'folder not found' : project.unregistered ? 'not saved' : (project.branch ?? '—')}
                      </span>
                    </span>
                    {current ? <CheckIcon className="size-4 text-primary-strong" aria-hidden="true" /> : null}
                  </DropdownMenuItem>
                )
              })}
            </DropdownMenuGroup>
            {singleProject ? null : (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem data-slot="add-project-local" onSelect={() => setBrowsing(true)}>
                  <FolderIcon aria-hidden="true" />
                  Open local folder…
                </DropdownMenuItem>
                <DropdownMenuItem data-slot="add-project-clone" onSelect={() => setCloning(true)}>
                  <GithubIcon aria-hidden="true" />
                  Clone from GitHub…
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => globalSettings.open('projects')}>
                  <Settings2Icon aria-hidden="true" />
                  Manage projects
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {/* Mounted only while open: they are the one part of the shell that talks to the API. */}
        {browsing ? <AddProjectDialog open onOpenChange={setBrowsing} /> : null}
        {cloning ? <CloneProjectDialog open onOpenChange={setCloning} /> : null}
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

const THEME_OPTIONS: ReadonlyArray<{ value: Theme; label: string; icon: typeof SunIcon }> = [
  { value: 'light', label: 'Light', icon: SunIcon },
  { value: 'dark', label: 'Dark', icon: MoonIcon },
  { value: 'system', label: 'System', icon: MonitorIcon },
]

/**
 * The rail's foot: everything about the cockpit itself rather than about a project — its
 * version and updates, the machine glance, global settings (a dialog, so you keep your place),
 * the theme, and the ⭐ ask.
 */
function FooterMenu({
  version,
  latestVersion,
  starCount,
  brandName,
  brandLogoUrl,
  hostWidget,
}: {
  version: string | null
  latestVersion: string | null
  starCount: number | null
  brandName: string
  brandLogoUrl: string | null
  /** The machine glance (CPU / RAM), shown at the top of the menu. */
  hostWidget?: ReactNode
}) {
  const { isMobile } = useSidebar()
  const globalSettings = useGlobalSettings()
  const { theme, setTheme } = useTheme()
  const [updating, setUpdating] = React.useState(false)
  const updateAvailable = Boolean(version && latestVersion && latestVersion !== version)

  return (
    <SidebarMenu className="items-center">
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              data-slot="footer-menu"
              tooltip={{ children: version ? `${brandName} v${version}` : brandName, hidden: false }}
              aria-label={`${brandName} menu`}
              className="relative size-9 justify-center overflow-visible rounded-md p-0 text-foreground data-[state=open]:bg-sidebar-accent [&>svg]:size-auto"
            >
              {brandLogoUrl ? (
                <img src={brandLogoUrl} alt="" className="size-7 object-contain" />
              ) : (
                <BrandMark height={28} />
              )}
              {updateAvailable ? (
                <StatusDot tone="pending" pulse className="absolute -top-0.5 -right-0.5 size-2 ring-2 ring-sidebar" />
              ) : null}
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="min-w-60 rounded-lg"
            side={isMobile ? 'top' : 'right'}
            align="end"
            sideOffset={6}
          >
            <DropdownMenuLabel className="flex items-baseline gap-2">
              <span className={cn(brandName === 'cezar' && 'lowercase')} style={{ fontFamily: 'var(--brand)' }}>
                {brandName}
              </span>
              {version ? (
                <span
                  data-slot="version-chip"
                  data-update-available={updateAvailable ? 'true' : undefined}
                  className="font-mono text-[11px] font-normal text-muted-foreground"
                >
                  v{version}
                </span>
              ) : null}
            </DropdownMenuLabel>
            {hostWidget ? <div className="px-1.5 pb-1.5">{hostWidget}</div> : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem data-slot="global-settings-link" onSelect={() => globalSettings.open()}>
              <Settings2Icon aria-hidden="true" />
              Global settings
            </DropdownMenuItem>
            {version ? (
              <DropdownMenuItem onSelect={() => setUpdating(true)}>
                <ArrowUpCircleIcon aria-hidden="true" />
                {updateAvailable ? `Update to v${latestVersion}` : 'Check for updates'}
                {updateAvailable ? <StatusDot tone="pending" pulse className="ml-auto" /> : null}
              </DropdownMenuItem>
            ) : null}
            {starCount === null ? null : (
              <DropdownMenuItem asChild>
                <a
                  data-slot="star-chip"
                  href={CEZAR_REPO_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Star cezar on GitHub — ${starCount.toLocaleString()} stars`}
                >
                  <StarIcon aria-hidden="true" />
                  Star on GitHub
                  <span className="ml-auto font-mono text-[11px] text-muted-foreground">{formatStarCount(starCount)}</span>
                </a>
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Theme</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              data-slot="theme-toggle"
              data-theme-pref={theme}
              value={theme}
              onValueChange={(value) => setTheme(value as Theme)}
            >
              {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
                <DropdownMenuRadioItem key={value} value={value} onSelect={(event) => event.preventDefault()}>
                  <Icon aria-hidden="true" />
                  {label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {updating ? (
          <SelfUpdateDialog
            open={updating}
            onOpenChange={setUpdating}
            autoApply={undefined}
            brandName={brandName}
          />
        ) : null}
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
