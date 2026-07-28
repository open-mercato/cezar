import { describe, expect, it } from 'vitest';
import type {
  BackendCheck as WebBackendCheck,
  Capabilities as WebCapabilities,
  ChangedFile as WebChangedFile,
  ChangesPayload as WebChangesPayload,
  ForgeInfo as WebForgeInfo,
  GithubComment as WebGithubComment,
  GithubCommentsData as WebGithubCommentsData,
  GithubData as WebGithubData,
  GithubItem as WebGithubItem,
  GithubMergeMethod as WebGithubMergeMethod,
  GithubPrMergeState as WebGithubPrMergeState,
  GithubTimelineEvent as WebGithubTimelineEvent,
  GithubTimelineEventKind as WebGithubTimelineEventKind,
  GroupResponse as WebGroupResponse,
  GroupVariant as WebGroupVariant,
  PickVariantResponse as WebPickVariantResponse,
  RepoBranchResponse as WebRepoBranchResponse,
  RepoCommitPayload as WebRepoCommitPayload,
  LogEntry as WebLogEntry,
  ProcessUsage as WebProcessUsage,
  ProviderStatus as WebProviderStatus,
  ProviderStatusResponse as WebProviderStatusResponse,
  RepoInfo as WebRepoInfo,
  RunEvent as WebRunEvent,
  QueuedMessage as WebQueuedMessage,
  RunRecord as WebRunRecord,
  RunStatus as WebRunStatus,
  Skill as WebSkill,
  StatusEntry as WebStatusEntry,
  StepState as WebStepState,
  StepStatus as WebStepStatus,
  TodoItem as WebTodoItem,
  WorkflowDef as WebWorkflowDef,
  WorkflowLoadIssue as WebWorkflowLoadIssue,
  WorkflowStepDef as WebWorkflowStepDef,
  WorkflowsResponse as WebWorkflowsResponse,
  WorktreeDirEntry as WebWorktreeDirEntry,
  ToolDisplay as WebToolDisplay,
  FileDiff as WebFileDiff,
  PermissionOption as WebPermissionOption,
  PermissionOptionKind as WebPermissionOptionKind,
  PlanEntry as WebPlanEntry,
  PlanStatus as WebPlanStatus,
  StopReason as WebStopReason,
  TokenUsage as WebTokenUsage,
  ToolKind as WebToolKind,
  ToolLocation as WebToolLocation,
  ToolStatus as WebToolStatus,
  UiBackend as WebUiBackend,
  UiEvent as WebUiEvent,
  UiEventType as WebUiEventType,
  UiItem as WebUiItem,
} from '@open-mercato/cezar-api-client';
import type { BackendCheck } from '../core/backend-detect.js';
import type { ProcessUsage } from '../core/process-usage.js';
import type { ProviderStatus, ProviderStatusResponse } from '../core/provider-auth.js';
import type { ToolDisplay } from '../core/tool-display.js';
import type {
  FileDiff,
  PermissionOption,
  PermissionOptionKind,
  PlanEntry,
  PlanStatus,
  StopReason,
  TokenUsage,
  ToolKind,
  ToolLocation,
  ToolStatus,
  UiBackend,
  UiEvent,
  UiEventType,
  UiItem,
} from '../core/ui-events.js';
import type { QueuedMessage, RunEvent, RunRecord, RunStatus, StepState, StepStatus } from '../runs/store.js';
import type { Skill } from '../skills.js';
import type { TodoItem } from '../todos.js';
import type { WorkflowLoadIssue, loadWorkflows } from '../workflows/load.js';
import type { WorkflowDef, WorkflowStepDef } from '../workflows/types.js';
import type { Capabilities } from './capabilities.js';
import type { ForgeAvailability, ForgeKind } from './forge/index.js';
import type { ForgeMergeMethod, ForgePrMergeState } from './forge/types.js';
import type { BranchResult, ChangedFile, ChangesPayload, CommitPayload, DirEntry } from './git-changes.js';
import type {
  ForgeComment,
  ForgeCommentsData,
  ForgeTimelineEvent,
  ForgeTimelineEventKind,
  GithubData,
  GithubItem,
} from './github.js';
import type { LogEntry, RepoInfo, StatusEntry } from './git.js';
import type { GroupResponse, GroupVariant, PickVariantResponse } from './server.js';

/**
 * The drift guard for `web/app/src/api/types.ts`.
 *
 * The cockpit bundle cannot import the server's modules (Node built-ins, NodeNext specifiers,
 * zod at runtime), so its API types are hand-mirrored. This file is what keeps "hand-mirrored"
 * from meaning "eventually wrong": every pair below must be mutually assignable, so renaming a
 * field, widening a union or making something optional in the server breaks `npm run typecheck`
 * — the gate — instead of breaking the UI at runtime.
 *
 * It lives on the server side deliberately: `npm run typecheck` covers `src/**`, and the web
 * types module is import-free precisely so NodeNext can reach it from here.
 *
 * Type-only imports, so nothing crosses the runtime boundary in either direction.
 */

/** Mutual assignability. `[…]` wrappers stop a naked union from distributing. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * Key-set equality — and it is NOT redundant with `Exact` (#472).
 *
 * `Exact` is blind to a missing OPTIONAL property: a type carrying an extra `foo?: T`
 * stays mutually assignable with one that lacks `foo` entirely, so both directions pass
 * and the guard reads `true`. Since most of `RunRecord` is optional, `Exact` alone would
 * have let a whole un-mirrored field through — verified by deleting the mirrored field
 * and watching the build stay green. `keyof` sees optional keys, so this catches it.
 *
 * Use BOTH for every hand-mirrored record: `Exact` for shapes and value types,
 * `ExactKeys` for presence.
 */
type ExactKeys<A, B> = Exact<keyof A, keyof B>;

/** Each `true` is one assertion the compiler makes. A drift turns it into `false`, which is
 *  not assignable to `true` — and the file stops compiling. */
const guards = {
  runStatus: true satisfies Exact<RunStatus, WebRunStatus>,
  stepStatus: true satisfies Exact<StepStatus, WebStepStatus>,
  stepState: true satisfies Exact<StepState, WebStepState>,
  runRecord: true satisfies Exact<RunRecord, WebRunRecord>,
  /** #472 — the queued prompt stack. `runRecord` above already fails if the field itself
   *  drifts; this pins the element type on its own so a change inside it is named. */
  queuedMessage: true satisfies Exact<QueuedMessage, WebQueuedMessage>,
  /** Presence guards — the ones that actually catch an un-mirrored optional field. */
  runRecordKeys: true satisfies ExactKeys<RunRecord, WebRunRecord>,
  queuedMessageKeys: true satisfies ExactKeys<QueuedMessage, WebQueuedMessage>,
  stepStateKeys: true satisfies ExactKeys<StepState, WebStepState>,
  runEvent: true satisfies Exact<RunEvent, WebRunEvent>,
  processUsage: true satisfies Exact<ProcessUsage, WebProcessUsage>,
  backendCheck: true satisfies Exact<BackendCheck, WebBackendCheck>,
  // The core row remains additive for workspace events, while every complete HTTP response is
  // enriched with the required preference by applyProviderEnablement().
  providerStatus: true satisfies Exact<ProviderStatus & { enabled: boolean }, WebProviderStatus>,
  providerStatusKeys: true satisfies ExactKeys<ProviderStatus & { enabled: boolean }, WebProviderStatus>,
  providerStatusResponse: true satisfies Exact<
    { providers: Array<ProviderStatus & { enabled: boolean }> },
    WebProviderStatusResponse
  >,
  providerStatusResponseKeys: true satisfies ExactKeys<ProviderStatusResponse, WebProviderStatusResponse>,
  repoInfo: true satisfies Exact<RepoInfo, WebRepoInfo>,
  statusEntry: true satisfies Exact<StatusEntry, WebStatusEntry>,
  logEntry: true satisfies Exact<LogEntry, WebLogEntry>,
  workflowStepDef: true satisfies Exact<WorkflowStepDef, WebWorkflowStepDef>,
  workflowDef: true satisfies Exact<WorkflowDef, WebWorkflowDef>,
  workflowLoadIssue: true satisfies Exact<WorkflowLoadIssue, WebWorkflowLoadIssue>,
  // `GET /api/workflows` returns loadWorkflows()'s resolved value verbatim.
  workflowsResponse: true satisfies Exact<
    Awaited<ReturnType<typeof loadWorkflows>>,
    WebWorkflowsResponse
  >,
  skill: true satisfies Exact<Skill, WebSkill>,
  todoItem: true satisfies Exact<TodoItem, WebTodoItem>,
  githubItem: true satisfies Exact<GithubItem, WebGithubItem>,
  githubData: true satisfies Exact<GithubData, WebGithubData>,
  githubMergeMethod: true satisfies Exact<ForgeMergeMethod, WebGithubMergeMethod>,
  githubPrMergeState: true satisfies Exact<ForgePrMergeState, WebGithubPrMergeState>,
  githubPrMergeStateKeys: true satisfies ExactKeys<ForgePrMergeState, WebGithubPrMergeState>,
  // The comment-thread payload (#499) and its timeline events (#525). ForgeComment was left
  // unpinned when #499 landed, which is exactly the drift this closes: `GET
  // /api/github/comments/:kind/:number` is a second consumer contract on the protected /api/github
  // family, and nothing was checking that its two type declarations stayed in step.
  //
  // Known limit of the `Exact<>` mechanism, verified rather than assumed and true of EVERY pin
  // here, not just these four: it catches a REQUIRED field added to one side, but NOT an optional
  // one — `{a: string}` and `{a: string; b?: number}` are mutually assignable, so both `extends`
  // arms hold. Adding `events?` to only one of the two declarations would therefore slip through.
  // Worth knowing before trusting these as total coverage; tightening it would mean a key-set
  // comparison rather than assignability, which is out of scope here.
  githubComment: true satisfies Exact<ForgeComment, WebGithubComment>,
  githubCommentsData: true satisfies Exact<ForgeCommentsData, WebGithubCommentsData>,
  githubTimelineEvent: true satisfies Exact<ForgeTimelineEvent, WebGithubTimelineEvent>,
  githubTimelineEventKind: true satisfies Exact<ForgeTimelineEventKind, WebGithubTimelineEventKind>,
  // Variant compare (spec 010): the compare view's columns and the pick answer.
  groupVariant: true satisfies Exact<GroupVariant, WebGroupVariant>,
  groupResponse: true satisfies Exact<GroupResponse, WebGroupResponse>,
  pickVariantResponse: true satisfies Exact<PickVariantResponse, WebPickVariantResponse>,
  // Session git view (R5): the structured /changes payload, the files-listing rows, and the
  // health route's additive forge/capabilities fields (`forge: { kind, ...detect() }`).
  changedFile: true satisfies Exact<ChangedFile, WebChangedFile>,
  changesPayload: true satisfies Exact<ChangesPayload, WebChangesPayload>,
  worktreeDirEntry: true satisfies Exact<DirEntry, WebWorktreeDirEntry>,
  // `tokenMetrics` is required on the current server snapshot but optional in the browser
  // contract so a newer cockpit can read an older server and preserve the legacy visible
  // default. `Required<>` keeps the current-server key set exact without erasing that wire-
  // compatibility choice from the shared DTO.
  capabilities: true satisfies Exact<Capabilities, Required<WebCapabilities>>,
  forgeInfo: true satisfies Exact<{ kind: ForgeKind } & ForgeAvailability, WebForgeInfo>,
  // Repo view (R5 Step 1.7): the structured commit diff and the branch action's answer
  // (the `/api/repo/branch` route serializes the ok-arm of BranchResult minus its `ok`).
  repoCommitPayload: true satisfies Exact<CommitPayload, WebRepoCommitPayload>,
  repoBranchResponse: true satisfies Exact<
    Omit<Extract<BranchResult, { ok: true }>, 'ok'>,
    WebRepoBranchResponse
  >,

  // ---- protocol v2 (`web/api-client/src/protocol/` mirrors `src/core/ui-events.ts` +
  // `src/core/tool-display.ts`). The full unions are guarded, not just spot fields:
  // `Exact` over `UiEvent`/`UiItem` compares every member (a new event type, a renamed
  // field, a widened enum — all break here). `tool-display-mirror.test.ts` guards the
  // display model's *behavior*; this guards its shape.
  uiBackend: true satisfies Exact<UiBackend, WebUiBackend>,
  toolStatus: true satisfies Exact<ToolStatus, WebToolStatus>,
  toolKind: true satisfies Exact<ToolKind, WebToolKind>,
  stopReason: true satisfies Exact<StopReason, WebStopReason>,
  planStatus: true satisfies Exact<PlanStatus, WebPlanStatus>,
  planEntry: true satisfies Exact<PlanEntry, WebPlanEntry>,
  tokenUsage: true satisfies Exact<TokenUsage, WebTokenUsage>,
  fileDiff: true satisfies Exact<FileDiff, WebFileDiff>,
  toolLocation: true satisfies Exact<ToolLocation, WebToolLocation>,
  permissionOptionKind: true satisfies Exact<PermissionOptionKind, WebPermissionOptionKind>,
  permissionOption: true satisfies Exact<PermissionOption, WebPermissionOption>,
  uiItem: true satisfies Exact<UiItem, WebUiItem>,
  uiEvent: true satisfies Exact<UiEvent, WebUiEvent>,
  uiEventType: true satisfies Exact<UiEventType, WebUiEventType>,
  toolDisplayModel: true satisfies Exact<ToolDisplay, WebToolDisplay>,
};

describe('web api types mirror the server', () => {
  // The assertions above are compile-time; this only proves the guard block is still here and
  // still says `true` — a deleted or negated guard is a real regression.
  it('holds every guard', () => {
    expect(Object.values(guards).every((v) => v === true)).toBe(true);
    expect(Object.keys(guards).length).toBeGreaterThan(15);
  });

  /**
   * The guards are only worth their compile time if `Exact` actually bites. A
   * mirror test that cannot fail is worse than none — it reads as coverage.
   * These pin the failure modes that matter for a hand-mirrored type: a field
   * added on one side only, and a field whose optionality diverges.
   */
  it('detects a REQUIRED field added server-side but not mirrored', () => {
    type Server = { a: string; b: number };
    type Web = { a: string };
    const missing: Exact<Server, Web> = false;
    expect(missing).toBe(false);
  });

  /**
   * The gap `ExactKeys` exists to close, pinned so nobody "simplifies" it away:
   * `Exact` alone passes an un-mirrored OPTIONAL field, which is most of RunRecord.
   */
  it('needs ExactKeys to detect an un-mirrored OPTIONAL field', () => {
    type Server = { a: string; b?: number };
    type Web = { a: string };
    // Exact says these match — they are mutually assignable. This is the blind spot.
    const exactIsFooled: Exact<Server, Web> = true;
    // ExactKeys is not fooled: 'a' | 'b' is not 'a'.
    const keysCatchIt: ExactKeys<Server, Web> = false;
    expect(exactIsFooled).toBe(true);
    expect(keysCatchIt).toBe(false);
  });

  it('detects an optionality mismatch', () => {
    type Server = { a?: string };
    type Web = { a: string };
    const diverged: Exact<Server, Web> = false;
    expect(diverged).toBe(false);
  });
});
