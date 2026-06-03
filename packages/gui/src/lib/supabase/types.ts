// Hand-written type map for the initial schema.
// TODO: replace with `supabase gen types typescript` output once the project
// is linked (`supabase link --project-ref <ref>`).

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type WorkspaceRole = 'admin' | 'actor' | 'viewer';

export type WorkflowBackend = 'anthropic-api' | 'claude-cli' | 'codex-cli';

// ─── Phase 3a: job queue + run/event tables ─────────────────────────────
// Note: `@cezar/core` also exports a `WorkflowRunStatus` (the in-process engine
// state). These are the *DB* string sets — kept local + named distinctly to
// avoid confusing the two.
export type JobKind = 'triage' | 'autofix' | 'ci-followup' | 'flow' | 'label-analysis';

export type LabelAnalysisStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'accepted'
  | 'failed'
  | 'cancelled';

export type WorkspaceLabelScope = 'issue' | 'pr' | 'both';
export type WorkspaceLabelSource = 'ai-analyzed' | 'user-edited' | 'manual';

// ─── Sync status (0029) ──────────────────────────────────────────────────
export type SyncStatusState = 'idle' | 'syncing' | 'done' | 'error';
export type SyncPhase = 'issues' | 'digests' | 'comments' | 'prs';
export interface SyncCounts {
  issuesFetched?: number;
  issuesCreated?: number;
  issuesUpdated?: number;
  digestsCreated?: number;
  commentsFetched?: number;
  prsUpdated?: number;
}

// Shape of `workspace_label_analyses.result` once the executor finishes.
export interface LabelAnalysisDraft {
  name: string;
  color?: string | null;
  description: string;
  when_to_add: string;
  when_to_remove: string;
  add_meaning: string;
  remove_meaning: string;
  exists_on_github: boolean;
}

export interface LabelAnalysisResult {
  issue_labels: LabelAnalysisDraft[];
  pr_labels: LabelAnalysisDraft[];
  notes?: string;
}

export interface LabelAnalysisInputsSummary {
  github_labels: number;
  issues_scanned: number;
  prs_scanned: number;
  codebase_files: string[];
}
export type JobStatus = 'queued' | 'claimed' | 'running' | 'done' | 'failed' | 'cancelled';
export type DbWorkflowRunStatus = 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled';
export type AgentRunStatus = 'running' | 'succeeded' | 'failed' | 'skipped';
export type AgentRunStepKind = 'agent' | 'effect' | 'human-gate' | 'commit' | 'open-pr' | 'push';
export type AgentRunEventType =
  | 'lifecycle'
  | 'agent-text'
  | 'tool-call'
  | 'tool-result'
  | 'note'
  | 'step-start'
  | 'step-end';
export type RunnerKind = 'cloud' | 'self-hosted';
export type RunnerStatus = 'online' | 'offline' | 'draining';

/**
 * Phase 5 (migration 0027) — shape of `runners.utilization`. Reported on each
 * runner heartbeat and overwritten in place (snapshot semantics, no
 * time-series). Captured-at is a runner-local timestamp; the cockpit pairs
 * it with `last_heartbeat_at` for the freshness display.
 */
export interface RunnerUtilization {
  inflight: number;
  capacity: number;
  cpuLoad: number;
  freeMemMb: number;
  totalMemMb: number;
  nodeVersion: string;
  uptimeSec: number;
  capturedAt: string;
}

export type CiAttributionVerdict = 'ours' | 'unrelated' | 'flaky' | 'unsure';
export type CiAttributionMethod = 'base-branch-control' | 'llm' | 'degraded';

export interface CiAttribution {
  verdict: CiAttributionVerdict;
  confidence: number;
  method: CiAttributionMethod;
  reasoning: string;
  preExistingChecks: string[];
  suggestedFocus?: string;
  model?: string;
  attributedAt: string;
}

export interface Database {
  public: {
    Tables: {
      workspaces: {
        Row: {
          id: string;
          slug: string;
          name: string;
          repo_owner: string;
          repo_name: string;
          installation_id: number | null;
          config: Json;
          meta: Json;
          auto_triage_enabled: boolean;
          autofix_enabled: boolean;
          separate_comment_per_step: boolean;
          action_auto_comment: boolean;
          auto_triage_action_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['workspaces']['Row'], 'id' | 'created_at' | 'updated_at' | 'auto_triage_action_id' | 'action_auto_comment'> & {
          id?: string;
          auto_triage_action_id?: string | null;
          action_auto_comment?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['workspaces']['Insert']>;
      };
      workspace_members: {
        Row: {
          workspace_id: string;
          user_id: string;
          role: WorkspaceRole;
          joined_at: string;
        };
        Insert: Database['public']['Tables']['workspace_members']['Row'];
        Update: Partial<Database['public']['Tables']['workspace_members']['Row']>;
      };
      issues: {
        Row: {
          id: string;
          workspace_id: string;
          number: number;
          title: string;
          body: string;
          state: 'open' | 'closed';
          labels: string[];
          assignees: string[];
          author: string;
          html_url: string;
          content_hash: string;
          comment_count: number;
          reactions: number;
          comments: Json;
          comments_fetched_at: string | null;
          digest: Json | null;
          analysis: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['issues']['Row'], 'id'> & { id?: string };
        Update: Partial<Database['public']['Tables']['issues']['Insert']>;
      };
      pull_requests: {
        Row: {
          id: string;
          workspace_id: string;
          number: number;
          title: string;
          body: string;
          state: 'open' | 'closed';
          draft: boolean;
          labels: string[];
          author: string;
          html_url: string;
          head_sha: string | null;
          head_ref: string | null;
          base_ref: string | null;
          pr_created_at: string | null;
          pr_updated_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<
          Database['public']['Tables']['pull_requests']['Row'],
          'id' | 'created_at' | 'updated_at'
        > & {
          id?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['pull_requests']['Insert']>;
      };
      sync_status: {
        Row: {
          workspace_id: string;
          status: SyncStatusState;
          phase: SyncPhase | null;
          message: string | null;
          /** { issuesFetched, issuesCreated, issuesUpdated, digestsCreated, commentsFetched, prsUpdated } */
          counts: SyncCounts;
          error: string | null;
          started_at: string | null;
          finished_at: string | null;
          updated_at: string;
        };
        Insert: {
          workspace_id: string;
          status?: SyncStatusState;
          phase?: SyncPhase | null;
          message?: string | null;
          counts?: SyncCounts;
          error?: string | null;
          started_at?: string | null;
          finished_at?: string | null;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['sync_status']['Insert']>;
      };
      user_github_tokens: {
        Row: {
          user_id: string;
          provider_token: string;
          provider_refresh_token: string | null;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['user_github_tokens']['Row'], 'updated_at'> & {
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['user_github_tokens']['Insert']>;
      };
      flows: {
        Row: {
          id: string;
          workspace_id: string;
          name: string;
          /** Array of `{ skill: string; argsTemplate: string; stopChainIfContains?: string }`. */
          steps: Json;
          /** Array of trigger objects — `{ kind: 'issue.opened' } | { kind: 'issue.labeled', label: string }`. */
          triggers: Json;
          /** Paused flows skip webhook auto-triggers but stay manually runnable. */
          paused: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['flows']['Row'], 'id' | 'triggers' | 'paused' | 'created_at' | 'updated_at'> & {
          id?: string;
          triggers?: Json;
          paused?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['flows']['Insert']>;
      };
      workflow_bindings: {
        Row: {
          id: string;
          workspace_id: string;
          repo: string | null;
          step_id: string;
          skill_name: string | null;
          backend: WorkflowBackend | null;
          model: string | null;
          extra_tools: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['workflow_bindings']['Row'], 'id' | 'extra_tools' | 'created_at' | 'updated_at'> & {
          id?: string;
          repo?: string | null;
          skill_name?: string | null;
          backend?: WorkflowBackend | null;
          model?: string | null;
          extra_tools?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['workflow_bindings']['Insert']>;
      };
      repo_skills: {
        Row: {
          workspace_id: string;
          repo: string;
          commit_sha: string | null;
          skills: Json;
          fetched_at: string;
        };
        Insert: Omit<Database['public']['Tables']['repo_skills']['Row'], 'commit_sha' | 'skills' | 'fetched_at'> & {
          commit_sha?: string | null;
          skills?: Json;
          fetched_at?: string;
        };
        Update: Partial<Database['public']['Tables']['repo_skills']['Insert']>;
      };
      actions: {
        Row: {
          id: string;
          workspace_id: string;
          name: string;
          kind: 'built-in' | 'user';
          description: string | null;
          system_prompt: string;
          skill_refs: Json;
          target: 'issue' | 'pr';
          triggers: Json;
          effects: Json | null;
          output_schema: Json | null;
          enabled: boolean;
          replaces_built_in: string | null;
          created_at: string;
          updated_at: string;
          created_by: string | null;
          updated_by: string | null;
          model: string;
          acceptance_mode: 'auto' | 'human-in-the-loop';
          confidence_config: Json;
        };
        Insert: Omit<Database['public']['Tables']['actions']['Row'],
          'id' | 'kind' | 'description' | 'system_prompt' | 'skill_refs' | 'triggers' |
          'effects' | 'output_schema' | 'enabled' | 'replaces_built_in' | 'created_at' | 'updated_at' |
          'created_by' | 'updated_by' | 'model' | 'acceptance_mode' | 'confidence_config'
        > & {
          id?: string;
          kind?: 'built-in' | 'user';
          description?: string | null;
          system_prompt?: string;
          skill_refs?: Json;
          triggers?: Json;
          effects?: Json | null;
          output_schema?: Json | null;
          enabled?: boolean;
          replaces_built_in?: string | null;
          created_at?: string;
          updated_at?: string;
          created_by?: string | null;
          updated_by?: string | null;
          model?: string;
          acceptance_mode?: 'auto' | 'human-in-the-loop';
          confidence_config?: Json;
        };
        Update: Partial<Database['public']['Tables']['actions']['Insert']>;
      };
      skill_overrides: {
        Row: {
          id: string;
          workspace_id: string;
          skill_name: string;
          body: string;
          execution_mode: string;
          triggers: Json;
          outputs: Json;
          capabilities: Json;
          enabled: boolean;
          created_at: string;
          updated_at: string;
          created_by: string | null;
          updated_by: string | null;
        };
        Insert: Omit<Database['public']['Tables']['skill_overrides']['Row'], 'id' | 'body' | 'execution_mode' | 'triggers' | 'outputs' | 'capabilities' | 'enabled' | 'created_at' | 'updated_at' | 'created_by' | 'updated_by'> & {
          id?: string;
          body?: string;
          execution_mode?: string;
          triggers?: Json;
          outputs?: Json;
          capabilities?: Json;
          enabled?: boolean;
          created_at?: string;
          updated_at?: string;
          created_by?: string | null;
          updated_by?: string | null;
        };
        Update: Partial<Database['public']['Tables']['skill_overrides']['Insert']>;
      };
      jobs: {
        Row: {
          id: string;
          workspace_id: string;
          repo: string | null;
          kind: JobKind;
          issue_number: number | null;
          pr_number: number | null;
          priority: number;
          status: JobStatus;
          required_backend: WorkflowBackend | null;
          claimed_by_runner: string | null;
          /** Renewable lease deadline (migration 0025). Watchdog reclaims any
           *  job whose lease has lapsed. NULL when the job isn't currently held. */
          claim_expires_at: string | null;
          /** Phase 4 (migration 0026) soft affinity — preferred runner for this
           *  job (typically inherited from the parent workflow run). NULL = no
           *  preference; any matching runner may claim. */
          preferred_runner_id: string | null;
          /** Phase 4 (migration 0026) soft-affinity window. After this instant
           *  the preference is ignored and any matching runner may claim. */
          preferred_until: string | null;
          attempts: number;
          max_attempts: number;
          scheduled_at: string;
          payload: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<
          Database['public']['Tables']['jobs']['Row'],
          'id' | 'priority' | 'status' | 'attempts' | 'max_attempts' | 'scheduled_at' | 'payload' | 'created_at' | 'updated_at' | 'claim_expires_at' | 'preferred_runner_id' | 'preferred_until'
        > & {
          id?: string;
          repo?: string | null;
          issue_number?: number | null;
          pr_number?: number | null;
          priority?: number;
          status?: JobStatus;
          required_backend?: WorkflowBackend | null;
          claimed_by_runner?: string | null;
          claim_expires_at?: string | null;
          preferred_runner_id?: string | null;
          preferred_until?: string | null;
          attempts?: number;
          max_attempts?: number;
          scheduled_at?: string;
          payload?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['jobs']['Insert']>;
      };
      workflow_runs: {
        Row: {
          id: string;
          workspace_id: string;
          job_id: string | null;
          workflow: string;
          repo: string | null;
          issue_number: number | null;
          pr_number: number | null;
          branch: string | null;
          head_sha: string | null;
          pr_url: string | null;
          status: DbWorkflowRunStatus;
          pause_requested: boolean;
          current_step_id: string | null;
          outcome: Json | null;
          reason: string | null;
          tokens_used: number;
          cost_estimate: number | null;
          started_at: string;
          finished_at: string | null;
          created_at: string;
          updated_at: string;
          /** Canonical Claude CLI session UUID for this run. Set once by the
           *  first step that mints one, then reused on re-claim (the runner
           *  passes `claude --resume <session_id>`). */
          session_id: string | null;
        };
        Insert: Omit<
          Database['public']['Tables']['workflow_runs']['Row'],
          'id' | 'status' | 'pause_requested' | 'tokens_used' | 'started_at' | 'created_at' | 'updated_at'
        > & {
          id?: string;
          job_id?: string | null;
          repo?: string | null;
          issue_number?: number | null;
          pr_number?: number | null;
          branch?: string | null;
          head_sha?: string | null;
          pr_url?: string | null;
          status?: DbWorkflowRunStatus;
          pause_requested?: boolean;
          current_step_id?: string | null;
          outcome?: Json | null;
          reason?: string | null;
          tokens_used?: number;
          cost_estimate?: number | null;
          started_at?: string;
          finished_at?: string | null;
          created_at?: string;
          updated_at?: string;
          session_id?: string | null;
        };
        Update: Partial<Database['public']['Tables']['workflow_runs']['Insert']>;
      };
      agent_runs: {
        Row: {
          id: string;
          workspace_id: string;
          workflow_run_id: string;
          step_id: string;
          iteration: number;
          kind: AgentRunStepKind | null;
          backend: string | null;
          model: string | null;
          status: AgentRunStatus;
          started_at: string;
          finished_at: string | null;
          tokens_used: number;
          cost_estimate: number | null;
          summary: string | null;
          error: string | null;
          /** Claude CLI session UUID for this step. The workflow engine reuses
           *  one id across every step of a workflow run, and on a re-claim the
           *  runner picks it up via `claude --resume <session_id>`. */
          session_id: string | null;
          /** Phase 5 (migration 0027) — runner that served this step. NULL for
           *  cron-dispatched steps (the anthropic-api path). First-writer-wins
           *  via the `ingest_runner_events` RPC. */
          runner_id: string | null;
        };
        Insert: Omit<
          Database['public']['Tables']['agent_runs']['Row'],
          'id' | 'iteration' | 'status' | 'started_at' | 'tokens_used'
        > & {
          id?: string;
          iteration?: number;
          kind?: AgentRunStepKind | null;
          backend?: string | null;
          model?: string | null;
          status?: AgentRunStatus;
          started_at?: string;
          finished_at?: string | null;
          tokens_used?: number;
          cost_estimate?: number | null;
          summary?: string | null;
          error?: string | null;
          session_id?: string | null;
          runner_id?: string | null;
        };
        Update: Partial<Database['public']['Tables']['agent_runs']['Insert']>;
      };
      agent_run_events: {
        Row: {
          id: number;
          workspace_id: string;
          workflow_run_id: string;
          agent_run_id: string | null;
          type: AgentRunEventType;
          payload: Json;
          created_at: string;
        };
        Insert: Omit<Database['public']['Tables']['agent_run_events']['Row'], 'id' | 'payload' | 'created_at'> & {
          id?: number;
          agent_run_id?: string | null;
          payload?: Json;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['agent_run_events']['Insert']>;
      };
      runners: {
        Row: {
          id: string;
          workspace_id: string | null;
          name: string;
          kind: RunnerKind;
          backends: string[];
          models: string[];
          token_hash: string | null;
          status: RunnerStatus;
          last_heartbeat_at: string | null;
          created_at: string;
          updated_at: string;
          /** Phase 4 (migration 0026) per-runner GitHub App install. When set
           *  the claim route mints an installation token against this id
           *  instead of the workspace-level install. `bigint` since GitHub
           *  install ids can exceed 2^31. */
          github_installation_id: number | null;
          /** Phase 4 (migration 0026) "inherit host" identity mode. When true
           *  the runner mints its own GitHub token locally from `gh auth
           *  token` / GITHUB_TOKEN; the central does NOT mint for these
           *  runs. Precedence: if both this AND `github_installation_id`
           *  are set, this wins. */
          github_inherit_host: boolean;
          /** Phase 5 (migration 0027) — latest utilization snapshot reported
           *  by the runner on heartbeat. Overwritten on every heartbeat — no
           *  time-series here. Shape: `RunnerUtilization`. NULL on older
           *  daemons that don't report. */
          utilization: RunnerUtilization | null;
        };
        Insert: Omit<
          Database['public']['Tables']['runners']['Row'],
          'id' | 'backends' | 'models' | 'status' | 'created_at' | 'updated_at' | 'github_installation_id' | 'github_inherit_host' | 'utilization'
        > & {
          id?: string;
          workspace_id?: string | null;
          backends?: string[];
          models?: string[];
          token_hash?: string | null;
          status?: RunnerStatus;
          last_heartbeat_at?: string | null;
          created_at?: string;
          updated_at?: string;
          github_installation_id?: number | null;
          github_inherit_host?: boolean;
          utilization?: RunnerUtilization | null;
        };
        Update: Partial<Database['public']['Tables']['runners']['Insert']>;
      };
      pending_decisions: {
        Row: {
          id: string;
          workspace_id: string;
          action_id: string;
          workflow_run_id: string | null;
          agent_run_id: string | null;
          target_kind: 'issue' | 'pr';
          issue_number: number | null;
          pr_number: number | null;
          target_title: string;
          effect: string;
          effect_args: Json;
          summary: string;
          confidence: number;
          status: 'pending' | 'accepted' | 'dismissed' | 'expired';
          created_at: string;
          decided_at: string | null;
          decided_by: string | null;
          decided_reason: string | null;
          apply_error: string | null;
          expires_at: string | null;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          action_id: string;
          workflow_run_id?: string | null;
          agent_run_id?: string | null;
          target_kind: 'issue' | 'pr';
          issue_number?: number | null;
          pr_number?: number | null;
          target_title: string;
          effect: string;
          effect_args?: Json;
          summary: string;
          confidence: number;
          status?: 'pending' | 'accepted' | 'dismissed' | 'expired';
          created_at?: string;
          decided_at?: string | null;
          decided_by?: string | null;
          decided_reason?: string | null;
          apply_error?: string | null;
          expires_at?: string | null;
        };
        Update: Partial<Database['public']['Tables']['pending_decisions']['Insert']>;
      };
      workspace_label_analyses: {
        Row: {
          id: string;
          workspace_id: string;
          job_id: string | null;
          status: LabelAnalysisStatus;
          started_at: string | null;
          finished_at: string | null;
          result: LabelAnalysisResult | null;
          error: string | null;
          inputs_summary: LabelAnalysisInputsSummary | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          job_id?: string | null;
          status?: LabelAnalysisStatus;
          started_at?: string | null;
          finished_at?: string | null;
          result?: LabelAnalysisResult | null;
          error?: string | null;
          inputs_summary?: LabelAnalysisInputsSummary | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['workspace_label_analyses']['Insert']>;
      };
      workspace_labels: {
        Row: {
          id: string;
          workspace_id: string;
          analysis_id: string | null;
          name: string;
          scope: WorkspaceLabelScope;
          color: string | null;
          description: string | null;
          when_to_add: string | null;
          when_to_remove: string | null;
          add_meaning: string | null;
          remove_meaning: string | null;
          exists_on_github: boolean;
          source: WorkspaceLabelSource;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          analysis_id?: string | null;
          name: string;
          scope: WorkspaceLabelScope;
          color?: string | null;
          description?: string | null;
          when_to_add?: string | null;
          when_to_remove?: string | null;
          add_meaning?: string | null;
          remove_meaning?: string | null;
          exists_on_github?: boolean;
          source?: WorkspaceLabelSource;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['workspace_labels']['Insert']>;
      };
      webhook_deliveries: {
        Row: {
          delivery_id: string;
          received_at: string;
        };
        Insert: {
          delivery_id: string;
          received_at?: string;
        };
        Update: Partial<Database['public']['Tables']['webhook_deliveries']['Insert']>;
      };
    };
  };
}
