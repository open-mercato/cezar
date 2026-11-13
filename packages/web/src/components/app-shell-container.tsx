import { memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import { matchPath, useLocation } from 'react-router'

import { useManagers } from '@/api/managers'
import { useHealth, useProjectRuns, useProjects, useRunsForProject, useSkillsUpdate, useStarCount, useTodos, useWorkspaceConfig, useWorkspaceUiState } from '@/api/queries'
import type { HealthResponse, ProjectsResponse, RunRecord, SkillsUpdateState } from '@open-mercato/cezar-api-client'
import { AppShell, type ProjectSwitcher as ProjectSwitcherData, type RepoChip } from '@/components/app-shell'
import { CommandPalette } from '@/components/command-palette'
import { TaskPalette } from '@/components/task-palette/task-palette'
import { ListViewProvider } from '@/components/list-view'
import { HostUsageWidget } from '@/components/host-usage-widget'
import { ProviderBannerContainer } from '@/components/provider-banner-container'
import { ConnectionBanner } from '@/components/cache-status'
import { TelemetryConsentBanner } from '@/components/telemetry-consent'
import { ProjectSwitcher } from '@/components/project-switcher'
import { SidebarExtensionPanels } from '@/components/extensions/sidebar-panels'
import { CurrentTasksContainer } from '@/components/current-tasks'
import { ToolsMenuItems, toolsTone, toolsTooltip } from '@/components/tools-menu'
import { ManagerHeads } from '@/components/manager-heads'
import { ManagerRail, ManagerSidebar } from '@/routes/manager/manager-sidebar'
import { useDocumentTitle } from '@/lib/use-document-title'
import { pathnameProjectId, stripProjectPrefix, useActiveProjectId } from '@/lib/project-router'
import { withServedBootProject } from '@/lib/served-boot-project'
import { useActiveForge } from '@/lib/active-forge'
import { useFeatureNews, WhatsNewNavItem } from '@/components/first-run'
import { TaskSwitchShortcut } from '@/lib/use-task-switch-shortcut'
import { unreadDoneCount } from '@/lib/read-state'
import { listCounts } from '@/lib/task-groups'
import { runTitle } from '@/lib/task-groups'
import { lastProjectId, managerHref, rememberLastProject, rememberManagerLocation } from '@/lib/manager-location'
import { whatsNewHasUnseen } from '@/lib/onboarding'
import { isManagerPathname, managersAttention } from '@/lib/managers'
import { useManagerModeTelemetry } from '@/lib/manager-telemetry'
import { pageTitleContext, preloadManagerRoutes } from '@/routes'

/**
 * Derive the sidebar's repo chip from `/api/health`.
 *
 * Null — the chip renders nothing — whenever there is nothing true to say: health hasn't
 * answered yet, or cezar is running outside a git repository (`repo: null`), which is a
 * supported way to run it. An empty chip is honest; "loading…" or a guessed folder name is not.
 *
 * The name is the repo root's basename: `/home/me/Projects/cezar` → `cezar`. Both separators,
 * because the server sends whatever path git gave it, and a trailing one is stripped first so
 * `/repo/` doesn't chip as an empty string.
 */
export function repoChipOf(health: HealthResponse | undefined): RepoChip | null {
  const repo = health?.repo
  if (!repo) return null
  const name = repo.root.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
  if (!name) return null
  return { name, branch: repo.branch }
}

/** Only a checked, still-actionable result earns chrome. An update failure may retain a proven
 * available scope, so keep that signal; all unknown/transient/degraded states stay quiet. */
export function skillsUpdateMarkerOf(state: SkillsUpdateState | undefined): boolean {
  return state?.available === true && (state.status === 'available' || state.status === 'error')
}

/**
 * The project the sidebar is about: the URL's, else — on an off-project page — the last one this
 * tab was in while the registry still lists it, else the boot project. Exported for the tests.
 */
export function sidebarProjectId(
  urlProjectId: string | null,
  remembered: string | null,
  registry: ProjectsResponse | undefined,
  bootProjectId: string | null,
): string | null {
  if (urlProjectId !== null) return urlProjectId
  const usable = remembered !== null && registry?.projects.some((project) => project.id === remembered && project.status !== 'missing')
  return usable ? remembered : bootProjectId
}

export interface SidebarCounts {
  unread: number
  needsYou: number
  running: number
}

/** One pass over the active project's list for every count the sidebar paints. */
export function sidebarCounts(runs: readonly RunRecord[]): SidebarCounts {
  let running = 0
  for (const run of runs) {
    if (!run.archived && run.status === 'running') running += 1
  }
  return { unread: unreadDoneCount(runs), needsYou: listCounts(runs).waiting, running }
}

/**
 * The app shell, wired to live data.
 *
 * AppShell itself stays presentational — it takes repo/version/inboxCount and renders them, or
 * renders nothing. This is the seam where those become real: `useHealth()` for the repo and
 * version chips, `useTodos()` for the inbox badge.
 *
 * Nothing here caches boot-time values (#369: the legacy UI read the branch once at startup and
 * then showed a stale branch forever). The chips read whatever is currently in the health query,
 * so keeping them live is `useHealth`'s job — its poll plus Step 3.2's reconnect/visibility
 * reconcile — not a change here.
 */
export const AppShellContainer = memo(function AppShellContainer({ children }: { children: ReactNode }) {
  const { pathname, search } = useLocation()
  const projectId = useActiveProjectId()
  const health = useHealth()
  const workspaceConfig = useWorkspaceConfig()
  const branding = workspaceConfig.data?.branding
  const customBranding = branding !== undefined && (
    branding.name !== 'cezar' || branding.logoUrl !== null
  )
  const starCount = useStarCount(!customBranding && workspaceConfig.data !== undefined)
  // The global inbox is opt-in (#471). With the capability off there is no Inbox nav item to
  // badge and the endpoint can only answer [], so the query parks rather than polls.
  const inboxAvailable = health.data?.capabilities.followups === true
  // GitHub automations are opt-in too (#801) — same honesty rule: without the server's word for
  // it the nav must not offer a tab whose every request would 409.
  const automationsAvailable = health.data?.capabilities.automations === true
  const todos = useTodos(inboxAvailable)
  // Mounted for the session: the switch's dot and the notification path read this cache in Code
  // mode too, and the workspace stream keeps it current.
  const managersAvailable = health.data?.capabilities.managers === true
  const managers = useManagers(managersAvailable)
  const inManager = managersAvailable && isManagerPathname(pathname)
  useManagerModeTelemetry(inManager)
  useEffect(() => {
    if (inManager) rememberManagerLocation(`${pathname}${search}`)
  }, [inManager, pathname, search])
  // The first switch to Manager used to wait on three chunks in a row (~800ms); fetch them idle.
  useEffect(() => {
    if (!managersAvailable) return
    const idle = window.requestIdleCallback ?? ((run: () => void) => window.setTimeout(run, 1))
    const cancel = window.cancelIdleCallback ?? window.clearTimeout
    const handle = idle(() => preloadManagerRoutes())
    return () => cancel(handle)
  }, [managersAvailable])
  const managerIds = useMemo(() => managers.data?.managers.map((manager) => manager.id), [managers.data])
  // Read during render on purpose: the effect above has stored the location by the time it matters.
  const managerTo = inManager ? '/manager' : managerHref(managerIds)
  const chatId = inManager ? matchPath('/manager/:id', pathname)?.params.id : undefined
  const chatName = chatId === undefined ? undefined : managers.data?.managers.find((manager) => manager.id === chatId)?.name
  // One query in the shell feeds every rendering of the active project's navigation (desktop,
  // mobile drawer, and grouped sidebar). Routes reuse this TanStack Query cache entry.
  const skillsUpdate = useSkillsUpdate(projectId ?? '', projectId !== null)
  const skillsUpdateAvailable = skillsUpdateMarkerOf(skillsUpdate.data)
  // Records the visit and dots the nav items whose feature shipped since (spec
  // 2026-10-26-first-run-onboarding, "Coming back").
  const newNavItems = useFeatureNews(stripProjectPrefix(pathname))
  const projectsQuery = useProjects()
  const projectsData = projectsQuery.data
  const urlProjectId = pathnameProjectId(pathname)
  useEffect(() => {
    if (urlProjectId !== null) rememberLastProject(urlProjectId)
  }, [urlProjectId])
  const bootProjectId = projectsData?.bootProject ?? health.data?.bootProject ?? null
  // Read during render: the effect above stores the page after the render that leaves it.
  const navProjectId = sidebarProjectId(projectId, projectId === null ? lastProjectId() : null, projectsData, bootProjectId)
  const registry = useMemo(
    () => withServedBootProject(projectsData, navProjectId, health.data),
    [projectsData, navProjectId, health.data],
  )
  const titleContext = pageTitleContext(pathname)
  // The three sidebar counts from ONE read of the active project's list: unread done items for
  // the Tasks badge (#unread-done-items), needs-you for Now, running for the footer. This shell
  // sits ABOVE the routed project provider, so name the URL project explicitly.
  const countsSelector = useMemo(() => sidebarCounts, [])
  const runs = useRunsForProject(navProjectId, bootProjectId, countsSelector)
  const isBootProject = projectId !== null && projectId === bootProjectId
  const activeProject = registry?.projects.find((project) => project.id === projectId)
  const navProject = registry?.projects.find((project) => project.id === navProjectId)
  const tracker = navProject?.tracker
  const titleRunId = titleContext.taskId
  const titleLabel = useProjectRuns(
    projectId ?? '',
    // Wait for the registry to identify the project before choosing the boot/non-boot cache
    // key. Health can arrive first; fetching then would briefly populate a project-scoped key
    // for the boot project before switching to the authoritative `default` key.
    activeProject !== undefined && titleRunId !== null,
    registry?.bootProject === projectId,
    useMemo(
      () => (list) => {
        const run = titleRunId ? list.find((item) => item.id === titleRunId) : undefined
        return run ? runTitle(run) : undefined
      },
      [titleRunId],
    ),
  ).data

  // Global settings intentionally has no selected project. Everywhere else the URL id selects
  // the authoritative registry entry; health may name only the CONFIRMED boot project while
  // the registry is unavailable, never a non-boot project whose root health does not describe.
  const globalSettings = pathname === '/settings/global' || pathname.startsWith('/settings/global/')
  const projectName = globalSettings
    ? null
    : (chatName ?? activeProject?.name ??
      (isBootProject ? (repoChipOf(health.data)?.name ?? null) : null))
  const pageLabel = titleLabel ?? titleContext.pageLabel

  useDocumentTitle({ projectName, pageLabel, brandName: workspaceConfig.data?.branding.name, brandLogoUrl: workspaceConfig.data?.branding.logoUrl })

  const repo = useMemo(
    () => repoChipOf(health.data),
    [health.data?.repo?.root, health.data?.repo?.branch],
  )
  // The rail-mode header's switcher: every registered project, the URL's one selected.
  const projectSwitcher = useMemo<ProjectSwitcherData | null>(
    () =>
      globalSettings
        ? null
        : {
            activeId: navProjectId,
            activeName: projectId === null ? (navProject?.name ?? projectName) : projectName,
            projects: (registry?.projects ?? []).map(({ id, name }) => ({ id, name })),
          },
    [globalSettings, navProjectId, projectId, navProject?.name, projectName, registry?.projects],
  )
  const banner = useMemo(() => <><ConnectionBanner /><ProviderBannerContainer /></>, [])
  // The opt-in ask (docs/telemetry.md): renders nothing once this machine has answered.
  const footerBanner = useMemo(() => <TelemetryConsentBanner />, [])
  const currentTasks = useMemo(() => <CurrentTasksContainer />, [])
  // The machine glance lives in the footer's "⋯" menu now, so it mounts only while that is open;
  // its own wrapper still gates the viewport and transport (nothing below `md` or in remote).
  const hostWidget = useMemo(() => <HostUsageWidget />, [])
  const whatsNew = useMemo(() => <WhatsNewNavItem menuItem />, [])
  const singleProject = health.data?.capabilities.singleProject === true
  // The switcher needs the registry; until it answers the shell shows the repo chip instead.
  const switcher = useMemo(
    () =>
      registry && !globalSettings ? (
        <ProjectSwitcher
          projects={registry.projects}
          activeId={navProjectId}
          singleProject={singleProject}
        />
      ) : undefined,
    [registry, globalSettings, navProjectId, singleProject],
  )
  // The sidebar project's extension sections (the same scope as its areas); `default` is the boot project.
  const extensionPanels = useMemo(
    () => <SidebarExtensionPanels projectId={navProjectId ?? 'default'} />,
    [navProjectId],
  )
  // The active project's forge, not the boot folder's (#1410) — feeds the nav and the note.
  const activeForge = useActiveForge()
  const toolsMenu = useMemo(
    () => (health.data ? <ToolsMenuItems health={health.data} forge={activeForge} /> : undefined),
    [health.data, activeForge],
  )
  const healthStatus = health.data ? (toolsTone(health.data) === 'success' ? 'healthy' : 'attention') : null
  const healthReason = health.data && healthStatus === 'attention' ? toolsTooltip(health.data) : null
  // The ⋯ button's What's new dot — the item itself sits inside the closed menu.
  const uiState = useWorkspaceUiState()
  const [now] = useState(() => Date.now())
  const whatsNewUnseen = whatsNewHasUnseen(
    uiState.data?.onboarding,
    { designMode: health.data?.capabilities.designMode, automations: health.data?.capabilities.automations },
    now,
  )
  // Slots, because AppShell stays QueryClient-free: each reads the managers cache itself.
  const managerSidebar = useMemo(() => <ManagerSidebar />, [])
  const managerRail = useMemo(() => <ManagerRail />, [])
  const managerHeads = useMemo(() => <ManagerHeads />, [])

  return (
    // The Active/Archived filter is shared by the quick-list below and the Tasks table (Step 3.4),
    // which renders in `children`. The provider goes here because this is the lowest node that has
    // both of them under it — the spec requires the two sets of tabs to be one filter.
    <ListViewProvider>
      <AppShell
        repo={repo}
        brandName={workspaceConfig.data?.branding.name ?? 'cezar'}
        brandLogoUrl={workspaceConfig.data?.branding.logoUrl ?? null}
        version={health.data?.version ?? null}
        latestVersion={health.data?.latestVersion ?? null}
        // The ⭐ ask's count. Same honesty rule as the chips above: `available: false` — offline,
        // a rate-limited IP, or promos silenced with `CEZ_NO_BANNER=1` — is `null` here, and
        // AppShell renders no chip for it rather than a button that cannot count.
        starCount={!customBranding && starCount.data?.available ? (starCount.data.count ?? null) : null}
        // `?? null` rather than `?? 0`: no badge while the inbox is unknown, and no badge when it
        // is known to be empty — AppShell renders neither for a falsy count.
        inboxCount={todos.data?.length ?? null}
        // Same `?? null` honesty: no badge while the list is unknown; a loaded list with none
        // unread is 0, which AppShell also renders as no badge.
        unreadCount={runs.data?.unread ?? null}
        nowCount={runs.data?.needsYou ?? null}
        runningCount={runs.data?.running ?? null}
        healthStatus={healthStatus}
        skillsUpdateAvailable={skillsUpdateAvailable}
        newNavItems={newNavItems}
        // Shown whenever the remote is a recognized forge, like each project group's tab (#698);
        // a cold or failed probe is the GitHub page's to explain and retry (#1412).
        forgeAvailable={activeForge != null}
        // Hidden unless health reports the opt-in inbox (#471) — same honesty rule as above:
        // the nav must not offer an Inbox this server will never fill.
        inboxAvailable={inboxAvailable}
        // Hidden unless health reports the opt-in automations capability (#801).
        automationsAvailable={automationsAvailable}
        tracker={tracker}
        banner={banner}
        whatsNew={whatsNew}
        whatsNewUnseen={whatsNewUnseen}
        healthReason={healthReason}
        linkProjectId={globalSettings ? null : navProjectId}
        offerAddProject={registry === undefined && projectsQuery.isError}
        footerBanner={footerBanner}
        singleProject={singleProject}
        currentTasks={currentTasks}
        switcher={switcher}
        hostWidget={hostWidget}
        extensionPanels={extensionPanels}
        toolsMenu={toolsMenu}
        managersAvailable={managersAvailable}
        managerAttention={managersAttention(managers.data?.managers)}
        managerTo={managerTo}
        managerSidebar={managerSidebar}
        managerRail={managerRail}
        managerHeads={managerHeads}
        projectSwitcher={projectSwitcher}
      >
        {children}
      </AppShell>
      {/* Global chrome, not a route: ⌘K must work on every URL. Mounted here (not in AppShell)
          because it needs the query client and router this container already assumes. */}
      <CommandPalette />
      {/* ⌘P, its task-scoped twin (spec 2026-10-17-task-palette). */}
      <TaskPalette />
      {/* ⌥↑/⌥↓ walk the sidebar's tasks, ⌥⇧ the ones that need you — on every page. */}
      <TaskSwitchShortcut />
    </ListViewProvider>
  )
})
