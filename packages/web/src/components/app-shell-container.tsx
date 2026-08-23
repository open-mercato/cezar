import type { ReactNode } from 'react'
import { useLocation } from 'react-router'

import { useHealth, useProjectRuns, useProjects, useRuns, useSkillsUpdate, useTodos } from '@/api/queries'
import type { HealthResponse, SkillsUpdateState } from '@open-mercato/cezar-api-client'
import { AppShell, type RepoChip } from '@/components/app-shell'
import { CommandPalette } from '@/components/command-palette'
import { ListViewProvider } from '@/components/list-view'
import { OfflineBanner } from '@/components/offline-banner'
import { ProviderBannerContainer } from '@/components/provider-banner-container'
import { ProjectSwitcher } from '@/components/project-switcher'
import { ProjectsSection } from '@/components/projects-section'
import { ProjectTaskGroupsContainer } from '@/components/task-quick-list'
import { TabLink } from '@/components/tab-link'
import { ToolsMenu } from '@/components/tools-menu'
import { activeNavPath, visibleNavItems } from '@/components/nav-items'
import { stripProjectPrefix } from '@/lib/project-router'
import { useDocumentTitle } from '@/lib/use-document-title'
import { useActiveProjectId } from '@/lib/project-router'
import { unreadDoneCount } from '@/lib/read-state'
import { runTitle } from '@/lib/task-groups'
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
export function AppShellContainer({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const projectId = useActiveProjectId()
  const health = useHealth()
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
  // Unread done items (#unread-done-items) for the Tasks badge. Reads the same active-scope run
  // list the sidebar quick-list and Tasks table already hold — one cache entry, no extra fetch.
  const runs = useRuns()
  const registry = useProjects().data
  const titleContext = pageTitleContext(pathname)
  const bootProjectId = registry?.bootProject ?? health.data?.bootProject ?? null
  const isBootProject = projectId !== null && projectId === bootProjectId
  const activeProject = registry?.projects.find((project) => project.id === projectId)
  const titleRuns = useProjectRuns(
    projectId ?? '',
    // Wait for the registry to identify the project before choosing the boot/non-boot cache
    // key. Health can arrive first; fetching then would briefly populate a project-scoped key
    // for the boot project before switching to the authoritative `default` key.
    activeProject !== undefined && titleContext.taskId !== null,
    registry?.bootProject === projectId,
  ).data

  // Global settings intentionally has no selected project. Everywhere else the URL id selects
  // the authoritative registry entry; health may name only the CONFIRMED boot project while
  // the registry is unavailable, never a non-boot project whose root health does not describe.
  const globalSettings = pathname === '/settings/global' || pathname.startsWith('/settings/global/')
  const projectName = globalSettings
    ? null
    : (activeProject?.name ??
      (isBootProject ? (repoChipOf(health.data)?.name ?? null) : null))
  const titleRun = titleContext.taskId
    ? titleRuns?.find((run) => run.id === titleContext.taskId)
    : undefined
  const pageLabel = titleRun ? runTitle(titleRun) : titleContext.pageLabel

  useDocumentTitle({ projectName, pageLabel })

  // Multi-project counts from the SECOND project on. The sidebar no longer swaps to the
  // per-project GROUPS view (user decision, 25-repo review): at 20+ registered repos the
  // grouped column collapsed the active project's own nav into a list of look-alike rows.
  // The flat active-project sidebar stays; the flag only pins the All-tasks door above it,
  // and the other projects are the topbar switcher's job.
  const multiProject = registry !== undefined && registry.projects.length > 1

  // The project menu's views (user decision: the bar chip's menu lists THIS project's views —
  // Tasks, Git, Skills, Workflows, the gated ones, Settings — never other projects). Lit from
  // the URL's area, the same rule the old workspace nav used.
  const areaPath = stripProjectPrefix(pathname)
  const activeTo = activeNavPath(areaPath)
  const projectViews = visibleNavItems({
    forge: health.data?.forge?.available === true,
    inbox: inboxAvailable,
    automations: automationsAvailable,
    singleProject: health.data?.capabilities.singleProject === true,
  })

  // The project's tab band (user decision: Tasks / Git / Skills / Workflows on the project's
  // pages, like a repo's tabs) — shown on the project-level views only: not inside a task
  // thread, the composer, the compare view or global settings, which are about one thing.
  const projectViewRoots = projectViews.filter((item) => !item.global && !item.library && item.to !== '/settings')
  const onProjectView =
    !globalSettings &&
    titleContext.taskId === null &&
    activeTo !== null &&
    projectViewRoots.some((item) => item.to === activeTo) &&
    !areaPath.startsWith('/tasks/') &&
    areaPath !== '/new' &&
    !areaPath.startsWith('/compare/')
  const projectTabs = onProjectView ? (
    <div data-slot="project-tabs" className="flex h-10 items-end gap-1 border-b border-border bg-background px-5">
      {projectViewRoots.map((item) => {
        const Icon = item.icon
        const count = item.badge === 'inbox-count' ? (todos.data?.length ?? 0) : 0
        return (
          <TabLink key={item.to} to={item.to} active={item.to === activeTo}>
            <Icon aria-hidden="true" className="size-3.5" />
            {item.label}
            {count > 0 ? (
              <span data-slot="nav-badge" className="rounded-full bg-violet px-1.5 py-px text-[10.5px] font-semibold text-violet-foreground">
                {count}
              </span>
            ) : null}
          </TabLink>
        )
      })}
    </div>
  ) : null

  return (
    // The Active/Archived filter is shared by the quick-list below and the Tasks table (Step 3.4),
    // which renders in `children`. The provider goes here because this is the lowest node that has
    // both of them under it — the spec requires the two sets of tabs to be one filter.
    <ListViewProvider>
      <AppShell
        repo={repoChipOf(health.data)}
        version={health.data?.version ?? null}
        latestVersion={health.data?.latestVersion ?? null}
        // `?? null` rather than `?? 0`: no badge while the inbox is unknown, and no badge when it
        // is known to be empty — AppShell renders neither for a falsy count.
        inboxCount={todos.data?.length ?? null}
        // Same `?? null` honesty: no badge while the list is unknown; a loaded list with none
        // unread is 0, which AppShell also renders as no badge.
        unreadCount={runs.data ? unreadDoneCount(runs.data) : null}
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
        banner={
          <>
            {/* Offline first: a dead server explains (and outranks) whatever the provider
                banner would be claiming from cached data. */}
            <OfflineBanner />
            <ProviderBannerContainer />
            {projectTabs}
          </>
        }
        // The project bar above the content — the same resolved name the document title uses,
        // falling back to the repo basename while the registry is unknown.
        projectName={projectName ?? repoChipOf(health.data)?.name ?? null}
        // With a registry answer the identity becomes a real switcher; before that (or outside
        // any project) the bar keeps the static chip built from `projectName` above.
        // The bar's breadcrumb: the open task's title (the same resolution the document title
        // uses), else the view's label. Never on the project's own Tasks table — "cezar › Tasks"
        // would say the project twice.
        crumb={titleRun ? runTitle(titleRun) : null}
        // On a project VIEW the tab band already lists the project's views, so the chip is just
        // the name (user decision); the menu returns where the band is absent (a task thread,
        // the composer) as the way back to those views.
        projectSwitcher={
          registry && registry.projects.length > 0 && !onProjectView ? (
            <ProjectSwitcher
              projects={registry.projects}
              activeId={projectId ?? registry.bootProject ?? null}
              items={projectViews}
              activeTo={activeTo}
              inboxCount={inboxAvailable ? (todos.data?.length ?? null) : null}
              skillsUpdateAvailable={skillsUpdateAvailable}
            />
          ) : undefined
        }
        singleProject={health.data?.capabilities.singleProject === true}
        taskQuickList={<ProjectTaskGroupsContainer />}
        projectsMenu={
          registry && registry.projects.length > 0 && health.data?.capabilities.singleProject !== true ? (
            <ProjectsSection projects={registry.projects} activeId={projectId ?? registry.bootProject ?? null} />
          ) : undefined
        }
        multiProject={multiProject}
        toolsMenu={<ToolsMenu health={health.data} />}
      >
        {children}
      </AppShell>
      {/* Global chrome, not a route: ⌘K must work on every URL. Mounted here (not in AppShell)
          because it needs the query client and router this container already assumes. */}
      <CommandPalette />
    </ListViewProvider>
  )
}
