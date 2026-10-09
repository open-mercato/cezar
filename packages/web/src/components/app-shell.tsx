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
  SidebarMenuBadge,
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

const SIDEBAR_OPEN_KEY = 'cez-sidebar-open'

function readSidebarOpen(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_OPEN_KEY) !== 'false'
  } catch {
    return true
  }
}

/**
 * The cockpit's app shell — the shadcn `inset` sidebar layout.
 *
 * The whole app sits on one canvas (`bg-sidebar`); the navigation lives directly on it and the
 * routed view floats on it as a rounded panel. That is the one elevation step the chrome has, and
 * it is what lets the pages inside stay flat and quiet.
 *
 *  - The sidebar collapses to an icon rail (⌘B, the top bar's trigger, or its own edge) and
 *    becomes a sheet below `md`. Its open state is a browser-local preference.
 *  - The panel is a three-row column: top bar / banner / scroller. Only the scroller scrolls —
 *    `overflow-hidden` here and on `body` means the document never does — and it keeps
 *    `data-slot="main"`, which the thread, the diff views and the commit list all resolve their
 *    scroll owner through.
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

  return (
    <SidebarProvider
      data-slot="app-shell"
      data-desktop={desktop ?? undefined}
      open={open}
      onOpenChange={onOpenChange}
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
      <AppSidebar {...props} />
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden border border-border/70 md:peer-data-[variant=inset]:shadow-xs">
        <TopBar crumbs={props.crumbs ?? []} toolsMenu={props.toolsMenu} />
        {banner ? <div data-slot="banner-slot">{banner}</div> : null}
        <ShellMain>{children}</ShellMain>
        <div data-slot="composer" className="pb-[env(safe-area-inset-bottom)]" />
      </SidebarInset>
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
function TopBar({ crumbs, toolsMenu }: { crumbs: readonly Crumb[]; toolsMenu?: ReactNode }) {
  return (
    <header
      data-slot="top-bar"
      className="flex h-12 shrink-0 items-center gap-2 border-b border-border/70 px-3 pt-[env(safe-area-inset-top)]"
    >
      <SidebarTrigger className="size-8 text-muted-foreground" />
      <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
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

type SidebarProps = Omit<AppShellProps, 'children' | 'banner' | 'crumbs' | 'toolsMenu'>

function AppSidebar({
  repo = null,
  projects = [],
  activeProjectId = null,
  bootProjectId = null,
  inboxCount = null,
  unreadCount = null,
  skillsUpdateAvailable = false,
  version = null,
  latestVersion = null,
  starCount = null,
  taskQuickList,
  hostWidget,
  forgeAvailable = true,
  inboxAvailable = true,
  automationsAvailable = true,
  tracker,
  singleProject = false,
  brandName = 'cezar',
  brandLogoUrl = null,
}: SidebarProps) {
  const { pathname } = useLocation()
  const { isMobile, setOpenMobile } = useSidebar()
  const closeMobile = React.useCallback(() => setOpenMobile(false), [setOpenMobile])
  const onNavigate = isMobile ? closeMobile : undefined

  // The sheet must not outlive the navigation it triggered — back/forward and the ⌘K palette
  // navigate without going through any of its links.
  React.useEffect(() => {
    setOpenMobile(false)
  }, [pathname, setOpenMobile])

  // The project the nav below is about: the one the URL names, else the boot project — a global
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
  // Settings is the project's own configuration, not a place you work in — it sits apart from
  // the rest so the list above it reads as "the things this project has".
  const workItems = items.filter((item) => item.to !== '/settings')
  const settingsItem = items.find((item) => item.to === '/settings')

  return (
    <Sidebar variant="inset" collapsible="icon" data-slot="sidebar">
      <SidebarHeader>
        <ProjectSwitcher
          projects={projects}
          activeProjectId={navProjectId}
          repo={repo}
          singleProject={singleProject}
          brandName={brandName}
        />
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              tooltip="New task (C)"
              className="bg-primary font-medium text-primary-foreground shadow-xs hover:bg-primary/90 hover:text-primary-foreground active:bg-primary/90 active:text-primary-foreground"
            >
              <Link to="/new" onClick={onNavigate} data-slot="new-task-link">
                <PlusIcon aria-hidden="true" />
                <span>New task</span>
                <Kbd
                  aria-hidden="true"
                  className="ml-auto border-primary-foreground/20 bg-primary-foreground/10 text-primary-foreground/70 group-data-[collapsible=icon]:hidden"
                >
                  C
                </Kbd>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="Dashboard" isActive={pathname === '/dashboard'}>
                  <RouterLink to="/dashboard" data-slot="dashboard-link" onClick={onNavigate}>
                    <LayoutDashboardIcon aria-hidden="true" />
                    <span>Dashboard</span>
                  </RouterLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="All tasks" isActive={pathname === '/tasks'}>
                  <RouterLink
                    to="/tasks"
                    data-slot="all-tasks-link"
                    aria-current={pathname === '/tasks' ? 'page' : undefined}
                    onClick={onNavigate}
                  >
                    <LayersIcon aria-hidden="true" />
                    <span>All tasks</span>
                  </RouterLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel className="truncate">{navProject?.name ?? repo?.name ?? 'Project'}</SidebarGroupLabel>
          <SidebarGroupContent>
            <nav aria-label="Main">
              <SidebarMenu>
                {workItems.map((item) => (
                  <NavRow
                    key={item.to}
                    item={item}
                    projectId={navProjectId}
                    active={item.to === activeTo}
                    inboxCount={inboxAvailable ? inboxCount : null}
                    unreadCount={unreadCount}
                    skillsUpdateAvailable={skillsUpdateAvailable}
                    onNavigate={onNavigate}
                  />
                ))}
                {settingsItem ? (
                  <NavRow
                    item={settingsItem}
                    projectId={navProjectId}
                    active={settingsItem.to === activeTo}
                    inboxCount={null}
                    unreadCount={null}
                    skillsUpdateAvailable={false}
                    onNavigate={onNavigate}
                  />
                ) : null}
              </SidebarMenu>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>

        {taskQuickList ? (
          <SidebarGroup className="min-h-0 group-data-[collapsible=icon]:hidden">
            <SidebarGroupLabel>Tasks</SidebarGroupLabel>
            <SidebarGroupContent data-slot="task-quick-list" className="@container/sidebar">
              <SidebarNavigateContext.Provider value={onNavigate}>{taskQuickList}</SidebarNavigateContext.Provider>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : null}
      </SidebarContent>

      <SidebarFooter data-slot="sidebar-footer">
        {hostWidget ? <div className="group-data-[collapsible=icon]:hidden">{hostWidget}</div> : null}
        <FooterMenu
          version={version}
          latestVersion={latestVersion}
          starCount={starCount}
          brandName={brandName}
          brandLogoUrl={brandLogoUrl}
          onNavigate={onNavigate}
        />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

/** One project nav row. Explicitly scoped (`/p/<id>/…`) so it works from a global page too. */
function NavRow({
  item,
  projectId,
  active,
  inboxCount,
  unreadCount,
  skillsUpdateAvailable,
  onNavigate,
}: {
  item: NavItem
  projectId: string | null
  active: boolean
  inboxCount: number | null
  unreadCount: number | null
  skillsUpdateAvailable: boolean
  onNavigate?: () => void
}) {
  const Icon = item.icon
  const count =
    item.badge === 'inbox-count' ? inboxCount : item.badge === 'tasks-unread' ? unreadCount : null
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild tooltip={item.label} isActive={active}>
        <Link to={scopeTo(projectId, item.to)} onClick={onNavigate} aria-current={active ? 'page' : undefined}>
          <Icon aria-hidden="true" />
          <span>{item.label}</span>
        </Link>
      </SidebarMenuButton>
      {count ? (
        <SidebarMenuBadge
          data-slot={item.badge === 'inbox-count' ? 'nav-badge' : 'nav-unread-badge'}
          title={item.badge === 'tasks-unread' ? `${count} unread finished ${count === 1 ? 'task' : 'tasks'}` : undefined}
          className="rounded-full bg-violet/12 px-1.5 text-[11px] font-semibold text-violet peer-data-[active=true]/menu-button:text-violet"
        >
          {count}
        </SidebarMenuBadge>
      ) : null}
      {item.badge === 'skills-update' && skillsUpdateAvailable ? (
        <SidebarMenuBadge data-slot="nav-update-marker">
          <span className="size-1.5 rounded-full bg-violet" aria-hidden="true" />
          <span className="sr-only">Skills update available</span>
        </SidebarMenuBadge>
      ) : null}
    </SidebarMenuItem>
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
  const navigate = useNavigate()
  const [browsing, setBrowsing] = React.useState(false)
  const [cloning, setCloning] = React.useState(false)
  const active = projects.find((project) => project.id === activeProjectId)
  const name = active?.name ?? repo?.name ?? brandName
  const branch = active?.branch ?? repo?.branch ?? null

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              data-slot="project-switcher"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <span
                aria-hidden="true"
                className="flex aspect-square size-8 items-center justify-center rounded-lg border bg-card text-[13px] font-semibold text-foreground uppercase shadow-2xs"
              >
                {name.trim().charAt(0) || '·'}
              </span>
              <span className="grid flex-1 text-left leading-tight">
                <span className="truncate text-[13.5px] font-semibold text-foreground">{name}</span>
                <span data-slot="repo-chip" className="truncate font-mono text-[11px] text-muted-foreground">
                  {branch ?? brandName}
                </span>
              </span>
              <ChevronsUpDownIcon className="ml-auto size-4 text-muted-foreground" aria-hidden="true" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-64 rounded-lg"
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
                <DropdownMenuItem asChild>
                  <RouterLink to="/settings/global/projects">
                    <Settings2Icon aria-hidden="true" />
                    Manage projects
                  </RouterLink>
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
 * The footer menu: everything about the cockpit itself rather than about a project — its
 * version and updates, global settings, the theme, and the ⭐ ask. One row instead of the old
 * footer's five chips, which is what frees the sidebar's bottom edge.
 */
function FooterMenu({
  version,
  latestVersion,
  starCount,
  brandName,
  brandLogoUrl,
  onNavigate,
}: {
  version: string | null
  latestVersion: string | null
  starCount: number | null
  brandName: string
  brandLogoUrl: string | null
  onNavigate?: () => void
}) {
  const { isMobile } = useSidebar()
  const { theme, setTheme } = useTheme()
  const [updating, setUpdating] = React.useState(false)
  const updateAvailable = Boolean(version && latestVersion && latestVersion !== version)

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              data-slot="footer-menu"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <span className="relative flex aspect-square size-8 items-center justify-center rounded-lg bg-contrast text-contrast-foreground">
                {brandLogoUrl ? (
                  <img src={brandLogoUrl} alt="" className="size-5 object-contain" />
                ) : (
                  <BrandMark height={16} />
                )}
                {updateAvailable ? (
                  <StatusDot tone="pending" pulse className="absolute -top-0.5 -right-0.5 size-2 ring-2 ring-sidebar" />
                ) : null}
              </span>
              <span className="grid flex-1 text-left leading-tight">
                <span
                  className={cn('truncate text-[13.5px] font-semibold text-foreground', brandName === 'cezar' && 'lowercase')}
                  style={{ fontFamily: 'var(--brand)' }}
                >
                  {brandName}
                </span>
                <span
                  data-slot="version-chip"
                  data-update-available={updateAvailable ? 'true' : undefined}
                  className="truncate font-mono text-[11px] text-muted-foreground"
                >
                  {version ? `v${version}` : 'Settings & more'}
                  {updateAvailable ? ' · update available' : ''}
                </span>
              </span>
              <ChevronsUpDownIcon className="ml-auto size-4 text-muted-foreground" aria-hidden="true" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-60 rounded-lg"
            side={isMobile ? 'top' : 'right'}
            align="end"
            sideOffset={6}
          >
            <DropdownMenuItem asChild>
              <RouterLink to="/settings/global" data-slot="global-settings-link" onClick={onNavigate}>
                <SettingsIcon aria-hidden="true" />
                Global settings
              </RouterLink>
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
