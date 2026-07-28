import type {
  AgentConfigFile,
  AgentConfigFileContent,
  AgentConfigFormat,
  AgentConfigKind,
  AgentConfigListing,
  AgentConfigScope,
  AgentConfigTracked,
  ApiRun,
  ArchiveFinishedResponse,
  CancelResponse,
  ChangedFile,
  ChangesPayload,
  CheckoutProjectInput,
  ConfigResponse,
  ContinueResponse,
  CreatePrResponse,
  CreateRunInput,
  CreateRunResponse,
  DeleteRunResponse,
  DeleteWorkflowResponse,
  DiffStat,
  EditQueuedMessageResponse,
  FinishResponse,
  FsBrowseDir,
  FsBrowseResponse,
  GitCommitResponse,
  GitPushResponse,
  GithubChecksData,
  GithubComment,
  GithubCommentsData,
  GithubData,
  GithubItem,
  GithubMergeMethod,
  GithubMergeResponse,
  GithubPrChange,
  GithubPrChangesData,
  GithubPrMergeState,
  GithubPrMergeStateResponse,
  GithubTimelineEvent,
  GithubTimelineEventKind,
  GroupResponse,
  GroupVariant,
  ImageInput,
  ImportableSkill,
  LaunchKeyResponse,
  LogEntry,
  MessageInput,
  MessageResponse,
  OpenInCliResponse,
  OpenTarget,
  OpenTargetsResponse,
  ParsedWorkflow,
  PatchRunInput,
  PickVariantResponse,
  PlanResponse,
  ProcessUsage,
  ProjectListEntry,
  ProjectsResponse,
  ProviderConnectResponse,
  ProviderConnectionState,
  ProviderId,
  ProviderStatus,
  ProviderStatusResponse,
  QueuedMessage,
  ReclaimWorktreesResponse,
  RegisterProjectResponse,
  RemoveProjectResponse,
  RemoveQueuedMessageResponse,
  RemoveTodoResponse,
  RemoveWorktreeResponse,
  RepoBranchResponse,
  RepoCommitPayload,
  RepoResponse,
  RunActivity,
  RunCommit,
  RunCommitsResponse,
  RunRecord,
  RunStatus,
  RunnerModelCatalogResponse,
  RunnerModelOption,
  RunnerModels,
  SaveWorkflowInput,
  SaveWorkflowResponse,
  SetAgentConfigInput,
  SetConfigInput,
  SetConfigResponse,
  SetWorkspaceConfigInput,
  Skill,
  SkillsUpdateScopeState,
  SkillsUpdateState,
  SkillsUpdateStatus,
  StartTodoResponse,
  StatusEntry,
  StepState,
  StepStatus,
  TodoItem,
  UiState,
  UpdateProjectInput,
  UpdateProjectResponse,
  UserMcpListing,
  WorkflowDef,
  WorkflowLoadIssue,
  WorkflowStepDef,
  WorkflowsResponse,
  WorkspaceConfigResponse,
  WorkspaceUiState,
  WorktreeDirEntry,
  WorktreeEntry,
  WorktreeInfo,
  WorktreesResponse,
} from '@open-mercato/cezar-contract'

import type {
  BackendCheck,
  Capabilities,
  ForgeInfo,
  HealthResponse,
  RepoInfo,
  Runner,
} from '@open-mercato/cezar-contract'
/**
 * The shape of the cockpit's HTTP surface (`packages/cezar/src/server/server.ts`), hand-written
 * for the families that are not chained yet.
 *
 * **This file is scheduled for deletion, one family at a time.** Where a route family has been
 * converted to a chained builder, the client infers its types from the handler itself and the
 * declarations here are removed. What is left is everything still registered as loose
 * statements, whose types Hono cannot see. Do not add to it — chain the family instead.
 *
 * Why a hand-written copy existed at all: the server is Node ESM under NodeNext (`.js`
 * specifiers, `node:*` imports, zod at runtime), so importing its modules from a browser bundle
 * would drag Node built-ins into it. The types are the contract; the code behind them is not.
 *
 * Until deleted, the copy is *checked*, not trusted: `packages/cezar/src/server/api-types.test.ts`
 * asserts type-exactness between these declarations and the server's own, so drift fails the
 * gate rather than hiding until runtime. Anything below without a guard there carries a real
 * drift risk; keep the guard list in step with this file.
 *
 * This module MUST stay import-free — it is the one part of the package that the NodeNext-side
 * guard compares against, and an import here would be a dependency the browser bundle inherits.
 */

// ---- runs (src/runs/store.ts) ------------------------------------------------------------

/**
 * One line of a run's NDJSON transcript. `type` mirrors the agent events plus engine
 * lifecycle, and the payload keys vary by type — hence the index signature. `seq` is the
 * dedup key the reducers key on (Step 3.2).
 */
export interface RunEvent {
  seq: number
  ts: string
  stepId?: string
  type: string
  [key: string]: unknown
}

// ---- parallel variants (spec 010, `GET /api/groups/:groupId`) ------------------------------

// ---- health / environment (src/core/backend-detect.ts, src/server/git.ts) -----------------

/** One `checkout-progress` workspace SSE payload (step 4.3). `cloning` carries one line of
 *  `git clone` output; `done`/`error` are terminal. The dialog shows `error` VERBATIM — a
 *  clone fails for reasons (auth, network, a typo'd repo) only the server can name. */
export interface CheckoutProgressEvent {
  checkoutId?: string
  name: string
  phase: 'cloning' | 'done' | 'error'
  line?: string
  error?: string
}

// ---- session git view (src/server/git-changes.ts, R5) ---------------------------------------

// ---- repo view (src/server/git.ts) ---------------------------------------------------------

// ---- workflows (src/workflows/types.ts, src/workflows/load.ts) ------------------------------

// ---- skills (src/skills.ts) -----------------------------------------------------------------

// ---- inbox (src/todos.ts) --------------------------------------------------------------------

// ---- GitHub tab (src/server/github.ts) --------------------------------------------------------

// ---- GUI prefs (`PUT /api/ui-state`) -----------------------------------------------------------

// ---- request bodies ------------------------------------------------------------------------------

// ---- mutation responses ---------------------------------------------------------------------------
