import { memo, useEffect, useMemo, type ReactNode } from 'react'
import { useLocation } from 'react-router'

import { useHealth, useProjectRuns, useProjects, useRunsForProject, useSkillsUpdate, useStarCount, useTodos, useWorkspaceConfig } from '@/api/queries'
import type { HealthResponse, SkillsUpdateState } from '@open-mercato/cezar-api-client'
import { AppShell, type Crumb, type RepoChip } from '@/components/app-shell'
import { CommandPalette } from '@/components/command-palette'
import { GlobalSettingsProvider } from '@/components/global-settings'
import { GlobalSettingsDialog } from '@/components/global-settings-dialog'
import { ListViewProvider } from '@/components/list-view'
import { HostUsageWidget } from '@/components/host-usage-widget'
import { ProviderBannerContainer } from '@/components/provider-banner-container'
import { TaskQuickListContainer } from '@/components/task-quick-list'
import { ToolsMenu } from '@/components/tools-menu'
import { useDocumentTitle } from '@/lib/use-document-title'
import { useActiveProjectId } from '@/lib/project-router'
import { unreadDoneCount } from '@/lib/read-state'
import { orderProjects } from '@/lib/project-order'
import { runTitle } from '@/lib/task-groups'
import { useProjectOrder } from '@/lib/use-project-order'
import { pageTitleContext } from '@/routes'

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
  const { pathname } = useLocation()
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
  // One query in the shell feeds every rendering of the active project's navigation (desktop,
  // mobile drawer, and grouped sidebar). Routes reuse this TanStack Query cache entry.
  const skillsUpdate = useSkillsUpdate(projectId ?? '', projectId !== null)
  const skillsUpdateAvailable = skillsUpdateMarkerOf(skillsUpdate.data)
  const registry = useProjects().data
  const titleContext = pageTitleContext(pathname)
  const bootProjectId = registry?.bootProject ?? health.data?.bootProject ?? null
  // Unread done items (#unread-done-items) for the Tasks badge. This shell sits ABOVE the routed
  // project provider, so name the URL project explicitly instead of reading the module scope.
  const unreadDoneCountSelector = useMemo(() => unreadDoneCount, [])
  const runs = useRunsForProject(projectId, bootProjectId, unreadDoneCountSelector)
  const isBootProject = projectId !== null && projectId === bootProjectId
  const activeProject = registry?.projects.find((project) => project.id === projectId)
  const bootProject = registry?.projects.find((project) => project.id === bootProjectId)
  const tracker = projectId === null ? bootProject?.tracker : activeProject?.tracker
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
    : (activeProject?.name ??
      (isBootProject ? (repoChipOf(health.data)?.name ?? null) : null))
  const pageLabel = titleLabel ?? titleContext.pageLabel

  useDocumentTitle({ projectName, pageLabel, brandName: workspaceConfig.data?.branding.name, brandLogoUrl: workspaceConfig.data?.branding.logoUrl })

  // The switcher lists the registry in the user's hand-picked order (#952), shared with ⌘K.
  const { order } = useProjectOrder()
  const projects = useMemo(
    () => (registry ? orderProjects(registry.projects, order) : []),
    [registry, order],
  )
  // The top bar's trail: the project (when the page belongs to one), then the page — and for a
  // task, the Tasks list it came from in between.
  const crumbs = useMemo<Crumb[]>(() => {
    const trail: Crumb[] = []
    const home = projectId === null ? null : `/p/${encodeURIComponent(projectId)}/`
    if (home && projectName) trail.push({ label: projectName, to: home })
    if (titleContext.taskId !== null) {
      if (home) trail.push({ label: 'Tasks', to: home })
      trail.push({ label: titleLabel ?? 'Task' })
    } else if (pageLabel) {
      trail.push({ label: globalSettings ? 'Global settings' : pageLabel })
    }
    return trail
  }, [projectId, projectName, titleContext.taskId, titleLabel, pageLabel, globalSettings])
  const repo = useMemo(
    () => repoChipOf(health.data),
    [health.data?.repo?.root, health.data?.repo?.branch],
  )
  const banner = useMemo(() => <ProviderBannerContainer />, [])
  const taskQuickList = useMemo(() => <TaskQuickListContainer />, [])
  // The sidebar glance. Created here, not inside `AppShell`, because the shell stays presentational
  // and QueryClient-free: the widget's own wrapper evaluates the viewport and transport gates and
  // mounts nothing below `md` or in remote, so neither the CSS-hidden column nor a hosted cockpit
  // ever pays for a sample it cannot show.
  const hostWidget = useMemo(() => <HostUsageWidget />, [])
  const toolsMenu = useMemo(() => <ToolsMenu health={health.data} />, [health.data])

  return (
    // The Active/Archived filter is shared by the quick-list below and the Tasks table (Step 3.4),
    // which renders in `children`. The provider goes here because this is the lowest node that has
    // both of them under it — the spec requires the two sets of tabs to be one filter.
    <ListViewProvider>
     <GlobalSettingsProvider dialog={<GlobalSettingsDialog />}>
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
        unreadCount={runs.data ?? null}
        skillsUpdateAvailable={skillsUpdateAvailable}
        // Hidden until health confirms the forge driver (R6 Step 1.1) — same honesty rule as
        // the chips: the nav must not claim a GitHub tab it cannot back. The Tools menu's
        // forge note says why it is absent.
        forgeAvailable={health.data?.forge?.available === true}
        // Hidden unless health reports the opt-in inbox (#471) — same honesty rule as above:
        // the nav must not offer an Inbox this server will never fill.
        inboxAvailable={inboxAvailable}
        // Hidden unless health reports the opt-in automations capability (#801).
        automationsAvailable={automationsAvailable}
        tracker={tracker}
        banner={banner}
        singleProject={health.data?.capabilities.singleProject === true}
        taskQuickList={taskQuickList}
        hostWidget={hostWidget}
        projects={projects}
        activeProjectId={globalSettings ? null : projectId}
        bootProjectId={bootProjectId}
        crumbs={crumbs}
        toolsMenu={toolsMenu}
      >
        {children}
      </AppShell>
      {/* Global chrome, not a route: ⌘K must work on every URL. Mounted here (not in AppShell)
          because it needs the query client and router this container already assumes. */}
      <CommandPalette />
     </GlobalSettingsProvider>
    </ListViewProvider>
  )
})
