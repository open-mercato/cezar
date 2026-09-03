import type {
  AgentConfigFileContent,
  AgentAccountDetailsResponse,
  AgentAccountStatusResponse,
  AgentProfileResponse,
  AgentProfileSelectionsResponse,
  AgentProfilesResponse,
  CreateAgentProfileInput,
  OpenAgentAccountFileInput,
  OpenAgentAccountFileResponse,
  RemoveAgentProfileResponse,
  SelectAgentProfileInput,
  UpdateAgentProfileInput,
  AutomationsResponse,
  AutomationCheck,
  AutomationCheckQueuedResponse,
  AutomationLogResponse,
  AutomationResponse,
  CreateAutomationInput,
  UpdateAutomationInput,
  AgentConfigListing,
  ApiRun,
  ArchiveFinishedResponse,
  MarkAllReadResponse,
  CancelAutoResumeResponse,
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
  GithubRefStatusData,
  GithubCommentsData,
  GithubData,
  GithubMergeMethod,
  GithubMergeResponse,
  GithubPrMergeStateResponse,
  GithubPrChangesData,
  GroupResponse,
  HealthResponse,
  AttachmentInput,
  LaunchKeyResponse,
  MessageInput,
  EditQueuedMessageResponse,
  MessageResponse,
  RemoveQueuedMessageResponse,
  OpenInCliResponse,
  OpenProjectInResponse,
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
  RunHistoryContext,
  RunHistoryPage,
  RepoResponse,
  Runner,
  ModelDiscoveryRunner,
  RunnerModelCatalogResponse,
  RunRecord,
  RunsIndexResponse,
  WorktreeEntry,
  SaveWorkflowInput,
  SaveWorkflowResponse,
  SetConfigInput,
  SetConfigResponse,
  SetAgentConfigInput,
  SetWorkspaceConfigInput,
  SetWorkspaceUiStateInput,
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
import {
  API_PREFIX,
  apiPath,
  createCezarClient,
  getApiBaseUrl,
  getApiScope,
  queryScope,
  runHistoryContextSchema,
  runHistoryPageSchema,
} from '@open-mercato/cezar-api-client'
import type { Ok, OkJson } from '@open-mercato/cezar-api-client'
import type { ClientResponse } from 'hono/client'
import type { ResponseFormat } from 'hono/types'
import type { AppType } from '@open-mercato/cezar/app-type'

/**
 * The cockpit's client for its own HTTP API.
 *
 * Same-origin by construction: the Hono server serves this bundle and owns `/api/v1/*`, and the
 * Vite dev server proxies `/api` to it. So every URL here is root-relative — there is no base
 * URL to configure and no cross-origin case to get wrong.
 *
 * Calls name a ROUTE (`/runs/:id/diff`), never a URL: `apiPath` (api-client) adds the version
 * and, when a project scope is active, the `/p/<id>` segment. That is why the version appears
 * once in this repo rather than at every call site. `runFileRawUrl` is the one URL this module
 * hands out instead of fetching itself, so it resolves the route at build time.
 *
 * This module is the boundary. It parses responses, turns every non-2xx into an `ApiError`
 * carrying the server's own words, and does nothing else: no caching, no retries, no
 * reconnect. Freshness is SSE's job and TanStack Query's (queries.ts, and Step 3.2's reconcile).
 *
 * Every call goes through the typed client (`cez`/`unwrap` below), which checks the route against
 * the server's own handlers. Three functions keep their own `fetch` for a reason `hc` cannot
 * express, and each says which in its own comment: `registerProject` (a 409 is a SUCCESS for the
 * add-project flow), `requestText` (the routes that answer `text/plain`), and `runFileRawUrl`
 * (a URL handed to an `<img>`, never fetched). All of them end in the same `ApiError` contract,
 * so a caller cannot tell which path a given function uses.
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

/**
 * The typed client over the same service (`@open-mercato/cezar-api-client`).
 *
 * Routes are being moved onto this one at a time. What it buys is compile-time checking of the
 * path, the request body and the response shape against the server's OWN handlers — the thing
 * the hand-written DTOs in this package approximate by hand and can drift from.
 *
 * It does NOT replace this module. `client.ts` stays the boundary: it owns `ApiError` (with the
 * server's own words), the credentials policy, and the non-JSON-body case. The typed client
 * only builds and sends the request; `unwrap` applies the same answer contract to whatever
 * comes back, so a migrated call behaves identically to a hand-written one.
 *
 * Not every route is ready. A handler that returns a loose type (`/health` answers
 * `Record<string, unknown>`) infers a weaker response than the DTO it replaces, so those wait
 * until the server tightens its own return types.
 */
const cez = createCezarClient<AppType>({
  // The base URL is resolved per request, not baked in at construction: this module is imported
  // before `main.tsx` configures it, and a `<meta>`-configured deployment must still take
  // effect. `hc` builds a root-relative URL, so prefixing here is the whole job.
  fetch: (input: string | URL | Request, init?: RequestInit) =>
    fetchOrThrow(withApiBase(String(input)), init),
})

/**
 * Prefix a root-relative URL the typed client built with the configured service origin.
 *
 * Also the one place the two request paths are reconciled on the wire. `hc` appends a `?` for
 * any `query` argument it is given, even one whose every value was optional and absent — an
 * equivalent URL, but not the one `apiPath` writes, and the stubs in this app's tests match on
 * the path they see.
 */
function withApiBase(url: string): string {
  const path = unscoped(url.endsWith('?') ? url.slice(0, -1) : url)
  return path.startsWith('/') ? `${getApiBaseUrl()}${path}` : path
}

/** The scoped spelling `hc` always builds for a project-scoped route, with no project mounted. */
const DEFAULT_SCOPE = `${API_PREFIX}/p/default`

/**
 * Drop the `/p/default` segment when no project scope is active.
 *
 * `hc` paths are static: a project-scoped route is spelled `p[':projectId']` at every call site
 * and the active scope goes in as `queryScope()`, which answers `'default'` when there is none.
 * That keeps ONE code path per call (the alternative was a branch per call), and the server
 * reserves `default` as the alias for the boot project, so both spellings reach the same handler.
 *
 * They are not the same URL, though, and this module's other half (`apiPath`) emits the
 * unprefixed one when unscoped. Normalising here — the single point every typed-client request
 * passes through — is what keeps an unscoped request byte-identical whichever half sent it, so
 * migrating a route never moves it on the wire.
 */
function unscoped(url: string): string {
  if (getApiScope() !== null || !url.startsWith(DEFAULT_SCOPE)) return url
  const rest = url.slice(DEFAULT_SCOPE.length)
  // Only a whole segment: a project genuinely called `default-ish` must keep its own prefix.
  return rest === '' || rest.startsWith('/') || rest.startsWith('?') ? `${API_PREFIX}${rest}` : url
}

/**
 * Apply this module's answer contract to a Response the typed client produced.
 *
 * Same three outcomes as `request()`: a non-2xx becomes an `ApiError` carrying the server's own
 * message, a non-JSON body becomes an `ApiError` naming the URL, anything else is the parsed
 * value — whose type the caller gets from the route, not from a hand-written declaration.
 */
/** The per-request options `hc` takes, from this module's `ReadOptions`. */
const init = (opts?: ReadOptions) => ({ init: { signal: opts?.signal } })

/**
 * Accepts a route that answers more than one FORMAT — `/repo/commit/:sha` serves a structured
 * payload or a raw blob on the same path, `/runs/:id/files` a listing or image bytes — and reads
 * the JSON branch. `OkJson` keeps that from becoming a hole: a route with no JSON branch at all
 * resolves to a branded error type rather than to `never`, which would have been assignable to
 * every caller's declared return type and failed only at runtime.
 */
async function unwrap<R extends ClientResponse<unknown, number, ResponseFormat>>(
  res: R,
  label: string,
): Promise<OkJson<R>> {
  const body = await res.text()
  if (!res.ok) throw errorFor(res.status, res.statusText, body)
  const parsed = parseJson(body)
  if (parsed === undefined) {
    throw new ApiError(res.status, `the cezar server answered ${label} with a non-JSON body`)
  }
  return parsed as OkJson<R>
}

/**
 * The `safeParse` half of a contract schema, spelled structurally.
 *
 * Keeps this package free of a direct `zod` dependency: the schemas arrive through the
 * api-client barrel as runtime values (`contract-pipeline.test.ts` pins that), and this is the
 * only part of them `unwrapValidated` uses.
 */
type ResponseValidator<T> = {
  safeParse: (value: unknown) => { success: true; data: T } | { success: false }
}

/**
 * `unwrap`, plus the shape check its cast cannot make.
 *
 * `unwrap` ends in `parsed as OkJson<R>` — a compile-time claim about a body the server sent at
 * runtime. For most routes the claim is harmless: a caller reading a missing field gets
 * `undefined` and renders nothing. The history routes are different — `useRunHistory` iterates
 * `page.events`, so a 200 whose body is not a page throws a `TypeError` mid-render and takes the
 * session view down with it, bypassing the hook's own full-replay fallback (which only triggers
 * on a REJECTED query). Validating here turns that body into the same `ApiError` a non-JSON body
 * already produces, so the malformed case degrades exactly like the unreachable one.
 *
 * Its own server cannot produce such a body (`contract-parity.test.ts` pins both response types
 * to these schemas) — this guards the boundary against a proxy, a stale server, or a stub.
 */
async function unwrapValidated<R extends ClientResponse<unknown, number, ResponseFormat>>(
  res: R,
  label: string,
  schema: ResponseValidator<OkJson<R>>,
): Promise<OkJson<R>> {
  const status = res.status
  const parsed = await unwrap(res, label)
  const result = schema.safeParse(parsed)
  if (!result.success) {
    throw new ApiError(status, `the cezar server answered ${label} with an unexpected body`)
  }
  return result.data
}

/**
 * The one `fetch` both request paths go through — hand-written and typed alike.
 *
 * Shared rather than duplicated because the two behaviours below are the contract, and a
 * migrated route that quietly lost either of them would be a regression nobody sees until a
 * server is down:
 *
 * - **Credentials.** Remote installations are commonly behind reverse-proxy Basic Auth, and
 *   every background query/mutation must reuse that authenticated browser session just like
 *   navigation does. `include` is harmless for the root-relative, same-origin paths used here.
 * - **Unreachable is an `ApiError`, not a `TypeError`.** The request never got an answer — not
 *   an HTTP failure, hence status 0 — but callers get one error type either way instead of two.
 *   An abort is re-thrown untouched: that is the caller cancelling, not the server failing.
 */
async function fetchOrThrow(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, credentials: 'include' })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
    throw new ApiError(0, `cannot reach the cezar server (${url})`, { cause })
  }
}

async function send(path: string, init: RequestInit): Promise<Response> {
  // Resolved here so the error names the URL that actually failed, not the route the caller
  // asked for — "cannot reach /health" would send someone looking for the wrong thing.
  return fetchOrThrow(apiPath(path), init)
}

/**
 * For the endpoints that answer `text/plain` (diffs, the handoff journal).
 *
 * These say so in `Accept`. Two of the server's routes now negotiate the representation from that
 * header when no query flag decides it (`/repo/commit/:sha`, `/runs/:id/files`), and a reader that
 * wants text should ASK for text rather than rely on a default — `fetch` would otherwise send
 * `*<slash>*`, which those routes deliberately read as "no preference". None of the callers here
 * is on a negotiating route today; the header is what keeps that true if one ever moves.
 */
async function requestText(path: string, init: RequestInit = {}): Promise<string> {
  const headers = new Headers(init.headers)
  headers.set('accept', 'text/plain')
  const res = await send(path, { ...init, headers })
  const body = await res.text()
  if (!res.ok) throw errorFor(res.status, res.statusText, body)
  return body
}

const runPath = (id: string, suffix = ''): string => `/runs/${encodeURIComponent(id)}${suffix}`

// ---- reads --------------------------------------------------------------------------------

/** Version, update check, repo/branch, and the tool probes behind the Tools menu. */
export async function getHealth(opts?: ReadOptions): Promise<HealthResponse> {
  return unwrap(await cez.api.v1.health.$get({}, init(opts)), '/health')
}

/** Host-local catalog for one discovery runner (`codex`, `opencode` — #794). Workspace-level:
 *  one CLI/account serves every project. */
export async function getRunnerModels(
  runner: ModelDiscoveryRunner,
  opts?: ReadOptions,
): Promise<RunnerModelCatalogResponse> {
  return unwrap(await cez.api.v1.models.$get({ query: { runner } }, init(opts)), '/models')
}

/** Host-local authentication state shared by every project. */
export async function getProviderStatus(
  refresh = false,
  opts?: ReadOptions,
): Promise<ProviderStatusResponse> {
  return parseProviderStatusResponse(
    await unwrap(
      await cez.api.v1.providers.status.$get(
        { query: refresh ? { refresh: '1' } : {} },
        init(opts),
      ),
      '/providers/status',
    ),
  )
}

/** The bookmarklet auto-start secret (spec 011). Fetched to compare against `/new?key=` —
 *  never rendered, never logged, never put back into a URL. */
export async function getLaunchKey(opts?: ReadOptions): Promise<LaunchKeyResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId']['launch-key'].$get(
      { param: { projectId: queryScope() } },
      init(opts),
    ),
    '/launch-key',
  )
}

/** The workspace project registry (multi-project spec). Workspace-level — one registry no
 *  matter which project is active, so it has no project-scoped spelling.
 *
 *  Migrated to the typed client: the path and the response shape are checked against the
 *  server's handler, and `ProjectsResponse` here is an assertion that the inferred type still
 *  matches the DTO rather than the source of it. */
export async function getProjects(opts?: ReadOptions): Promise<ProjectsResponse> {
  return unwrap(await cez.api.v1.projects.$get({}, init(opts)), '/projects')
}

/** One directory listing for the folder picker (`GET /api/fs/browse`, step 4.1). `path`
 *  omitted means the independently configured browse root, so the dialog never has to know
 *  or duplicate that workspace setting. */
export async function browseFs(
  path?: string,
  opts?: ReadOptions & {
    /** Include dot-directories. Off by default (project folders are not hidden); ON for the
     *  agent-account picker, where EVERY candidate is one — `~/.claude-klaudiusz` and friends. */
    showHidden?: boolean
  },
): Promise<FsBrowseResponse> {
  return unwrap(
    // An absent `path` stays absent rather than becoming `?path=`: the server distinguishes
    // "no path" (the configured browse root) from an empty one only by `?? ''`, but `hc` drops
    // an `undefined` value entirely, which keeps the URL the one this call always sent. Same
    // reason `showHidden` is omitted rather than sent as `0`.
    await cez.api.v1.fs.browse.$get(
      {
        query: {
          path: path === '' ? undefined : path,
          ...(opts?.showHidden ? { showHidden: '1' } : {}),
        },
      },
      init(opts),
    ),
    '/fs/browse',
  )
}

/** The authoritative run list — sorted newest-first by the server. */
export async function getRuns(opts?: ReadOptions): Promise<ApiRun[]> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs.$get({ param: { projectId: queryScope() } }, init(opts)),
    '/runs',
  )
}

/** One project's run list by EXPLICIT id (`GET /api/p/:projectId/runs`, step 3.3): the sidebar
 *  reads non-active projects' tasks, which the active-scope `send()` prefix cannot reach. An
 *  already-`/api/p/`-prefixed path passes through `apiPath` untouched, so this stays
 *  correct whatever scope is mounted. */
export async function getProjectRuns(projectId: string, opts?: ReadOptions): Promise<ApiRun[]> {
  return unwrap(await cez.api.v1.p[':projectId'].runs.$get({ param: { projectId } }, init(opts)), '/runs')
}

/** The cross-project task index (`GET /api/v1/workspace/runs-index`) — what lets ⌘K find a task
 *  without knowing which project it lives in. Workspace-level like the registry, so it has no
 *  project-scoped spelling and never takes `queryScope()`. */
export async function getRunsIndex(opts?: ReadOptions): Promise<RunsIndexResponse> {
  return unwrap(await cez.api.v1.workspace['runs-index'].$get({}, init(opts)), '/workspace/runs-index')
}

export async function getRun(id: string, opts?: ReadOptions): Promise<ApiRun> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].$get(
      { param: { projectId: queryScope(), id: encodeURIComponent(id) } },
      init(opts),
    ),
    runPath(id),
  )
}

/**
 * The same read by EXPLICIT project — the twin of `getRun`, for the reason `archiveProjectRun`
 * spells out: the global Tasks page stands outside every `/p/:projectId`, so `queryScope()` would
 * name the BOOT project for a row that belongs to another one. It is also the only way that page
 * can learn a run's steps: its own index ships a deliberately slim entry (no `steps`, no
 * `runner`), and whether a finished task can be reopened is a question only the full record
 * answers.
 */
export async function getProjectRun(projectId: string, id: string, opts?: ReadOptions): Promise<ApiRun> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].$get(
      { param: { projectId, id: encodeURIComponent(id) } },
      init(opts),
    ),
    runPath(id),
  )
}

/** One reverse-paged history page. Validated (not merely cast) because `useRunHistory` iterates
 *  `events`: see `unwrapValidated`. */
export async function getRunHistory(
  id: string,
  cursor?: string,
  opts?: ReadOptions,
): Promise<RunHistoryPage> {
  return unwrapValidated(
    await cez.api.v1.p[':projectId'].runs[':id'].history.$get(
      {
        param: { projectId: queryScope(), id: encodeURIComponent(id) },
        query: { ...(cursor !== undefined ? { cursor } : {}) },
      },
      init(opts),
    ),
    `${runPath(id)}/history`,
    runHistoryPageSchema,
  )
}

/** The compact current-state context for a run. Validated for the same reason as the page above. */
export async function getRunHistoryContext(id: string, opts?: ReadOptions): Promise<RunHistoryContext> {
  return unwrapValidated(
    await cez.api.v1.p[':projectId'].runs[':id']['history-context'].$get(
      { param: { projectId: queryScope(), id: encodeURIComponent(id) } },
      init(opts),
    ),
    `${runPath(id)}/history-context`,
    runHistoryContextSchema,
  )
}

export async function getUiState(opts?: ReadOptions): Promise<UiState> {
  return unwrap(
    await cez.api.v1.p[':projectId']['ui-state'].$get(
      { param: { projectId: queryScope() } },
      init(opts),
    ),
    '/ui-state',
  )
}

export async function getWorkflows(opts?: ReadOptions): Promise<WorkflowsResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].workflows.$get(
      { param: { projectId: queryScope() } },
      init(opts),
    ),
    '/workflows',
  )
}

export async function getSkills(opts?: ReadOptions): Promise<Skill[]> {
  return unwrap(
    await cez.api.v1.p[':projectId'].skills.$get(
      // `query` is required once the route declares one, even when every key in it is optional
      // — `hc` drops the empty search string, so the URL is the one this call always sent.
      { param: { projectId: queryScope() }, query: {} },
      init(opts),
    ),
    '/skills',
  )
}

/** Wait for the server's already-started team-skill load. Used only after the fast catalog
 * read has rendered, so a cold clone never delays opening a skill picker. */
export async function getSkillsWhenReady(opts?: ReadOptions): Promise<Skill[]> {
  return unwrap(
    await cez.api.v1.p[':projectId'].skills.$get(
      { param: { projectId: queryScope() }, query: { wait: '1' } },
      init(opts),
    ),
    '/skills',
  )
}

/** Refresh the team skills repos (spec 005: clone/fetch, degrade quietly offline) and answer
 *  the merged catalog — the Settings → Skills "Refresh" button. */
export async function refreshSkills(): Promise<Skill[]> {
  return unwrap(
    await cez.api.v1.p[':projectId'].skills.refresh.$post({ param: { projectId: queryScope() } }),
    '/skills/refresh',
  )
}

/** The default (vendor) repo's full skill list — every skill the "Import skills" panel can
 *  offer, regardless of import state. Empty once a repo configures its own `skillsRepos`. */
export async function getImportableSkills(opts?: ReadOptions): Promise<ImportableSkill[]> {
  return unwrap(
    await cez.api.v1.p[':projectId'].skills.importable.$get(
      { param: { projectId: queryScope() }, query: {} },
      init(opts),
    ),
    '/skills/importable',
  )
}

/** Wait for the server's already-started team-skill load before listing importable skills —
 *  the same cold-cache convergence as `getSkillsWhenReady`, off the panel's first render. */
export async function getImportableSkillsWhenReady(opts?: ReadOptions): Promise<ImportableSkill[]> {
  return unwrap(
    await cez.api.v1.p[':projectId'].skills.importable.$get(
      { param: { projectId: queryScope() }, query: { wait: '1' } },
      init(opts),
    ),
    '/skills/importable',
  )
}

export async function getTodos(opts?: ReadOptions): Promise<TodoItem[]> {
  return unwrap(
    await cez.api.v1.p[':projectId'].todos.$get({ param: { projectId: queryScope() } }, init(opts)),
    '/todos',
  )
}

export async function getRepo(opts?: ReadOptions): Promise<RepoResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].repo.$get({ param: { projectId: queryScope() } }, init(opts)),
    '/repo',
  )
}

/** The Settings → Agents knobs in one read (`GET /api/config`, additive R6 route). */
export async function getConfig(opts?: ReadOptions): Promise<ConfigResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].config.$get({ param: { projectId: queryScope() } }, init(opts)),
    '/config',
  )
}

/** The selected project's agent-owned config catalog and current file state. */
export async function getAgentConfig(opts: ReadOptions = {}): Promise<AgentConfigListing> {
  return unwrap(
    await cez.api.v1.p[':projectId']['agent-config'].$get(
      { param: { projectId: queryScope() } },
      init(opts),
    ),
    '/agent-config',
  )
}

/** One selected-project config file's raw contents and optimistic version. */
export async function getAgentConfigFile(
  id: string,
  opts: ReadOptions = {},
): Promise<AgentConfigFileContent> {
  return unwrap(
    await cez.api.v1.p[':projectId']['agent-config'][':id'].$get(
      { param: { projectId: queryScope(), id: encodeURIComponent(id) } },
      init(opts),
    ),
    `/agent-config/${encodeURIComponent(id)}`,
  )
}

/** Save inside the selected project scope; send() adds /api/p/:projectId. */
export async function putAgentConfigFile(
  id: string,
  body: SetAgentConfigInput,
): Promise<AgentConfigFileContent> {
  return unwrap(
    await cez.api.v1.p[':projectId']['agent-config'][':id'].$put({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
      json: body,
    }),
    `/agent-config/${encodeURIComponent(id)}`,
  )
}

/** The main working tree's structured uncommitted diff vs HEAD (R5 repo view). 409 (as an
 *  ApiError with the reason) when the server runs outside a git repository. */
export async function getRepoChanges(opts?: ReadOptions): Promise<ChangesPayload> {
  return unwrap(
    await cez.api.v1.p[':projectId'].repo.changes.$get(
      { param: { projectId: queryScope() } },
      init(opts),
    ),
    '/repo/changes',
  )
}

/** One commit's structured diff (R5 repo view): `?structured=1` on the legacy commit route —
 *  additive, the text-blob answer stays for the legacy UI. 409 + reason for unknown shas. */
/*  NOT on the typed client, and it is the route that cannot be: the same handler answers the
 *  legacy `text/plain` blob when `?structured=1` is absent (a protected surface —
 *  BACKWARD_COMPATIBILITY.md §2), so `hc` infers a text member alongside the JSON one — one path,
 *  two formats. `unwrap` reads the JSON branch; `OkJson` is what stops that from also silently
 *  accepting a route that has no JSON branch at all. */
export async function getRepoCommit(sha: string, opts?: ReadOptions): Promise<RepoCommitPayload> {
  return unwrap(
    await cez.api.v1.p[':projectId'].repo.commit[':sha'].$get(
      { param: { projectId: queryScope(), sha: encodeURIComponent(sha) }, query: { structured: '1' } },
      init(opts),
    ),
    '/repo/commit/:sha',
  )
}

/** A run's own commits (`<base>..HEAD`, newest first) for the task's Commits tab. */
export async function getRunCommits(id: string, opts?: ReadOptions): Promise<RunCommitsResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].commits.$get(
      { param: { projectId: queryScope(), id: encodeURIComponent(id) } },
      init(opts),
    ),
    runPath(id, '/commits'),
  )
}

/** One of a run's commits, structured like the Changes tab. 409 for unknown shas. */
export async function getRunCommit(
  id: string,
  sha: string,
  opts?: ReadOptions,
): Promise<RepoCommitPayload> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].commit[':sha'].$get(
      { param: { projectId: queryScope(), id: encodeURIComponent(id), sha: encodeURIComponent(sha) } },
      init(opts),
    ),
    runPath(id, `/commit/${encodeURIComponent(sha)}`),
  )
}

/** Issues + PRs via the logged-in `gh`. Degrades to `{ available: false, reason }` server-side —
 *  an unreachable forge is a hint in the tab, not an ApiError. */
export async function getGithub(
  params: { limit?: number; refresh?: boolean } = {},
  opts?: ReadOptions,
): Promise<GithubData> {
  return unwrap(
    await cez.api.v1.p[':projectId'].github.$get(
      {
        param: { projectId: queryScope() },
        // `refresh: false` sends nothing at all — the server tests `=== '1'`, and a parameter we
        // do not mean is how a "false" ends up read as truthy somewhere downstream.
        query: {
          limit: params.limit === undefined ? undefined : String(params.limit),
          refresh: params.refresh ? '1' : undefined,
        },
      },
      init(opts),
    ),
    '/github',
  )
}

/** Lazy PR checks glyphs for on-screen rows (#664). The list call no longer ships
 *  `statusCheckRollup`; this fills the glyph in per visible PR. Degrades to
 *  `{ available: false, reason }` server-side — a missing glyph, never an ApiError. */
export async function getGithubChecks(
  prNumbers: number[],
  opts?: ReadOptions,
): Promise<GithubChecksData> {
  return unwrap(
    await cez.api.v1.p[':projectId'].github.checks.$get(
      { param: { projectId: queryScope() }, query: { prs: prNumbers.join(',') } },
      init(opts),
    ),
    '/github/checks',
  )
}

/**
 * Batched status for the PR/issue chips on screen. Takes its project EXPLICITLY, like
 * `getProjectRuns` and `archiveProjectRun` and for the same reason: the global Tasks page stands
 * outside every `/p/:projectId`, and its rows belong to different projects — `queryScope()` would
 * ask the boot project about another project's PR number and get a confident wrong answer.
 * Callers standing in one project pass their own id.
 *
 * Degrades to `{ available: false, reason }` server-side; an absent number is "nothing known",
 * which the chip renders exactly as it did before statuses existed.
 */
export async function getGithubRefStatus(
  projectId: string,
  refs: { prs?: readonly number[]; issues?: readonly number[] },
  opts?: ReadOptions,
): Promise<GithubRefStatusData> {
  return unwrap(
    await cez.api.v1.p[':projectId'].github['ref-status'].$get(
      {
        param: { projectId },
        query: {
          // Spread conditionally: the route reads an ABSENT key as "not asked for", and an empty
          // string would be a malformed list (a 400) rather than a silent no-op.
          ...(refs.prs?.length ? { prs: refs.prs.join(',') } : {}),
          ...(refs.issues?.length ? { issues: refs.issues.join(',') } : {}),
        },
      },
      init(opts),
    ),
    '/github/ref-status',
  )
}

/** The full comment thread for one issue/PR (#499). Degrades to `{ available: false, reason }`
 *  server-side — an unreachable thread is a one-line hint in the detail view, not an ApiError. */
export async function getGithubComments(
  kind: 'issue' | 'pr',
  number: number,
  params: { refresh?: boolean } = {},
  opts?: ReadOptions,
): Promise<GithubCommentsData> {
  return unwrap(
    await cez.api.v1.p[':projectId'].github.comments[':kind'][':number'].$get(
      {
        param: { projectId: queryScope(), kind, number: String(number) },
        // `refresh=1` is what busts the route's 60 s `commentsCache` (server.ts). Without it a
        // manual refresh re-requests and is handed the same cached object — the caller must be
        // able to say "actually go and ask gh", exactly as `getGithub` can.
        query: { refresh: params.refresh ? '1' : undefined },
      },
      init(opts),
    ),
    `/github/comments/${kind}/${number}`,
  )
}

export async function getGithubPrMergeState(
  number: number,
  params: { refresh?: boolean } = {},
  opts?: ReadOptions,
): Promise<GithubPrMergeStateResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].github.prs[':number']['merge-state'].$get(
      {
        param: { projectId: queryScope(), number: String(number) },
        query: { refresh: params.refresh ? '1' : undefined },
      },
      init(opts),
    ),
    `/github/prs/${number}/merge-state`,
  )
}

export async function mergeGithubPr(
  number: number,
  input: { method: GithubMergeMethod; expectedHeadSha: string; overrideRules?: boolean },
): Promise<GithubMergeResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].github.prs[':number'].merge.$post({
      param: { projectId: queryScope(), number: String(number) },
      json: input,
    }),
    '/github/prs/:number/merge',
  )
}

export async function getGithubPrChanges(
  number: number,
  params: { refresh?: boolean } = {},
  opts?: ReadOptions,
): Promise<GithubPrChangesData> {
  return unwrap(
    await cez.api.v1.p[':projectId'].github.prs[':number'].changes.$get(
      {
        param: { projectId: queryScope(), number: String(number) },
        query: { refresh: params.refresh ? '1' : undefined },
      },
      init(opts),
    ),
    `/github/prs/${number}/changes`,
  )
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

/** The run's structured working-directory-vs-base diff (R5): per-file status/±/patch + the
 *  aggregate stat. Worktree-off runs read the repo checkout they executed in. */
export async function getRunChanges(id: string, opts?: ReadOptions): Promise<ChangesPayload> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].changes.$get(
      { param: { projectId: queryScope(), id: encodeURIComponent(id) } },
      init(opts),
    ),
    runPath(id, '/changes'),
  )
}

/** One worktree path (R5 Files tab; also the Changes tab's expandable-context source):
 *  a directory listing, or a file with content unless binary/too large. */
export async function getRunFile(id: string, path: string, opts?: ReadOptions): Promise<WorktreeEntry> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].files.$get(
      { param: { projectId: queryScope(), id: encodeURIComponent(id) }, query: { path } },
      init(opts),
    ),
    '/runs/:id/files',
  )
}

/** The same-origin URL an `<img>` can load an image file's bytes from (R5 Files tab). The
 *  server serves raw ONLY for image extensions within the size cap — everything else 409s.
 *  Scoped here rather than in send() — this URL is handed to an `<img>`, never fetched. */
export function runFileRawUrl(id: string, path: string): string {
  return apiPath(runPath(id, `/files?path=${encodeURIComponent(path)}&raw=1`))
}

/** The variant-compare data (spec 010): one entry per variant of the group, with the legacy
 *  `git diff --stat` text and the handoff Progress excerpt. 404 for an unknown group. */
export async function getGroup(groupId: string, opts?: ReadOptions): Promise<GroupResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].groups[':groupId'].$get(
      { param: { projectId: queryScope(), groupId: encodeURIComponent(groupId) } },
      init(opts),
    ),
    `/groups/${encodeURIComponent(groupId)}`,
  )
}

// ---- workspace mutations ------------------------------------------------------------------

/**
 * Open a terminal signed in to `provider`, optionally for a NAMED account.
 *
 * `profileId` aims the login at one agent account (spec 2026-07-29-agent-profiles): the server
 * renders `CLAUDE_CONFIG_DIR=… claude /login` for it and fails closed rather than running the bare
 * command, because a terminal silently pointed at the wrong account is invisible to the user.
 * Omitted means the discovered account, which is how the Providers card has always called this.
 */
export async function connectProvider(
  provider: ProviderId,
  profileId?: string,
): Promise<ProviderConnectResponse> {
  return unwrap(
    await cez.api.v1.providers.connect.$post({
      json: { provider, ...(profileId ? { profileId } : {}) },
    }),
    '/providers/connect',
  )
}

export async function setProviderEnabled(
  provider: ProviderId,
  enabled: boolean,
): Promise<ProviderStatusResponse> {
  return parseProviderStatusResponse(
    await unwrap(
      await cez.api.v1.providers[':provider'].enabled.$put({
        param: { provider },
        json: { enabled },
      }),
      `/providers/${encodeURIComponent(provider)}/enabled`,
    ),
  )
}

export async function retryProviderAuth(
  provider: ProviderId,
  authFailureId: string,
): Promise<ProviderStatusResponse> {
  return parseProviderStatusResponse(
    await unwrap(
      await cez.api.v1.providers[':provider'].retry.$post({
        param: { provider },
        json: { authFailureId },
      }),
      `/providers/${encodeURIComponent(provider)}/retry`,
    ),
  )
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
  const path = '/projects'
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
 * On the typed client, unlike `registerProject` above: every non-2xx here IS a failure the dialog
 * must show (a 409 means the target folder exists, and there is no entry to navigate to), so
 * `unwrap`'s ordinary contract is the right one. It surfaces the server's `{ error }` string as
 * the ApiError message, which is exactly what the dialog renders — a clone fails for reasons only
 * the server can name.
 *
 * No timeout of our own: cloning a large repo legitimately takes minutes, and the request is
 * what the dialog waits on. Progress meanwhile comes from `checkout-progress` on the workspace
 * stream, keyed by `input.checkoutId`.
 */
export async function checkoutProject(input: CheckoutProjectInput): Promise<RegisterProjectResponse> {
  return unwrap(await cez.api.v1.projects.checkout.$post({ json: input }), '/projects/checkout')
}

/**
 * Deregister a project (`DELETE /api/projects/:projectId`, step 4.4).
 *
 * Registry-only by contract — the server deletes NOTHING under the project root — so this
 * never needs an "are you sure you have a backup" ceremony beyond the pane's own confirm.
 * Ordinary `unwrap`: the 409s (running tasks, the boot project) are real failures whose
 * `{ error }` message is what the pane shows, and `errorFor` already surfaces it.
 */
export async function removeProject(projectId: string): Promise<RemoveProjectResponse> {
  return unwrap(
    await cez.api.v1.projects[':projectId'].$delete({ param: { projectId: encodeURIComponent(projectId) } }),
    `/projects/${encodeURIComponent(projectId)}`,
  )
}

/**
 * Set or clear a project's per-project concurrency ceiling
 * (`PATCH /api/v1/projects/:projectId`, spec 2026-07-22). `maxParallel: null`
 * clears the override back to "inherit the workspace cap"; an integer pins it.
 * The server applies the new ceiling live (semaphore refresh), so the answer is
 * the updated entry the pane swaps into its list.
 *
 * Deliberately NOT where a project's agent account is set — that is
 * `selectAgentProfile` (`PUT /api/v1/workspace/agent-profiles/selection`), so
 * the selection is stored beside the accounts it names.
 */
export async function updateProject(
  projectId: string,
  input: UpdateProjectInput,
): Promise<UpdateProjectResponse> {
  return unwrap(
    await cez.api.v1.projects[':projectId'].$patch({
      param: { projectId: encodeURIComponent(projectId) },
      json: input,
    }),
    `/projects/${encodeURIComponent(projectId)}`,
  )
}

// ---- run mutations ------------------------------------------------------------------------

/** ×1 answers the run record; ×2/×3 answers `{ runs }` — narrow on `'runs' in result`. */
export async function createRun(input: CreateRunInput): Promise<CreateRunResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs.$post({ param: { projectId: queryScope() }, json: input }),
    '/runs',
  )
}

export async function cancelRun(id: string): Promise<CancelResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].cancel.$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
    }),
    runPath(id, '/cancel'),
  )
}

/** Archives by default; pass `false` to bring a run back into the live list. */
export async function archiveRun(id: string, archived = true): Promise<RunRecord> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].archive.$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
      json: { archived },
    }),
    runPath(id, '/archive'),
  )
}

/**
 * The same route by EXPLICIT project — the twin of `getProjectRuns`, and for the same reason:
 * the global Tasks page stands outside every `/p/:projectId`, so `queryScope()` would send the
 * BOOT project's id for a row that belongs to another project, and the archive would either 404
 * or (with a colliding id) land on the wrong task. Every caller that is already standing in the
 * run's own project keeps using `archiveRun`.
 */
export async function archiveProjectRun(
  projectId: string,
  id: string,
  archived = true,
): Promise<RunRecord> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].archive.$post({
      param: { projectId, id: encodeURIComponent(id) },
      json: { archived },
    }),
    runPath(id, '/archive'),
  )
}

/**
 * The read receipt by EXPLICIT project — the twin of `archiveProjectRun`, and for the same
 * reason: the global Tasks page stands outside every `/p/:projectId`, so `queryScope()` would
 * stamp the receipt on the boot project. `read: false` is the inverse route (#775).
 */
export async function setProjectRunRead(
  projectId: string,
  id: string,
  read: boolean,
): Promise<RunRecord> {
  const route = read ? 'read' : 'unread'
  return unwrap(
    await (read
      ? cez.api.v1.p[':projectId'].runs[':id'].read.$post({
          param: { projectId, id: encodeURIComponent(id) },
        })
      : cez.api.v1.p[':projectId'].runs[':id'].unread.$post({
          param: { projectId, id: encodeURIComponent(id) },
        })),
    runPath(id, `/${route}`),
  )
}

/** Stop THIS task from resuming itself after a usage limit (spec
 *  2026-08-03-auto-resume-after-usage-limit) — the per-task twin of the workspace setting.
 *  Idempotent: a task with nothing scheduled answers the same way. */
export async function cancelAutoResume(id: string): Promise<CancelAutoResumeResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id']['auto-resume'].$delete({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
    }),
    runPath(id, '/auto-resume'),
  )
}

/** Sweep every finished (done/failed/cancelled) active run into the archive in one call —
 *  the Tasks header's "Archive finished" button. */
export async function archiveFinished(): Promise<ArchiveFinishedResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs['archive-finished'].$post({
      param: { projectId: queryScope() },
    }),
    '/runs/archive-finished',
  )
}

/** Read receipt (#unread-done-items): opening a task's thread marks it read. Bodyless —
 *  the server stamps `seenAt = now` and answers with the updated record. */
export async function markRunSeen(id: string): Promise<RunRecord> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].read.$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
    }),
    runPath(id, '/read'),
  )
}

/** Put a finished task back to unread (#775): the inverse of `markRunSeen`. Bodyless — the
 *  server CLEARS `seenAt` (an absent receipt is what every reader already treats as unread)
 *  and answers with the updated record. */
export async function markRunUnseen(id: string): Promise<RunRecord> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].unread.$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
    }),
    runPath(id, '/unread'),
  )
}

/** "Mark all read": stamp every currently-unread finished run in one call. */
export async function markAllRunsSeen(): Promise<MarkAllReadResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs['read-all'].$post({
      param: { projectId: queryScope() },
    }),
    '/runs/read-all',
  )
}

/** Close a waiting session gracefully — the run completes as done. 409 when nothing is open. */
export async function finishRun(id: string): Promise<FinishResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].finish.$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
    }),
    runPath(id, '/finish'),
  )
}

/** The follow-up composer's optional overrides for a Continue (#401): pick which backend, model
 *  and agent account handle the reopened session. Omitted fields keep the run's current
 *  backend/model/account. `text`/`images` are the prompt the reopened session starts on — omitted,
 *  the engine opens with its plain "Continue.". */
export interface ContinueOptions {
  text?: string
  images?: AttachmentInput[]
  runner?: Runner
  model?: string
  /** Which login of that agent reopens it (spec 2026-07-29-agent-profiles). Switching account
   *  starts a fresh session server-side — a session id lives inside ONE account's config dir. */
  agentProfile?: string
}

/** Reopen a finished run's session. 409 (with the reason) when it cannot be resumed. An optional
 *  runner/model override lets the follow-up choose the engine; omitted keeps the run's current
 *  backend (backward compat). */
export async function continueRun(id: string, opts: ContinueOptions = {}): Promise<ContinueResponse> {
  const body = {
    ...(opts.text !== undefined ? { text: opts.text } : {}),
    ...(opts.images !== undefined ? { images: opts.images } : {}),
    ...(opts.runner !== undefined ? { runner: opts.runner } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.agentProfile !== undefined ? { agentProfile: opts.agentProfile } : {}),
  }
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].continue.$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
      json: body,
    }),
    runPath(id, '/continue'),
  )
}

/** The same reopen by EXPLICIT project — see `archiveProjectRun`. */
export async function continueProjectRun(
  projectId: string,
  id: string,
  opts: ContinueOptions = {},
): Promise<ContinueResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].continue.$post({
      param: { projectId, id: encodeURIComponent(id) },
      json: {
        ...(opts.text !== undefined ? { text: opts.text } : {}),
        ...(opts.images !== undefined ? { images: opts.images } : {}),
        ...(opts.runner !== undefined ? { runner: opts.runner } : {}),
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.agentProfile !== undefined ? { agentProfile: opts.agentProfile } : {}),
      },
    }),
    runPath(id, '/continue'),
  )
}

/** Draft PR from the review gate (spec 009): push the branch, `gh pr create --draft`; the run
 *  completes as done with the PR badge. On 409 the ApiError's `manual` carries the
 *  `git merge <branch>` fallback to show copyable. */
export async function createRunPr(id: string): Promise<CreatePrResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].pr.$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
    }),
    runPath(id, '/pr'),
  )
}

/** Rename a run (#389): the edit becomes the display title and wins over any auto-summary. */
export async function patchRun(id: string, patch: PatchRunInput): Promise<RunRecord> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].$patch({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
      json: patch,
    }),
    runPath(id),
  )
}

/** Deletes the run, its transcript, its worktree and its branch. 409 while it is still active. */
export async function deleteRun(id: string): Promise<DeleteRunResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].$delete({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
    }),
    runPath(id),
  )
}

/** Inbox "Dismiss" (spec 007): check the follow-up off — the server deletes the entry. */
export async function removeTodo(id: string): Promise<RemoveTodoResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].todos[':id'].$delete({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
    }),
    `/todos/${encodeURIComponent(id)}`,
  )
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
export async function startTodo(
  id: string,
  opts: StartTodoOptions = {},
): Promise<StartTodoResponse> {
  const body = {
    ...(opts.runner !== undefined ? { runner: opts.runner } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.prompt !== undefined ? { prompt: opts.prompt } : {}),
  }
  // No override → no body at all, exactly the bodyless POST this endpoint has always sent
  // (`continueRun` posts `{}` because it always carried one). The server tolerates either, and
  // `hc` sends nothing for an `undefined` json — no body AND no content-type, which is the same
  // request `mutate(…, undefined)` used to build.
  return unwrap(
    await cez.api.v1.p[':projectId'].todos[':id'].start.$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
      json: Object.keys(body).length > 0 ? body : undefined,
    }),
    `/todos/${encodeURIComponent(id)}/start`,
  )
}

/** "Pick this one" (spec 010): the winner rests at `review` for the gate; the losers are
 *  cancelled if alive, archived, and their worktrees + branches removed. 409 while the picked
 *  variant is still active — the server's words come back verbatim in the ApiError. */
export async function pickVariant(groupId: string, runId: string): Promise<PickVariantResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].groups[':groupId'].pick.$post({
      param: { projectId: queryScope(), groupId: encodeURIComponent(groupId) },
      json: { runId },
    }),
    `/groups/${encodeURIComponent(groupId)}/pick`,
  )
}

/** Hand the session off to a real terminal (spec 003), in the run's worktree when it still
 *  exists. On 409 the ApiError's `command` carries the manual `cd … && <resume>` to copy. */
export async function openRunInCli(id: string): Promise<OpenInCliResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id']['open-in-cli'].$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
    }),
    runPath(id, '/open-in-cli'),
  )
}

/** The local editors / file-manager / terminal this machine can open a worktree in (#open-in).
 *  Empty in hosted mode (CEZ_REMOTE). */
export async function getOpenTargets(opts?: ReadOptions): Promise<OpenTargetsResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId']['open-targets'].$get(
      { param: { projectId: queryScope() } },
      init(opts),
    ),
    '/open-targets',
  )
}

/** Open the ACTIVE PROJECT's own folder in the chosen local app (Settings → "Project folder").
 *  No path travels: the server opens the scoped project's registered root. 400 for an app this
 *  machine does not have or a `cli:` handoff, 409 in hosted mode or when the launch failed. */
export async function openProjectIn(target: string): Promise<OpenProjectInResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId']['open-in'].$post({
      param: { projectId: queryScope() },
      json: { target },
    }),
    '/open-in',
  )
}

/** Open the run's worktree in the chosen local app. 409 with `path` when it could not launch. */
export async function openRunIn(
  id: string,
  target: string,
): Promise<{ opened: boolean; path: string }> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id']['open-in'].$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
      json: { target },
    }),
    runPath(id, '/open-in'),
  )
}

/** Diff pane "open in default app" (#365, LOCAL MODE ONLY): opens one worktree file with the
 *  OS's default handler for its type — not the file manager, a specific file. 409 (server's own
 *  words) in hosted mode, for a path outside the worktree, or when no app could be launched. */
export async function openRunFileInApp(
  id: string,
  path: string,
): Promise<{ opened: boolean; path: string }> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id']['open-in'].$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
      json: { target: 'default', path },
    }),
    runPath(id, '/open-in'),
  )
}

/** `git add -A && git commit` in the run's worktree (R5). Every predictable git failure —
 *  clean tree, failing hook, missing identity — is a 409 whose ApiError speaks git's words. */
export async function commitRun(id: string, message: string): Promise<GitCommitResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].git.commit.$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
      json: { message },
    }),
    runPath(id, '/git/commit'),
  )
}

/** Push the worktree's branch, setting upstream when it has none (R5). No remote, detached
 *  HEAD and rejected pushes all come back as 409 + reason. */
export async function pushRun(id: string): Promise<GitPushResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].git.push.$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
    }),
    runPath(id, '/git/push'),
  )
}

/** Deliver text and/or pasted screenshots into a run's live session. 409 once it has closed. */
export async function sendMessage(id: string, message: MessageInput): Promise<MessageResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].messages.$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
      json: { text: message.text ?? '', images: message.images ?? [] },
    }),
    runPath(id, '/messages'),
  )
}

/** The same delivery by EXPLICIT project — see `archiveProjectRun`. What lets a chip on the
 *  global Tasks page speak to a run in a project this page is not standing in. */
export async function sendProjectRunMessage(
  projectId: string,
  id: string,
  message: MessageInput,
): Promise<MessageResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].messages.$post({
      param: { projectId, id: encodeURIComponent(id) },
      json: { text: message.text ?? '', images: message.images ?? [] },
    }),
    runPath(id, '/messages'),
  )
}

/** Replace a stacked message on a still-queued run (#472). 404 unknown run/message,
 *  409 once the run has started. */
export async function editQueuedMessage(
  id: string,
  msgId: string,
  message: MessageInput,
): Promise<EditQueuedMessageResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id']['queued-messages'][':msgId'].$patch({
      param: { projectId: queryScope(), id: encodeURIComponent(id), msgId: encodeURIComponent(msgId) },
      json: message,
    }),
    runPath(id, `/queued-messages/${encodeURIComponent(msgId)}`),
  )
}

/** Drop a stacked message from a still-queued run (#472). */
export async function removeQueuedMessage(
  id: string,
  msgId: string,
): Promise<RemoveQueuedMessageResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id']['queued-messages'][':msgId'].$delete({
      param: { projectId: queryScope(), id: encodeURIComponent(id), msgId: encodeURIComponent(msgId) },
    }),
    runPath(id, `/queued-messages/${encodeURIComponent(msgId)}`),
  )
}

/** Repo-view branch action (R5): switch to an existing branch, or create one (from `from` or
 *  HEAD) and switch. Invalid names, unknown start points and dirty-tree checkout conflicts
 *  all come back as 409 whose ApiError carries git's own reason. */
export async function createRepoBranch(input: { name: string; from?: string }): Promise<RepoBranchResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].repo.branch.$post({
      param: { projectId: queryScope() },
      json: input,
    }),
    '/repo/branch',
  )
}

// ---- plan mode (spec 008) -------------------------------------------------------------------

/** Chain-from-prompt: the planner proposes 1–5 steps for the task. Degraded answers come back
 *  as a one-step plan with `fallback: true`, never as an error — only transport/validation fail. */
export async function postPlan(task: string): Promise<PlanResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].plan.$post({
      param: { projectId: queryScope() },
      json: { task },
    }),
    '/plan',
  )
}

// ---- GitHub automations (#694) ---------------------------------------------------------------
//
// Project-scoped, like the runs family: the definitions, their state and the log are per-project
// files. The one exception is `getAutomationCheck` — a manual check lives in the server's memory
// under an id the POST handed back, and its route reads no project, so it has no scoped spelling.

/** Every automation with its runtime state, latest log row and tallies, plus the forge's
 *  availability and the scheduler summary — one read, the whole page. */
export async function getAutomations(opts?: ReadOptions): Promise<AutomationsResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].automations.$get(
      { param: { projectId: queryScope() } },
      init(opts),
    ),
    '/automations',
  )
}

/** Create a definition. Always created PAUSED unless `enable` asks for a current-time baseline. */
export async function createAutomation(input: CreateAutomationInput): Promise<AutomationResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].automations.$post({
      param: { projectId: queryScope() },
      json: input,
    }),
    '/automations',
  )
}

/** Edit a definition. `expectedRevision` is the one the editor read — a stale one answers 409
 *  rather than overwriting an edit made elsewhere. */
export async function updateAutomation(
  id: string,
  input: UpdateAutomationInput,
): Promise<AutomationResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].automations[':id'].$put({
      // `hc` does not percent-encode a path param, so ids are pre-encoded at every call site.
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
      json: input,
    }),
    `/automations/${encodeURIComponent(id)}`,
  )
}

/** Enable (from a current-time baseline — existing records never launch) or pause. Two routes,
 *  because they are two acts: only one of them establishes a baseline. */
export async function setAutomationEnabled(id: string, enabled: boolean): Promise<AutomationResponse> {
  const param = { projectId: queryScope(), id: encodeURIComponent(id) }
  const label = `/automations/${encodeURIComponent(id)}/${enabled ? 'enable' : 'pause'}`
  return unwrap(
    enabled
      ? await cez.api.v1.p[':projectId'].automations[':id'].enable.$post({ param })
      : await cez.api.v1.p[':projectId'].automations[':id'].pause.$post({ param }),
    label,
  )
}

/** Start a manual check (202) — `preview` counts matches and launches nothing, `execute` runs
 *  the poll for real. Poll `getAutomationCheck` with the returned id. */
export async function checkAutomation(
  id: string,
  mode: 'preview' | 'execute',
): Promise<AutomationCheckQueuedResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].automations[':id'].check.$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
      json: { mode },
    }),
    `/automations/${encodeURIComponent(id)}/check`,
  )
}

/** One manual check's progress. Workspace-level: the check registry is the server's, not a
 *  project's — the id is the whole address. */
export async function getAutomationCheck(id: string, opts?: ReadOptions): Promise<AutomationCheck> {
  return unwrap(
    await cez.api.v1['automation-checks'][':checkId'].$get(
      { param: { checkId: encodeURIComponent(id) } },
      init(opts),
    ),
    `/automation-checks/${encodeURIComponent(id)}`,
  )
}

/** One automation's execution log — newest first, capped server-side at 100 rows. */
export async function getAutomationLog(
  id: string,
  opts?: ReadOptions,
): Promise<AutomationLogResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId']['automation-log'].$get(
      { param: { projectId: queryScope() }, query: { automationId: id } },
      init(opts),
    ),
    `/automation-log?automationId=${encodeURIComponent(id)}`,
  )
}

/** Save an approved plan as a reusable chain. A 409 carries `exists: true` on the ApiError —
 *  ask the user, then retry with `overwrite: true`. */
export async function createWorkflow(input: SaveWorkflowInput): Promise<SaveWorkflowResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].workflows.$post({
      param: { projectId: queryScope() },
      json: input,
    }),
    '/workflows',
  )
}

/** Import support for the builder (spec 012): the server parses + validates pasted workflow
 *  YAML (either form) and answers the normalized definition. */
export async function parseWorkflow(yaml: string): Promise<ParsedWorkflow> {
  return unwrap(
    await cez.api.v1.p[':projectId'].workflows.parse.$post({
      param: { projectId: queryScope() },
      json: { yaml },
    }),
    '/workflows/parse',
  )
}

/** Delete a saved workflow file (spec 012 follow-up). Built-ins answer 400 — they have no
 *  file and always come back. */
export async function deleteWorkflow(name: string): Promise<DeleteWorkflowResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].workflows[':name'].$delete({
      param: { projectId: queryScope(), name: encodeURIComponent(name) },
    }),
    `/workflows/${encodeURIComponent(name)}`,
  )
}

// ---- prefs ---------------------------------------------------------------------------------

/** Merges server-side (the stored object spread under the patch) and answers the merged state. */
export async function putUiState(patch: UiState): Promise<UiState> {
  return unwrap(
    await cez.api.v1.p[':projectId']['ui-state'].$put({
      param: { projectId: queryScope() },
      json: patch,
    }),
    '/ui-state',
  )
}

/** The cross-project GUI state (`~/.cezar/ui-state.json`, step 2.7). Workspace-level:
 *  `apiPath` never prefixes `/api/workspace/*`. */
export async function getWorkspaceUiState(opts?: ReadOptions): Promise<WorkspaceUiState> {
  return unwrap(await cez.api.v1.workspace['ui-state'].$get({}, init(opts)), '/workspace/ui-state')
}

/** Shallow top-level merge server-side, same as its per-repo twin — send whole top-level
 *  objects (`{ sidebar: {...} }`), never a nested leaf alone. Answers the merged state. */
export async function putWorkspaceUiState(
  patch: SetWorkspaceUiStateInput,
  opts: { keepalive?: boolean } = {},
): Promise<WorkspaceUiState> {
  return unwrap(
    await cez.api.v1.workspace['ui-state'].$put(
      { json: patch },
      { init: { keepalive: opts.keepalive } },
    ),
    '/workspace/ui-state',
  )
}

/**
 * The global settings slice of `~/.cezar/config.json` (step 2.7) — Settings → Resources, (step 4.4)
 * the checkout-root field, and the agent defaults.
 *
 * `agentDefaults` is materialized HERE rather than guarded at each read site, for the same reason
 * the agent-accounts collections are: during development the cockpit and the server can be
 * different versions (Vite serves this bundle while `dist/` or another process serves the API), and
 * an older server answering without the key crashed the accounts page on `.runner`. One boundary,
 * one place a missing key becomes the empty answer it means.
 */
export async function getWorkspaceConfig(opts?: ReadOptions): Promise<WorkspaceConfigResponse> {
  const answer = await unwrap(
    await cez.api.v1.workspace.config.$get({}, init(opts)),
    '/workspace/config',
  )
  return { ...answer, agentDefaults: answer.agentDefaults ?? {} }
}

/**
 * Every agent account on this machine (spec 2026-07-29-agent-profiles) — the discovered defaults
 * plus any extra config dirs. Workspace-level, so never scope-prefixed. Hosted mode answers
 * `{editable: false, profiles: [], …}` rather than leaking host paths.
 *
 * The collections are filled in HERE rather than guarded at each of the ~5 read sites. During
 * development the cockpit and the server can be different versions (Vite serves this bundle while
 * `dist/` or another process serves the API), and an older server answering without `files` or
 * `selections` crashed the accounts pane on `.map` of undefined. Normalizing at the boundary — the
 * job this module already does for provider status — means every consumer can trust the shape, and
 * the next additive field is one line here instead of a hunt for missing `??`s.
 */
export async function getAgentProfiles(opts?: ReadOptions): Promise<AgentProfilesResponse> {
  const answer = await unwrap(
    await cez.api.v1.workspace['agent-profiles'].$get({}, init(opts)),
    '/workspace/agent-profiles',
  )
  return {
    ...answer,
    profileCapableProviders: answer.profileCapableProviders ?? [],
    selections: answer.selections ?? {},
    defaults: answer.defaults ?? {},
    profiles: (answer.profiles ?? []).map((profile) => ({ ...profile, files: profile.files ?? [] })),
  }
}

/** Register an extra config dir as an account. The id is allocated server-side from the label. */
export async function createAgentProfile(
  input: CreateAgentProfileInput,
): Promise<AgentProfileResponse> {
  return unwrap(
    await cez.api.v1.workspace['agent-profiles'].$post({ json: input }),
    '/workspace/agent-profiles',
  )
}

/** One account's auth state, probed for real (spec 2026-07-29-agent-profiles). Off the listing on
 *  purpose: a probe shells out to an agent CLI, so the pane paints first and fills rows in as these
 *  land. `refresh` drops the server's cached answer for this account and re-probes. */
export async function getAgentAccountStatus(
  routeId: string,
  opts?: ReadOptions & { refresh?: boolean },
): Promise<AgentAccountStatusResponse> {
  return unwrap(
    await cez.api.v1.workspace['agent-profiles'][':id'].status.$get(
      {
        param: { id: encodeURIComponent(routeId) },
        query: opts?.refresh ? { refresh: '1' } : {},
      },
      init(opts),
    ),
    `/workspace/agent-profiles/${encodeURIComponent(routeId)}/status`,
  )
}

/** Who an account is signed in as (spec 2026-07-29-agent-profiles). Fetched only when the user
 *  asks for it — it is deliberately NOT part of the listing, so "hidden by default" means the data
 *  is absent rather than merely unrendered. Address discovered accounts via `agentAccountRouteId`. */
export async function getAgentAccountDetails(
  routeId: string,
  opts?: ReadOptions,
): Promise<AgentAccountDetailsResponse> {
  return unwrap(
    await cez.api.v1.workspace['agent-profiles'][':id'].details.$get(
      { param: { id: encodeURIComponent(routeId) } },
      init(opts),
    ),
    `/workspace/agent-profiles/${encodeURIComponent(routeId)}/details`,
  )
}

/** Open one of an account's own config files — or its folder — in a local app. `file` is a catalog
 *  id (or `folder`); this never sends a path, so the route has no traversal surface. */
export async function openAgentAccountFile(
  routeId: string,
  input: OpenAgentAccountFileInput,
): Promise<OpenAgentAccountFileResponse> {
  return unwrap(
    await cez.api.v1.workspace['agent-profiles'][':id'].open.$post({
      param: { id: encodeURIComponent(routeId) },
      json: input,
    }),
    `/workspace/agent-profiles/${encodeURIComponent(routeId)}/open`,
  )
}

/** Point one project's provider at an account. `profileId: null` clears it back to the
 *  discovered account. Lives on the accounts family, not `PATCH /projects`, because the selection
 *  is stored beside the accounts it names. */
export async function selectAgentProfile(
  input: SelectAgentProfileInput,
): Promise<AgentProfileSelectionsResponse> {
  return unwrap(
    await cez.api.v1.workspace['agent-profiles'].selection.$put({ json: input }),
    '/workspace/agent-profiles/selection',
  )
}

/** Rename an account or repoint its folder. Partial — send only what changed. */
export async function updateAgentProfile(
  id: string,
  input: UpdateAgentProfileInput,
): Promise<AgentProfileResponse> {
  return unwrap(
    await cez.api.v1.workspace['agent-profiles'][':id'].$patch({
      param: { id: encodeURIComponent(id) },
      json: input,
    }),
    `/workspace/agent-profiles/${encodeURIComponent(id)}`,
  )
}

/** Deregister an account. The folder is never touched, and projects using it fall back to the
 *  discovered default (the server scrubs their references in the same write). */
export async function removeAgentProfile(id: string): Promise<RemoveAgentProfileResponse> {
  return unwrap(
    await cez.api.v1.workspace['agent-profiles'][':id'].$delete({
      param: { id: encodeURIComponent(id) },
    }),
    `/workspace/agent-profiles/${encodeURIComponent(id)}`,
  )
}

/** Cached Open Mercato update state for one registered project. The GET is immediate; the
 * server may start a stale detection-only refresh after taking its snapshot. */
export async function getSkillsUpdate(
  projectId: string,
  opts?: ReadOptions,
): Promise<SkillsUpdateState> {
  return unwrap(
    await cez.api.v1.workspace['skills-update'].$get({ query: { projectId } }, init(opts)),
    `/workspace/skills-update?projectId=${encodeURIComponent(projectId)}`,
  )
}

/** Force a bounded detection pass. The browser supplies identity only, never executable input. */
export async function checkSkillsUpdate(projectId: string): Promise<SkillsUpdateState> {
  return unwrap(
    await cez.api.v1.workspace['skills-update'].check.$post({ json: { projectId } }),
    '/workspace/skills-update/check',
  )
}

/** Apply the server-owned, lock-authorized update set. Identity is the only browser input. */
export async function applySkillsUpdate(projectId: string): Promise<SkillsUpdateState> {
  return unwrap(
    await cez.api.v1.workspace['skills-update'].apply.$post({ json: { projectId } }),
    '/workspace/skills-update/apply',
  )
}

/** Partial update — absent keys stay untouched; answers the merged config. A `projectsDir`
 *  the server cannot write to comes back as a 400 `ApiError` whose message is the reason,
 *  which is exactly what the Projects pane renders inline (step 4.4). */
export async function putWorkspaceConfig(
  patch: SetWorkspaceConfigInput,
): Promise<WorkspaceConfigResponse> {
  return unwrap(await cez.api.v1.workspace.config.$put({ json: patch }), '/workspace/config')
}

/** Set/clear the agents' config knobs — base branch, default runner, system prompt, per-runner
 *  model presets (Settings → Agents, R6 1.5). Merged into the raw config.json server-side so
 *  unrelated user keys survive; `null` clears a knob back to its default. */
export async function putConfig(patch: SetConfigInput): Promise<SetConfigResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].config.$put({
      param: { projectId: queryScope() },
      json: patch,
    }),
    '/config',
  )
}

/** The worktree management panel (#483): every materialized task worktree with disk usage,
 *  retention state, the total, and the current keep-limit. */
export async function getWorktrees(opts?: ReadOptions): Promise<WorktreesResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].worktrees.$get(
      { param: { projectId: queryScope() } },
      init(opts),
    ),
    '/worktrees',
  )
}

/** "Reclaim now": force the retention enforcer to reclaim over-limit finished worktrees
 *  (directory only — branch kept). Returns the reclaimed run ids. Always 200. */
export async function reclaimWorktrees(): Promise<ReclaimWorktreesResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].worktrees.reclaim.$post({
      param: { projectId: queryScope() },
      json: {},
    }),
    '/worktrees/reclaim',
  )
}

/** Per-row "Delete" in the worktrees panel: reclaim one run's worktree AND its branch
 *  (the existing spec-006 route). 409 while the run is active. */
export async function removeRunWorktree(id: string): Promise<RemoveWorktreeResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id']['remove-worktree'].$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
    }),
    runPath(id, '/remove-worktree'),
  )
}
