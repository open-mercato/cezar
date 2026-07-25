import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'

import { mergeProviderStatusResponse } from '@/lib/provider-status'

import {
  browseFs,
  checkoutProject,
  getAgentConfig,
  getAgentConfigFile,
  getConfig,
  getGithub,
  getGithubComments,
  getGithubPrChanges,
  getGroup,
  getHealth,
  getLaunchKey,
  getOpenTargets,
  getProviderStatus,
  getProjectRuns,
  getProjects,
  getRunnerModels,
  getRepo,
  getRunCommit,
  getRunCommits,
  getRepoChanges,
  getRepoCommit,
  getRun,
  getRunChanges,
  getRunDiff,
  getRunFile,
  getRunHandoff,
  getRuns,
  getImportableSkills,
  getImportableSkillsWhenReady,
  getSkills,
  getSkillsWhenReady,
  getTodos,
  getUiState,
  getWorkflows,
  getWorkspaceConfig,
  getWorkspaceUiState,
  getSkillsUpdate,
  checkSkillsUpdate,
  applySkillsUpdate,
  getWorktrees,
  editQueuedMessage,
  patchRun,
  removeQueuedMessage,
  registerProject,
  removeProject,
  updateProject,
  sendMessage,
  putAgentConfigFile,
  retryProviderAuth,
} from './client'
import { queryScope } from './project-scope'
import type {
  CheckoutProjectInput,
  HealthResponse,
  MessageInput,
  PatchRunInput,
  ProviderId,
  ProviderStatusResponse,
  SetAgentConfigInput,
  UpdateProjectInput,
} from './types'
import { subscribeTopic } from './ws'

/**
 * Query keys, in one place and exported, because they are a contract rather than an
 * implementation detail: Step 3.2's stream handlers invalidate and reconcile *these* keys when
 * an event says the data behind them moved. A key spelled inline at a call site is a key
 * nothing can invalidate.
 *
 * Hierarchical on purpose — `queryKeys.runs.all` invalidates the list and every single-run
 * query under it in one call.
 *
 * Every key leads with the ACTIVE project scope (multi-project spec, step 3.1): the registered
 * project id, or the stable `'default'` sentinel when unscoped — read at access time via
 * `queryScope()`, which is why the constant keys are getters. One cache, never bleeding across
 * projects: project A's `['a','runs','list']` and project B's `['b','runs','list']` are simply
 * different entries, and a scoped invalidation (`queryKeys.runs.all` under scope A) can only
 * ever reach A's data. Call sites are unchanged — they keep writing `queryKeys.runs.list()`.
 */
export const queryKeys = {
  get health() {
    return [queryScope(), 'health'] as const
  },
  runs: {
    get all() {
      return [queryScope(), 'runs'] as const
    },
    list: () => [queryScope(), 'runs', 'list'] as const,
    detail: (id: string) => [queryScope(), 'runs', 'detail', id] as const,
    diff: (id: string) => [queryScope(), 'runs', 'diff', id] as const,
    changes: (id: string) => [queryScope(), 'runs', 'changes', id] as const,
    file: (id: string, path: string) => [queryScope(), 'runs', 'files', id, path] as const,
    handoff: (id: string) => [queryScope(), 'runs', 'handoff', id] as const,
    commits: (id: string) => [queryScope(), 'runs', 'commits', id] as const,
    commit: (id: string, sha: string) => [queryScope(), 'runs', 'commit', id, sha] as const,
  },
  groups: {
    detail: (groupId: string) => [queryScope(), 'groups', groupId] as const,
  },
  get todos() {
    return [queryScope(), 'todos'] as const
  },
  get workflows() {
    return [queryScope(), 'workflows'] as const
  },
  get skills() {
    return [queryScope(), 'skills'] as const
  },
  get skillsReady() {
    return [queryScope(), 'skills', 'ready'] as const
  },
  /** Children of `skills`: the "Import skills" panel's opt-in catalog. Sharing the `skills`
   *  prefix means a refresh that invalidates the catalog re-reads the importable list too. */
  get importableSkills() {
    return [queryScope(), 'skills', 'importable'] as const
  },
  get importableSkillsReady() {
    return [queryScope(), 'skills', 'importable', 'ready'] as const
  },
  get launchKey() {
    return [queryScope(), 'launch-key'] as const
  },
  get repo() {
    return [queryScope(), 'repo'] as const
  },
  /** Children of `repo` on purpose: invalidating `queryKeys.repo` (a branch switch, a new
   *  commit) prefix-matches the working-tree diff and every cached commit diff too. */
  get repoChanges() {
    return [queryScope(), 'repo', 'changes'] as const
  },
  repoCommit: (sha: string) => [queryScope(), 'repo', 'commit', sha] as const,
  get uiState() {
    return [queryScope(), 'ui-state'] as const
  },
  /** The Settings → Agents knobs (`GET /api/config`, R6 1.5). */
  get config() {
    return [queryScope(), 'config'] as const
  },
  get agentConfig() {
    return [queryScope(), 'agent-config'] as const
  },
  agentConfigFile: (id: string) => [queryScope(), 'agent-config', 'file', id] as const,
  /** The worktree management panel (`GET /api/worktrees`, #483). */
  get worktrees() {
    return [queryScope(), 'worktrees'] as const
  },
  github: (params: { limit?: number } = {}) => [queryScope(), 'github', params.limit ?? null] as const,
  githubComments: (kind: 'issue' | 'pr', number: number) =>
    [queryScope(), 'github', 'comments', kind, number] as const,
  get openTargets() {
    return [queryScope(), 'open-targets'] as const
  },
}

/**
 * Workspace-level keys — deliberately NOT scope-led: there is one project registry no matter
 * which project is active, and the `/p/:projectId` route gate reads it while the scope is
 * still being decided, so a scope-dependent key would chase its own tail (mount provider →
 * scope changes → key changes → data gone → provider unmounts).
 */
export const workspaceQueryKeys = {
  models: (runner: string) => ['workspace', 'models', runner] as const,
  providerStatus: ['workspace', 'providers', 'status'] as const,
  projects: ['workspace', 'projects'] as const,
  /** `~/.cezar/ui-state.json` via `GET/PUT /api/workspace/ui-state` (step 2.7) — cross-project
   *  GUI prefs, e.g. the sidebar's per-project collapse map (step 3.3), and — since step 3.5 —
   *  appearance + notifications, which describe the user rather than a repo. */
  uiState: ['workspace', 'ui-state'] as const,
  /** `~/.cezar/config.json`'s settings slice via `GET/PUT /api/workspace/config` (step 2.7):
   *  the global Resources knobs and the checkout root. */
  config: ['workspace', 'config'] as const,
  skillsUpdate: (projectId: string) => ['workspace', 'skills-update', projectId] as const,
  /** One directory listing from `GET /api/fs/browse` (step 4.2's folder picker). Keyed by the
   *  browsed path — `null` is the browse root, whose absolute location only the server knows.
   *  Not scope-led: there is one filesystem behind the workspace, not one per project. */
  fsBrowseRoot: ['workspace', 'fs-browse'] as const,
  fsBrowse: (path: string | null) => [...workspaceQueryKeys.fsBrowseRoot, path] as const,
}

/** `enabled` lets a caller that only MIGHT render the model pills (the thread's Continue —
 *  hooks cannot be called conditionally) skip the fetch when it definitely won't. */
export function useRunnerModels(enabled = true) {
  return useQuery({
    queryKey: workspaceQueryKeys.models('codex'),
    queryFn: ({ signal }) => getRunnerModels({ signal }),
    staleTime: 5 * 60 * 1_000,
    enabled,
  })
}

export function useProviderStatus() {
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: workspaceQueryKeys.providerStatus,
    queryFn: async ({ signal }) => {
      const requestStart = queryClient.getQueryData<ProviderStatusResponse>(
        workspaceQueryKeys.providerStatus,
      )
      const response = await getProviderStatus(false, { signal })
      return mergeProviderStatusResponse(
        requestStart,
        queryClient.getQueryData(workspaceQueryKeys.providerStatus),
        response,
      )
    },
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  })
}

export function useRefreshProviderStatus() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => getProviderStatus(true),
    onMutate: () => queryClient.getQueryData<ProviderStatusResponse>(workspaceQueryKeys.providerStatus),
    onSuccess: (result, _variables, requestStart) => queryClient.setQueryData<ProviderStatusResponse>(
      workspaceQueryKeys.providerStatus,
      (cached) => mergeProviderStatusResponse(requestStart, cached, result),
    ),
  })
}

export function useRetryProviderAuth() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      provider,
      authFailureId,
    }: {
      provider: ProviderId
      authFailureId: string
    }) => retryProviderAuth(provider, authFailureId),
    onMutate: () => queryClient.getQueryData<ProviderStatusResponse>(workspaceQueryKeys.providerStatus),
    onSuccess: (result, variables, requestStart) => {
      queryClient.setQueryData<ProviderStatusResponse>(workspaceQueryKeys.providerStatus, (cached) =>
        mergeProviderStatusResponse(requestStart, cached, result, variables.authFailureId))
    },
  })
}

/** The workspace project registry (`GET /api/projects`): the `/p/:projectId` route gate's
 *  known/unknown answer, the boot slug behind the `/p/default` alias, and the list the
 *  unknown-project screen offers. Step 3.3's sidebar reads it too. */
export function useProjects() {
  return useQuery({
    queryKey: workspaceQueryKeys.projects,
    queryFn: ({ signal }) => getProjects({ signal }),
  })
}

/** One directory listing for the add-project folder picker (step 4.2). `path: null` asks for
 *  the browse root. Retries are off: the interesting failures here are the deliberate 400/404s
 *  (outside the root, no such directory) — re-asking cannot change those answers, and the
 *  dialog shows the server's own words instead. */
export function useFsBrowse(path: string | null) {
  return useQuery({
    queryKey: workspaceQueryKeys.fsBrowse(path),
    queryFn: ({ signal }) => browseFs(path ?? undefined, { signal }),
    retry: false,
  })
}

/**
 * Register a browsed folder (`POST /api/projects`, step 4.2).
 *
 * Invalidates the registry so the sidebar grows the new project WITHOUT a reload — the caller
 * navigates to `/p/<id>/` on success, and the `/p/:projectId` route gate reads that same query
 * to decide the id is known, so a stale list would bounce a just-added project to the
 * unknown-project screen.
 *
 * A 409 (already registered) resolves rather than rejects — see `registerProject` in client.ts;
 * the caller navigates to the existing entry either way.
 */
export function useRegisterProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (root: string) => registerProject(root),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.projects }),
  })
}

/**
 * Clone a GitHub repo into the checkout root and register it (`POST /api/projects/checkout`,
 * step 4.3). Same registry invalidation as `useRegisterProject` and for the same reason — the
 * caller navigates to `/p/<id>/`, and the route gate reads that query to decide the id is known.
 *
 * No retry: a clone is a long, side-effecting call. Re-running it after a failure would race
 * the server's own cleanup of the partial directory and land on the 409 instead of the real
 * error, which is precisely the confusing outcome the cleanup exists to prevent.
 */
/**
 * Deregister a project (`DELETE /api/projects/:projectId`, step 4.4 — Settings → Projects).
 *
 * Same registry invalidation as the two add paths, for the mirror reason: the sidebar must
 * LOSE the group without a reload. The server also emits `project-removed` on the workspace
 * stream, which invalidates the same key for every OTHER open tab (global-events.tsx) — this
 * one is for the tab that pressed the button, whose own answer arrives before the event.
 *
 * No retry: the interesting failures are the deliberate 409s (running tasks, the boot
 * project), and re-asking cannot change those answers.
 */
export function useRemoveProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (projectId: string) => removeProject(projectId),
    retry: false,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.projects }),
  })
}

/**
 * Set or clear a project's per-project concurrency ceiling
 * (`PATCH /api/projects/:projectId`, spec 2026-07-22 — Settings → Projects).
 *
 * Same registry invalidation as the add/remove paths: the pane reads the ceiling
 * off the projects query, so the row must reflect the new value without a reload.
 * No retry — an out-of-range value or unknown id (400/404) is a deterministic
 * refusal re-asking cannot change.
 */
export function useUpdateProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (variables: { id: string } & UpdateProjectInput) =>
      updateProject(variables.id, { maxParallel: variables.maxParallel }),
    retry: false,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.projects }),
  })
}

export function useCheckoutProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CheckoutProjectInput) => checkoutProject(input),
    retry: false,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.projects }),
  })
}

/**
 * The ONE session-long `health` topic subscription. Call it exactly once, at the app root
 * (`GlobalEventsProvider`) — never from `useHealth`.
 *
 * Health is a SESSION-GLOBAL signal: it feeds the always-present shell (the repo/branch chip,
 * the version chip, forge/inbox nav gating, the Tools menu), so its demand is the whole session,
 * not any one view. Subscribing per `useHealth` consumer instead would tie that global signal to
 * ~15 component lifecycles — the topic would flap `subscribe`/`unsubscribe` on every mount,
 * unmount and StrictMode remount, and would drop entirely for any instant no consumer happened
 * to be mounted. One root-level subscription keeps it live continuously, so the cockpit is
 * always notified when health changes; the `useHealth` readers below just read the cache it fills.
 *
 * The cache key is read inside the callback (`queryKeys.health` is a scope-aware getter), so a
 * project switch routes each pushed snapshot to the active scope's cache without re-subscribing.
 */
export function useHealthSubscription(): void {
  const queryClient = useQueryClient()
  useEffect(
    () =>
      subscribeTopic('health', (data) => {
        queryClient.setQueryData(queryKeys.health, data as HealthResponse)
      }),
    [queryClient],
  )
}

/** Version + update check + repo/branch + tool probes. Feeds the sidebar's repo and version
 *  chips and (Step 4.2) the Tools menu.
 *
 * A pure read: the HTTP query is the authoritative bootstrap and the reconcile target
 * (global-events.tsx invalidates it on reconnect/visibility), and live updates arrive by the
 * one `useHealthSubscription` at the root folding pushed `/api/ws` frames into this same cache
 * (#369 — this replaced the old 5 s `refetchInterval` per tab). Safe to call from as many
 * components as need health; they all read one cache and none of them touches the socket. */
export function useHealth() {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: ({ signal }) => getHealth({ signal }),
  })
}

/** The local "Open in…" targets (#open-in). Machine-level and stable, so it caches broadly;
 *  empty in hosted mode. */
export function useOpenTargets() {
  return useQuery({
    queryKey: queryKeys.openTargets,
    queryFn: ({ signal }) => getOpenTargets({ signal }),
    staleTime: 5 * 60_000,
  })
}

/** The authoritative run list. */
export function useRuns() {
  return useQuery({
    queryKey: queryKeys.runs.list(),
    queryFn: ({ signal }) => getRuns({ signal }),
  })
}

/**
 * One project's run list by EXPLICIT id — the sidebar's per-group task lists (step 3.3), which
 * must read projects the mounted scope cannot reach. Keyed `[projectId, 'runs', 'list']`: for
 * the ACTIVE project that is the very entry `useRuns()` fills and the stream patches, so the
 * two views share one cache; for any other project it is that project's own entry, kept fresh
 * by refetch-on-expand rather than by the stream (the stream filter applies only the active
 * scope's events). `enabled: false` parks the fetch — a COLLAPSED group costs one registry
 * row, never a runs request (spec, "40 registered projects" row) — while still reading any
 * cached answer, which is what lets a collapsed group keep its attention badge.
 *
 * `boot: true` aliases the key scope to `'default'`: the boot project mounts UNSCOPED
 * (routes.tsx keeps its legacy `/api/*` surface), so its main view and the SSE patcher both
 * live under the `'default'`-led keys — the boot group must read that SAME entry, or its list
 * and needs-you badge freeze at whatever the expand-time fetch answered. The fetch itself
 * still goes to `/api/p/<bootId>/runs`, which the server answers byte-identically (the
 * route-parity contract).
 */
export function useProjectRuns(projectId: string, enabled = true, boot = false) {
  return useQuery({
    queryKey: [boot ? 'default' : projectId, 'runs', 'list'] as const,
    queryFn: ({ signal }) => getProjectRuns(projectId, { signal }),
    enabled,
  })
}

/** One run, authoritative. `id` may be absent while a route param is still unresolved. */
export function useRun(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.runs.detail(id ?? ''),
    queryFn: ({ signal }) => getRun(id as string, { signal }),
    enabled: Boolean(id),
  })
}

export function useRunDiff(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.runs.diff(id ?? ''),
    queryFn: ({ signal }) => getRunDiff(id as string, { signal }),
    enabled: Boolean(id),
  })
}

/** The structured worktree diff behind the Changes tab (R5). A 409 ("no worktree — …") is a
 *  real answer here, not a network hiccup — retrying cannot change it, so retries are off and
 *  the view renders the server's own reason. */
export function useRunChanges(id: string | undefined, live = false) {
  return useQuery({
    queryKey: queryKeys.runs.changes(id ?? ''),
    queryFn: ({ signal }) => getRunChanges(id as string, { signal }),
    enabled: Boolean(id),
    retry: false,
    // While the run is active the agent is still writing — poll so the Changes tab keeps up
    // instead of showing a stale empty snapshot from before the first write (#changes-live).
    refetchInterval: live ? 4000 : false,
    // Once a run finishes, polling stops (live === false) — but final agent/post-run-hook
    // writes and the user editing files in the worktree still change the diff. Scope a
    // focus refetch and a zero staleTime to THIS query (the global client keeps
    // refetchOnWindowFocus off + a 5-min staleTime, #query-client) so returning to a finished
    // task's Changes tab re-fetches instead of serving the last, possibly-empty snapshot.
    refetchOnWindowFocus: true,
    staleTime: 0,
  })
}

/** One worktree path for the Files tab (R5): the root/dir listings the tree lazy-loads and
 *  the file entries the preview renders. `path` is '' for the worktree root and `undefined`
 *  while nothing is selected. Like /changes, a 409 ("no worktree — …") is an answer retries
 *  cannot change, so retries are off. Cached per (run, path) — re-expanding a folder is free. */
export function useRunFile(id: string | undefined, path: string | undefined) {
  return useQuery({
    queryKey: queryKeys.runs.file(id ?? '', path ?? ''),
    queryFn: ({ signal }) => getRunFile(id as string, path as string, { signal }),
    enabled: Boolean(id) && path !== undefined,
    retry: false,
  })
}

/** The variant-compare data for `/compare/:groupId` (spec 010). Freshness while variants are
 *  still running is the ROUTE's concern: the group endpoint is not on the SSE stream, so the
 *  compare view invalidates this key when the run list (which IS stream-patched) shows a member
 *  changing state — no polling, per the sync doctrine. */
export function useGroup(groupId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.groups.detail(groupId ?? ''),
    queryFn: ({ signal }) => getGroup(groupId as string, { signal }),
    enabled: Boolean(groupId),
  })
}

/** A run's commit list (Commits tab). Polls while active so new commits appear as the agent
 *  autosaves. A 409 ("no worktree") is a real answer retries can't change. */
export function useRunCommits(id: string | undefined, live = false) {
  return useQuery({
    queryKey: queryKeys.runs.commits(id ?? ''),
    queryFn: ({ signal }) => getRunCommits(id as string, { signal }),
    enabled: Boolean(id),
    retry: false,
    refetchInterval: live ? 5000 : false,
  })
}

/** One of a run's commits, structured like the Changes tab. */
export function useRunCommit(id: string | undefined, sha: string | undefined) {
  return useQuery({
    queryKey: queryKeys.runs.commit(id ?? '', sha ?? ''),
    queryFn: ({ signal }) => getRunCommit(id as string, sha as string, { signal }),
    enabled: Boolean(id) && Boolean(sha),
    retry: false,
  })
}

/** The handoff journal behind the header's Notes panel. `enabled` gates the fetch on the panel
 *  actually being open — notes are read on demand, not on every thread visit. */
export function useRunHandoff(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.runs.handoff(id ?? ''),
    queryFn: ({ signal }) => getRunHandoff(id as string, { signal }),
    enabled: Boolean(id) && enabled,
  })
}

/** The follow-up inbox. Drives the nav badge. */
/** The follow-up inbox. `enabled: false` (the caller passing `false` while
 *  `capabilities.followups` is off, #471) parks the query instead of polling an
 *  endpoint that can only answer `[]` — `data` stays undefined, which the inbox
 *  badge already reads as "no badge". */
export function useTodos(enabled = true) {
  return useQuery({
    queryKey: queryKeys.todos,
    queryFn: ({ signal }) => getTodos({ signal }),
    enabled,
  })
}

export function useWorkflows() {
  return useQuery({
    queryKey: queryKeys.workflows,
    queryFn: ({ signal }) => getWorkflows({ signal }),
  })
}

/** `enabled` gates the fetch for surfaces that need skills only once interacted with — the
 *  composer's `/` autocomplete fetches on first trigger, never on every thread visit. (The
 *  palette gets the same laziness structurally: its content mounts only while open.) */
export function useSkills(enabled = true) {
  const queryClient = useQueryClient()
  const skillsKey = queryKeys.skills
  const skillsScope = skillsKey[0]
  const skills = useQuery({
    queryKey: skillsKey,
    queryFn: ({ signal }) => getSkills({ signal }),
    enabled,
  })
  const ready = useQuery({
    queryKey: queryKeys.skillsReady,
    queryFn: ({ signal }) => getSkillsWhenReady({ signal }),
    enabled: enabled && skills.isSuccess,
    staleTime: Infinity,
    retry: false,
  })

  useEffect(() => {
    // Treat the follow-up as best-effort. The fast catalog remains authoritative
    // if an older server/proxy answers this additive request unexpectedly.
    if (Array.isArray(ready.data)) queryClient.setQueryData([skillsScope, 'skills'], ready.data)
  }, [queryClient, ready.data, skillsScope])

  return skills
}

/** The opt-in catalog for the "Import skills" panel — the default (vendor) repo's full skill
 *  list, regardless of import state. Same fast-then-`wait=1` convergence as `useSkills`: the
 *  panel renders whatever the cache holds immediately, then the cold-clone wait fills it in. */
export function useImportableSkills(enabled = true) {
  const queryClient = useQueryClient()
  const importableKey = queryKeys.importableSkills
  const scope = importableKey[0]
  const importable = useQuery({
    queryKey: importableKey,
    queryFn: ({ signal }) => getImportableSkills({ signal }),
    enabled,
  })
  const ready = useQuery({
    queryKey: queryKeys.importableSkillsReady,
    queryFn: ({ signal }) => getImportableSkillsWhenReady({ signal }),
    enabled: enabled && importable.isSuccess,
    staleTime: Infinity,
    retry: false,
  })

  useEffect(() => {
    // Best-effort, like useSkills: seed the fast list from the converged one.
    if (Array.isArray(ready.data)) queryClient.setQueryData([scope, 'skills', 'importable'], ready.data)
  }, [queryClient, ready.data, scope])

  return importable
}

/** The bookmarklet auto-start secret (spec 011). Mounted ONLY by the Settings → Skills
 *  bookmarklet panel, which bakes it into the generated `javascript:` links exactly like the
 *  legacy generator did. The key never renders as text and never goes back into a URL bar. */
export function useLaunchKey() {
  return useQuery({
    queryKey: queryKeys.launchKey,
    queryFn: ({ signal }) => getLaunchKey({ signal }),
    // The key is stable for the server's lifetime — refetching it buys nothing.
    staleTime: Infinity,
  })
}

export function useRepo() {
  return useQuery({
    queryKey: queryKeys.repo,
    queryFn: ({ signal }) => getRepo({ signal }),
  })
}

/** The main working tree's structured diff behind the repo view's Changes section (R5 1.7).
 *  Same 409 stance as `useRunChanges`: "not a git repository" is an answer, not a hiccup. */
export function useRepoChanges() {
  return useQuery({
    queryKey: queryKeys.repoChanges,
    queryFn: ({ signal }) => getRepoChanges({ signal }),
    retry: false,
  })
}

/** One commit's structured diff (R5 repo view). A 409 ("unknown commit") is an answer retries
 *  cannot change. Cached per sha — commit history is immutable, so revisits are free. */
export function useRepoCommit(sha: string | undefined) {
  return useQuery({
    queryKey: queryKeys.repoCommit(sha ?? ''),
    queryFn: ({ signal }) => getRepoCommit(sha as string, { signal }),
    enabled: Boolean(sha),
    retry: false,
  })
}

/** The Settings → Agents knobs (R6 1.5): base branch, default runner, system prompt, per-runner
 *  model presets. The composer reads it too — `defaultModels` preselects its Model pill. */
export function useConfig() {
  return useQuery({
    queryKey: queryKeys.config,
    queryFn: ({ signal }) => getConfig({ signal }),
  })
}

/** The worktree management panel (#483). Invalidated by the global event stream when a run
 *  finishes or is reclaimed, so the on-disk list and total stay live while the panel is open. */
export function useWorktrees() {
  return useQuery({
    queryKey: queryKeys.worktrees,
    queryFn: ({ signal }) => getWorktrees({ signal }),
  })
}

export function useUiState() {
  return useQuery({
    queryKey: queryKeys.uiState,
    queryFn: ({ signal }) => getUiState({ signal }),
  })
}

/** The selected project's agent-owned config files and precedence metadata. */
export function useAgentConfig() {
  return useQuery({
    queryKey: queryKeys.agentConfig,
    queryFn: ({ signal }) => getAgentConfig({ signal }),
  })
}

export function useAgentConfigFile(id: string | null) {
  return useQuery({
    queryKey: queryKeys.agentConfigFile(id ?? ''),
    queryFn: ({ signal }) => getAgentConfigFile(id as string, { signal }),
    enabled: id !== null,
  })
}

export function usePutAgentConfigFile(id: string) {
  const queryClient = useQueryClient()
  // Capture the scope at hook render time. A save may finish after the user has
  // switched projects; recomputing these getters in onSuccess would otherwise
  // write the previous project's response into the newly active cache.
  const listingKey = queryKeys.agentConfig
  const fileKey = queryKeys.agentConfigFile(id)
  return useMutation({
    mutationFn: (body: SetAgentConfigInput) => putAgentConfigFile(id, body),
    onSuccess: (result) => {
      queryClient.setQueryData(fileKey, result)
      void queryClient.invalidateQueries({ queryKey: listingKey })
    },
  })
}

/** The cross-project GUI state (`~/.cezar/ui-state.json`). Read once and cached — the sidebar
 *  applies its own writes optimistically and PUTs behind a debounce, so nothing polls this. */
export function useWorkspaceUiState() {
  return useQuery({
    queryKey: workspaceQueryKeys.uiState,
    queryFn: ({ signal }) => getWorkspaceUiState({ signal }),
  })
}

/** The global settings slice of `~/.cezar/config.json` — Settings → Resources (step 3.5) and
 *  the Projects pane's checkout root (step 4.4). Not scope-led: one workspace, one answer. */
export function useWorkspaceConfig() {
  return useQuery({
    queryKey: workspaceQueryKeys.config,
    queryFn: ({ signal }) => getWorkspaceConfig({ signal }),
  })
}

export function useSkillsUpdate(projectId: string, enabled = true) {
  return useQuery({
    queryKey: workspaceQueryKeys.skillsUpdate(projectId),
    queryFn: ({ signal }) => getSkillsUpdate(projectId, { signal }),
    enabled,
    // GET deliberately answers the current snapshot and starts a stale check in the
    // background. Poll only while that snapshot is transient so an initial `idle`
    // response converges without turning every open cockpit into a permanent poller.
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return status === undefined || status === 'idle' || status === 'checking' || status === 'updating'
        ? 1_000
        : false
    },
  })
}

export function useCheckSkillsUpdate(projectId: string) {
  const queryClient = useQueryClient()
  const key = workspaceQueryKeys.skillsUpdate(projectId)
  return useMutation({
    mutationFn: () => checkSkillsUpdate(projectId),
    onSuccess: (state) => queryClient.setQueryData(key, state),
  })
}

export function useApplySkillsUpdate(projectId: string) {
  const queryClient = useQueryClient()
  const key = workspaceQueryKeys.skillsUpdate(projectId)
  return useMutation({ mutationFn: () => applySkillsUpdate(projectId), onSuccess: (state) => queryClient.setQueryData(key, state) })
}

/** Rename a run (#389): `PATCH /api/runs/:id`. Invalidates `runs.*` so the list and the detail
 *  view refetch the authoritative record. The run header's inline title edit sits on this. */
export function usePatchRun(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (patch: PatchRunInput) => patchRun(id, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
  })
}

/** Deliver a reply into a live session (`POST /api/runs/:id/messages`). The transcript itself
 *  grows over SSE (`user-message`, then the agent's turn); the invalidation refreshes the
 *  record (status flips waiting → running). Errors are the CALLER's to surface — the composer
 *  restores the draft and toasts, so no toast fires here. */
export function useSendMessage(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (message: MessageInput) => sendMessage(id, message),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
  })
}

/** Edit a message stacked on a queued run (`PATCH /api/runs/:id/queued-messages/:msgId`, #472).
 *  Invalidates `runs.*` so the thread re-renders from the authoritative record — the stack lives
 *  on the record, not in the event stream. Errors are the CALLER's to surface, as with
 *  `useSendMessage`: a 409 means the run started, and the bubble goes read-only on the next
 *  frame anyway. */
export function useEditQueuedMessage(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ msgId, message }: { msgId: string; message: MessageInput }) =>
      editQueuedMessage(id, msgId, message),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
  })
}

/** Remove a message stacked on a queued run (`DELETE /api/runs/:id/queued-messages/:msgId`). */
export function useRemoveQueuedMessage(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (msgId: string) => removeQueuedMessage(id, msgId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
  })
}

/** Issues + PRs through the forge (`/api/github`). `enabled` exists for the GitHub tab's
 *  legacy two-shot load: the background everything-open fetch (limit 1000) waits until the
 *  fast default batch has proven the forge reachable — no point paying the big `gh` call
 *  twice just to learn "unavailable" twice. */
export function useGithub(params: { limit?: number } = {}, enabled = true) {
  return useQuery({
    queryKey: queryKeys.github(params),
    queryFn: ({ signal }) => getGithub({ limit: params.limit }, { signal }),
    enabled,
  })
}

/** The comment thread for one issue/PR (`/api/github/comments/…`, #499). Fetched only while a
 *  detail view is mounted (`enabled`); `staleTime` aligns with the 60 s server cache so switching
 *  back to an item doesn't re-hit gh. */
export function useGithubComments(kind: 'issue' | 'pr', number: number, enabled = true) {
  return useQuery({
    queryKey: queryKeys.githubComments(kind, number),
    queryFn: ({ signal }) => getGithubComments(kind, number, {}, { signal }),
    enabled,
    staleTime: 60_000,
  })
}

export function useGithubPrChanges(number: number | undefined) {
  return useQuery({
    queryKey: ['github', 'pr-changes', number ?? 0],
    queryFn: ({ signal }) => getGithubPrChanges(number as number, {}, { signal }),
    enabled: number !== undefined,
    staleTime: 60_000,
    retry: false,
  })
}
