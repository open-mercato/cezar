import type {
  AgentConfigFileContent,
  AgentConfigListing,
  ApiRun,
  ArchiveFinishedResponse,
  CancelResponse,
  ChangesPayload,
  CheckoutProjectInput,
  ConfigResponse,
  ReclaimWorktreesResponse,
  RemoveWorktreeResponse,
  WorktreesResponse,
  ContinueResponse,
  CreatePrResponse,
  CreateRunInput,
  CreateRunResponse,
  DeleteRunResponse,
  DeleteWorkflowResponse,
  FinishResponse,
  FsBrowseResponse,
  GitCommitResponse,
  GitPushResponse,
  GithubChecksData,
  GithubCommentsData,
  GithubData,
  GithubMergeMethod,
  GithubMergeResponse,
  GithubPrMergeStateResponse,
  GithubPrChangesData,
  GroupResponse,
  HealthResponse,
  ImageInput,
  LaunchKeyResponse,
  MessageInput,
  EditQueuedMessageResponse,
  MessageResponse,
  RemoveQueuedMessageResponse,
  OpenInCliResponse,
  OpenTargetsResponse,
  ParsedWorkflow,
  PatchRunInput,
  PickVariantResponse,
  PlanResponse,
  ProviderConnectResponse,
  ProviderId,
  ProviderStatusResponse,
  ProjectsResponse,
  RegisterProjectResponse,
  RemoveProjectResponse,
  UpdateProjectInput,
  UpdateProjectResponse,
  RemoveTodoResponse,
  RepoBranchResponse,
  RepoCommitPayload,
  RunCommitsResponse,
  RepoResponse,
  Runner,
  RunnerModelCatalogResponse,
  RunRecord,
  WorktreeEntry,
  SaveWorkflowInput,
  SaveWorkflowResponse,
  SetConfigInput,
  SetConfigResponse,
  SetAgentConfigInput,
  SetWorkspaceConfigInput,
  ImportableSkill,
  Skill,
  StartTodoResponse,
  TodoItem,
  UiState,
  WorkflowsResponse,
  WorkspaceConfigResponse,
  WorkspaceUiState,
  SkillsUpdateState,
} from '@open-mercato/cezar-api-client'
import { parseProviderStatusResponse } from '@/lib/provider-status'
import { scopeApiPath } from '@open-mercato/cezar-api-client'

/**
 * The typed client for the cockpit's own HTTP API.
 *
 * Same-origin by construction: the Hono server serves this bundle and owns `/api/*`, and the
 * Vite dev server proxies `/api` to it. So every path here is root-relative — there is no base
 * URL to configure and no cross-origin case to get wrong.
 *
 * Multi-project (spec, step 3.1): every path below is spelled in the legacy unscoped form and
 * prefixed to `/api/p/<id>` at request time by `send()` (via `scopeApiPath`) when a project
 * scope is active. Unscoped, `scopeApiPath` is the identity — the request paths stay
 * byte-identical to the single-project cockpit. `runFileRawUrl` is the one URL this module
 * hands out instead of fetching itself, so it applies the scope at build time.
 *
 * This module is the boundary. It parses responses, turns every non-2xx into an `ApiError`
 * carrying the server's own words, and does nothing else: no caching, no retries, no
 * reconnect. Freshness is SSE's job and TanStack Query's (queries.ts, and Step 3.2's reconcile).
 */

/**
 * A failed API call.
 *
 * `message` is the server's `{ error }` verbatim wherever it sent one, because it writes those
 * for the person reading them — "run is active — cancel it first", "no terminal emulator
 * found". Rewording them here would be inventing a worse error. The extras are the fields the
 * server pairs with specific 409s so the UI can offer the manual way out.
 */
export class ApiError extends Error {
  /** HTTP status, or 0 when the request never reached the server (offline, server stopped). */
  readonly status: number
  /** `POST /api/runs/:id/pr`: the `git merge <branch>` to run by hand when the PR failed. */
  readonly manual?: string
  /** `POST /api/runs/:id/open-in-cli`: the resume command, when no terminal could be opened. */
  readonly command?: string
  /** `POST /api/workflows`: the file is already there — the caller may retry with `overwrite`. */
  readonly exists?: boolean

  constructor(
    status: number,
    message: string,
    extras: { manual?: string; command?: string; exists?: boolean; cause?: unknown } = {},
  ) {
    super(message, extras.cause !== undefined ? { cause: extras.cause } : undefined)
    this.name = 'ApiError'
    this.status = status
    this.manual = extras.manual
    this.command = extras.command
    this.exists = extras.exists
  }
}

export type ReadOptions = {
  /** Wired to TanStack Query's per-query signal, so an unmounted view stops its fetch. */
  signal?: AbortSignal
}

type Json = Record<string, unknown>

/** JSON.parse that answers "not JSON" instead of throwing — an error body is untrusted input:
 *  a proxy's HTML 502 page is as likely as the server's own `{ error }`. */
function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown
  } catch {
    return undefined
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Build the ApiError for a non-2xx, preferring the server's own message. */
function errorFor(status: number, statusText: string, body: string): ApiError {
  const parsed = parseJson(body)
  const json: Json = parsed && typeof parsed === 'object' ? (parsed as Json) : {}
  const message =
    str(json.error) ??
    // No `{ error }` — a proxy error page, an empty body, a crash. Say what we know rather
    // than leak a page of HTML into a toast.
    `${status} ${statusText || 'request failed'}`.trim()
  return new ApiError(status, message, {
    manual: str(json.manual),
    command: str(json.command),
    exists: typeof json.exists === 'boolean' ? json.exists : undefined,
  })
}

async function send(path: string, init: RequestInit): Promise<Response> {
  try {
    // Be explicit at the shared boundary: remote installations are commonly protected by
    // reverse-proxy Basic Auth, and every background query/mutation must reuse that authenticated
    // browser session just like navigation does. `include` is harmless for the root-relative,
    // same-origin paths enforced above and prevents an individual call site from silently losing
    // credentials when the browser/proxy combination is stricter than the fetch default.
    return await fetch(scopeApiPath(path), { ...init, credentials: 'include' })
  } catch (cause) {
    // The request never got an answer. Not an HTTP failure — hence status 0 — but callers get
    // one error type either way instead of two.
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
    throw new ApiError(0, `cannot reach the cezar server (${path})`, { cause })
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await send(path, init)
  const body = await res.text()
  if (!res.ok) throw errorFor(res.status, res.statusText, body)
  const parsed = parseJson(body)
  if (parsed === undefined) {
    throw new ApiError(res.status, `the cezar server answered ${path} with a non-JSON body`)
  }
  return parsed as T
}

/** For the endpoints that answer `text/plain` (diffs, the handoff journal). */
async function requestText(path: string, init: RequestInit = {}): Promise<string> {
  const res = await send(path, init)
  const body = await res.text()
  if (!res.ok) throw errorFor(res.status, res.statusText, body)
  return body
}

function get<T>(path: string, opts: ReadOptions = {}): Promise<T> {
  return request<T>(path, { method: 'GET', signal: opts.signal })
}

function mutate<T>(method: string, path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
}

const runPath = (id: string, suffix = ''): string => `/api/runs/${encodeURIComponent(id)}${suffix}`

// ---- reads --------------------------------------------------------------------------------

/** Version, update check, repo/branch, and the tool probes behind the Tools menu. */
export function getHealth(opts?: ReadOptions): Promise<HealthResponse> {
  return get<HealthResponse>('/api/health', opts)
}

/** Host-local Codex catalog. Workspace-level: one CLI/account serves every project. */
export function getRunnerModels(opts?: ReadOptions): Promise<RunnerModelCatalogResponse> {
  return get<RunnerModelCatalogResponse>('/api/models?runner=codex', opts)
}

/** Host-local authentication state shared by every project. */
export function getProviderStatus(
  refresh = false,
  opts?: ReadOptions,
): Promise<ProviderStatusResponse> {
  return get<unknown>(
    `/api/providers/status${refresh ? '?refresh=1' : ''}`,
    opts,
  ).then(parseProviderStatusResponse)
}

/** The bookmarklet auto-start secret (spec 011). Fetched to compare against `/new?key=` —
 *  never rendered, never logged, never put back into a URL. */
export function getLaunchKey(opts?: ReadOptions): Promise<LaunchKeyResponse> {
  return get<LaunchKeyResponse>('/api/launch-key', opts)
}

/** The workspace project registry (multi-project spec). Workspace-level, so `scopeApiPath`
 *  never prefixes it — one registry no matter which project is active. */
export function getProjects(opts?: ReadOptions): Promise<ProjectsResponse> {
  return get<ProjectsResponse>('/api/projects', opts)
}

/** One directory listing for the folder picker (`GET /api/fs/browse`, step 4.1). `path`
 *  omitted means the independently configured browse root, so the dialog never has to know
 *  or duplicate that workspace setting. */
export function browseFs(path?: string, opts?: ReadOptions): Promise<FsBrowseResponse> {
  const query = path === undefined || path === '' ? '' : `?path=${encodeURIComponent(path)}`
  return get<FsBrowseResponse>(`/api/fs/browse${query}`, opts)
}

/** The authoritative run list — sorted newest-first by the server. */
export function getRuns(opts?: ReadOptions): Promise<ApiRun[]> {
  return get<ApiRun[]>('/api/runs', opts)
}

/** One project's run list by EXPLICIT id (`GET /api/p/:projectId/runs`, step 3.3): the sidebar
 *  reads non-active projects' tasks, which the active-scope `send()` prefix cannot reach. An
 *  already-`/api/p/`-prefixed path passes through `scopeApiPath` untouched, so this stays
 *  correct whatever scope is mounted. */
export function getProjectRuns(projectId: string, opts?: ReadOptions): Promise<ApiRun[]> {
  return get<ApiRun[]>(`/api/p/${encodeURIComponent(projectId)}/runs`, opts)
}

export function getRun(id: string, opts?: ReadOptions): Promise<ApiRun> {
  return get<ApiRun>(runPath(id), opts)
}

export function getUiState(opts?: ReadOptions): Promise<UiState> {
  return get<UiState>('/api/ui-state', opts)
}

export function getWorkflows(opts?: ReadOptions): Promise<WorkflowsResponse> {
  return get<WorkflowsResponse>('/api/workflows', opts)
}

export function getSkills(opts?: ReadOptions): Promise<Skill[]> {
  return get<Skill[]>('/api/skills', opts)
}

/** Wait for the server's already-started team-skill load. Used only after the fast catalog
 * read has rendered, so a cold clone never delays opening a skill picker. */
export function getSkillsWhenReady(opts?: ReadOptions): Promise<Skill[]> {
  return get<Skill[]>('/api/skills?wait=1', opts)
}

/** Refresh the team skills repos (spec 005: clone/fetch, degrade quietly offline) and answer
 *  the merged catalog — the Settings → Skills "Refresh" button. */
export function refreshSkills(): Promise<Skill[]> {
  return mutate<Skill[]>('POST', '/api/skills/refresh')
}

/** The default (vendor) repo's full skill list — every skill the "Import skills" panel can
 *  offer, regardless of import state. Empty once a repo configures its own `skillsRepos`. */
export function getImportableSkills(opts?: ReadOptions): Promise<ImportableSkill[]> {
  return get<ImportableSkill[]>('/api/skills/importable', opts)
}

/** Wait for the server's already-started team-skill load before listing importable skills —
 *  the same cold-cache convergence as `getSkillsWhenReady`, off the panel's first render. */
export function getImportableSkillsWhenReady(opts?: ReadOptions): Promise<ImportableSkill[]> {
  return get<ImportableSkill[]>('/api/skills/importable?wait=1', opts)
}

export function getTodos(opts?: ReadOptions): Promise<TodoItem[]> {
  return get<TodoItem[]>('/api/todos', opts)
}

export function getRepo(opts?: ReadOptions): Promise<RepoResponse> {
  return get<RepoResponse>('/api/repo', opts)
}

/** The Settings → Agents knobs in one read (`GET /api/config`, additive R6 route). */
export function getConfig(opts?: ReadOptions): Promise<ConfigResponse> {
  return get<ConfigResponse>('/api/config', opts)
}

/** The selected project's agent-owned config catalog and current file state. */
export function getAgentConfig(opts: ReadOptions = {}): Promise<AgentConfigListing> {
  return get<AgentConfigListing>('/api/agent-config', opts)
}

/** One selected-project config file's raw contents and optimistic version. */
export function getAgentConfigFile(id: string, opts: ReadOptions = {}): Promise<AgentConfigFileContent> {
  return get<AgentConfigFileContent>(`/api/agent-config/${encodeURIComponent(id)}`, opts)
}

/** Save inside the selected project scope; send() adds /api/p/:projectId. */
export function putAgentConfigFile(
  id: string,
  body: SetAgentConfigInput,
): Promise<AgentConfigFileContent> {
  return mutate<AgentConfigFileContent>('PUT', `/api/agent-config/${encodeURIComponent(id)}`, body)
}

/** The main working tree's structured uncommitted diff vs HEAD (R5 repo view). 409 (as an
 *  ApiError with the reason) when the server runs outside a git repository. */
export function getRepoChanges(opts?: ReadOptions): Promise<ChangesPayload> {
  return get<ChangesPayload>('/api/repo/changes', opts)
}

/** One commit's structured diff (R5 repo view): `?structured=1` on the legacy commit route —
 *  additive, the text-blob answer stays for the legacy UI. 409 + reason for unknown shas. */
export function getRepoCommit(sha: string, opts?: ReadOptions): Promise<RepoCommitPayload> {
  return get<RepoCommitPayload>(`/api/repo/commit/${encodeURIComponent(sha)}?structured=1`, opts)
}

/** A run's own commits (`<base>..HEAD`, newest first) for the task's Commits tab. */
export function getRunCommits(id: string, opts?: ReadOptions): Promise<RunCommitsResponse> {
  return get<RunCommitsResponse>(runPath(id, '/commits'), opts)
}

/** One of a run's commits, structured like the Changes tab. 409 for unknown shas. */
export function getRunCommit(id: string, sha: string, opts?: ReadOptions): Promise<RepoCommitPayload> {
  return get<RepoCommitPayload>(runPath(id, `/commit/${encodeURIComponent(sha)}`), opts)
}

/** Issues + PRs via the logged-in `gh`. Degrades to `{ available: false, reason }` server-side —
 *  an unreachable forge is a hint in the tab, not an ApiError. */
export function getGithub(
  params: { limit?: number; refresh?: boolean } = {},
  opts?: ReadOptions,
): Promise<GithubData> {
  const query = new URLSearchParams()
  if (params.limit !== undefined) query.set('limit', String(params.limit))
  if (params.refresh) query.set('refresh', '1')
  const search = query.toString()
  return get<GithubData>(`/api/github${search ? `?${search}` : ''}`, opts)
}

/** Lazy PR checks glyphs for on-screen rows (#664). The list call no longer ships
 *  `statusCheckRollup`; this fills the glyph in per visible PR. Degrades to
 *  `{ available: false, reason }` server-side — a missing glyph, never an ApiError. */
export function getGithubChecks(
  prNumbers: number[],
  opts?: ReadOptions,
): Promise<GithubChecksData> {
  const search = new URLSearchParams({ prs: prNumbers.join(',') }).toString()
  return get<GithubChecksData>(`/api/github/checks?${search}`, opts)
}

/** The full comment thread for one issue/PR (#499). Degrades to `{ available: false, reason }`
 *  server-side — an unreachable thread is a one-line hint in the detail view, not an ApiError. */
export function getGithubComments(
  kind: 'issue' | 'pr',
  number: number,
  params: { refresh?: boolean } = {},
  opts?: ReadOptions,
): Promise<GithubCommentsData> {
  // `refresh=1` is what busts the route's 60 s `commentsCache` (server.ts). Without it a manual
  // refresh re-requests and is handed the same cached object — the caller must be able to say
  // "actually go and ask gh", exactly as `getGithub` can.
  const search = params.refresh ? '?refresh=1' : ''
  return get<GithubCommentsData>(`/api/github/comments/${kind}/${number}${search}`, opts)
}

export function getGithubPrMergeState(
  number: number,
  params: { refresh?: boolean } = {},
  opts?: ReadOptions,
): Promise<GithubPrMergeStateResponse> {
  return get<GithubPrMergeStateResponse>(
    `/api/github/prs/${number}/merge-state${params.refresh ? '?refresh=1' : ''}`,
    opts,
  )
}

export function mergeGithubPr(
  number: number,
  input: { method: GithubMergeMethod; expectedHeadSha: string; overrideRules?: boolean },
): Promise<GithubMergeResponse> {
  return mutate<GithubMergeResponse>('POST', `/api/github/prs/${number}/merge`, input)
}

export function getGithubPrChanges(
  number: number,
  params: { refresh?: boolean } = {},
  opts?: ReadOptions,
): Promise<GithubPrChangesData> {
  return get<GithubPrChangesData>(`/api/github/prs/${number}/changes${params.refresh ? '?refresh=1' : ''}`, opts)
}

/** The run's worktree diff against its base, as unified-diff text. Also the plain-text
 *  "(no worktree — …)" sentence for runs that executed in the repo working tree. */
export function getRunDiff(id: string, opts?: ReadOptions): Promise<string> {
  return requestText(runPath(id, '/diff'), { method: 'GET', signal: opts?.signal })
}

/** The run's handoff journal (spec 007) as markdown text. `''` until the file is seeded —
 *  the server only 404s for an unknown run, never for a missing file. */
export function getRunHandoff(id: string, opts?: ReadOptions): Promise<string> {
  return requestText(runPath(id, '/handoff'), { method: 'GET', signal: opts?.signal })
}

/** The run's structured worktree-vs-base diff (R5): per-file status/±/patch + the aggregate
 *  stat. 409 (as an ApiError with the server's reason) when the run has no worktree. */
export function getRunChanges(id: string, opts?: ReadOptions): Promise<ChangesPayload> {
  return get<ChangesPayload>(runPath(id, '/changes'), opts)
}

/** One worktree path (R5 Files tab; also the Changes tab's expandable-context source):
 *  a directory listing, or a file with content unless binary/too large. */
export function getRunFile(id: string, path: string, opts?: ReadOptions): Promise<WorktreeEntry> {
  return get<WorktreeEntry>(runPath(id, `/files?path=${encodeURIComponent(path)}`), opts)
}

/** The same-origin URL an `<img>` can load an image file's bytes from (R5 Files tab). The
 *  server serves raw ONLY for image extensions within the size cap — everything else 409s.
 *  Scoped here rather than in send() — this URL is handed to an `<img>`, never fetched. */
export function runFileRawUrl(id: string, path: string): string {
  return scopeApiPath(runPath(id, `/files?path=${encodeURIComponent(path)}&raw=1`))
}

/** The variant-compare data (spec 010): one entry per variant of the group, with the legacy
 *  `git diff --stat` text and the handoff Progress excerpt. 404 for an unknown group. */
export function getGroup(groupId: string, opts?: ReadOptions): Promise<GroupResponse> {
  return get<GroupResponse>(`/api/groups/${encodeURIComponent(groupId)}`, opts)
}

// ---- workspace mutations ------------------------------------------------------------------

export function connectProvider(provider: ProviderId): Promise<ProviderConnectResponse> {
  return mutate<ProviderConnectResponse>('POST', '/api/providers/connect', { provider })
}

export function setProviderEnabled(
  provider: ProviderId,
  enabled: boolean,
): Promise<ProviderStatusResponse> {
  return mutate<unknown>(
    'PUT',
    `/api/providers/${encodeURIComponent(provider)}/enabled`,
    { enabled },
  ).then(parseProviderStatusResponse)
}

export function retryProviderAuth(
  provider: ProviderId,
  authFailureId: string,
): Promise<ProviderStatusResponse> {
  return mutate<unknown>(
    'POST',
    `/api/providers/${encodeURIComponent(provider)}/retry`,
    { authFailureId },
  ).then(parseProviderStatusResponse)
}

/**
 * Register an existing folder (`POST /api/projects`, step 4.2).
 *
 * The one call in this module that does not funnel through `request()`: a 409 (already
 * registered) is NOT a failure for the add-project flow — the server answers it with the
 * EXISTING entry, which is exactly what the dialog needs to navigate to. Every other non-2xx
 * still becomes the same ApiError as anywhere else.
 */
export async function registerProject(root: string): Promise<RegisterProjectResponse> {
  const path = '/api/projects'
  const res = await send(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root }),
  })
  const body = await res.text()
  const parsed = parseJson(body)
  const project = (parsed as { project?: unknown } | undefined)?.project
  if ((res.ok || res.status === 409) && project !== undefined && project !== null) {
    return parsed as RegisterProjectResponse
  }
  if (!res.ok) throw errorFor(res.status, res.statusText, body)
  throw new ApiError(res.status, `the cezar server answered ${path} without a project`)
}

/**
 * Clone a GitHub repo into the checkout root and register it (`POST /api/projects/checkout`,
 * step 4.3).
 *
 * Ordinary `mutate()`, unlike `registerProject` above: every non-2xx here IS a failure the
 * dialog must show (a 409 means the target folder exists, and there is no entry to navigate
 * to). `mutate` already surfaces the server's `{ error }` string as the ApiError message, which
 * is exactly what the dialog renders — a clone fails for reasons only the server can name.
 *
 * No timeout of our own: cloning a large repo legitimately takes minutes, and the request is
 * what the dialog waits on. Progress meanwhile comes from `checkout-progress` on the workspace
 * stream, keyed by `input.checkoutId`.
 */
export function checkoutProject(input: CheckoutProjectInput): Promise<RegisterProjectResponse> {
  return mutate<RegisterProjectResponse>('POST', '/api/projects/checkout', input)
}

/**
 * Deregister a project (`DELETE /api/projects/:projectId`, step 4.4).
 *
 * Registry-only by contract — the server deletes NOTHING under the project root — so this
 * never needs an "are you sure you have a backup" ceremony beyond the pane's own confirm.
 * Ordinary `mutate()`: the 409s (running tasks, the boot project) are real failures whose
 * `{ error }` message is what the pane shows, and `errorFor` already surfaces it.
 */
export function removeProject(projectId: string): Promise<RemoveProjectResponse> {
  return mutate<RemoveProjectResponse>('DELETE', `/api/projects/${encodeURIComponent(projectId)}`)
}

/**
 * Set or clear a project's per-project concurrency ceiling
 * (`PATCH /api/projects/:projectId`, spec 2026-07-22). `maxParallel: null`
 * clears the override back to "inherit the workspace cap"; an integer pins it.
 * The server applies the new ceiling live (semaphore refresh), so the answer is
 * the updated entry the pane swaps into its list.
 */
export function updateProject(projectId: string, input: UpdateProjectInput): Promise<UpdateProjectResponse> {
  return mutate<UpdateProjectResponse>('PATCH', `/api/projects/${encodeURIComponent(projectId)}`, input)
}

// ---- run mutations ------------------------------------------------------------------------

/** ×1 answers the run record; ×2/×3 answers `{ runs }` — narrow on `'runs' in result`. */
export function createRun(input: CreateRunInput): Promise<CreateRunResponse> {
  return mutate<CreateRunResponse>('POST', '/api/runs', input)
}

export function cancelRun(id: string): Promise<CancelResponse> {
  return mutate<CancelResponse>('POST', runPath(id, '/cancel'))
}

/** Archives by default; pass `false` to bring a run back into the live list. */
export function archiveRun(id: string, archived = true): Promise<RunRecord> {
  return mutate<RunRecord>('POST', runPath(id, '/archive'), { archived })
}

/** Sweep every finished (done/failed/cancelled) active run into the archive in one call —
 *  the Tasks header's "Archive finished" button. */
export function archiveFinished(): Promise<ArchiveFinishedResponse> {
  return mutate<ArchiveFinishedResponse>('POST', '/api/runs/archive-finished')
}

/** Close a waiting session gracefully — the run completes as done. 409 when nothing is open. */
export function finishRun(id: string): Promise<FinishResponse> {
  return mutate<FinishResponse>('POST', runPath(id, '/finish'))
}

/** The follow-up composer's optional overrides for a Continue (#401): pick which backend and
 *  model handle the reopened session. Omitted fields keep the run's current backend/model.
 *  `text`/`images` are the prompt the reopened session starts on — omitted, the engine opens
 *  with its plain "Continue.". */
export interface ContinueOptions {
  text?: string
  images?: ImageInput[]
  runner?: Runner
  model?: string
}

/** Reopen a finished run's session. 409 (with the reason) when it cannot be resumed. An optional
 *  runner/model override lets the follow-up choose the engine; omitted keeps the run's current
 *  backend (backward compat). */
export function continueRun(id: string, opts: ContinueOptions = {}): Promise<ContinueResponse> {
  const body: Record<string, unknown> = {}
  if (opts.text !== undefined) body.text = opts.text
  if (opts.images !== undefined) body.images = opts.images
  if (opts.runner !== undefined) body.runner = opts.runner
  if (opts.model !== undefined) body.model = opts.model
  return mutate<ContinueResponse>('POST', runPath(id, '/continue'), body)
}

/** Draft PR from the review gate (spec 009): push the branch, `gh pr create --draft`; the run
 *  completes as done with the PR badge. On 409 the ApiError's `manual` carries the
 *  `git merge <branch>` fallback to show copyable. */
export function createRunPr(id: string): Promise<CreatePrResponse> {
  return mutate<CreatePrResponse>('POST', runPath(id, '/pr'))
}

/** Rename a run (#389): the edit becomes the display title and wins over any auto-summary. */
export function patchRun(id: string, patch: PatchRunInput): Promise<RunRecord> {
  return mutate<RunRecord>('PATCH', runPath(id), patch)
}

/** Deletes the run, its transcript, its worktree and its branch. 409 while it is still active. */
export function deleteRun(id: string): Promise<DeleteRunResponse> {
  return mutate<DeleteRunResponse>('DELETE', runPath(id))
}

/** Inbox "Dismiss" (spec 007): check the follow-up off — the server deletes the entry. */
export function removeTodo(id: string): Promise<RemoveTodoResponse> {
  return mutate<RemoveTodoResponse>('DELETE', `/api/todos/${encodeURIComponent(id)}`)
}

/** The Inbox card's optional backend choice + extra instructions for a Run. Unlike
 *  `ContinueOptions` these start a NEW run, so an omitted `runner`/`model` means the host's
 *  `defaultRunner`, not "keep the run's". `prompt` (#413) is extra instructions appended to the
 *  suggested/summary task text — e.g. a template inserted in the Inbox composer. */
export interface StartTodoOptions {
  runner?: Runner
  model?: string
  prompt?: string
}

/** Inbox "Run" (spec 007): the server turns the entry into a task — a one-off single-step
 *  workflow around the suggested skill when it exists, plain quick-task otherwise — and
 *  answers 201 with the new run. 409 when the entry was already started. An optional
 *  runner/model (#401) picks the engine and an optional `prompt` (#413) appends instructions;
 *  with neither, sends no body at all — the pre-#401/#413 bodyless POST, kept for compat. */
export function startTodo(id: string, opts: StartTodoOptions = {}): Promise<StartTodoResponse> {
  const body: Record<string, unknown> = {}
  if (opts.runner !== undefined) body.runner = opts.runner
  if (opts.model !== undefined) body.model = opts.model
  if (opts.prompt !== undefined) body.prompt = opts.prompt
  // No override → no body at all, exactly the bodyless POST this endpoint has always sent
  // (`continueRun` posts `{}` because it always carried one). The server tolerates either.
  return mutate<StartTodoResponse>(
    'POST',
    `/api/todos/${encodeURIComponent(id)}/start`,
    Object.keys(body).length > 0 ? body : undefined,
  )
}

/** "Pick this one" (spec 010): the winner rests at `review` for the gate; the losers are
 *  cancelled if alive, archived, and their worktrees + branches removed. 409 while the picked
 *  variant is still active — the server's words come back verbatim in the ApiError. */
export function pickVariant(groupId: string, runId: string): Promise<PickVariantResponse> {
  return mutate<PickVariantResponse>('POST', `/api/groups/${encodeURIComponent(groupId)}/pick`, { runId })
}

/** Hand the session off to a real terminal (spec 003), in the run's worktree when it still
 *  exists. On 409 the ApiError's `command` carries the manual `cd … && <resume>` to copy. */
export function openRunInCli(id: string): Promise<OpenInCliResponse> {
  return mutate<OpenInCliResponse>('POST', runPath(id, '/open-in-cli'))
}

/** The local editors / file-manager / terminal this machine can open a worktree in (#open-in).
 *  Empty in hosted mode (CEZ_REMOTE). */
export function getOpenTargets(opts?: ReadOptions): Promise<OpenTargetsResponse> {
  return get<OpenTargetsResponse>('/api/open-targets', opts)
}

/** Open the run's worktree in the chosen local app. 409 with `path` when it could not launch. */
export function openRunIn(id: string, target: string): Promise<{ opened: boolean; path: string }> {
  return mutate<{ opened: boolean; path: string }>('POST', runPath(id, '/open-in'), { target })
}

/** Diff pane "open in default app" (#365, LOCAL MODE ONLY): opens one worktree file with the
 *  OS's default handler for its type — not the file manager, a specific file. 409 (server's own
 *  words) in hosted mode, for a path outside the worktree, or when no app could be launched. */
export function openRunFileInApp(id: string, path: string): Promise<{ opened: boolean; path: string }> {
  return mutate<{ opened: boolean; path: string }>('POST', runPath(id, '/open-in'), { target: 'default', path })
}

/** `git add -A && git commit` in the run's worktree (R5). Every predictable git failure —
 *  clean tree, failing hook, missing identity — is a 409 whose ApiError speaks git's words. */
export function commitRun(id: string, message: string): Promise<GitCommitResponse> {
  return mutate<GitCommitResponse>('POST', runPath(id, '/git/commit'), { message })
}

/** Push the worktree's branch, setting upstream when it has none (R5). No remote, detached
 *  HEAD and rejected pushes all come back as 409 + reason. */
export function pushRun(id: string): Promise<GitPushResponse> {
  return mutate<GitPushResponse>('POST', runPath(id, '/git/push'))
}

/** Deliver text and/or pasted screenshots into a run's live session. 409 once it has closed. */
export function sendMessage(id: string, message: MessageInput): Promise<MessageResponse> {
  return mutate<MessageResponse>('POST', runPath(id, '/messages'), {
    text: message.text ?? '',
    images: message.images ?? [],
  })
}

/** Replace a stacked message on a still-queued run (#472). 404 unknown run/message,
 *  409 once the run has started. */
export function editQueuedMessage(
  id: string,
  msgId: string,
  message: MessageInput,
): Promise<EditQueuedMessageResponse> {
  return mutate<EditQueuedMessageResponse>(
    'PATCH',
    runPath(id, `/queued-messages/${encodeURIComponent(msgId)}`),
    message,
  )
}

/** Drop a stacked message from a still-queued run (#472). */
export function removeQueuedMessage(id: string, msgId: string): Promise<RemoveQueuedMessageResponse> {
  return mutate<RemoveQueuedMessageResponse>(
    'DELETE',
    runPath(id, `/queued-messages/${encodeURIComponent(msgId)}`),
  )
}

/** Repo-view branch action (R5): switch to an existing branch, or create one (from `from` or
 *  HEAD) and switch. Invalid names, unknown start points and dirty-tree checkout conflicts
 *  all come back as 409 whose ApiError carries git's own reason. */
export function createRepoBranch(input: { name: string; from?: string }): Promise<RepoBranchResponse> {
  return mutate<RepoBranchResponse>('POST', '/api/repo/branch', input)
}

// ---- plan mode (spec 008) -------------------------------------------------------------------

/** Chain-from-prompt: the planner proposes 1–5 steps for the task. Degraded answers come back
 *  as a one-step plan with `fallback: true`, never as an error — only transport/validation fail. */
export function postPlan(task: string): Promise<PlanResponse> {
  return mutate<PlanResponse>('POST', '/api/plan', { task })
}

/** Save an approved plan as a reusable chain. A 409 carries `exists: true` on the ApiError —
 *  ask the user, then retry with `overwrite: true`. */
export function createWorkflow(input: SaveWorkflowInput): Promise<SaveWorkflowResponse> {
  return mutate<SaveWorkflowResponse>('POST', '/api/workflows', input)
}

/** Import support for the builder (spec 012): the server parses + validates pasted workflow
 *  YAML (either form) and answers the normalized definition. */
export function parseWorkflow(yaml: string): Promise<ParsedWorkflow> {
  return mutate<ParsedWorkflow>('POST', '/api/workflows/parse', { yaml })
}

/** Delete a saved workflow file (spec 012 follow-up). Built-ins answer 400 — they have no
 *  file and always come back. */
export function deleteWorkflow(name: string): Promise<DeleteWorkflowResponse> {
  return mutate<DeleteWorkflowResponse>('DELETE', `/api/workflows/${encodeURIComponent(name)}`)
}

// ---- prefs ---------------------------------------------------------------------------------

/** Merges server-side (the stored object spread under the patch) and answers the merged state. */
export function putUiState(patch: UiState): Promise<UiState> {
  return mutate<UiState>('PUT', '/api/ui-state', patch)
}

/** The cross-project GUI state (`~/.cezar/ui-state.json`, step 2.7). Workspace-level:
 *  `scopeApiPath` never prefixes `/api/workspace/*`. */
export function getWorkspaceUiState(opts?: ReadOptions): Promise<WorkspaceUiState> {
  return get<WorkspaceUiState>('/api/workspace/ui-state', opts)
}

/** Shallow top-level merge server-side, same as its per-repo twin — send whole top-level
 *  objects (`{ sidebar: {...} }`), never a nested leaf alone. Answers the merged state. */
export function putWorkspaceUiState(patch: WorkspaceUiState): Promise<WorkspaceUiState> {
  return mutate<WorkspaceUiState>('PUT', '/api/workspace/ui-state', patch)
}

/** The global settings slice of `~/.cezar/config.json` (step 2.7) — Settings → Resources and
 *  (step 4.4) the checkout-root field. Workspace-level, so never scope-prefixed. */
export function getWorkspaceConfig(opts?: ReadOptions): Promise<WorkspaceConfigResponse> {
  return get<WorkspaceConfigResponse>('/api/workspace/config', opts)
}

/** Cached Open Mercato update state for one registered project. The GET is immediate; the
 * server may start a stale detection-only refresh after taking its snapshot. */
export function getSkillsUpdate(projectId: string, opts?: ReadOptions): Promise<SkillsUpdateState> {
  return get<SkillsUpdateState>(`/api/workspace/skills-update?projectId=${encodeURIComponent(projectId)}`, opts)
}

/** Force a bounded detection pass. The browser supplies identity only, never executable input. */
export function checkSkillsUpdate(projectId: string): Promise<SkillsUpdateState> {
  return mutate<SkillsUpdateState>('POST', '/api/workspace/skills-update/check', { projectId })
}

/** Apply the server-owned, lock-authorized update set. Identity is the only browser input. */
export function applySkillsUpdate(projectId: string): Promise<SkillsUpdateState> {
  return mutate<SkillsUpdateState>('POST', '/api/workspace/skills-update/apply', { projectId })
}

/** Partial update — absent keys stay untouched; answers the merged config. A `projectsDir`
 *  the server cannot write to comes back as a 400 `ApiError` whose message is the reason,
 *  which is exactly what the Projects pane renders inline (step 4.4). */
export function putWorkspaceConfig(patch: SetWorkspaceConfigInput): Promise<WorkspaceConfigResponse> {
  return mutate<WorkspaceConfigResponse>('PUT', '/api/workspace/config', patch)
}

/** Set/clear the agents' config knobs — base branch, default runner, system prompt, per-runner
 *  model presets (Settings → Agents, R6 1.5). Merged into the raw config.json server-side so
 *  unrelated user keys survive; `null` clears a knob back to its default. */
export function putConfig(patch: SetConfigInput): Promise<SetConfigResponse> {
  return mutate<SetConfigResponse>('PUT', '/api/config', patch)
}

/** The worktree management panel (#483): every materialized task worktree with disk usage,
 *  retention state, the total, and the current keep-limit. */
export function getWorktrees(opts?: ReadOptions): Promise<WorktreesResponse> {
  return get<WorktreesResponse>('/api/worktrees', opts)
}

/** "Reclaim now": force the retention enforcer to reclaim over-limit finished worktrees
 *  (directory only — branch kept). Returns the reclaimed run ids. Always 200. */
export function reclaimWorktrees(): Promise<ReclaimWorktreesResponse> {
  return mutate<ReclaimWorktreesResponse>('POST', '/api/worktrees/reclaim', {})
}

/** Per-row "Delete" in the worktrees panel: reclaim one run's worktree AND its branch
 *  (the existing spec-006 route). 409 while the run is active. */
export function removeRunWorktree(id: string): Promise<RemoveWorktreeResponse> {
  return mutate<RemoveWorktreeResponse>('POST', runPath(id, '/remove-worktree'))
}
