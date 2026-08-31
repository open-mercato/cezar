import { useMutation, useQueries, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo } from 'react'

import { mergeProviderStatusResponse } from '@/lib/provider-status'

import {
  ApiError,
  browseFs,
  checkoutProject,
  connectProvider,
  continueRun,
  continueProjectRun,
  createAgentProfile,
  getAgentConfig,
  getAgentConfigFile,
  getAgentAccountDetails,
  getAgentAccountStatus,
  getAgentProfiles,
  getConfig,
  getGithub,
  getGithubChecks,
  getGithubComments,
  getGithubPrChanges,
  getGithubRefStatus,
  getGroup,
  getHealth,
  getLaunchKey,
  getOpenTargets,
  getProviderStatus,
  getProjectRun,
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
  getRunsIndex,
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
  markRunSeen,
  markRunUnseen,
  patchRun,
  removeQueuedMessage,
  registerProject,
  openAgentAccountFile,
  removeAgentProfile,
  removeProject,
  selectAgentProfile,
  updateAgentProfile,
  updateProject,
  sendMessage,
  sendProjectRunMessage,
  putAgentConfigFile,
  retryProviderAuth,
} from './client'
import { queryScope, REFERENCE_STATUS_MAX, runnerDiscoversModels } from '@open-mercato/cezar-api-client'
import { useProjectScope } from './project-scope-context'
import { isReferenceStatus } from '@/lib/reference-status'
import { githubRepoBase } from '@/lib/tasks-table'
import { normalizeTagsForDisplay } from '@/lib/project-tags'
import type { ContinueOptions } from './client'
import type {
  CheckoutProjectInput,
  CreateAgentProfileInput,
  HealthResponse,
  MessageInput,
  Runner,
  PatchRunInput,
  ProviderId,
  OpenAgentAccountFileInput,
  ProjectListEntry,
  ProjectsResponse,
  GithubRefStatusData,
  ProviderStatusResponse,
  ReferenceStatus,
  RunRecord,
  SelectAgentProfileInput,
  SetAgentConfigInput,
  UpdateAgentProfileInput,
  UpdateProjectInput,
} from '@open-mercato/cezar-api-client'
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
  /** Lazy PR checks glyphs (`GET /api/github/checks`, #664), keyed by the sorted PR numbers so the
   *  same visible window de-dupes to one cache entry. */
  githubChecks: (prNumbers: readonly number[]) =>
    [queryScope(), 'github', 'checks', [...prNumbers].sort((a, b) => a - b).join(',')] as const,
  /** Batched PR/issue chip status. Led by the EXPLICIT project rather than `queryScope()` —
   *  the global Tasks page asks about several projects at once, and two of them may each have a
   *  PR #42. Keyed by the sorted numbers, so the same window de-dupes to one cache entry. */
  githubRefStatus: (projectId: string, prNumbers: readonly number[], issueNumbers: readonly number[]) =>
    [
      projectId,
      'github',
      'ref-status',
      [...prNumbers].sort((a, b) => a - b).join(','),
      [...issueNumbers].sort((a, b) => a - b).join(','),
    ] as const,
  githubComments: (kind: 'issue' | 'pr', number: number) =>
    [queryScope(), 'github', 'comments', kind, number] as const,
  githubMergeState: (number: number) => [queryScope(), 'github', 'merge-state', number] as const,
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
  /** The cross-project task index behind ⌘K. Workspace-led for the same reason the registry is:
   *  it answers for every project at once, so no scope owns it. */
  runsIndex: ['workspace', 'runs-index'] as const,
  /** `~/.cezar/ui-state.json` via `GET/PUT /api/workspace/ui-state` (step 2.7) — cross-project
   *  GUI prefs, e.g. the sidebar's per-project collapse map (step 3.3), and — since step 3.5 —
   *  appearance + notifications, which describe the user rather than a repo. */
  uiState: ['workspace', 'ui-state'] as const,
  /** `~/.cezar/config.json`'s settings slice via `GET/PUT /api/workspace/config` (step 2.7):
   *  the global Resources knobs and the checkout root. */
  config: ['workspace', 'config'] as const,
  /** Agent accounts via `GET /api/v1/workspace/agent-profiles` (spec 2026-07-29-agent-profiles).
   *  Workspace-led like the registry: an account describes the machine, not a repo. */
  agentProfiles: ['workspace', 'agent-profiles'] as const,
  /** One account's identity, keyed by its route id. A child of `agentProfiles` so removing an
   *  account drops any details cached for it in the same invalidation. */
  agentAccountDetails: (routeId: string) =>
    ['workspace', 'agent-profiles', 'details', routeId] as const,
  /** One account's auth state — a child of `agentProfiles`, so removing an account drops it too. */
  agentAccountStatus: (routeId: string) =>
    ['workspace', 'agent-profiles', 'status', routeId] as const,
  skillsUpdate: (projectId: string) => ['workspace', 'skills-update', projectId] as const,
  /** One directory listing from `GET /api/fs/browse` (step 4.2's folder picker). Keyed by the
   *  browsed path — `null` is the browse root, whose absolute location only the server knows.
   *  Not scope-led: there is one filesystem behind the workspace, not one per project. */
  fsBrowseRoot: ['workspace', 'fs-browse'] as const,
  fsBrowse: (path: string | null, showHidden = false) =>
    [...workspaceQueryKeys.fsBrowseRoot, path, showHidden] as const,
}

/**
 * One runner's host-discovered catalog, cached per runner (#794 — this used to be hard-wired to
 * Codex, which is why OpenCode had nothing but stale presets to show).
 *
 * A runner with no host catalog (claude) never fetches and never resolves data, so its picker
 * falls back to static presets exactly as before — callers can pass any runner and read
 * `data`/`isError` without checking first.
 *
 * `enabled` lets a caller that only MIGHT render the model pills (the thread's Continue — hooks
 * cannot be called conditionally) skip the fetch when it definitely won't.
 */
export function useRunnerModels(runner: Runner, enabled = true) {
  return useQuery({
    queryKey: workspaceQueryKeys.models(runner),
    // The narrowing IS the guard — the query is disabled for a runner with no host catalog, so
    // this branch is unreachable rather than merely unlikely, and no cast is needed to say so.
    queryFn: ({ signal }) =>
      runnerDiscoversModels(runner)
        ? getRunnerModels(runner, { signal })
        : Promise.reject(new Error(`${runner} has no host model catalog`)),
    staleTime: 5 * 60 * 1_000,
    enabled: enabled && runnerDiscoversModels(runner),
  })
}

/**
 * Every runner's catalog at once, keyed by runner — for the screens that render a row PER runner
 * (the Settings default-model selects) rather than one for the runner the user picked.
 *
 * One `useRunnerModels` call per runner in a fixed order, so the hook count never varies and
 * each catalog keeps its own cache entry, `enabled` state and error state.
 */
export function useRunnerModelCatalogs(
  enabled = true,
): Record<Runner, ReturnType<typeof useRunnerModels>> {
  const claude = useRunnerModels('claude', enabled)
  const codex = useRunnerModels('codex', enabled)
  const opencode = useRunnerModels('opencode', enabled)
  const pi = useRunnerModels('pi', enabled)
  return { claude, codex, opencode, pi }
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
    // One bootstrap per session cache. Runtime incidents arrive over the workspace stream and
    // user-driven Connect/Check again/Try again actions update this same key immediately; a
    // background interval only re-probes unchanged credentials and can repeatedly challenge a
    // reverse-proxy-authenticated mobile browser. A focus refresh is allowed once the answer is
    // five minutes old, covering credentials changed outside cezar without permanent polling.
    staleTime: 5 * 60_000,
    refetchInterval: false,
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
export function useFsBrowse(path: string | null, showHidden = false) {
  return useQuery({
    // `showHidden` is part of the key: the two listings of one directory are different answers,
    // and sharing a cache entry would show whichever caller asked first.
    queryKey: workspaceQueryKeys.fsBrowse(path, showHidden),
    queryFn: ({ signal }) => browseFs(path ?? undefined, { signal, showHidden }),
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
 *
 * The invalidation is deliberately NOT returned: TanStack awaits a promise a mutation callback
 * returns before running the per-call ones, so returning it would make the caller's `onSuccess`
 * wait for the registry REFETCH. Settings → General removes the project its own URL names and
 * navigates away in that callback — gating that on a second round-trip leaves the user on a page
 * for a project that no longer exists for as long as the refetch takes.
 */
export function useRemoveProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (projectId: string) => removeProject(projectId),
    retry: false,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.projects })
    },
  })
}

/**
 * Edit one registry entry — the per-project concurrency ceiling (spec 2026-07-22) and the
 * grouping tags — from Settings → Projects.
 *
 * **Optimistic, and that is load-bearing rather than cosmetic.** The editors are bound to the
 * server value with no local mirror, so between the PATCH and the refetch the cached project
 * still holds the OLD list. Adding two tags in a row therefore read the stale list twice and the
 * second save overwrote the first: click `api`, click `web`, and `api` was gone — the whole list
 * is replaced wholesale, so a stale read is a silent deletion, not a stale display.
 *
 * Writing the new value into the cache immediately closes that window: the next click composes on
 * top of it. The server's own answer then replaces the row (it is the authority on normalization),
 * and the final invalidate re-reads the registry. A failure rolls the snapshot back, so a refused
 * edit leaves the row exactly as it was.
 *
 * No retry — an out-of-range value or unknown id (400/404) is a deterministic refusal re-asking
 * cannot change.
 */
export function useUpdateProject() {
  const queryClient = useQueryClient()
  return useMutation({
    // Forwarded whole rather than key by key: the body is partial, so an unlisted key would be
    // silently dropped instead of sent — which is how `agentProfile` would have gone missing.
    mutationFn: (variables: { id: string } & UpdateProjectInput) => {
      const { id, ...patch } = variables
      return updateProject(id, patch)
    },
    retry: false,
    onMutate: async ({ id, ...patch }) => {
      await queryClient.cancelQueries({ queryKey: workspaceQueryKeys.projects })
      const previous = queryClient.getQueryData<ProjectsResponse>(workspaceQueryKeys.projects)
      queryClient.setQueryData<ProjectsResponse>(workspaceQueryKeys.projects, (current) =>
        current === undefined
          ? current
          : {
              ...current,
              projects: current.projects.map((project) =>
                project.id === id ? applyProjectPatch(project, patch) : project,
              ),
            },
      )
      return { previous }
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(workspaceQueryKeys.projects, context.previous)
      }
    },
    onSuccess: ({ project: updated }) => {
      // The server is the authority on normalization (trim, case-insensitive dedupe, sort), so
      // its entry replaces the optimistic one rather than merging with it.
      queryClient.setQueryData<ProjectsResponse>(workspaceQueryKeys.projects, (current) =>
        current === undefined
          ? current
          : {
              ...current,
              projects: current.projects.map((project) =>
                project.id === updated.id ? updated : project,
              ),
            },
      )
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.projects }),
  })
}

/** One registry entry with a PATCH body applied — the same per-key rule the route follows: a
 *  field changes only when the body NAMED it, and `null` (or, for tags, an empty list) clears. */
function applyProjectPatch(
  project: ProjectListEntry,
  patch: UpdateProjectInput,
): ProjectListEntry {
  const { maxParallel: _mp, tags: _tags, ...rest } = project
  const next: ProjectListEntry = { ...rest }
  const maxParallel = 'maxParallel' in patch ? patch.maxParallel : project.maxParallel
  if (maxParallel !== null && maxParallel !== undefined) next.maxParallel = maxParallel
  const tags = 'tags' in patch && patch.tags !== undefined ? patch.tags : project.tags
  const normalized = tags === null || tags === undefined ? [] : normalizeTagsForDisplay(tags)
  if (normalized.length > 0) next.tags = normalized
  return next
}

/**
 * The three agent-account mutations (spec 2026-07-29-agent-profiles).
 *
 * All three invalidate the PROJECTS list as well as the account list: deleting an account scrubs
 * every project's reference to it server-side, so a projects cache left alone would keep showing
 * a selection that no longer exists.
 */
function useAgentProfileMutation<TVariables>(
  mutationFn: (variables: TVariables) => Promise<unknown>,
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn,
    retry: false,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.agentProfiles }),
        queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.projects }),
      ])
    },
  })
}

export function useCreateAgentProfile() {
  return useAgentProfileMutation((input: CreateAgentProfileInput) => createAgentProfile(input))
}

export function useUpdateAgentProfile() {
  return useAgentProfileMutation((variables: { id: string } & UpdateAgentProfileInput) => {
    const { id, ...patch } = variables
    return updateAgentProfile(id, patch)
  })
}

export function useRemoveAgentProfile() {
  return useAgentProfileMutation((id: string) => removeAgentProfile(id))
}

/** Point one project's provider at an account (spec 2026-07-29-agent-profiles). */
export function useSelectAgentProfile() {
  return useAgentProfileMutation((input: SelectAgentProfileInput) => selectAgentProfile(input))
}

/**
 * Who an account is signed in as — fetched ONLY once `enabled` (the row's "Show details").
 *
 * `enabled: false` is the whole point: identity is not in the accounts listing, so until the user
 * asks, no request carries it and nothing caches it. `staleTime: 0` so re-opening the row after a
 * re-login shows the new answer rather than a remembered one.
 */
export function useAgentAccountDetails(routeId: string, enabled: boolean) {
  return useQuery({
    queryKey: workspaceQueryKeys.agentAccountDetails(routeId),
    queryFn: ({ signal }) => getAgentAccountDetails(routeId, { signal }),
    enabled,
    staleTime: 0,
    retry: false,
  })
}

/**
 * One account's auth state — the GAP-FILLER, not the normal path.
 *
 * The listing carries a status whenever the server has one cached, which after the boot warm is
 * almost always. This covers the rest: an account added mid-session, or a cache that has aged out.
 * Each row asks for its own in parallel, so the pane still paints from the spawn-free listing and
 * fills dots in as answers arrive rather than blocking on a spawn per provider AND per account.
 */
export function useAgentAccountStatus(routeId: string, enabled: boolean) {
  return useQuery({
    queryKey: workspaceQueryKeys.agentAccountStatus(routeId),
    queryFn: ({ signal }) => getAgentAccountStatus(routeId, { signal }),
    // Only when the listing had nothing cached to give us. The server warms this at boot and keeps
    // a connected answer for minutes, so in the normal case the listing already carries it and this
    // never fires — no request, no CLI spawn, no "Checking…" flicker.
    enabled,
    staleTime: 60_000,
    retry: false,
  })
}

/**
 * Sign IN to one agent account — the last mile of "add account → Connect → the CLI creates the
 * folder", which is the documented first-run sequence and the only way a second login can be
 * created from cezar.
 *
 * Invalidates both the account listing and the provider card: the login the user just opened is
 * for a named account, but the terminal they finish it in can equally be the discovered one, and a
 * stale card is what makes people press Connect twice.
 */
export function useConnectAgentAccount() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ provider, profileId }: { provider: ProviderId; profileId?: string }) =>
      connectProvider(provider, profileId),
    retry: false,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.agentProfiles }),
        queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.providerStatus }),
      ])
    },
  })
}

/**
 * Re-probe ONE account for real (`?refresh=1`), for the "Check again" the pane offers beside
 * Connect — the affordance the cached-by-default listing is designed around.
 *
 * Writes the answer straight into the per-account status cache so the row updates without a second
 * round-trip, and never retries: the interesting failures here are the server's own refusals.
 */
export function useRecheckAgentAccount() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (routeId: string) => getAgentAccountStatus(routeId, { refresh: true }),
    retry: false,
    onSuccess: (answer, routeId) => {
      queryClient.setQueryData(workspaceQueryKeys.agentAccountStatus(routeId), answer)
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.agentProfiles })
    },
  })
}

/** Hand one of an account's config files to a local app. Nothing to invalidate — opening a file
 *  changes no cezar state, so this deliberately does NOT go through the shared mutation helper. */
export function useOpenAgentAccountFile() {
  return useMutation({
    mutationFn: (variables: { routeId: string } & OpenAgentAccountFileInput) => {
      const { routeId, ...input } = variables
      return openAgentAccountFile(routeId, input)
    },
    retry: false,
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
 * to be mounted. One root-level subscription keeps local cockpits live continuously, so they are
 * always notified when health changes; remote cockpits stay on authenticated HTTP because browser
 * WebSocket cannot carry proxy credentials explicitly. The `useHealth` readers below just read
 * the cache either transport fills.
 *
 * The cache key is read inside the callback (`queryKeys.health` is a scope-aware getter), so a
 * project switch routes each pushed snapshot to the active scope's cache without re-subscribing.
 */
export function useHealthSubscription(): void {
  const queryClient = useQueryClient()
  useEffect(() => {
    let releaseTopic: (() => void) | undefined

    const syncTransport = (): void => {
      const health = queryClient.getQueryData<HealthResponse>(queryKeys.health)
      const local = health?.capabilities?.localHandoff === true
      if (local && releaseTopic === undefined) {
        releaseTopic = subscribeTopic('health', (data) => {
          queryClient.setQueryData(queryKeys.health, data as HealthResponse)
        })
      } else if (!local && releaseTopic !== undefined) {
        releaseTopic()
        releaseTopic = undefined
      }
    }

    // Do not open a socket before the authenticated HTTP bootstrap tells us the deployment
    // mode. Browser WebSocket has no credentials option, so a remote Basic Auth proxy can reject
    // the upgrade and trigger ws.ts's three-second reconnect loop (and a login prompt each time).
    // Local cockpits opt in after health arrives; remote/failed bootstraps fail closed to HTTP.
    syncTransport()
    const releaseCache = queryClient.getQueryCache().subscribe(syncTransport)
    return () => {
      releaseCache()
      releaseTopic?.()
    }
  }, [queryClient])
}

/** Version + update check + repo/branch + tool probes. Feeds the sidebar's repo and version
 *  chips and (Step 4.2) the Tools menu.
 *
 * A pure read: the HTTP query is the authoritative bootstrap and the reconcile target
 * (global-events.tsx invalidates it on reconnect/visibility), and live updates arrive by the
 * one local-only `useHealthSubscription` at the root folding pushed `/api/v1/ws` frames into this same cache
 * (#369 — this replaced the old 5 s `refetchInterval` per tab). Safe to call from as many
 * components as need health; they all read one cache and none of them touches the socket. */
export function useHealth() {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: ({ signal }) => getHealth({ signal }),
  })
}

/**
 * The GitHub web root (`https://github.com/owner/repo`) of the project currently on screen, or
 * undefined when it cannot be proven — the only authority `taskIssueUrl` may synthesize a link
 * against (#526).
 *
 * The boot-project guard is the load-bearing part. `/health` is WORKSPACE-level (project-scope.ts
 * `WORKSPACE_LEVEL`): the server always builds it from `bootRoot`, so its `repo.remote` names the
 * project cezar launched in, whichever project the URL is scoped to. Handing a non-boot project's
 * task a link built from the boot project's repo would point at a completely different repository
 * — the same wrong-link defect #526 exists to kill.
 *
 * The per-project remote that guard was waiting for already exists: the registry serves each
 * project's own `repoUrl` (rebuilt server-side from the parsed remote, credentials stripped), and
 * it is what All tasks builds every cross-project chip from. Reading it here is what stops the
 * SAME task from showing a linked chip on `/tasks` and inert text on its own page — which is how
 * this was found: a declared PR was a dead `#901` in the task view and a working link one screen
 * over. Health stays the fallback, and stays boot-only, so an unregistered boot folder (or a
 * registry that has not loaded yet) keeps answering exactly as before.
 */
export function useProjectRepoBase(): string | undefined {
  const health = useHealth().data
  const projects = useProjects().data?.projects
  const { projectId } = useProjectScope()
  const scopedId = projectId ?? health?.bootProject
  const registered = scopedId === undefined ? undefined : projects?.find((project) => project.id === scopedId)
  if (registered?.repoUrl) return registered.repoUrl
  const isBootProject = projectId === null || projectId === health?.bootProject
  return isBootProject ? githubRepoBase(health?.repo?.remote) : undefined
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
 * Every registered project's recent tasks, slim — the ⌘K palette's cross-project finder.
 *
 * `enabled` rather than always-on, and the palette passes `false` in a single-project workspace:
 * there is nothing to aggregate there, and the active project's own `useRuns()` entry (already
 * warm, and stream-patched) answers better than this snapshot could.
 *
 * ONE request for the whole registry, deliberately — the alternative, N `useProjectRuns` calls,
 * ships a full `RunRecord` per run (`steps[]` and all) times the registry, to render a title and
 * a dot. `staleTime` because a task search is a glance, not a live view: the palette mounts on
 * open, and re-opening it seconds later should not re-ask the whole workspace. The active
 * project's rows come from `useRuns()` anyway, so the live half of the list is never this stale.
 */
export function useRunsIndex(enabled = true, refetchIntervalMs?: number) {
  return useQuery({
    queryKey: workspaceQueryKeys.runsIndex,
    queryFn: ({ signal }) => getRunsIndex({ signal }),
    enabled,
    staleTime: 30_000,
    // The cockpit's default is NO polling, because the run stream says when something changed
    // (see `createQueryClient`). This index DOES hear the stream — the one `/workspace/events`
    // connection carries every project's run news, and `global-events.tsx` debounces it into an
    // invalidation here — so the interval is a backstop for what a stream cannot promise (a
    // dropped socket, a frozen tab, a run that ended while the connection was down), not the only
    // freshness mechanism. Only the global Tasks page (a live view rather than a glance) asks for
    // one; the palette leaves it off and keeps its 30s staleness.
    ...(refetchIntervalMs === undefined ? {} : { refetchInterval: refetchIntervalMs }),
    // No `refetchOnWindowFocus` here on purpose, though the tab-comes-back case is real (the
    // interval above does not run in a hidden tab). `global-events.tsx` already reconciles this
    // key on `visibilitychange`, which is the same event with better manners — one reconcile for
    // every stale cache rather than a per-query refetch, and it fires on the visibility flip
    // rather than on every window focus.
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

/**
 * One run of a NAMED project — what a surface outside `/p/:projectId` has to use.
 *
 * `enabled` is the point as much as the project: the only caller is a panel that opens on hover
 * (the conflict chip's "Resolve conflicts"), and a table must not fetch a record per row for
 * panels nobody has opened. Keyed by the project, so the global page and that project's own page
 * share one cache entry rather than two spellings of the same run.
 */
export function useProjectRun(projectId: string | undefined, id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: [projectId ?? 'default', 'runs', 'detail', id ?? ''] as const,
    queryFn: ({ signal }) => getProjectRun(projectId as string, id as string, { signal }),
    enabled: enabled && Boolean(projectId) && Boolean(id),
  })
}

export function useRunDiff(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.runs.diff(id ?? ''),
    queryFn: ({ signal }) => getRunDiff(id as string, { signal }),
    enabled: Boolean(id),
  })
}

/** The structured session diff behind the Changes tab (R5). A 409 (for example, a reclaimed
 *  worktree whose directory is unavailable) is a real answer, not a network hiccup — retrying
 *  cannot change it, so retries are off and the view renders the server's own reason. */
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
 *  works. A 409 from an unavailable backing directory is a real answer retries can't change. */
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
 *  model presets. Task-start surfaces read this project-scoped query for both runner and model
 *  defaults; `/api/health` is workspace-level and intentionally describes only the boot repo. */
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

/**
 * Every agent account on this machine (spec 2026-07-29-agent-profiles).
 *
 * Read by three surfaces — the Accounts settings section, the per-project picker in Settings →
 * Agents, and the composer's override — so it is one cached query rather than three fetches.
 * Not scope-led: one machine, one set of accounts.
 */
export function useAgentProfiles() {
  return useQuery({
    queryKey: workspaceQueryKeys.agentProfiles,
    queryFn: ({ signal }) => getAgentProfiles({ signal }),
  })
}

export function useSkillsUpdate(projectId: string, enabled = true) {
  return useQuery({
    queryKey: workspaceQueryKeys.skillsUpdate(projectId),
    queryFn: ({ signal }) => getSkillsUpdate(projectId, { signal }),
    enabled,
    // GET deliberately answers the current snapshot and starts a stale check in the
    // background. Retry only while that snapshot is transient so an initial `idle`
    // response converges. Checks may legitimately take tens of seconds, so a one-minute cadence
    // avoids repeatedly challenging authenticated remote sessions while still converging after
    // a long-running operation. The initial mount remains the session's one automatic check.
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return status === undefined || status === 'idle' || status === 'checking' || status === 'updating'
        ? 60_000
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

/**
 * Mark the WORKSPACE run index stale after a change to one run's read state.
 *
 * The index (`GET /workspace/runs-index`) is a third cache, independent of the project-scoped
 * run list and detail these mutations patch, and it has a 30s staleTime. Without this, opening an
 * unread task from the global Tasks page and coming straight back showed it STILL unread until
 * the next poll or a refresh — which reads as "the click did not work".
 *
 * Invalidate rather than patch, deliberately. Patching would need the run's project id (the index
 * keys on `projectId + id`, because a run id is only unique inside one project), and this
 * mutation knows a run only by id — deriving the project from the router would couple a data hook
 * to a `<Router>` that its own unit tests, and any non-routed caller, do not provide. Nothing is
 * observing the index while you are in a thread, so this costs no request: it simply means the
 * global page's next mount reads the truth instead of a stale snapshot.
 */
function invalidateRunsIndex(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.runsIndex })
}

/**
 * Mark one run read (#unread-done-items): `POST /api/runs/:id/read`. Opening a finished task's
 * thread fires this so the unread dot clears without waiting for the round-trip — the list and
 * detail caches are stamped with `seenAt` optimistically, then reconciled to the server's exact
 * value (which also arrives independently over the `run` SSE). On error the optimistic stamp is
 * rolled back, so a run that could not be marked read honestly stays unread.
 */
export function useMarkRunSeen() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => markRunSeen(id),
    onMutate: async (id: string) => {
      // Cancel BOTH caches this stamps: an in-flight refetch of either that settles after the
      // optimistic write would otherwise put the unread dot straight back.
      await queryClient.cancelQueries({ queryKey: queryKeys.runs.list() })
      await queryClient.cancelQueries({ queryKey: queryKeys.runs.detail(id) })
      const prevList = queryClient.getQueryData<RunRecord[]>(queryKeys.runs.list())
      const prevDetail = queryClient.getQueryData<RunRecord>(queryKeys.runs.detail(id))
      const now = new Date().toISOString()
      queryClient.setQueryData<RunRecord[]>(queryKeys.runs.list(), (list) =>
        list?.map((run) => (run.id === id ? { ...run, seenAt: now } : run)),
      )
      queryClient.setQueryData<RunRecord>(queryKeys.runs.detail(id), (run) =>
        run ? { ...run, seenAt: now } : run,
      )
      return { prevList, prevDetail, id }
    },
    onError: (_error, id, context) => {
      // Both restores are guarded: with no snapshot there is nothing to roll back TO, and
      // writing `undefined` would evict a cache entry the mutation never touched.
      if (context?.prevList) queryClient.setQueryData(queryKeys.runs.list(), context.prevList)
      if (context?.prevDetail) queryClient.setQueryData(queryKeys.runs.detail(id), context.prevDetail)
    },
    onSuccess: (updated) => {
      // Take ONLY the receipt out of the answer — never the whole record.
      //
      // `POST /runs/:id/read` answers with a SNAPSHOT taken while the request was in flight, and
      // this mutation fires at the exact moment a run finishes, which is also the busiest moment
      // on the run stream. Writing the snapshot wholesale therefore reverts every field the
      // stream advanced in that window, permanently — nothing refetches afterwards, so the
      // thread stays wrong until the next reload.
      //
      // The case that exposed it (spec 2026-08-03-auto-resume-after-usage-limit): a run fails on
      // a usage limit and, a beat later, publishes the instant it will resume itself. The read
      // receipt raced that beat and put back a record with no `autoResumeAt`, so the thread's
      // resume hint vanished on every LIVE schedule while a page refresh always showed it.
      //
      // `seenAt` is the only field this mutation changes, so it is the only one worth taking
      // from its answer; everything else belongs to the stream and the authoritative fetch.
      const stampReceipt = (run: RunRecord): RunRecord =>
        run.id === updated.id ? { ...run, seenAt: updated.seenAt } : run
      queryClient.setQueryData<RunRecord[]>(queryKeys.runs.list(), (list) => list?.map(stampReceipt))
      queryClient.setQueryData<RunRecord>(queryKeys.runs.detail(updated.id), (current) =>
        current ? stampReceipt(current) : updated,
      )
      invalidateRunsIndex(queryClient)
    },
  })
}

/**
 * Put one finished run back to unread (#775): `POST /api/runs/:id/unread`. The exact inverse of
 * `useMarkRunSeen`, down to the cache choreography — both caches cancelled so an in-flight
 * refetch cannot re-stamp the receipt after the optimistic write, `seenAt` *cleared* instead of
 * stamped, and a guarded rollback so a run that could not be marked unread honestly stays read
 * (which is also the mixed-version failure mode: an older server 404s this route, and the user
 * sees the marker not come back rather than a cockpit lying about the server's state).
 *
 * Clearing is spelled as a rest-destructure rather than `seenAt: undefined`: the reader is
 * `isUnread`, which keys on the field being absent, and an explicit `undefined` would survive
 * into a record shape the server never writes.
 */
export function useMarkRunUnseen() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => markRunUnseen(id),
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.runs.list() })
      await queryClient.cancelQueries({ queryKey: queryKeys.runs.detail(id) })
      const prevList = queryClient.getQueryData<RunRecord[]>(queryKeys.runs.list())
      const prevDetail = queryClient.getQueryData<RunRecord>(queryKeys.runs.detail(id))
      queryClient.setQueryData<RunRecord[]>(queryKeys.runs.list(), (list) =>
        list?.map((run) => (run.id === id ? withoutReceipt(run) : run)),
      )
      queryClient.setQueryData<RunRecord>(queryKeys.runs.detail(id), (run) =>
        run ? withoutReceipt(run) : run,
      )
      return { prevList, prevDetail, id }
    },
    onError: (_error, id, context) => {
      if (context?.prevList) queryClient.setQueryData(queryKeys.runs.list(), context.prevList)
      if (context?.prevDetail) queryClient.setQueryData(queryKeys.runs.detail(id), context.prevDetail)
    },
    onSuccess: (updated) => {
      // Clear ONLY the receipt on the record already in cache — never write the answer wholesale.
      //
      // Same reason as the read twin above: `POST /runs/:id/unread` answers with a SNAPSHOT taken
      // while the request was in flight, so writing it over the cached record permanently reverts
      // every field the run stream advanced in that window (nothing refetches afterwards). A
      // finished run is quieter than a just-finished one, but it is not silent — the janitor still
      // discovers PR links, titles still get summarized, and a `failed` run still publishes its
      // `autoResumeAt`. Clearing the one field this mutation owns cannot lose any of them.
      const clearReceipt = (run: RunRecord): RunRecord =>
        run.id === updated.id ? withoutReceipt(run) : run
      queryClient.setQueryData<RunRecord[]>(queryKeys.runs.list(), (list) => list?.map(clearReceipt))
      queryClient.setQueryData<RunRecord>(queryKeys.runs.detail(updated.id), (current) =>
        current ? clearReceipt(current) : updated,
      )
      invalidateRunsIndex(queryClient)
    },
  })
}

/** A copy of the record with the read receipt gone — the optimistic half of `useMarkRunUnseen`. */
function withoutReceipt(run: RunRecord): RunRecord {
  const { seenAt: _dropped, ...rest } = run
  return rest
}

/** Deliver a reply into a live session (`POST /api/runs/:id/messages`). The transcript itself
 *  grows over SSE (`user-message`, then the agent's turn); the invalidation refreshes the
 *  record (status flips waiting → running). Errors are the CALLER's to surface — the composer
 *  restores the draft and toasts, so no toast fires here. A 409 ("session closed") still
 *  invalidates: it means the cached record claimed a live session the server no longer has, so
 *  the refetch flips the composer to its closed/Continue form instead of leaving it aimed at a
 *  session that will keep refusing. */
export function useSendMessage(id: string, projectId?: string) {
  const queryClient = useQueryClient()
  return useMutation({
    // `projectId` only where the caller stands OUTSIDE the run's project — the global Tasks page,
    // whose rows span the registry and where `queryScope()` would name the boot project. Absent
    // is the ordinary case and keeps the scoped-by-context spelling.
    mutationFn: (message: MessageInput) =>
      projectId === undefined ? sendMessage(id, message) : sendProjectRunMessage(projectId, id, message),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
      }
    },
  })
}

/** Reopen a closed run's last agent session (`POST /api/runs/:id/continue`), starting it on an
 *  opening prompt. The sibling of `useSendMessage` for a run whose session has already ended:
 *  same invalidation (the record flips to `running`, the transcript grows over SSE) and the
 *  same contract that errors belong to the CALLER, so a refusal can be shown where the user
 *  acted. The thread composer keeps its own mutation (`useContinueAction`) because it also owns
 *  the runner/model pills; this hook is the plain "resume on the run's own engine" path. */
export function useContinueRun(id: string, projectId?: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (opts: ContinueOptions = {}) =>
      projectId === undefined ? continueRun(id, opts) : continueProjectRun(projectId, id, opts),
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

/** Lazy PR checks glyphs (`/api/github/checks`, #664). The list call no longer ships
 *  `statusCheckRollup`, so the PR row's checks glyph is hydrated here for the on-screen rows only.
 *  `enabled` gates it to the PR view with a non-empty window; `staleTime` matches the 60 s server
 *  cache so re-visiting the same window doesn't re-hit gh. Degrade is silent — an unavailable
 *  payload just leaves rows without a glyph. */
export function useGithubChecks(prNumbers: number[], enabled = true) {
  return useQuery({
    queryKey: queryKeys.githubChecks(prNumbers),
    queryFn: ({ signal }) => getGithubChecks(prNumbers, { signal }),
    enabled: enabled && prNumbers.length > 0,
    staleTime: 60_000,
  })
}

/** How many numbers of one kind one project's ref-status request may carry. The server's cap,
 *  imported rather than restated: the route 400s past it, so a second copy that drifted would turn
 *  every chip on a busy project into an error instead of a neutral chip. */
const REF_STATUS_MAX = REFERENCE_STATUS_MAX

/**
 * The numbers one request asks about, capped — **newest first, then sorted for the key**.
 *
 * Both halves matter. Sorting makes the truncation deterministic rather than render-order
 * dependent (a row must not gain and lose its status as the table re-sorts), and taking the
 * HIGHEST numbers puts the cap where it costs least: issue and PR numbers grow over a repository's
 * life, so a project with more references on screen than the cap keeps the recent ones — the rows
 * anybody is looking at — and drops the oldest, rather than the other way round. The result is
 * re-sorted ascending because the query key is built from this list and two orderings of the same
 * window must not be two cache entries.
 */
function cappedNumbers(numbers: Iterable<number>): number[] {
  return [...numbers]
    .sort((a, b) => b - a)
    .slice(0, REF_STATUS_MAX)
    .sort((a, b) => a - b)
}

/** One chip's identity: which project's forge to ask, and about what. */
export interface ReferenceStatusRequest {
  projectId: string
  kind: 'PR' | 'Issue'
  number: number
}

/**
 * What is known about one chip — the status if we have ever learned it, AND what the request
 * covering it is doing, which are genuinely different questions.
 *
 * They were one question at first (`status | undefined`), and that was the bug behind "the chips
 * sometimes just go blank": `undefined` collapsed *still loading*, *GitHub is unreachable*, *there
 * is no such number* and *we already know this one, the batch was merely re-keyed* into one silent
 * neutral chip, with no way for the chip to say which of them had happened.
 */
export interface ReferenceStatusEntry {
  /** The last status we ever learned for this reference. Kept across refetches, re-keyed batches
   *  and forge failures — only ever REPLACED by a newer answer, never cleared by one that failed
   *  to arrive. */
  status?: ReferenceStatus
  /**
   * What the request covering this reference is doing right now:
   *  - `idle` — nothing has asked about it (no provider, or past the per-project cap);
   *  - `loading` — its request is in flight;
   *  - `ready` — the forge answered, and `status` is that answer;
   *  - `unknown` — the forge answered and does not have this number;
   *  - `unavailable` — the forge could not be reached (`reason` says why).
   */
  state: 'idle' | 'loading' | 'ready' | 'unknown' | 'unavailable'
  /** Only on `unavailable` — the server's human hint ("gh CLI not found…"). */
  reason?: string
  /**
   * Does this pull request's branch refuse to merge into its base? The second axis the status
   * cannot carry (`conflicts` in the contract), remembered on exactly the same terms as `status`.
   *
   * `undefined` means NOTHING IS KNOWN — no answer yet, or a server from before the field existed
   * — and is not the same as `false`, which is the forge having told us it merges cleanly. Only
   * `true` may paint anything.
   */
  conflicting?: boolean
}

export type ReferenceStatusLookup = (ref: ReferenceStatusRequest) => ReferenceStatusEntry

/**
 * Every status this tab has ever learned, by reference — the memory that stops the chips
 * flickering.
 *
 * The queries are keyed by the WHOLE batch (`…/ref-status/40,42/12`), because a batch is what one
 * request covers. That makes the query cache exactly the wrong shape for DISPLAY: type one letter
 * into the search box and the visible set changes, which is a different key, which is a cold cache
 * entry — so every chip on screen blanked until the round trip finished, even though nothing about
 * those pull requests had changed. The same fires on the global page's 15 s index poll the moment
 * any task gains or loses a reference, and on every tab switch.
 *
 * So what is REMEMBERED is per reference, and outlives any one batch, surface or failure. Nothing
 * here is ever invented: an entry appears only when the forge answered with a status for that
 * exact number, and any later answer overwrites it. The cost is bounded staleness — a chip can
 * show the last successful answer while a new one is in flight — which is the same 60 s staleness
 * the cache already accepts, and is strictly better than blanking to a neutral chip that reads as
 * "nothing to see here".
 *
 * Module-level rather than per-hook so the sidebar, the table and the run header share one memory:
 * they routinely paint the same PR, and learning it three times would mean three flickers.
 */
const rememberedStatuses = new Map<string, ReferenceStatus>(restoreRememberedStatuses())
/** Bounded like the server's own caches. Insertion-ordered, so the least recently learned goes. */
const REMEMBERED_MAX = 1000

function rememberStatus(key: string, status: ReferenceStatus): void {
  if (rememberedStatuses.get(key) === status) return
  // Re-inserted rather than overwritten, so a status still being looked at stays young in the
  // eviction order.
  rememberedStatuses.delete(key)
  rememberedStatuses.set(key, status)
  while (rememberedStatuses.size > REMEMBERED_MAX) {
    const oldest = rememberedStatuses.keys().next().value
    if (oldest === undefined) break
    rememberedStatuses.delete(oldest)
  }
  scheduleRememberedSave()
}

/**
 * The same memory, for the conflict axis — the numbers last seen as CONFLICTING.
 *
 * A set of keys rather than a second map, because only `true` is worth carrying: the interesting
 * population is tiny (a conflicting PR is the exception), and a key's absence already means the
 * one thing `undefined` has to mean everywhere else here — nothing is known. `rememberConflict`
 * deletes on a `false` answer, so a resolved conflict stops painting on the very next response
 * rather than lingering the way an un-cleared flag would.
 */
const rememberedConflicts = new Set<string>(restoreRememberedConflicts())

function rememberConflict(key: string, conflicting: boolean): void {
  if (rememberedConflicts.has(key) === conflicting) return
  if (conflicting) {
    rememberedConflicts.add(key)
    // Bounded on the same terms as the statuses; insertion-ordered, so the oldest goes first.
    while (rememberedConflicts.size > REMEMBERED_MAX) {
      const oldest = rememberedConflicts.values().next().value
      if (oldest === undefined) break
      rememberedConflicts.delete(oldest)
    }
  } else {
    rememberedConflicts.delete(key)
  }
  scheduleRememberedSave()
}

/**
 * …and the same memory across a RELOAD, in `sessionStorage`.
 *
 * Without it a refresh repaints every chip neutral and then colours them in a beat later, which is
 * the "first we see the fallback, then it changes" flicker one level up from the one the in-memory
 * map fixed. The statuses are already on this machine; making the user watch them arrive again is
 * a choice, not a constraint.
 *
 * `sessionStorage`, not `localStorage`, and that is the safety bound: it dies with the tab, so the
 * oldest thing this can paint is from earlier in the same sitting — never a status from last week
 * shown with confidence on a cold morning. A live answer replaces it within one round trip either
 * way, and the tooltip labels a value as `last known` whenever the forge cannot be reached.
 *
 * Everything here is best-effort: private-mode quota errors, a disabled storage, a payload from a
 * future version — all degrade to the pre-persistence behaviour rather than breaking the cockpit.
 */
const REMEMBERED_STORAGE_KEY = 'cez.reference-statuses.v1'
/** The conflict axis, under its own key rather than inside the payload above: the status file's
 *  format is read by every bundle that has ever run in this tab, and widening its entries would
 *  make an older one discard every status it found there. A key it has never heard of it simply
 *  never reads. */
const REMEMBERED_CONFLICTS_STORAGE_KEY = 'cez.reference-conflicts.v1'

/** Exported for tests: it runs once at module load, which is not a moment a test can observe. */
export function restoreRememberedStatuses(): [string, ReferenceStatus][] {
  try {
    const raw = globalThis.sessionStorage?.getItem(REMEMBERED_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is [string, ReferenceStatus] =>
        // The status is checked against the vocabulary this bundle knows, not merely against
        // `string`: the payload may have been written by a NEWER cockpit in this same tab (it
        // survives reloads, and a server rollback does not clear it), and a value added after
        // this bundle shipped must degrade to the neutral chip rather than be painted with a
        // presentation that does not exist.
        Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && isReferenceStatus(entry[1]),
    )
  } catch {
    return []
  }
}

/** Exported for tests, like its sibling. A key list, and anything else in the slot is ignored —
 *  the file is best-effort in every direction. */
export function restoreRememberedConflicts(): string[] {
  try {
    const raw = globalThis.sessionStorage?.getItem(REMEMBERED_CONFLICTS_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((key): key is string => typeof key === 'string')
  } catch {
    return []
  }
}

let rememberedSave: ReturnType<typeof setTimeout> | undefined
function scheduleRememberedSave(): void {
  // Coalesced: a table's worth of statuses arrives as one response and would otherwise stringify
  // the whole map once per reference.
  if (rememberedSave !== undefined) return
  rememberedSave = setTimeout(() => {
    rememberedSave = undefined
    try {
      globalThis.sessionStorage?.setItem(REMEMBERED_STORAGE_KEY, JSON.stringify([...rememberedStatuses]))
      // One timer, two slots: both are written by the same responses, so a second scheduler would
      // only mean a second stringify pass over the same arrival.
      globalThis.sessionStorage?.setItem(
        REMEMBERED_CONFLICTS_STORAGE_KEY,
        JSON.stringify([...rememberedConflicts]),
      )
    } catch {
      // Quota, private mode, storage disabled — the in-memory map still works.
    }
  }, 250)
}

/**
 * The project a surface's references belong to, named the way the REST of the cockpit names it.
 *
 * `useProjectScope()` answers `null` when unscoped, and the obvious fallback — the `'default'`
 * alias every project-scoped route accepts — is a trap HERE specifically. The global Tasks page
 * keys each chip by its run's real `projectId`, because its rows span the registry. A surface
 * keying the same pull request as `default` remembers it under a second name: the two never see
 * each other's answer, they fetch it twice, and a status updated on one stays stale on the other.
 *
 * Health knows which project `default` actually is. Undefined until it answers, which leaves
 * chips neutral for that moment rather than writing an entry under a name nothing else uses.
 */
export function useReferenceProjectId(): string | undefined {
  const scope = useProjectScope()
  const health = useHealth()
  return scope.projectId ?? health.data?.bootProject
}

/**
 * Adopt statuses that arrived with something else — today, the cross-project run index, which
 * ships whatever the server already had cached for the references its rows carry.
 *
 * This is the cheapest possible version of the whole feature: no request, no round trip, and the
 * chips are coloured in the same paint as the rows rather than a beat later. What it does NOT do
 * is replace the fetch — the index answers from cache only, so a reference the server has never
 * looked up is simply absent here, and `useReferenceStatuses` still goes and asks.
 *
 * Seeding the memory rather than rendering from the payload directly, and that is the point: the
 * memory is already what every chip reads, and every other path (a batch response, a re-key, a
 * reload) writes to it. One place to look, one precedence — a later real answer overwrites a
 * seeded one exactly as it overwrites any other.
 */
export function rememberReferenceStatuses(
  byProject: Record<string, { prs: Record<number, ReferenceStatus>; issues: Record<number, ReferenceStatus> }>,
): void {
  for (const [projectId, buckets] of Object.entries(byProject)) {
    for (const [number, status] of Object.entries(buckets.prs)) {
      rememberStatus(refStatusKey({ projectId, kind: 'PR', number: Number(number) }), status)
    }
    for (const [number, status] of Object.entries(buckets.issues)) {
      rememberStatus(refStatusKey({ projectId, kind: 'Issue', number: Number(number) }), status)
    }
  }
}

/** Test-only: the memory is module-level AND persisted, so one case's statuses would leak into
 *  the next — and, without clearing the store, into the next run of the suite. */
export function __clearRememberedStatusesForTests(): void {
  rememberedStatuses.clear()
  rememberedConflicts.clear()
  clearTimeout(rememberedSave)
  rememberedSave = undefined
  try {
    globalThis.sessionStorage?.removeItem(REMEMBERED_STORAGE_KEY)
    globalThis.sessionStorage?.removeItem(REMEMBERED_CONFLICTS_STORAGE_KEY)
  } catch {
    // Nothing to clear.
  }
}

/**
 * When to ask about a batch again — the server's answer, obeyed.
 *
 * The cockpit deliberately has no opinion here. Whether a status can still move is forge
 * semantics, and those live server-side next to the cache that decides whether asking would even
 * reach GitHub; a second copy in the cockpit was two tables of constants that had to agree with
 * nothing enforcing it. `null` means "nothing in this answer can change" — a table of merged pull
 * requests schedules nothing at all.
 *
 * The fallback covers only the shapes where there is no answer to obey yet: still loading, or a
 * transport error, where react-query's `retry` owns the immediate attempt and this is just the
 * backstop that keeps the query from going silent forever.
 */
const REF_STATUS_FALLBACK_MS = 5 * 60_000

export function refStatusRecheckAfter(data: GithubRefStatusData | undefined): number | null {
  if (!data) return REF_STATUS_FALLBACK_MS
  return data.recheckAfterMs
}

const refStatusKey = (ref: ReferenceStatusRequest) => `${ref.projectId}\u0000${ref.kind}#${ref.number}`

/**
 * Status for every PR/issue chip a surface is painting, in as few requests as there are projects
 * on screen.
 *
 * The grouping is the point: a task table's references are spread across projects and kinds, and
 * the route is project-scoped, so this collects them into one request per project (both kinds in
 * the same request) rather than one per chip. The caller passes whatever it has and reads back a
 * lookup — no surface has to know about batching, caps, or which project a row came from.
 *
 * `staleTime` matches the server's 60 s cache: re-rendering, re-sorting or paging back to the
 * same window costs nothing. Nothing polls — a status changes on GitHub, not in the run stream,
 * so it refreshes when the query is remounted or invalidated, exactly like the checks glyphs.
 */
export function useReferenceStatuses(
  refs: readonly ReferenceStatusRequest[],
  enabled = true,
): ReferenceStatusLookup {
  // The refs array is rebuilt every render; its CONTENT is what the queries depend on. One sorted
  // signature string keeps the grouping (and therefore every query key) stable across repaints.
  const signature = refs
    .map(refStatusKey)
    .sort()
    .join('|')
  const groups = useMemo(() => {
    const byProject = new Map<string, { prs: Set<number>; issues: Set<number> }>()
    for (const ref of refs) {
      const bucket = byProject.get(ref.projectId) ?? { prs: new Set<number>(), issues: new Set<number>() }
      bucket[ref.kind === 'PR' ? 'prs' : 'issues'].add(ref.number)
      byProject.set(ref.projectId, bucket)
    }
    return [...byProject.entries()].map(([projectId, bucket]) => ({
      projectId,
      prs: cappedNumbers(bucket.prs),
      issues: cappedNumbers(bucket.issues),
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `signature` IS the content of `refs`
  }, [signature])

  const results = useQueries({
    queries: groups.map((group) => ({
      queryKey: queryKeys.githubRefStatus(group.projectId, group.prs, group.issues),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        getGithubRefStatus(group.projectId, { prs: group.prs, issues: group.issues }, { signal }),
      enabled: enabled && group.prs.length + group.issues.length > 0,
      // The one query family in the cockpit that legitimately polls. Everything else is told what
      // changed by the run stream; GitHub is outside that stream and pushes the cockpit nothing,
      // so a chip that says "checks running" has no other way to ever stop saying it. WHEN to ask
      // is the server's call (`recheckAfterMs`), never a constant here.
      staleTime: (query: { state: { data?: GithubRefStatusData } }) =>
        refStatusRecheckAfter(query.state.data) ?? Infinity,
      // `refetchIntervalInBackground` stays at its default, so a hidden tab schedules nothing.
      refetchInterval: (query: { state: { data?: GithubRefStatusData } }) =>
        refStatusRecheckAfter(query.state.data) ?? false,
      // Coming back to the tab is the strongest "is this still true?" signal there is, and the
      // staleTime above rate-limits it to the same cadence — an answer that can never change has
      // an infinite staleTime and so ignores focus entirely. The global default is `false` for the
      // streamed queries, which this is not.
      refetchOnWindowFocus: true,
    })),
  })

  const byRef = useMemo(() => {
    const map = new Map<string, ReferenceStatusEntry>()
    results.forEach((result, index) => {
      const group = groups[index]
      if (!group) return
      // Walk the numbers we ASKED about, not the ones that came back: a number the forge does not
      // have is absent from the answer, and that absence is exactly what `unknown` has to report.
      const asked: ReferenceStatusRequest[] = [
        ...group.prs.map((number) => ({ projectId: group.projectId, kind: 'PR' as const, number })),
        ...group.issues.map((number) => ({ projectId: group.projectId, kind: 'Issue' as const, number })),
      ]
      const data = result.data
      for (const ref of asked) {
        const key = refStatusKey(ref)
        // Whatever this request says, the last thing we learned about this reference stands until
        // a NEWER answer replaces it.
        const remembered = rememberedStatuses.get(key)
        // Same rule as the status, one axis over: the last thing we were told stands until a
        // newer answer replaces it, and `undefined` stays available to mean "never told".
        const rememberedConflict = rememberedConflicts.has(key) ? true : undefined
        if (data?.available) {
          // Either bucket. A repository numbers its issues and pull requests from one sequence, so
          // #774 is exactly one of the two — and which one the cockpit GUESSED (`taskReferences`
          // infers it from whichever field carried the number) can be wrong. The server files the
          // answer under what the number really is; a chip labelled PR that turns out to name an
          // issue still gets that issue's status, which beats reporting "not found".
          const status = data.prs[ref.number] ?? data.issues[ref.number]
          if (status) {
            // A server from before the field omits `conflicts` entirely, and that absence is not
            // an answer: leave the memory alone rather than clearing it to "merges cleanly".
            const conflicting = data.conflicts ? data.conflicts.includes(ref.number) : undefined
            // Written during render on purpose: this is a cache, not state — the write is
            // idempotent, derived solely from the response, and re-running it (StrictMode's
            // double invoke) lands on the same value.
            rememberStatus(key, status)
            if (conflicting !== undefined) rememberConflict(key, conflicting)
            map.set(key, {
              state: 'ready',
              status,
              ...((conflicting ?? rememberedConflict) ? { conflicting: true } : {}),
            })
          } else {
            map.set(key, { state: 'unknown', ...(remembered ? { status: remembered } : {}) })
          }
        } else if (data) {
          map.set(key, {
            state: 'unavailable',
            reason: data.reason,
            ...(remembered ? { status: remembered } : {}),
            ...(rememberedConflict ? { conflicting: true } : {}),
          })
        } else if (result.isError) {
          // A transport failure, as opposed to the server's own "I could not reach gh" payload.
          map.set(key, {
            state: 'unavailable',
            reason: result.error instanceof Error ? result.error.message : undefined,
            ...(remembered ? { status: remembered } : {}),
            ...(rememberedConflict ? { conflicting: true } : {}),
          })
        } else {
          map.set(key, {
            state: 'loading',
            ...(remembered ? { status: remembered } : {}),
            ...(rememberedConflict ? { conflicting: true } : {}),
          })
        }
      }
    })
    return map
    // `results` is a fresh array identity every render; its DATA is what the map is built from.
  }, [groups, results.map((result) => `${result.dataUpdatedAt}:${result.status}`).join(',')])

  return useCallback(
    (ref: ReferenceStatusRequest): ReferenceStatusEntry => {
      const key = refStatusKey(ref)
      const current = byRef.get(key)
      if (current) return current
      // Not in any batch on this surface — past the cap, or asked about by a different surface
      // that has since unmounted. Whatever was learned then is still the best answer there is.
      const remembered = rememberedStatuses.get(key)
      return {
        state: 'idle',
        ...(remembered ? { status: remembered } : {}),
        ...(rememberedConflicts.has(key) ? { conflicting: true } : {}),
      }
    },
    [byRef],
  )
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
