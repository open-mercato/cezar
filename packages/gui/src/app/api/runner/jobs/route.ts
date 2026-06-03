import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseStoreAdapter } from '@/lib/adapters/supabase-store';
import { loadWorkspaceConfig } from '@/lib/load-workspace-config';
import { loadWorkspaceLabels } from '@/lib/load-workspace-labels';
import { canAcquireListener, waitForJobsQueuedNotify } from '@/lib/pg-listen';
import { authRunner } from '../_auth';
import type { Database } from '@/lib/supabase/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type JobRow = Database['public']['Tables']['jobs']['Row'];

// `wait` query param is clamped to [0, MAX_WAIT_SEC]. 25s matches the
// ingress-timeout headroom on most Vercel/edge proxies; the runner sets a
// matching client-side fetch timeout (= wait + 5s) in runner-client.ts.
const MAX_WAIT_SEC = 25;

/**
 * GET /api/runner/jobs?backends=anthropic-api,claude-cli&wait=25
 *
 * A runner long-polls this to claim work. We:
 *   1. try `claim_next_job_for_runner` (FOR UPDATE SKIP LOCKED) restricted to
 *      the requested backends — fast path when there's queued work.
 *   2. when there isn't, optionally LISTEN on `jobs_queued` and re-try once on
 *      wake. NOTIFY is fired by the 0025 trigger on insert/requeue.
 *   3. on a hit: build the merged workspace config (incl. a freshly-minted
 *      GitHub token), snapshot the issue store, create the `workflow_runs`
 *      row, mark the job `running`, and return everything the runner needs.
 *
 * Returns `{ job: null }` (or HTTP 204 implicitly via `{ job: null }`) when
 * nothing was found within the wait window.
 */
export async function GET(req: Request) {
  const auth = await authRunner(req);
  if (auth instanceof NextResponse) return auth;
  const { runner, admin } = auth;

  // No heartbeat-on-poll: the daemon's dedicated `/api/runner/heartbeat` (now
  // a single RPC, migration 0020) is the single source of truth. The previous
  // double-write here was pure overhead per claim tick.

  const url = new URL(req.url);
  const requested = (url.searchParams.get('backends') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const backends = requested.length ? requested : runner.backends;
  if (backends.length === 0) return NextResponse.json({ job: null });

  const waitParam = Number(url.searchParams.get('wait') ?? '0');
  const waitSec = Number.isFinite(waitParam) ? Math.max(0, Math.min(MAX_WAIT_SEC, waitParam)) : 0;

  const claimOnce = async (): Promise<JobRow | null> => {
    const { data, error } = await admin.rpc('claim_next_job_for_runner', {
      p_runner_id: runner.id,
      p_backends: backends,
      p_limit: 1,
    });
    if (error) throw new Error(error.message);
    return ((data ?? []) as JobRow[])[0] ?? null;
  };

  let job: JobRow | null;
  try {
    job = await claimOnce();
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }

  // Long-poll path: nothing claimable right now — wait for a NOTIFY (or
  // timeout / client disconnect) and try once more. We only enter this if the
  // caller asked for it AND the in-process listener pool has room — otherwise
  // we behave like the old short-poll (single attempt, return null).
  if (!job && waitSec > 0 && canAcquireListener()) {
    const woke = await waitForJobsQueuedNotify(waitSec * 1000, req.signal);
    if (woke && !req.signal.aborted) {
      try { job = await claimOnce(); }
      catch (err) { return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 }); }
    }
  }

  if (!job) return NextResponse.json({ job: null });

  // From here on, any failure should release the job back to the queue so it
  // isn't stuck `claimed` until the watchdog. If we already inserted a fresh
  // `workflow_runs` row for this claim (vs. reusing an in-flight one), mark it
  // `failed` so it doesn't leak as a phantom `running` row the next claim's
  // reuse branch could latch onto — leaving two runners writing to it.
  let insertedRunRowId: string | null = null;
  const releaseJob = async () => {
    if (insertedRunRowId) {
      await admin.from('workflow_runs').update({
        status: 'failed',
        finished_at: new Date().toISOString(),
        reason: 'claim aborted before runner ack',
        updated_at: new Date().toISOString(),
      }).eq('id', insertedRunRowId);
    }
    await admin.from('jobs').update({
      status: 'queued',
      claimed_by_runner: null,
      claim_expires_at: null,
      updated_at: new Date().toISOString(),
    }).eq('id', job.id);
  };

  try {
    const core = await import('@cezar/core');

    // ── workspace + github token ──
    const { data: ws } = await admin.from('workspaces').select('repo_owner, repo_name').eq('id', job.workspace_id).single();
    if (!ws) throw new Error(`workspace ${job.workspace_id} not found`);
    const owner = ws.repo_owner;
    const repo = ws.repo_name;

    // ── per-runner GitHub identity (migration 0026) ──
    // Three modes, with precedence (inherit_host wins if both are set):
    //   1. inherit host: runner mints its own token from `gh auth token` /
    //      GITHUB_TOKEN — central returns no token; `ghIdentitySource` is
    //      `'host'` so the runner knows to swap in its cached value before
    //      calling executeJobLocally.
    //   2. per-runner App install: mint directly against the runner's
    //      configured installation id.
    //   3. workspace (default — today's behavior): try the workspace-level
    //      App install, fall back to the workspace admin token.
    let githubToken: string | null = null;
    let ghIdentitySource: string;
    if (runner.github_inherit_host) {
      ghIdentitySource = 'host';
      // No central minting — the runner side substitutes its cached host
      // token before passing to executeJobLocally.
    } else if (runner.github_installation_id != null) {
      const installId = Number(runner.github_installation_id);
      ghIdentitySource = `runner-install:${installId}`;
      try {
        if (!core.GitHubAppService.isConfigured()) {
          throw new Error('GitHub App not configured on central');
        }
        githubToken = await new core.GitHubAppService().getInstallationTokenById(installId);
      } catch (err) {
        // Per-runner install configured but unusable (no access to repo, app
        // not configured, etc.) — warn and fall back to workspace path so a
        // misconfiguration doesn't strand the job.
        console.warn(
          `[runner-api] per-runner install ${installId} failed, falling back to workspace token:`,
          err instanceof Error ? err.message : err,
        );
        ghIdentitySource = `workspace:${job.workspace_id} (runner-install:${installId} failed)`;
        if (owner && core.GitHubAppService.isConfigured()) {
          try { githubToken = await new core.GitHubAppService().getInstallationToken(owner); }
          catch (e) { console.error(`[runner-api] workspace install token also failed for ${owner}:`, e instanceof Error ? e.message : e); }
        }
        if (!githubToken) githubToken = await resolveWorkspaceToken(job.workspace_id, admin);
      }
    } else {
      ghIdentitySource = `workspace:${job.workspace_id}`;
      if (owner && core.GitHubAppService.isConfigured()) {
        try { githubToken = await new core.GitHubAppService().getInstallationToken(owner); }
        catch (err) { console.error(`[runner-api] installation token failed for ${owner}:`, err instanceof Error ? err.message : err); }
      }
      if (!githubToken) githubToken = await resolveWorkspaceToken(job.workspace_id, admin);
    }
    // For host-inherit runs we deliberately leave githubToken null — the
    // runner will substitute. For every other mode we must have one.
    if (!runner.github_inherit_host && !githubToken) {
      throw new Error('no github token available for workspace');
    }

    // For inherit-host mode we pass undefined so the config's github.token
    // stays at its empty default; the runner substitutes its host-minted
    // token before invoking the engine.
    const config = await loadWorkspaceConfig(job.workspace_id, admin, {
      githubToken: githubToken ?? undefined,
    });
    config.workflow = { ...(config.workflow ?? {}), useEngine: true };
    // The runner clones the repo itself — don't ship the SaaS's (local) repoRoot.
    config.autofix.repoRoot = '';

    // Workspace label catalog — shipped to the runner so the engine on the
    // self-hosted side gets the same per-step prompt augmentation as the cron
    // dispatcher (see execute-workflow-job.ts).
    const labels = await loadWorkspaceLabels(admin, job.workspace_id);

    // ── issue-store snapshot ──
    const adapter = new SupabaseStoreAdapter(admin, job.workspace_id);
    const store = await core.IssueStore.fromPort(adapter);
    const storeSnapshot = store.getAllData();

    const runIssueNumber = job.kind === 'ci-followup'
      ? ((job.payload as { ciFollowup?: { issueNumber?: number } })?.ciFollowup?.issueNumber ?? job.issue_number)
      : job.issue_number;

    // ── flow lookup ── For `kind='flow'` jobs the runner needs the flow's
    //   name + steps so it can build a Workflow and call runFlow. Load the
    //   row by `payload.flowId` here so the runner doesn't need DB access.
    //   `workflow_runs.workflow` becomes `flow:<name>` so the cockpit labels
    //   runner-driven flow runs the same way cron-driven ones look.
    type FlowPayload = { flowId?: string; flowInput?: string };
    let flowOut: { name: string; steps: import('@cezar/core').FlowStep[]; input: string } | null = null;
    let workflowLabel: string = job.kind;
    if (job.kind === 'flow') {
      const payload = (job.payload ?? {}) as FlowPayload;
      if (!payload.flowId) throw new Error('flow job missing payload.flowId');
      const { data: flowRow, error: fErr } = await admin
        .from('flows')
        .select('name, steps, paused')
        .eq('id', payload.flowId)
        .eq('workspace_id', job.workspace_id)
        .single();
      if (fErr || !flowRow) throw new Error(`flow ${payload.flowId} not found: ${fErr?.message ?? 'no row'}`);
      const parsedSteps = parseFlowSteps(flowRow.steps);
      flowOut = {
        name: flowRow.name,
        steps: parsedSteps,
        input: payload.flowInput ?? (runIssueNumber != null ? String(runIssueNumber) : ''),
      };
      workflowLabel = `flow:${flowRow.name}`;
    }

    // ── workflow_runs row ──
    // Phase 2: a watchdog-requeued job (claimed_by_runner was cleared after a
    // lease expiry) already has an in-flight `workflow_runs` row from the
    // crashed runner — reuse it so the runner can `claude --resume <id>`
    // off the same session. The previous run's `session_id` flows back
    // through `resumeSessionId` below.
    const repoSlug = owner && repo ? `${owner}/${repo}` : job.repo;
    const { data: existingRun } = await admin
      .from('workflow_runs')
      .select('id, session_id, status')
      .eq('job_id', job.id)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    let runRowId: string;
    let resumeSessionId: string | null = null;
    if (existingRun && (existingRun.status === 'running' || existingRun.status === 'paused' || existingRun.status === 'queued')) {
      runRowId = existingRun.id;
      resumeSessionId = existingRun.session_id ?? null;
      // Mark the row running again so the cockpit reflects the re-claim.
      await admin.from('workflow_runs').update({ status: 'running' }).eq('id', runRowId);
    } else {
      const { data: runRow, error: runErr } = await admin
        .from('workflow_runs')
        .insert({
          workspace_id: job.workspace_id,
          job_id: job.id,
          workflow: workflowLabel,
          repo: repoSlug,
          issue_number: runIssueNumber ?? null,
          pr_number: job.pr_number ?? null,
          status: 'running',
          started_at: new Date().toISOString(),
        })
        .select('id')
        .single();
      if (runErr || !runRow) throw new Error(`workflow_runs insert failed: ${runErr?.message}`);
      runRowId = runRow.id;
      // Track the freshly-inserted row so `releaseJob` can mark it `failed`
      // rather than leak it as a phantom `running` row. We don't touch the
      // reuse branch's row — that one legitimately belongs to a prior claim.
      insertedRunRowId = runRowId;
    }

    await admin.from('jobs').update({ status: 'running', updated_at: new Date().toISOString() }).eq('id', job.id);

    const ciFollowupSeed = job.kind === 'ci-followup'
      ? (job.payload as { ciFollowup?: unknown })?.ciFollowup ?? null
      : null;

    return NextResponse.json({
      job: {
        id: job.id,
        workspaceId: job.workspace_id,
        repo: job.repo,
        kind: job.kind,
        issueNumber: job.issue_number,
        prNumber: job.pr_number,
        requiredBackend: job.required_backend,
      },
      workflowRunId: runRowId,
      workspace: { id: job.workspace_id, owner, repo },
      // `config.github.token` IS included on purpose — the runner needs it; it's
      // already a short-lived/scoped token. No other secrets travel. Null for
      // host-inherit runners; they substitute their own.
      config,
      githubToken,
      /** Phase 4 (migration 0026) — informational label for which identity
       *  served this claim. The runner logs it on job start so the operator
       *  can see "workspace:abc-…" vs "runner-install:12345" vs "host" at a
       *  glance. Drives the host-side token substitution when === 'host'. */
      ghIdentitySource,
      store: storeSnapshot,
      ciFollowupSeed,
      flow: flowOut,
      labels,
      // Phase 2: re-claim resume. When non-null the runner asks the engine
      // to spawn `claude --resume <id>` for the first agent step so the
      // new process picks up the prior on-disk conversation; cross-host
      // re-claims fall back to a fresh start under the same id.
      resumeSessionId,
    });
  } catch (err) {
    await releaseJob().catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    console.error('[runner-api] /jobs failed:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Defensive parser for the `flows.steps` JSONB column — keeps the runner-API
 * contract clean even if a row was inserted by an older client. Mirrors the
 * GUI-side `parseSteps` in `app/workflows/actions.ts`.
 */
function parseFlowSteps(raw: unknown): import('@cezar/core').FlowStep[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s) => {
      if (!s || typeof s !== 'object') return null;
      const obj = s as Record<string, unknown>;
      const step: import('@cezar/core').FlowStep = {
        skill: typeof obj.skill === 'string' ? obj.skill : '',
        argsTemplate: typeof obj.argsTemplate === 'string' ? obj.argsTemplate : '',
      };
      if (typeof obj.stopChainIfContains === 'string' && obj.stopChainIfContains) step.stopChainIfContains = obj.stopChainIfContains;
      if (typeof obj.systemNotes === 'string' && obj.systemNotes) step.systemNotes = obj.systemNotes;
      return step;
    })
    .filter((x): x is import('@cezar/core').FlowStep => x !== null);
}

/** Mirrors the per-workspace token lookup in the crons (`execute-workflow-job.ts`). */
async function resolveWorkspaceToken(
  workspaceId: string,
  admin: SupabaseClient<Database>,
): Promise<string | null> {
  const { data: admins } = await admin.from('workspace_members').select('user_id').eq('workspace_id', workspaceId).eq('role', 'admin');
  if (admins && admins.length > 0) {
    const ids = admins.map((a) => a.user_id);
    const { data: tokens } = await admin.from('user_github_tokens').select('provider_token').in('user_id', ids).limit(1);
    const token = tokens?.[0]?.provider_token;
    if (token) return token;
  }
  return process.env.GITHUB_TOKEN || null;
}
