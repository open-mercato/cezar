// Store
export {
  StoreSchema,
  StoredIssueSchema,
  IssueAnalysisSchema,
  IssueDigestSchema,
  StoredCommentSchema,
  StoreMetaSchema,
  type Store,
  type StoredIssue,
  type StoredComment,
  type IssueAnalysis,
  type IssueDigest,
  type StoreMeta,
} from './store/store.model.js';
export { IssueStore, type IssueFilter } from './store/store.js';

// Config
export { ConfigSchema, type Config } from './config/config.model.js';
export { loadConfig } from './config/loader.js';

// Services
export {
  GitHubService,
  GitHubApiError,
  classifyGitHubError,
  toGitHubApiError,
  isAuthOrRateLimitError,
  summarizeCi,
  parseCheckRunUrl,
  extractReferencedIssues,
  type RawIssue,
  type RawPullRequest,
  type TimelineCrossReference,
  type CheckRunSummary,
  type CiOverall,
  type CiSummary,
  type GitHubErrorKind,
  type ClassifiedGitHubError,
} from './services/github.service.js';
export {
  LLMService,
  DuplicateResponseSchema,
  type DuplicateMatch,
} from './services/llm.service.js';
// GitHub App helper (Phase 1, §3.9) — additive; OAuth login flow untouched.
export { GitHubAppService } from './services/github-app.service.js';
export {
  formatAuditComment,
  withAuditFooter,
  postAuditComment,
  type AuditFooterMeta,
} from './services/audit.js';

// Utils
export { chunkArray } from './utils/chunker.js';
export { contentHash } from './utils/hash.js';
export { formatCommentsForPrompt } from './utils/comment-formatter.js';

// Ports
export type { StorePort } from './ports/store.port.js';
export type { EventPort, AgentEvent } from './ports/event.port.js';
export type { ConfigPort } from './ports/config.port.js';
export type {
  ConfirmationPort,
  PreflightSummary,
  RootCausePrompt,
} from './ports/confirmation.port.js';

// Agent runner abstraction (Phase 0). `AgentEvent` here is the legacy
// `event.port.ts` shape (kept for the CLI/GUI); the normalized runner event
// is re-exported below as `RunnerAgentEvent` to avoid the name clash.
export type {
  AgentRunner,
  AgentBackend,
  AgentRunSpec,
  AgentRunResult,
  AgentToolCallRecord,
  AgentEvent as RunnerAgentEvent,
} from './agents/agent-runner.js';
export { isBashCommandAllowed, extractBashCommand } from './agents/agent-runner.js';
// `parseStructured` is already exported via `actions/autofix/agent-session.js`.
export { costWeightedTokens } from './agents/structured-output.js';
export { AnthropicApiRunner } from './agents/anthropic-api-runner.js';
export { ClaudeCodeCliRunner, type SpawnFn } from './agents/claude-cli-runner.js';
export { CodexCliRunner } from './agents/codex-cli-runner.js';
export {
  createAgentRunner,
  DEFAULT_AGENT_BACKEND,
  type CreateAgentRunnerOptions,
} from './agents/runner-factory.js';
export {
  RunnerRegisterRequestSchema,
  RunnerRegisterResponseSchema,
  type RunnerRegisterRequest,
  type RunnerRegisterResponse,
} from './agents/runner-register.model.js';

// Autofix internals (orchestrator + agent session). The CLI still owns the
// terminal-facing AutofixRunner + verbose toggle.
export * from './actions/autofix/orchestrator.js';
export * from './actions/autofix/agent-session.js';
export * from './actions/autofix/token-budget.js';
export * from './actions/autofix/worktree.js';
export * from './actions/autofix/skills.js';
export * from './actions/autofix/messages.js';
export * from './actions/autofix/prompts/analyzer.js';
export * from './actions/autofix/prompts/fixer.js';
export * from './actions/autofix/prompts/reviewer.js';
export * from './actions/autofix/ci-attribution.js';

// Runnable project environment (native shell / docker-compose) for autofix runs.
export {
  createRunEnv,
  resolveComposeCommand,
  NativeShellEnv,
  DockerComposeEnv,
  detectComposeFile,
  firstComposeService,
  COMPOSE_FILENAMES,
  tailLines,
  waitForHttp,
  parseHostPort,
  type RunEnv,
  type ShellResult,
  type DevServerHandle,
  type ProjectEnvSpec,
  type CreateRunEnvOpts,
  type ComposeCommand,
  type DockerComposeEnvOpts,
} from './provision/index.js';

// Skills (Phase 1a) — merged built-in + repo `.ai/skills/**/*.md` catalog.
export {
  discoverSkills,
  discoverBuiltinSkills,
  skillsForStage,
  normalizeSkillSource,
  parseSkillMarkdown,
  SKILL_SOURCE_PRIORITY,
  type Skill,
  type SkillSource,
  type ParsedSkillMarkdown,
} from './skills/skill-catalog.js';

// Data-driven actions runtime — system prompt + skill_refs + effects/tools.
// Lands alongside the legacy actions/* plugin tree; the cutover happens in
// the next commit (seed defaults + workflow engine reroute + legacy delete).
export {
  runAction,
  EFFECT_REGISTRY,
  ALL_EFFECT_NAMES,
  executeEffect,
  effectsAsAnthropicTools,
  loadActionByName,
  loadAutoTriageAction,
  listEnabledActions,
  DEFAULT_ACTIONS,
  formatOpenIssuesKb,
  runTriagePass,
  buildAutoCommentBody,
  actionAlreadyCommented,
  actionPreviouslyCommented,
  autoCommentTag,
  type ActionDef,
  type ActionTrigger,
  type ActionRunResult,
  type ActionTarget,
  type RunActionDeps,
  type EffectDef,
  type EffectCall,
  type EffectContext,
  type EffectName,
  type AcceptanceMode,
  type AutoConfidenceConfig,
  type HitlConfidenceConfig,
  type ConfidenceConfig,
  type EffectRoutingMode,
  type DeferredEffect,
  type DeferSink,
  type OpenIssueKbEntry,
  type TriagePassOptions,
  type TriagePassActionResult,
  type TriagePassResult,
  type TriagePassDeferSink,
  type BuildAutoCommentArgs,
} from './actions-v2/index.js';

// Workflow bindings (Phase 1a) — the binding model + resolution chain.
export {
  resolveStepConfig,
  AUTOFIX_STEP_IDS,
  DEFAULT_WORKSPACE_WORKFLOW_SETTINGS,
  type WorkflowBinding,
  type WorkflowStepId,
  type WorkspaceWorkflowSettings,
  type ResolvedStepConfig,
} from './workflows/binding.js';

// Declarative workflow engine (Phase 2) — lands alongside `AutofixOrchestrator`;
// the cutover (orchestrator → thin adapter) is Phase 3.
export {
  WorkflowEngine,
  runWorkflow,
  type WorkflowRunContext,
  type WorkflowGitHub,
} from './workflows/workflow-engine.js';
export {
  agentStep,
  type Workflow,
  type WorkflowStep,
  type WorkflowStepKind,
  type WorkflowStepContext,
  type WorkflowRunStatus,
  type StepRunStatus,
  type StepOutcome,
  type AgentRunRecord,
  type WorkflowRunResult,
  type WorkflowLoop,
  type WorkflowEffectDeps,
  type AgentStepDef,
  type EffectStepDef,
  type HumanGateStepDef,
  type CommitStepDef,
  type OpenPrStepDef,
  type PushStepDef,
  type HumanGatePrompt,
  type HumanGateDecision,
  type CommentSection,
  type CommentTarget,
} from './workflows/workflow.js';
export {
  autofixWorkflow,
  VerifyInRepoSchema,
  type AutofixBlackboard,
  type VerifyInRepo,
} from './workflows/definitions/autofix.workflow.js';
export {
  ciFollowupWorkflow,
  type CiFollowupBlackboard,
  type CiFollowupSeed,
} from './workflows/definitions/ci-followup.workflow.js';

// Worktree helpers — exported so the GUI's flow runner can prep a worktree
// before calling `runWorkflow` (same as the autofix path does internally).
export {
  createWorktree,
  commitAll,
  getDiffAgainstBase,
  fetchRemoteBranch,
  type WorktreeHandle,
} from './actions/autofix/worktree.js';

// Workspace label catalog — shared vocabulary surfaced to every agent step.
export {
  formatLabelCatalogPrompt,
  type WorkspaceLabel,
  type LabelScope,
  type LabelPromptScope,
} from './labels/label-catalog.js';

// Flow runner — runtime for the simple "flows" feature (workspace-defined
// chains of skill steps). Used both by the GUI dispatcher (cron-based) and
// the self-hosted runner daemon.
export {
  runFlow,
  extractPrMarkers,
  renderTemplate,
  effectiveStepNotes,
  composeStepSystemPrompt,
  FLOW_STEP_SCAFFOLDING,
  DEFAULT_STEP_NOTES,
  FLOW_STEP_SYSTEM_PROMPT,
  type FlowStep,
  type FlowRow,
  type RunFlowParams,
} from './workflows/flow-runner.js';
