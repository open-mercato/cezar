import { Suspense, lazy } from 'react'
import {
  matchPath,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useParams,
} from 'react-router'

import { useHealth, useProjects } from './api/queries'
import { ProjectScopeProvider } from './api/project-scope-context'
import { locationToRestore, readStoredLastLocation } from './lib/last-location'
import { Navigate as ScopedNavigate, stripProjectPrefix } from './lib/project-router'
import { CompareLoading } from './routes/compare-loading'
import { GithubLoading } from './routes/github/github-loading'
import { InboxRoute } from './routes/inbox'
import { NewTaskRoute } from './routes/new-task'
import { NotFoundRoute } from './routes/not-found'
import { RepoGitLoading } from './routes/repo-git/repo-git-loading'
import { SkillsLoading } from './routes/skills-loading'
import { UnknownProjectRoute } from './routes/unknown-project'
import { WorkflowsLoading } from './routes/workflows/workflows-loading'
import { GitTabLoading } from './routes/task-git/git-tab-loading'
import { ThreadLoading } from './routes/task-thread/thread-loading'
import { visibleSettingsSections, type SettingsSectionId } from './routes/settings/registry'
import {
  SettingsIndexRoute,
  SettingsSectionRoute,
  settingsSectionPath,
} from './routes/settings/settings-shell'
import { TasksOverviewRoute } from './routes/tasks-overview'
import { GlobalTasksRoute } from './routes/global-tasks'
import { AutomationsRoute } from './routes/automations/automations'

/** Lazy ON PURPOSE: the thread view carries the markdown stack (Streamdown + remark/rehype,
 *  ~140 KB gz) — as a static import it would sit in the main bundle every visitor pays for
 *  before any route renders. The Suspense fallback is the same loading state the route itself
 *  shows while fetching, so the split is invisible to the user. */
const TaskThreadRoute = lazy(() =>
  import('./routes/task-thread/task-thread').then((m) => ({ default: m.TaskThreadRoute })),
)

/** Lazy for the same reason: the compare view renders Progress excerpts through Streamdown and
 *  full diffs through the Shiki singleton — thread-chunk weight the home screen must not pay. */
const CompareVariantsRoute = lazy(() =>
  import('./routes/compare-variants').then((m) => ({ default: m.CompareVariantsRoute })),
)

/** Lazy because both tabs render the shared run header, which lives in the thread chunk
 *  (markdown stack and all) — a static import here would pull that into the main bundle. */
const TaskChangesRoute = lazy(() =>
  import('./routes/task-git/task-changes').then((m) => ({ default: m.TaskChangesRoute })),
)
const TaskFilesRoute = lazy(() =>
  import('./routes/task-git/task-files').then((m) => ({ default: m.TaskFilesRoute })),
)
const TaskCommitsRoute = lazy(() =>
  import('./routes/task-git/task-commits').then((m) => ({ default: m.TaskCommitsRoute })),
)

/** Lazy because the repo view renders through the `<Diff>` facade and the Shiki singleton —
 *  the same heavy chunk the task git tabs ride; the home screen must not pay for it. */
const RepoGitRoute = lazy(() =>
  import('./routes/repo-git/repo-git').then((m) => ({ default: m.RepoGitRoute })),
)

/** Lazy because the GitHub detail pane renders issue/PR bodies through the same markdown
 *  stack the thread carries — thread-chunk weight the home screen must not pay. */
const GithubRoute = lazy(() =>
  import('./routes/github/github').then((m) => ({ default: m.GithubRoute })),
)
/** `/github`'s index (#417) — restores the last-selected tab. Same chunk as `GithubRoute`,
 *  just a second named export off the same lazy import. */
const GithubIndexRoute = lazy(() =>
  import('./routes/github/github').then((m) => ({ default: m.GithubIndexRoute })),
)

/** Lazy because the builder carries dnd-kit (R6 Step 1.6) — drag machinery only this surface
 *  uses, so only this surface pays for it. */
const WorkflowsRoute = lazy(() =>
  import('./routes/workflows/workflows').then((m) => ({ default: m.WorkflowsRoute })),
)

/** Lazy because the skill detail renders the skill body through the same markdown stack the
 *  thread carries — thread-chunk weight the home screen must not pay (it used to ride the main
 *  bundle as a static Settings section). */
const SkillsRoute = lazy(() => import('./routes/skills').then((m) => ({ default: m.SkillsRoute })))

/** `/settings/skills` moved to the top-level `/skills` (out of the Settings shell). Redirect —
 *  preserving the `?skill=` selection and any hash — so pasted links and saved bookmarklets
 *  still land. The scoped Navigate keeps the redirect inside the active project. */
function SettingsSkillsRedirect() {
  const location = useLocation()
  return (
    <ScopedNavigate
      to={{ pathname: '/skills', search: location.search, hash: location.hash }}
      replace
    />
  )
}

/** A settings section that MOVED from the project area to the global one. Its own hop, not an
 *  inline `<Navigate>`, because `settingsSectionPath` returns a bare pathname: only a component
 *  can read `useLocation` and carry the query and hash across. Legacy flat URLs reach here on a
 *  SECOND hop (`LegacyPathRedirect` first), and dropping either half there would silently undo
 *  what that hop just preserved. Plain Navigate — the target is outside every project. */
function MovedSettingsSectionRedirect({ sectionId }: { sectionId: SettingsSectionId }) {
  const location = useLocation()
  return (
    <Navigate
      to={{
        pathname: settingsSectionPath('global', sectionId),
        search: location.search,
        hash: location.hash,
      }}
      replace
    />
  )
}

/** What renders while a redirect target is still being resolved (the boot id from `/api/health`,
 *  the registry from `/api/projects`). Deliberately quiet: the answer arrives in one local round
 *  trip, and any real screen here would flash the WRONG screen (spec, "URL scheme"). */
function ScopeResolving() {
  return (
    <div data-route="scope-resolving" className="flex min-h-full flex-col">
      <p className="px-4 py-6 text-center text-xs text-soft-foreground">Loading…</p>
    </div>
  )
}

/**
 * The `/p/:projectId` layout gate (multi-project spec, step 3.2) — the ONE place the URL's
 * project id becomes the app's project scope:
 *
 *  - `/p/default/…` is the reserved alias for the boot project (never an allocated slug):
 *    normalized to the real slug with a `replace` navigation, so the address bar always names
 *    the project. Params, query and hash survive byte-for-byte.
 *  - an id the registry doesn't know renders the "not registered here" screen — the cockpit
 *    twin of the API's 404;
 *  - a known id mounts `ProjectScopeProvider`, which scopes the API client and the query
 *    cache for the whole routed subtree (`<Outlet />`).
 *
 * When `/api/projects` itself errors (server unreachable), the gate mounts the scope anyway:
 * known-ness cannot be verified, and the routed views' own error states are the honest surface
 * for an unreachable server — a permanent "Loading…" here would not be.
 */
function ProjectScopeRoute() {
  const { projectId = '' } = useParams()
  const location = useLocation()
  const projects = useProjects()
  const health = useHealth()

  if (projectId === 'default') {
    // The registry names the boot slug; health's additive `bootProject` (the same slug) is the
    // fallback when the registry query ERRORED. With neither and the registry still fetching,
    // stay quiet; with the registry errored and no fallback either, fall through — the
    // server-side `default` alias answers every `/api/p/default/*` route as the boot project,
    // so mounting the scope (whose routed views own the honest error states) beats a permanent
    // "Loading…" (the same doctrine as the projects-error path below).
    const boot =
      projects.data?.bootProject ?? (projects.isError ? health.data?.bootProject : undefined)
    if (boot !== undefined) {
      const rest = location.pathname.replace(/^\/p\/default(?=\/|$)/, '')
      return (
        <Navigate
          to={`/p/${encodeURIComponent(boot)}${rest || '/'}${location.search}${location.hash}`}
          replace
        />
      )
    }
    if (!projects.isError) return <ScopeResolving />
  }

  if (projects.data) {
    const known =
      projects.data.bootProject === projectId ||
      projects.data.projects.some((project) => project.id === projectId)
    if (!known) return <UnknownProjectRoute projectId={projectId} registry={projects.data} />
  } else if (!projects.isError) {
    return <ScopeResolving />
  }

  // The BOOT project mounts UNSCOPED (projectId null): the step-3.1 invariant keeps its API
  // requests byte-identical to the single-project cockpit — the protected legacy `/api/*`
  // surface — and its cache under the same `'default'`-led keys the shell chrome (which
  // renders outside this provider) already uses. Only non-boot projects pay the `/api/p/<id>`
  // prefix. Links carry the URL prefix either way (project-router falls back to the URL).
  const scopeId = projects.data?.bootProject === projectId ? null : projectId

  return (
    <ProjectScopeProvider projectId={scopeId}>
      {/* React Router keeps the matched child mounted when only this parent param changes.
          Project-local queries and mount-time state must instead start from the project the URL
          now names. Key the child boundary (not the provider, whose unmount resets API scope). */}
      <Outlet key={projectId} />
    </ProjectScopeProvider>
  )
}

/**
 * The composer, remounted per project (multi-project spec, step 3.4).
 *
 * A `/p/:projectId` param change alone re-renders the SAME `NewTaskRoute` instance — React
 * Router matches the same route element either way. That is fine for the queries (their keys
 * carry the scope) but wrong for the composer's mount-time state: the draft is read once from
 * the departing project's storage key, and the write-back effect would then persist it under
 * the arriving project's key — exactly the draft leak the per-project keys exist to prevent.
 * Keying on the project makes the swap a real unmount/mount, so the draft, the pickers and the
 * deep-link capture all start from the project the URL now names.
 */
function NewTaskProjectRoute() {
  const { projectId = '' } = useParams()
  return <NewTaskRoute key={projectId} />
}

/**
 * Legacy flat URLs — every pre-multi-project path, `/tasks/:id` bookmarks and the `/new?...`
 * bookmarklet grammar included — redirect to the boot project's scoped twin, preserving path,
 * query and hash byte-for-byte (BACKWARD_COMPATIBILITY.md protects the bookmarklet contract).
 * The exact bare root is the sole exception: once health and the registry settle, it may restore
 * the last valid project-scoped page THIS browser was on (localStorage, so a second client never
 * decides where this one lands). Any query/hash makes `/` explicit, so pasted links always win.
 * `replace` keeps Back from bouncing off either startup redirect.
 */
function LegacyPathRedirect() {
  const location = useLocation()
  const health = useHealth()
  const projects = useProjects()
  const resolvedBoot = health.data?.bootProject ?? projects.data?.bootProject
  const bootSourcesSettled =
    (health.data !== undefined || health.isError) &&
    (projects.data !== undefined || projects.isError)
  if (resolvedBoot === undefined && !bootSourcesSettled) return <ScopeResolving />
  // Health and the registry normally name the same boot project. If neither can answer after
  // both queries settle, the server-side `default` alias remains the no-config fallback.
  const boot = resolvedBoot ?? 'default'

  const isBareRoot =
    location.pathname === '/' && location.search === '' && location.hash === ''
  if (isBareRoot) {
    // The remembered location itself is local and synchronous; only the registry that validates
    // its project is still worth waiting for.
    if (projects.data === undefined && !projects.isError) return <ScopeResolving />

    const restored = locationToRestore(
      readStoredLastLocation(),
      projects.data,
      resolvedBoot,
    )
    if (restored !== null) return <Navigate to={restored} replace />
  }

  // A bare `/p` (or `/p/`) names no project — send it to the boot project's home rather than
  // minting a nonsense `/p/<boot>/p` path.
  const path = location.pathname === '/p' || location.pathname === '/p/' ? '/' : location.pathname
  return (
    <Navigate
      to={`/p/${encodeURIComponent(boot)}${path}${location.search}${location.hash}`}
      replace
    />
  )
}

export interface PageTitleContext {
  pageLabel: string | null
  taskId: string | null
}

const PAGE_TITLE_ROUTES = [
  { pattern: '/', pageLabel: 'Tasks' },
  // The global page. It is not project-scoped, so it never carries a `/p/` prefix to strip —
  // but it goes through the same table, because the browser title is one mechanism.
  { pattern: '/tasks', pageLabel: 'All tasks' },
  { pattern: '/new', pageLabel: 'New task' },
  { pattern: '/compare/:groupId', pageLabel: 'Compare' },
  { pattern: '/git/*', pageLabel: 'Git' },
  { pattern: '/github/*', pageLabel: 'GitHub' },
  { pattern: '/automations/*', pageLabel: 'Automations' },
  { pattern: '/skills', pageLabel: 'Skills' },
  { pattern: '/inbox', pageLabel: 'Inbox' },
  { pattern: '/workflows/*', pageLabel: 'Workflows' },
  { pattern: '/settings/*', pageLabel: 'Settings' },
] as const

/** Browser-title context from the project-relative route map; raw ids are lookup keys only. */
export function pageTitleContext(pathname: string): PageTitleContext {
  const projectPath = stripProjectPrefix(pathname)
  const task = matchPath({ path: '/tasks/:id/*', end: true }, projectPath)
  if (task) return { pageLabel: null, taskId: task.params.id ?? null }

  const route = PAGE_TITLE_ROUTES.find(({ pattern }) =>
    matchPath({ path: pattern, end: true }, projectPath),
  )
  return { pageLabel: route?.pageLabel ?? null, taskId: null }
}

/** The route map from the spec's "Routing — every surface is a URL" section.
 *
 *  Real URLs, not hash routes: the Hono server serves the built index.html for
 *  every non-/api GET (src/server/static-ui.ts `resolveGetRequest`), so each of
 *  these cold-loads and survives a refresh — `/p/…` paths included.
 *
 *  Every path lives under `/p/:projectId/` (multi-project spec, step 3.2) via the one
 *  `ProjectScopeRoute` layout above; the flat spellings below are relative to that prefix and
 *  stay stable — they are what teammates paste, and the legacy flat URLs redirect onto them.
 */
export function AppRoutes() {
  const capabilities = useHealth().data?.capabilities
  return (
    <Routes>
      <Route path="/p/:projectId" element={<ProjectScopeRoute />}>
        <Route index element={<TasksOverviewRoute />} />
        <Route path="new" element={<NewTaskProjectRoute />} />

        <Route
          path="tasks/:id"
          element={
            <Suspense fallback={<ThreadLoading />}>
              <TaskThreadRoute />
            </Suspense>
          }
        />
        <Route
          path="tasks/:id/changes"
          element={
            <Suspense fallback={<GitTabLoading tab="changes" />}>
              <TaskChangesRoute />
            </Suspense>
          }
        />
        <Route
          path="tasks/:id/files"
          element={
            <Suspense fallback={<GitTabLoading tab="files" />}>
              <TaskFilesRoute />
            </Suspense>
          }
        />
        <Route
          path="tasks/:id/commits"
          element={
            <Suspense fallback={<GitTabLoading tab="changes" />}>
              <TaskCommitsRoute />
            </Suspense>
          }
        />
        <Route
          path="tasks/:id/commits/:sha"
          element={
            <Suspense fallback={<GitTabLoading tab="changes" />}>
              <TaskCommitsRoute />
            </Suspense>
          }
        />
        <Route
          path="compare/:groupId"
          element={
            <Suspense fallback={<CompareLoading />}>
              <CompareVariantsRoute />
            </Suspense>
          }
        />

        {/* The repo view (R5 Step 1.7): each segment is a URL — /git (working-tree changes),
            /git/commits (+ /:sha for one commit's diff), /git/branches. */}
        <Route
          path="git"
          element={
            <Suspense fallback={<RepoGitLoading />}>
              <RepoGitRoute tab="changes" />
            </Suspense>
          }
        />
        <Route
          path="git/commits"
          element={
            <Suspense fallback={<RepoGitLoading />}>
              <RepoGitRoute tab="commits" />
            </Suspense>
          }
        />
        <Route
          path="git/commits/:sha"
          element={
            <Suspense fallback={<RepoGitLoading />}>
              <RepoGitRoute tab="commits" />
            </Suspense>
          }
        />
        <Route
          path="git/branches"
          element={
            <Suspense fallback={<RepoGitLoading />}>
              <RepoGitRoute tab="branches" />
            </Suspense>
          }
        />
        {/* The GitHub tab (R6 Step 1.1): issues and PRs are separate list URLs, each item a
            deep link. The nav item is forge-gated in the shell; the routes stay reachable so a
            pasted link renders the honest unavailable explainer instead of a 404. The bare
            `/github` is the one URL that restores the last-selected tab (#417) — `/github/prs`
            and the `:n` deep links are always exactly what they say. */}
        <Route
          path="github"
          element={
            <Suspense fallback={<GithubLoading />}>
              <GithubIndexRoute />
            </Suspense>
          }
        />
        <Route
          path="github/prs"
          element={
            <Suspense fallback={<GithubLoading />}>
              <GithubRoute view="prs" />
            </Suspense>
          }
        />
        <Route
          path="github/issues/:n"
          element={
            <Suspense fallback={<GithubLoading />}>
              <GithubRoute view="issues" />
            </Suspense>
          }
        />
        <Route
          path="github/prs/:n"
          element={
            <Suspense fallback={<GithubLoading />}>
              <GithubRoute view="prs" />
            </Suspense>
          }
        />
        <Route
          path="github/prs/:n/changes"
          element={
            <Suspense fallback={<GithubLoading />}>
              <GithubRoute view="prs" changes />
            </Suspense>
          }
        />
        <Route path="automations" element={<AutomationsRoute />} />
        <Route path="automations/new" element={<AutomationsRoute mode="new" />} />
        <Route path="automations/:automationId" element={<AutomationsRoute mode="edit" />} />
        <Route path="automations/:automationId/log" element={<AutomationsRoute mode="log" />} />

        {/* The skills catalog (R6 Step 1.4) — its own top-level surface, no settings sub-nav.
            `/settings/skills` redirects here (below) so pasted links keep working. */}
        <Route
          path="skills"
          element={
            <Suspense fallback={<SkillsLoading />}>
              <SkillsRoute />
            </Suspense>
          }
        />

        {/* The follow-up inbox (R6 Step 1.2): light — no markdown stack — so it rides the main
            bundle like the overview does. */}
        <Route path="inbox" element={<InboxRoute />} />

        {/* The workflow builder (R6 Step 1.6): /workflows opens the canvas on the repo's first
            saved chain, /workflows/:name deep-links a specific one. */}
        <Route
          path="workflows"
          element={
            <Suspense fallback={<WorkflowsLoading />}>
              <WorkflowsRoute />
            </Suspense>
          }
        />
        <Route
          path="workflows/:name"
          element={
            <Suspense fallback={<WorkflowsLoading />}>
              <WorkflowsRoute />
            </Suspense>
          }
        />

        {/* Settings (R6 Step 1.3): registry-driven — the section list, nav and routes all come
            from routes/settings/registry.tsx. Hidden sections are NOT routed, so their URLs are
            honest 404s until the section ships (notifications unhides in Step 1.7).

            Only the PROJECT-scoped sections live here (multi-project spec, step 3.5); the
            global ones are the top-level `/settings/global/*` block below. */}
        <Route path="settings" element={<SettingsIndexRoute scope="project" capabilities={capabilities} />} />
        <Route path="settings/skills" element={<SettingsSkillsRedirect />} />
        {visibleSettingsSections('project', capabilities).map((section) => (
          <Route
            key={section.id}
            path={`settings/${section.id}`}
            element={<SettingsSectionRoute section={section} scope="project" capabilities={capabilities} />}
          />
        ))}
        {/* A section that MOVED out of the project area keeps its old URL working: every
            pre-3.5 bookmark and every legacy flat `/settings/appearance` (which the redirect
            below turns into `/p/<boot>/settings/appearance`) lands on the global twin instead
            of a 404 — query and hash intact across both hops. */}
        {visibleSettingsSections('global', capabilities).map((section) => (
          <Route
            key={section.id}
            path={`settings/${section.id}`}
            element={<MovedSettingsSectionRedirect sectionId={section.id} />}
          />
        ))}

        <Route path="*" element={<NotFoundRoute />} />
      </Route>

      {/* The global Tasks page — the second cockpit area outside `/p/:projectId`, and outside it
          for the same reason global settings are: "every project's tasks" scoped to one project
          is a contradiction. Its data is the workspace-level run index, which is never
          scope-prefixed.

          EXACTLY `/tasks`, never `/tasks/*`: `/tasks/:id` is a legacy flat task link and must
          keep redirecting to the boot project's thread (`LegacyPathRedirect` below owns it).
          React Router ranks this static segment above that `*`, so the two never compete. */}
      <Route path="/tasks" element={<GlobalTasksRoute />} />

      {/* Global settings (multi-project spec, step 3.5) — the one cockpit area that is NOT
          under `/p/:projectId`, because nothing here belongs to a project: appearance and
          notifications are the user's, resources are the machine's, and the Projects pane IS
          the registry. No `ProjectScopeProvider` above it, so its sections must read/write the
          workspace routes (`/api/workspace/*`), which are never scope-prefixed.

          Static segments outrank the `*` legacy redirect below in React Router's ranking, so
          these win regardless of order — listed here for readability. */}
      <Route path="/settings/global" element={<SettingsIndexRoute scope="global" capabilities={capabilities} />} />
      {visibleSettingsSections('global', capabilities).map((section) => (
        <Route
          key={section.id}
          path={settingsSectionPath('global', section.id)}
          element={<SettingsSectionRoute section={section} scope="global" capabilities={capabilities} />}
        />
      ))}

      {/* Everything else IS a legacy flat URL — the boot-project redirect owns it. The 404 for
          truly unknown paths still renders, scoped, after the redirect. */}
      <Route path="*" element={<LegacyPathRedirect />} />
    </Routes>
  )
}
