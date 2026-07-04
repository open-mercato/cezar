// Hand-written type map for the initial schema.
// TODO: replace with `supabase gen types typescript` output once the project
// is linked (`supabase link --project-ref <ref>`).

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type WorkspaceRole = 'admin' | 'actor' | 'viewer';

export type WorkflowBackend = 'anthropic-api' | 'claude-cli' | 'codex-cli';

// ─── Phase 3a: job queue + run/event tables ─────────────────────────────
// Note: `@cezar/core` also exports a `WorkflowRunStatus` (the in-process engine
// state). These are the *DB* string sets — kept local + named distinctly to
// avoid confusing the two.
export type JobKind =
  | 'triage'
  | 'autofix'
  | 'ci-followup'
  | 'flow'
  | 'label-analysis'
  | 'sync'
  | 'action';

export type LabelAnalysisStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'accepted'
  | 'failed'
  | 'cancelled';

export type WorkspaceLabelScope = 'issue' | 'pr' | 'both';
export type WorkspaceLabelSource = 'ai-analyzed' | 'user-edited' | 'manual';

/** Per-workspace AI-digest cadence (migration 0042 / spec §5). `auto` runs
 *  digests on their own `digest_interval_minutes` cadence; `manual` only on the
 *  initial import or the admin "Generate digests now" action; `off` never. */
export type DigestMode = 'auto' | 'manual' | 'off';

// ─── Sync status (0029) ──────────────────────────────────────────────────
export type SyncStatusState = 'idle' | 'syncing' | 'done' | 'error';
export type SyncPhase = 'issues' | 'digests' | 'comments' | 'prs';
/** Classification of a sync failure (migration 0041) — drives the indicator's
 *  actionable error copy + recovery CTA. `auth` ⇒ expired/revoked token or an
 *  uninstalled App (→ Reconnect); `rate_limit` is transient; `not_found` is a
 *  repo-access problem; `unknown` falls back to the raw message. */
export type SyncErrorKind = 'auth' | 'rate_limit' | 'not_found' | 'unknown';
export interface SyncCounts {
  issuesFetched?: number;
  issuesCreated?: number;
  issuesUpdated?: number;
  digestsCreated?: number;
  /** Total issues slated for digesting this run (open + un-digested), captured
   *  before the LLM call so the first-import bar has a denominator. */
  digestsTotal?: number;
  commentsFetched?: number;
  prsUpdated?: number;
  // ── Per-run PR deltas (spec §4) — computed from a pre-upsert state diff,
  // so the "what changed" toast reflects *this* sync rather than cumulative
  // totals. Skipped on the initial import (everything would be "new"). ──
  /** PRs not previously present in the store. */
  prsCreated?: number;
  /** PRs that went open → closed this run. Merges fold in here when no merge
   *  signal is available (`RawPullRequest` carries none today). */
  prsClosed?: number;
  /** PRs closed *as merged* this run. Unset while the fetch lacks a merge
   *  signal — merges are counted under `prsClosed` instead. */
  prsMerged?: number;
  /** PRs that went closed → open this run. */
  prsReopened?: number;
  // ── Finer issue deltas (spec §4), split out of `issuesUpdated`. ──
  /** Issues that went open → closed this run. */
  issuesClosed?: number;
  /** Issues that went closed → open this run. */
  issuesReopened?: number;
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
export type DbWorkflowRunStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'cancelled';
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
          /** Issue #262 — once true, the GUI has already seeded this workspace
           *  with all built-in skills enabled, so the lazy seed won't undo any
           *  disables the user made afterwards. */
          skill_states_seeded: boolean;
          sync_mode: 'auto' | 'manual';
          sync_interval_minutes: number;
          last_webhook_received_at: string | null;
          last_webhook_event: string | null;
          // §5 (migration 0042) — AI-digest cadence, decoupled from the
          // metadata-sync cadence so "sync often" doesn't mean "spend often".
          digest_mode: DigestMode;
          digest_interval_minutes: number;
          last_digested_at: string | null;
          auto_triage_action_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<
          Database['public']['Tables']['workspaces']['Row'],
          | 'id'
          | 'created_at'
          | 'updated_at'
          | 'auto_triage_action_id'
          | 'action_auto_comment'
          | 'sync_mode'
          | 'sync_interval_minutes'
          | 'last_webhook_received_at'
          | 'last_webhook_event'
          | 'digest_mode'
          | 'digest_interval_minutes'
          | 'last_digested_at'
          | 'skill_states_seeded'
        > & {
          id?: string;
          auto_triage_action_id?: string | null;
          action_auto_comment?: boolean;
          sync_mode?: 'auto' | 'manual';
          sync_interval_minutes?: number;
          last_webhook_received_at?: string | null;
          last_webhook_event?: string | null;
          digest_mode?: DigestMode;
          digest_interval_minutes?: number;
          last_digested_at?: string | null;
          skill_states_seeded?: boolean;
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
          /** { issuesFetched, issuesCreated, issuesUpdated, digestsCreated, digestsTotal, commentsFetched, prsUpdated } */
          counts: SyncCounts;
          error: string | null;
          /** Classification of the last failure (migration 0041), set with
           *  status='error' so the indicator can show a recovery CTA. */
          error_kind: SyncErrorKind | null;
          /** True during the workspace's first full import (migration 0040) —
           *  flips the indicator to a determinate "Importing" bar. */
          initial: boolean;
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
          error_kind?: SyncErrorKind | null;
          initial?: boolean;
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
        Insert: Omit<
          Database['public']['Tables']['flows']['Row'],
          'id' | 'triggers' | 'paused' | 'created_at' | 'updated_at'
        > & {
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
        Insert: Omit<
          Database['public']['Tables']['workflow_bindings']['Row'],
          'id' | 'extra_tools' | 'created_at' | 'updated_at'
        > & {
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
        Insert: Omit<
          Database['public']['Tables']['repo_skills']['Row'],
          'commit_sha' | 'skills' | 'fetched_at'
        > & {
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
          // Added by migration 0044 (actions-cleanup Phase 3) — ships in the
          // same release as the code that selects it.
          context_refs: Json;
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
          // Added by migration 0044 — Phase 5 schema (per-effect routing
          // override + the configured suggest-workflow target).
          effect_routing: Json;
          suggested_flow_id: string | null;
        };
        Insert: Omit<
          Database['public']['Tables']['actions']['Row'],
          | 'id'
          | 'kind'
          | 'description'
          | 'system_prompt'
          | 'skill_refs'
          | 'context_refs'
          | 'triggers'
          | 'effects'
          | 'output_schema'
          | 'enabled'
          | 'replaces_built_in'
          | 'created_at'
          | 'updated_at'
          | 'created_by'
          | 'updated_by'
          | 'model'
          | 'acceptance_mode'
          | 'confidence_config'
          | 'effect_routing'
          | 'suggested_flow_id'
        > & {
          id?: string;
          kind?: 'built-in' | 'user';
          description?: string | null;
          system_prompt?: string;
          skill_refs?: Json;
          context_refs?: Json;
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
          effect_routing?: Json;
          suggested_flow_id?: string | null;
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
        Insert: Omit<
          Database['public']['Tables']['skill_overrides']['Row'],
          | 'id'
          | 'body'
          | 'execution_mode'
          | 'triggers'
          | 'outputs'
          | 'capabilities'
          | 'enabled'
          | 'created_at'
          | 'updated_at'
          | 'created_by'
          | 'updated_by'
        > & {
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
      workspace_skill_states: {
        Row: {
          id: string;
          workspace_id: string;
          skill_name: string;
          enabled: boolean;
          /** Forward-looking: pin a skill to a specific source (PR 2–4 add more
           *  sources). NULL = follow default priority. */
          pinned_source: string | null;
          created_at: string;
          updated_at: string;
          created_by: string | null;
          updated_by: string | null;
        };
        Insert: Omit<
          Database['public']['Tables']['workspace_skill_states']['Row'],
          | 'id'
          | 'enabled'
          | 'pinned_source'
          | 'created_at'
          | 'updated_at'
          | 'created_by'
          | 'updated_by'
        > & {
          id?: string;
          enabled?: boolean;
          pinned_source?: string | null;
          created_at?: string;
          updated_at?: string;
          created_by?: string | null;
          updated_by?: string | null;
        };
        Update: Partial<Database['public']['Tables']['workspace_skill_states']['Insert']>;
      };
      skill_sources: {
        Row: {
          id: string;
          workspace_id: string;
          /**
           * Only `'external-repo'` today. skills.sh shipped as its own table
           * (`skills_sh_skills`), so this column is not widened to `'skills-sh'`.
           */
          kind: 'external-repo';
          name: string;
          /** For `kind='external-repo'`: `{ owner, repo, branch, folder }`. */
          config: Json;
          last_synced_at: string | null;
          last_sync_error: string | null;
          created_at: string;
          updated_at: string;
          created_by: string | null;
          updated_by: string | null;
        };
        Insert: Omit<
          Database['public']['Tables']['skill_sources']['Row'],
          | 'id'
          | 'config'
          | 'last_synced_at'
          | 'last_sync_error'
          | 'created_at'
          | 'updated_at'
          | 'created_by'
          | 'updated_by'
        > & {
          id?: string;
          config?: Json;
          last_synced_at?: string | null;
          last_sync_error?: string | null;
          created_at?: string;
          updated_at?: string;
          created_by?: string | null;
          updated_by?: string | null;
        };
        Update: Partial<Database['public']['Tables']['skill_sources']['Insert']>;
      };
      external_repo_skills: {
        Row: {
          source_id: string;
          commit_sha: string | null;
          /** Array of `{ name, description, suggestedStages, path, source, body }`
           *  — body inline so the dispatcher works without a local clone. */
          skills: Json;
          fetched_at: string;
        };
        Insert: Omit<
          Database['public']['Tables']['external_repo_skills']['Row'],
          'commit_sha' | 'skills' | 'fetched_at'
        > & {
          commit_sha?: string | null;
          skills?: Json;
          fetched_at?: string;
        };
        Update: Partial<Database['public']['Tables']['external_repo_skills']['Insert']>;
      };
      uploaded_skills: {
        Row: {
          id: string;
          workspace_id: string;
          name: string;
          body: string;
          description: string | null;
          /** Array of stage ids (`'verify-in-repo' | 'fix' | …`) — same shape as
           *  the YAML `cezar-stages` frontmatter list. */
          suggested_stages: Json;
          uploaded_at: string;
          updated_at: string;
          uploaded_by: string | null;
          updated_by: string | null;
        };
        Insert: Omit<
          Database['public']['Tables']['uploaded_skills']['Row'],
          | 'id'
          | 'body'
          | 'description'
          | 'suggested_stages'
          | 'uploaded_at'
          | 'updated_at'
          | 'uploaded_by'
          | 'updated_by'
        > & {
          id?: string;
          body?: string;
          description?: string | null;
          suggested_stages?: Json;
          uploaded_at?: string;
          updated_at?: string;
          uploaded_by?: string | null;
          updated_by?: string | null;
        };
        Update: Partial<Database['public']['Tables']['uploaded_skills']['Insert']>;
      };
      skills_sh_skills: {
        Row: {
          id: string;
          workspace_id: string;
          /** API identifier — `{source}/{slug}` (e.g. `vercel-labs/skills/find-skills`). */
          source_slug: string;
          name: string;
          body: string;
          description: string | null;
          suggested_stages: Json;
          /** API snapshot fingerprint — Refresh compares against this. */
          content_hash: string | null;
          install_url: string | null;
          imported_at: string;
          last_synced_at: string;
          last_sync_error: string | null;
          imported_by: string | null;
        };
        Insert: Omit<
          Database['public']['Tables']['skills_sh_skills']['Row'],
          | 'id'
          | 'body'
          | 'description'
          | 'suggested_stages'
          | 'content_hash'
          | 'install_url'
          | 'imported_at'
          | 'last_synced_at'
          | 'last_sync_error'
          | 'imported_by'
        > & {
          id?: string;
          body?: string;
          description?: string | null;
          suggested_stages?: Json;
          content_hash?: string | null;
          install_url?: string | null;
          imported_at?: string;
          last_synced_at?: string;
          last_sync_error?: string | null;
          imported_by?: string | null;
        };
        Update: Partial<Database['public']['Tables']['skills_sh_skills']['Insert']>;
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
          | 'id'
          | 'priority'
          | 'status'
          | 'attempts'
          | 'max_attempts'
          | 'scheduled_at'
          | 'payload'
          | 'created_at'
          | 'updated_at'
          | 'claim_expires_at'
          | 'preferred_runner_id'
          | 'preferred_until'
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
          | 'id'
          | 'status'
          | 'pause_requested'
          | 'tokens_used'
          | 'started_at'
          | 'created_at'
          | 'updated_at'
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
        Insert: Omit<
          Database['public']['Tables']['agent_run_events']['Row'],
          'id' | 'payload' | 'created_at'
        > & {
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
          | 'id'
          | 'backends'
          | 'models'
          | 'status'
          | 'created_at'
          | 'updated_at'
          | 'github_installation_id'
          | 'github_inherit_host'
          | 'utilization'
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
