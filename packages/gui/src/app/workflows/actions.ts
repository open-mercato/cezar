'use server';

import { revalidatePath } from 'next/cache';
import {
  discoverSkills,
  renderTemplate,
  FLOW_STEP_SCAFFOLDING,
  DEFAULT_STEP_NOTES,
  effectiveStepNotes,
} from '@cezar/core';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { getActiveWorkspace } from '@/lib/workspace';
import { loadWorkspaceConfig } from '@/lib/load-workspace-config';
import { ensureRepoClone, withRepoLock } from '@/lib/repo-clone';
import type { Database } from '@/lib/supabase/types';

/**
 * Server actions backing the `/workflows` page — CRUD for the simple `flows`
 * table (migration 0021) + the auto-triggers (migration 0022) + the
 * "Run on issue #" entry point + a server-side prompt preview helper.
 */

export type ActionResult<T = {}> = (T & { ok: true }) | { ok: false; error: string };

export interface FlowStep {
  skill: string;
  argsTemplate: string;
  /**
   * When set, after the step runs the engine checks if its text output
   * contains this substring; if it does, the chain stops cleanly with status
   * `succeeded` and reason "stopped at step N". A simple short-circuit for
   * skills that legitimately decide "no action needed".
   */
  stopChainIfContains?: string;
  /**
   * Extra system-prompt content prepended to the skill body. When unset
   * (or whitespace-only), a built-in default explaining the `PR_URL=` /
   * `PR_NUMBER=` marker contract is used. Set to override per step.
   */
  systemNotes?: string;
}

export type FlowTrigger =
  | { kind: 'issue.opened' }
  | { kind: 'issue.labeled'; label: string };

export interface SkillSummary {
  name: string;
  /** First line of the skill's frontmatter `description` field; empty when none. */
  description: string;
}

export interface FlowStepOutcome {
  stepId: string;
  status: string;
  iteration: number;
  /** Best-effort: error, summary, or tail of the agent's text output. */
  output: string;
}

export interface FlowRecentRun {
  id: string;
  status: string;
  issueNumber: number | null;
  startedAt: string;
}

export interface FlowStats {
  /** Total runs in the last 7 days. */
  totalLast7d: number;
  /** Runs whose status is 'succeeded' in the last 7 days. */
  succeededLast7d: number;
  /** Average cost-weighted tokens per run over the last 7 days (0 when no runs). */
  avgTokens: number;
}

export interface FlowSummary {
  id: string;
  name: string;
  steps: FlowStep[];
  triggers: FlowTrigger[];
  paused: boolean;
  updatedAt: string;
  /** Most recent workflow_runs row whose `workflow` matches `flow:<name>` — with per-step output snippets. */
  lastRun?: {
    id: string;
    status: string;
    issueNumber: number | null;
    startedAt: string;
    finishedAt: string | null;
    reason: string | null;
    steps: FlowStepOutcome[];
  };
  /** Lightweight pills for the at-a-glance history strip (up to 5, newest first). */
  recentRuns: FlowRecentRun[];
  /** 7-day stats — success rate + avg tokens. */
  stats: FlowStats;
}

// ─── Read ────────────────────────────────────────────────────────────────────

export async function listFlows(): Promise<FlowSummary[]> {
  const workspace = await getActiveWorkspace();
  if (!workspace) return [];
  const supabase = createSupabaseAdminClient();

  const { data: rows, error } = await supabase
    .from('flows')
    .select('id, name, steps, triggers, paused, updated_at')
    .eq('workspace_id', workspace.id)
    .order('updated_at', { ascending: false });
  if (error || !rows) return [];

  const workflowKeys = rows.map((r) => `flow:${r.name}`);
  const lastRuns = new Map<string, FlowSummary['lastRun']>();
  const recentByWorkflow = new Map<string, FlowRecentRun[]>();
  const statsByWorkflow = new Map<string, FlowStats>();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  if (workflowKeys.length > 0) {
    const { data: runs } = await supabase
      .from('workflow_runs')
      .select('id, workflow, status, issue_number, started_at, finished_at, reason, tokens_used')
      .eq('workspace_id', workspace.id)
      .in('workflow', workflowKeys)
      .order('started_at', { ascending: false });
    if (runs) {
      // Group runs by workflow (descending), and tally stats over the 7-day window.
      const seenLatest = new Set<string>();
      const latestRunIds: string[] = []; // for the per-step output query (only the most-recent per workflow)
      for (const run of runs) {
        const key = run.workflow;
        const list = recentByWorkflow.get(key) ?? [];
        if (list.length < 5) list.push({
          id: run.id,
          status: run.status,
          issueNumber: run.issue_number,
          startedAt: run.started_at,
        });
        recentByWorkflow.set(key, list);
        if (!seenLatest.has(key)) {
          seenLatest.add(key);
          latestRunIds.push(run.id);
        }
        if (run.started_at >= sevenDaysAgo) {
          const cur = statsByWorkflow.get(key) ?? { totalLast7d: 0, succeededLast7d: 0, avgTokens: 0 };
          cur.totalLast7d += 1;
          if (run.status === 'succeeded') cur.succeededLast7d += 1;
          // running average — we'll finalize by dividing once at the end.
          cur.avgTokens += run.tokens_used ?? 0;
          statsByWorkflow.set(key, cur);
        }
      }
      for (const [, s] of statsByWorkflow) {
        s.avgTokens = s.totalLast7d > 0 ? Math.round(s.avgTokens / s.totalLast7d) : 0;
      }

      // Per-step output snippet — only fetched for the most-recent run per
      // workflow (everything else is "open in cockpit"). Keeps this query tight.
      const stepRowsByRun = new Map<string, Array<{ id: string; stepId: string; status: string; iteration: number; summary: string | null; error: string | null }>>();
      const stepIdsForEventQuery: string[] = [];
      if (latestRunIds.length > 0) {
        const { data: ar } = await supabase
          .from('agent_runs')
          .select('id, workflow_run_id, step_id, status, iteration, started_at, summary, error')
          .in('workflow_run_id', latestRunIds)
          .order('started_at', { ascending: true });
        for (const row of ar ?? []) {
          const list = stepRowsByRun.get(row.workflow_run_id) ?? [];
          list.push({ id: row.id, stepId: row.step_id, status: row.status, iteration: row.iteration, summary: row.summary, error: row.error });
          stepRowsByRun.set(row.workflow_run_id, list);
          stepIdsForEventQuery.push(row.id);
        }
      }

      const textByAgentRun = new Map<string, string>();
      if (stepIdsForEventQuery.length > 0) {
        const { data: events } = await supabase
          .from('agent_run_events')
          .select('agent_run_id, payload, type, created_at')
          .in('agent_run_id', stepIdsForEventQuery)
          .eq('type', 'agent-text')
          .order('created_at', { ascending: true });
        for (const ev of events ?? []) {
          const payload = (ev.payload ?? {}) as { text?: unknown };
          if (typeof payload.text !== 'string' || !ev.agent_run_id) continue;
          textByAgentRun.set(ev.agent_run_id, (textByAgentRun.get(ev.agent_run_id) ?? '') + payload.text);
        }
      }

      for (const run of runs) {
        if (lastRuns.has(run.workflow)) continue;
        const steps = (stepRowsByRun.get(run.id) ?? []).map<FlowStepOutcome>((s) => {
          let output = '';
          if (s.status === 'failed' && s.error) output = s.error;
          else if (s.status === 'skipped' && s.summary) output = s.summary;
          else {
            const text = textByAgentRun.get(s.id) ?? '';
            output = text.length > 240 ? '…' + text.slice(-240) : text;
          }
          return { stepId: s.stepId, status: s.status, iteration: s.iteration, output };
        });
        lastRuns.set(run.workflow, {
          id: run.id,
          status: run.status,
          issueNumber: run.issue_number,
          startedAt: run.started_at,
          finishedAt: run.finished_at,
          reason: run.reason,
          steps,
        });
      }
    }
  }

  return rows.map((row) => {
    const key = `flow:${row.name}`;
    return {
      id: row.id,
      name: row.name,
      steps: parseSteps(row.steps),
      triggers: parseTriggers(row.triggers),
      paused: row.paused,
      updatedAt: row.updated_at,
      lastRun: lastRuns.get(key),
      recentRuns: recentByWorkflow.get(key) ?? [],
      stats: statsByWorkflow.get(key) ?? { totalLast7d: 0, succeededLast7d: 0, avgTokens: 0 },
    };
  });
}

function parseSteps(raw: unknown): FlowStep[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s) => {
      if (!s || typeof s !== 'object') return null;
      const obj = s as Record<string, unknown>;
      const step: FlowStep = {
        skill: typeof obj.skill === 'string' ? obj.skill : '',
        argsTemplate: typeof obj.argsTemplate === 'string' ? obj.argsTemplate : '',
      };
      if (typeof obj.stopChainIfContains === 'string' && obj.stopChainIfContains) {
        step.stopChainIfContains = obj.stopChainIfContains;
      }
      if (typeof obj.systemNotes === 'string' && obj.systemNotes) {
        step.systemNotes = obj.systemNotes;
      }
      return step;
    })
    .filter((x): x is FlowStep => x !== null);
}

function parseTriggers(raw: unknown): FlowTrigger[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t): FlowTrigger | null => {
      if (!t || typeof t !== 'object') return null;
      const obj = t as Record<string, unknown>;
      if (obj.kind === 'issue.opened') return { kind: 'issue.opened' };
      if (obj.kind === 'issue.labeled' && typeof obj.label === 'string') {
        return { kind: 'issue.labeled', label: obj.label };
      }
      return null;
    })
    .filter((x): x is FlowTrigger => x !== null);
}

// ─── Write ──────────────────────────────────────────────────────────────────

export async function upsertFlow(params: {
  id?: string;
  name: string;
  steps: FlowStep[];
  triggers: FlowTrigger[];
  paused?: boolean;
}): Promise<ActionResult<{ id: string }>> {
  const workspace = await getActiveWorkspace();
  if (!workspace) return { ok: false, error: 'no active workspace' };
  if (workspace.role === 'viewer') return { ok: false, error: 'viewers cannot edit flows' };
  if (!params.name.trim()) return { ok: false, error: 'name is required' };

  const supabase = createSupabaseAdminClient();
  const row: Database['public']['Tables']['flows']['Insert'] = {
    workspace_id: workspace.id,
    name: params.name.trim(),
    steps: params.steps as unknown as Database['public']['Tables']['flows']['Insert']['steps'],
    triggers: params.triggers as unknown as Database['public']['Tables']['flows']['Insert']['triggers'],
  };
  if (params.paused !== undefined) row.paused = params.paused;

  if (params.id) {
    const { error } = await supabase
      .from('flows')
      .update({ ...row, updated_at: new Date().toISOString() })
      .eq('id', params.id)
      .eq('workspace_id', workspace.id);
    if (error) return { ok: false, error: error.message };
    revalidatePath('/workflows');
    return { ok: true, id: params.id };
  }

  const { data, error } = await supabase
    .from('flows')
    .insert(row)
    .select('id')
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? 'insert failed' };
  revalidatePath('/workflows');
  return { ok: true, id: data.id };
}

export async function setFlowPaused(id: string, paused: boolean): Promise<ActionResult> {
  const workspace = await getActiveWorkspace();
  if (!workspace) return { ok: false, error: 'no active workspace' };
  if (workspace.role === 'viewer') return { ok: false, error: 'viewers cannot pause flows' };
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from('flows')
    .update({ paused, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('workspace_id', workspace.id);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/workflows');
  return { ok: true };
}

export async function deleteFlow(id: string): Promise<ActionResult> {
  const workspace = await getActiveWorkspace();
  if (!workspace) return { ok: false, error: 'no active workspace' };
  if (workspace.role === 'viewer') return { ok: false, error: 'viewers cannot delete flows' };
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from('flows')
    .delete()
    .eq('id', id)
    .eq('workspace_id', workspace.id);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/workflows');
  return { ok: true };
}

export async function runFlowOnIssue(params: {
  flowId: string;
  issueNumber: number;
}): Promise<ActionResult<{ jobId: string }>> {
  const workspace = await getActiveWorkspace();
  if (!workspace) return { ok: false, error: 'no active workspace' };
  if (workspace.role === 'viewer') return { ok: false, error: 'viewers cannot start runs' };
  if (!Number.isInteger(params.issueNumber) || params.issueNumber <= 0) {
    return { ok: false, error: 'issue number must be a positive integer' };
  }

  const supabase = createSupabaseAdminClient();
  const { data: flow } = await supabase
    .from('flows')
    .select('id')
    .eq('id', params.flowId)
    .eq('workspace_id', workspace.id)
    .single();
  if (!flow) return { ok: false, error: 'flow not found' };

  const repo = workspace.repoOwner && workspace.repoName
    ? `${workspace.repoOwner}/${workspace.repoName}`
    : null;

  const { data: job, error } = await supabase
    .from('jobs')
    .insert({
      workspace_id: workspace.id,
      repo,
      kind: 'flow',
      issue_number: params.issueNumber,
      pr_number: null,
      priority: 10,
      status: 'queued',
      max_attempts: 1,
      payload: {
        trigger: 'manual',
        flowId: params.flowId,
        flowInput: String(params.issueNumber),
      },
    })
    .select('id')
    .single();
  if (error || !job) return { ok: false, error: error?.message ?? 'enqueue failed' };

  revalidatePath('/workflows');
  revalidatePath('/cockpit');
  return { ok: true, jobId: job.id };
}

// ─── Skill catalog with descriptions ────────────────────────────────────────

export async function listAvailableSkills(): Promise<SkillSummary[]> {
  const workspace = await getActiveWorkspace();
  if (!workspace) return [];
  const supabase = createSupabaseAdminClient();
  const { data } = await supabase
    .from('repo_skills')
    .select('skills')
    .eq('workspace_id', workspace.id);
  if (!data) return [];
  const byName = new Map<string, SkillSummary>();
  for (const row of data) {
    const arr = (row.skills as Array<Record<string, unknown>> | null) ?? [];
    for (const s of arr) {
      if (!s || typeof s.name !== 'string' || !s.name.trim()) continue;
      const description =
        typeof s.description === 'string'
          ? s.description.split('\n')[0].trim().slice(0, 240)
          : '';
      // First write wins (repo_skills is one row per repo; for multi-repo
      // workspaces, skills across repos with the same name are de-duped here).
      if (!byName.has(s.name)) byName.set(s.name, { name: s.name, description });
    }
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Prompt preview ─────────────────────────────────────────────────────────

export interface PreviewResult {
  stepNumber: number;
  skill: string;
  /** Generic flow-step scaffolding (constant). */
  scaffoldingSystemPrompt: string;
  /** Effective step notes — either the user's override or DEFAULT_STEP_NOTES. */
  stepNotes: string;
  /** True when `stepNotes` came from the built-in default (user hasn't overridden). */
  stepNotesIsDefault: boolean;
  /** The default text — useful for the editor's placeholder. */
  defaultStepNotes: string;
  /** Just the skill body — UI appends this to scaffolding for the "what the agent sees" view. */
  skillBody: string;
  /** Empty when the skill couldn't be found in the workspace's repo. */
  skillBodyMissing: boolean;
  userPrompt: string;
}

export async function renderStepPreview(params: {
  flowId: string;
  stepIdx: number;
  sampleInput: string;
  samplePrevTaskId: string;
  samplePrevPrUrl: string;
  samplePrevPrNumber: string;
  /** Optional sample for {{previousOutput}} — defaults to a placeholder. */
  samplePrevOutput?: string;
}): Promise<ActionResult<PreviewResult>> {
  const workspace = await getActiveWorkspace();
  if (!workspace) return { ok: false, error: 'no active workspace' };
  const supabase = createSupabaseAdminClient();

  const { data: flow, error } = await supabase
    .from('flows')
    .select('steps')
    .eq('id', params.flowId)
    .eq('workspace_id', workspace.id)
    .single();
  if (error || !flow) return { ok: false, error: 'flow not found' };

  const steps = parseSteps(flow.steps);
  const step = steps[params.stepIdx];
  if (!step) return { ok: false, error: `step ${params.stepIdx + 1} not found` };

  const userPrompt = renderTemplate(step.argsTemplate, {
    input: params.sampleInput,
    previousTaskId: params.samplePrevTaskId,
    previousPullRequestUrl: params.samplePrevPrUrl,
    previousPullRequestNumber: params.samplePrevPrNumber,
    previousOutput: params.samplePrevOutput ?? '<previous step output goes here>',
    existingCezarPr: '<no open Cezar PR on this issue>',
  });

  // Try to read the skill body from the workspace's cloned repo. Best-effort —
  // when the clone isn't materialized yet, we still return the rendered user
  // prompt so the UI shows the args part of the preview.
  let skillBody = '';
  let skillBodyMissing = true;
  try {
    const config = await loadWorkspaceConfig(workspace.id, supabase, {});
    if (config.github.owner && config.github.repo) {
      // Serialize the clone + skill read on the shared per-repo worktree so a
      // concurrent triage/autofix job can't reset it mid-read (see
      // withRepoLock in lib/repo-clone).
      const owner = config.github.owner;
      const repo = config.github.repo;
      const hit = await withRepoLock(owner, repo, async () => {
        if (!config.autofix.repoRoot) {
          config.autofix.repoRoot = await ensureRepoClone(
            owner,
            repo,
            config.github.token,
            config.autofix.baseBranch,
          );
        }
        const skills = await discoverSkills(config.autofix.repoRoot, config.autofix.skillsDir ?? '.ai/skills');
        return skills.find((s) => s.name === step.skill);
      });
      if (hit) {
        skillBody = hit.body;
        skillBodyMissing = false;
      }
    }
  } catch {
    // swallow — surface as `skillBodyMissing` and let the UI degrade gracefully.
  }

  const trimmed = (step.systemNotes ?? '').trim();
  const stepNotes = effectiveStepNotes(step);
  return {
    ok: true,
    stepNumber: params.stepIdx + 1,
    skill: step.skill,
    scaffoldingSystemPrompt: FLOW_STEP_SCAFFOLDING,
    stepNotes,
    stepNotesIsDefault: trimmed.length === 0,
    defaultStepNotes: DEFAULT_STEP_NOTES,
    skillBody,
    skillBodyMissing,
    userPrompt,
  };
}
