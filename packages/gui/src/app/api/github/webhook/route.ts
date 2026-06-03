import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { upsertIssueFromWebhook, type WebhookIssue } from '@/lib/upsert-issue-from-webhook';
import type { Database } from '@/lib/supabase/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Phase 5 — the GitHub App webhook receiver (docs §3.7). Verifies the
 * `X-Hub-Signature-256` HMAC, then dispatches on `X-GitHub-Event`:
 *
 *   - `issues` (opened / reopened / title-or-body edited): upsert the issue into
 *     the matching workspace(s) and enqueue a (deduped) `triage` job. The
 *     `/api/cron/dispatch` cron / a self-hosted runner drains it.
 *   - `check_run` (completed/failure): no-op — the ci-watch/ci-attribute/ci-fix
 *     crons already drive the CI follow-up loop (it needs an attribution seed
 *     they produce). TODO(phase-5): convert that to webhook-driven jobs.
 *   - `pull_request`: no-op — the issue-match cron handles PR↔issue linking.
 *     TODO(phase-5).
 *   - `installation` / `installation_repositories`: best-effort record the
 *     installation id on the matching workspace(s).
 *   - `ping` → `{ ok: true }`. Anything else → `{ ignored: true }`.
 *
 * Always responds fast — no agent work happens here. Without
 * `GITHUB_APP_WEBHOOK_SECRET` set it returns 503 (so a missing setup is
 * obvious; the `/api/cron/triage-sweep` poll is the fallback in that case).
 *
 * Replay/idempotency: after the signature check, the `X-GitHub-Delivery` id is
 * recorded in `webhook_deliveries` (migration 0029). A duplicate id (captured
 * replay or GitHub's own 5xx retry) short-circuits as `{ ok: true, replay: true }`
 * so we never re-upsert or re-enqueue. The dispatch cron GCs the table.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const secret = process.env.GITHUB_APP_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'webhook secret not configured' }, { status: 503 });
  }

  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return NextResponse.json({ error: 'unreadable body' }, { status: 400 });
  }

  const signature = req.headers.get('x-hub-signature-256') ?? '';
  if (!verifySignature(rawBody, signature, secret)) {
    return NextResponse.json({ error: 'bad signature' }, { status: 401 });
  }

  const event = req.headers.get('x-github-event') ?? '';

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(rawBody) as WebhookPayload;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  try {
    const admin = createSupabaseAdminClient();

    // Idempotency / replay guard (migration 0029). Record the delivery id
    // before dispatch; a unique-violation means we've already processed this
    // delivery (malicious replay or GitHub's own 5xx retry) — short-circuit so
    // we don't re-upsert issues/PRs or re-enqueue triage/ci-followup/flow jobs.
    // Runs after the signature check so only authenticated deliveries reach the
    // table. A `ping` carries no actionable work; let it through unrecorded.
    if (event !== 'ping') {
      const deliveryId = req.headers.get('x-github-delivery') ?? '';
      if (!deliveryId) {
        return NextResponse.json({ error: 'missing delivery id' }, { status: 400 });
      }
      const { error: dedupError } = await admin.from('webhook_deliveries').insert({ delivery_id: deliveryId });
      if (dedupError) {
        if (dedupError.code === '23505') {
          return NextResponse.json({ ok: true, replay: true });
        }
        // A transient insert failure shouldn't drop the delivery — fall through
        // and process it (the in-flight-job dedup downstream limits the blast
        // radius). Log so it's visible.
        console.error(`[github-webhook] delivery dedup insert failed:`, dedupError.message);
      }
    }

    switch (event) {
      case 'ping':
        return NextResponse.json({ ok: true });
      case 'issues':
        return await handleIssues(admin, payload);
      case 'check_run':
        return await handleCheckRun(admin, payload);
      case 'pull_request':
        return await handlePullRequest(admin, payload);
      case 'installation':
      case 'installation_repositories':
        return await handleInstallation(admin, payload);
      default:
        return NextResponse.json({ ignored: true, event });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[github-webhook] ${event} handler failed:`, msg);
    // Ack with 200 even on a downstream failure: a 5xx makes GitHub retry the
    // same delivery (~8 times / 24h), which — combined with the upsert/enqueue
    // dedup not yet running — turns one flaky Supabase call into a storm of
    // duplicate triage/flow jobs. We accepted the delivery and own the
    // recovery (the triage-sweep poll is the safety net), so don't hand GitHub
    // the retry queue.
    return NextResponse.json({ ok: false, error: 'handler error' }, { status: 200 });
  }
}

// ─── signature ──────────────────────────────────────────────────────────────

function verifySignature(rawBody: string, headerValue: string, secret: string): boolean {
  if (!headerValue.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
  const a = Buffer.from(headerValue, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ─── payload shapes (the slices we touch) ───────────────────────────────────

interface WebhookPayload {
  action?: string;
  changes?: { title?: unknown; body?: unknown };
  issue?: WebhookIssue;
  pull_request?: WebhookPullRequest;
  /** Present on `issues.labeled` — the label that was just added. */
  label?: { name?: string };
  repository?: { name: string; owner: { login: string } };
  installation?: { id: number };
  check_run?: {
    name: string;
    status: string;
    conclusion: string | null;
    head_sha: string;
    html_url: string | null;
    pull_requests?: Array<{ number: number; head?: { ref?: string }; base?: { ref?: string } }>;
  };
}

interface WebhookPullRequest {
  number: number;
  title: string;
  body: string | null;
  state: string;
  draft?: boolean;
  user?: { login: string } | null;
  html_url: string;
  labels?: Array<{ name: string }>;
  head?: { sha?: string; ref?: string } | null;
  base?: { ref?: string } | null;
  created_at: string;
  updated_at: string;
}

// ─── issues ─────────────────────────────────────────────────────────────────

const TRIAGE_ACTIONS = new Set(['opened', 'reopened']);

async function handleIssues(admin: SupabaseAdmin, payload: WebhookPayload): Promise<NextResponse> {
  const action = payload.action ?? '';
  const isTriageRelevant =
    TRIAGE_ACTIONS.has(action) ||
    (action === 'edited' && !!payload.changes && ('title' in payload.changes || 'body' in payload.changes));
  const isFlowRelevant = action === 'opened' || action === 'labeled';
  if (!isTriageRelevant && !isFlowRelevant) {
    return NextResponse.json({ ok: true, ignored: `issues.${action}` });
  }

  const issue = payload.issue;
  const repo = payload.repository;
  if (!issue || !repo) return NextResponse.json({ ok: true, ignored: 'issues event missing issue/repository' });

  const workspaces = await resolveWorkspaces(admin, payload, repo);
  if (workspaces.length === 0) return NextResponse.json({ ok: true, ignored: 'no matching workspace' });

  const repoSlug = `${repo.owner.login}/${repo.name}`;
  // GitHub puts the just-added label on `payload.label` for issues.labeled.
  const justLabeled =
    action === 'labeled' && payload.label && typeof payload.label.name === 'string'
      ? payload.label.name
      : null;

  let triageEnqueued = 0;
  let flowsEnqueued = 0;
  for (const ws of workspaces) {
    // Upsert the issue once per workspace either way so the issues table stays
    // current even for flow-only triggers.
    try {
      await upsertIssueFromWebhook(admin, ws.id, issue);
    } catch (err) {
      console.error(`[github-webhook] issue upsert failed for ws ${ws.id}:`, err instanceof Error ? err.message : err);
      continue;
    }

    // Triage path (existing behavior).
    if (isTriageRelevant && ws.auto_triage_enabled) {
      const { data: open } = await admin
        .from('jobs')
        .select('id')
        .eq('workspace_id', ws.id)
        .eq('kind', 'triage')
        .eq('issue_number', issue.number)
        .in('status', ['queued', 'claimed', 'running'])
        .limit(1);
      if (!open || open.length === 0) {
        const { error } = await admin.from('jobs').insert({
          workspace_id: ws.id,
          repo: repoSlug,
          kind: 'triage',
          issue_number: issue.number,
          pr_number: null,
          priority: 5,
          status: 'queued',
          max_attempts: 1,
          payload: { trigger: 'webhook', action },
        });
        if (error) {
          console.error(`[github-webhook] triage enqueue failed for ws ${ws.id}:`, error.message);
        } else {
          triageEnqueued++;
        }
      }
    }

    // Flow auto-trigger path. Match flows whose `triggers` include
    // `issue.opened` (on opened) or `issue.labeled` with the right label.
    if (isFlowRelevant) {
      flowsEnqueued += await enqueueFlowsForIssueEvent(admin, {
        workspaceId: ws.id,
        repoSlug,
        issueNumber: issue.number,
        action,
        labelName: justLabeled,
      });
    }
  }
  return NextResponse.json({
    ok: true,
    triageEnqueued,
    flowsEnqueued,
    workspaces: workspaces.length,
  });
}

/**
 * For a `issues.opened` / `issues.labeled` event, find flows in `workspaceId`
 * whose `triggers` match and enqueue one `kind='flow'` job per match. Skips
 * flows that already have an in-flight job for this issue (dedupe).
 */
async function enqueueFlowsForIssueEvent(
  admin: SupabaseAdmin,
  args: {
    workspaceId: string;
    repoSlug: string;
    issueNumber: number;
    action: string;
    labelName: string | null;
  },
): Promise<number> {
  const { data: flows } = await admin
    .from('flows')
    .select('id, name, triggers, paused')
    .eq('workspace_id', args.workspaceId)
    .eq('paused', false);
  if (!flows || flows.length === 0) return 0;

  let enqueued = 0;
  for (const flow of flows) {
    const triggers = Array.isArray(flow.triggers) ? (flow.triggers as Array<Record<string, unknown>>) : [];
    const matches = triggers.some((t) => {
      if (!t || typeof t !== 'object') return false;
      if (args.action === 'opened' && t.kind === 'issue.opened') return true;
      if (args.action === 'labeled' && t.kind === 'issue.labeled') {
        return typeof t.label === 'string' && t.label === args.labelName;
      }
      return false;
    });
    if (!matches) continue;

    // Dedupe: don't double-enqueue a flow for the same issue while one's
    // already in flight (e.g. label added, then issue edited later).
    const { data: open } = await admin
      .from('jobs')
      .select('id, payload')
      .eq('workspace_id', args.workspaceId)
      .eq('kind', 'flow')
      .eq('issue_number', args.issueNumber)
      .in('status', ['queued', 'claimed', 'running']);
    const alreadyForThisFlow = (open ?? []).some((row) => {
      const p = (row.payload ?? {}) as { flowId?: string };
      return p.flowId === flow.id;
    });
    if (alreadyForThisFlow) continue;

    const { error } = await admin.from('jobs').insert({
      workspace_id: args.workspaceId,
      repo: args.repoSlug,
      kind: 'flow',
      issue_number: args.issueNumber,
      pr_number: null,
      priority: 5,
      status: 'queued',
      max_attempts: 1,
      payload: {
        trigger: 'webhook',
        action: args.action,
        flowId: flow.id,
        flowInput: String(args.issueNumber),
      },
    });
    if (error) {
      console.error(`[github-webhook] flow '${flow.name}' enqueue failed:`, error.message);
      continue;
    }
    enqueued++;
  }
  return enqueued;
}

// ─── check_run ──────────────────────────────────────────────────────────────

/**
 * `check_run.completed` with a failing conclusion on a PR that an autofix run
 * opened → enqueue a `ci-followup` job whose payload carries the CiFollowupInput
 * seed. The dispatcher (or runner) drains it via the engine's `ci-followup`
 * workflow, which posts a fix attempt back to the same PR.
 *
 * Only acts when:
 *   - `action === 'completed'` and `conclusion` is a failure-ish state
 *     (`failure` / `timed_out` / `cancelled` / `action_required` / `startup_failure`).
 *   - the head_sha (or one of the linked PRs) corresponds to a `workflow_runs`
 *     row from THIS workspace where `workflow === 'autofix'` and `status === 'succeeded'`
 *     (i.e. the autofix did open a PR — not a third-party PR happening to fail).
 *
 * The `attribution` field is a *seed*; the real attribution happens inside the
 * `ci-followup` workflow's `attribute` step. We pass through the failed check
 * name(s) and the html_url (so the agent can fetch logs if it wants).
 */
const CHECK_RUN_FAIL_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']);

async function handleCheckRun(admin: SupabaseAdmin, payload: WebhookPayload): Promise<NextResponse> {
  if (payload.action !== 'completed') return NextResponse.json({ ok: true, ignored: `check_run.${payload.action}` });
  const cr = payload.check_run;
  const repo = payload.repository;
  if (!cr || !repo) return NextResponse.json({ ok: true, ignored: 'check_run missing payload/repo' });
  if (cr.conclusion == null || !CHECK_RUN_FAIL_CONCLUSIONS.has(cr.conclusion)) {
    return NextResponse.json({ ok: true, ignored: `check_run conclusion=${cr.conclusion}` });
  }
  const linkedPrNumbers = (cr.pull_requests ?? []).map((p) => p.number);
  if (linkedPrNumbers.length === 0) {
    return NextResponse.json({ ok: true, ignored: 'check_run not linked to any PR' });
  }

  const workspaces = await resolveWorkspaces(admin, payload, repo);
  if (workspaces.length === 0) return NextResponse.json({ ok: true, ignored: 'no matching workspace' });

  const repoSlug = `${repo.owner.login}/${repo.name}`;
  let enqueued = 0;

  for (const ws of workspaces) {
    // Find the autofix workflow_run that owns one of the linked PRs.
    const { data: ownRuns } = await admin
      .from('workflow_runs')
      .select('id, issue_number, pr_number, branch, job_id')
      .eq('workspace_id', ws.id)
      .eq('workflow', 'autofix')
      .in('pr_number', linkedPrNumbers)
      .limit(1);
    const ownRun = ownRuns?.[0];
    if (!ownRun || ownRun.issue_number == null || ownRun.pr_number == null) continue;

    // Phase 4 soft affinity (migration 0026) — look up which runner handled
    // the parent autofix. Null when the parent ran on the cron path
    // (claimed_by_runner stays NULL there) — we deliberately skip affinity
    // in that case since it's pointless.
    let parentRunnerId: string | null = null;
    if (ownRun.job_id) {
      const { data: parentJob } = await admin
        .from('jobs')
        .select('claimed_by_runner')
        .eq('id', ownRun.job_id)
        .maybeSingle();
      parentRunnerId = parentJob?.claimed_by_runner ?? null;
    }

    // Count prior ci-followup attempts for this PR so the agent honours the
    // attempt cap. (`workflow_runs.pr_number` is the source of truth.)
    const { count: priorAttempts } = await admin
      .from('workflow_runs')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', ws.id)
      .eq('workflow', 'ci-followup')
      .eq('pr_number', ownRun.pr_number);
    const attemptMax = 3;
    if ((priorAttempts ?? 0) >= attemptMax) continue;

    // Dedupe — skip if a ci-followup job is already queued for this PR.
    const { data: open } = await admin
      .from('jobs')
      .select('id')
      .eq('workspace_id', ws.id)
      .eq('kind', 'ci-followup')
      .eq('pr_number', ownRun.pr_number)
      .in('status', ['queued', 'claimed', 'running'])
      .limit(1);
    if (open && open.length > 0) continue;

    // Build the CiFollowupInput seed. The `attribute` workflow step does the
    // real attribution work; this just provides the entry point.
    const ciFollowupSeed = {
      issueNumber: ownRun.issue_number,
      prNumber: ownRun.pr_number,
      branch: ownRun.branch ?? '',
      attemptIndex: (priorAttempts ?? 0) + 1,
      attemptMax,
      attribution: {
        reasoning: `check_run '${cr.name}' on PR #${ownRun.pr_number} concluded '${cr.conclusion}'`,
        preExistingChecks: [],
      },
      failedCheckNames: [cr.name],
      logTails: cr.html_url ? [{ checkName: cr.name, lines: [`(see ${cr.html_url})`] }] : undefined,
    };

    // Phase 4 soft affinity — 30s window in which the parent runner is
    // preferred; after that any matching runner can claim.
    const preferred = parentRunnerId
      ? {
          preferred_runner_id: parentRunnerId,
          preferred_until: new Date(Date.now() + 30_000).toISOString(),
        }
      : {};
    const { error } = await admin.from('jobs').insert({
      workspace_id: ws.id,
      repo: repoSlug,
      kind: 'ci-followup',
      issue_number: ownRun.issue_number,
      pr_number: ownRun.pr_number,
      priority: 8,
      status: 'queued',
      max_attempts: 1,
      payload: { trigger: 'webhook', ciFollowup: ciFollowupSeed },
      ...preferred,
    });
    if (error) {
      console.error(`[github-webhook] ci-followup enqueue failed for ws ${ws.id}:`, error.message);
      continue;
    }
    enqueued++;
  }

  return NextResponse.json({ ok: true, enqueued, workspaces: workspaces.length });
}

// ─── pull_request ───────────────────────────────────────────────────────────

const PR_UPSERT_ACTIONS = new Set([
  'opened',
  'reopened',
  'edited',
  'synchronize',
  'ready_for_review',
  'converted_to_draft',
  'labeled',
  'unlabeled',
]);
const PR_CLOSE_ACTIONS = new Set(['closed']);

async function handlePullRequest(admin: SupabaseAdmin, payload: WebhookPayload): Promise<NextResponse> {
  const action = payload.action ?? '';
  const pr = payload.pull_request;
  const repo = payload.repository;
  if (!pr || !repo) return NextResponse.json({ ok: true, ignored: 'pull_request missing payload/repo' });

  if (!PR_UPSERT_ACTIONS.has(action) && !PR_CLOSE_ACTIONS.has(action)) {
    return NextResponse.json({ ok: true, ignored: `pull_request.${action}` });
  }

  const workspaces = await resolveWorkspaces(admin, payload, repo);
  if (workspaces.length === 0) return NextResponse.json({ ok: true, ignored: 'no matching workspace' });

  const labels = Array.isArray(pr.labels)
    ? pr.labels.map((l) => l?.name).filter((n): n is string => typeof n === 'string' && n.length > 0)
    : [];

  let upserts = 0;
  for (const ws of workspaces) {
    const { error } = await admin.from('pull_requests').upsert(
      {
        workspace_id: ws.id,
        number: pr.number,
        title: pr.title,
        body: pr.body ?? '',
        state: pr.state === 'closed' ? 'closed' : 'open',
        draft: pr.draft ?? false,
        labels,
        author: pr.user?.login ?? 'unknown',
        html_url: pr.html_url,
        head_sha: pr.head?.sha ?? null,
        head_ref: pr.head?.ref ?? null,
        base_ref: pr.base?.ref ?? null,
        pr_created_at: pr.created_at,
        pr_updated_at: pr.updated_at,
      },
      { onConflict: 'workspace_id,number' },
    );
    if (error) {
      console.error(`[github-webhook] pull_request upsert failed for ws ${ws.id}:`, error.message);
      continue;
    }
    upserts++;
  }

  return NextResponse.json({ ok: true, upserts, workspaces: workspaces.length });
}

// ─── installation ───────────────────────────────────────────────────────────

async function handleInstallation(admin: SupabaseAdmin, payload: WebhookPayload): Promise<NextResponse> {
  const action = payload.action ?? '';
  const installationId = payload.installation?.id;
  const repo = payload.repository;
  try {
    if (action === 'created' || action === 'added') {
      if (installationId != null && repo) {
        await admin
          .from('workspaces')
          .update({ installation_id: installationId })
          .eq('repo_owner', repo.owner.login)
          .eq('repo_name', repo.name);
      }
    } else if (action === 'deleted' || action === 'removed') {
      if (installationId != null) {
        await admin.from('workspaces').update({ installation_id: null }).eq('installation_id', installationId);
      } else if (repo) {
        await admin.from('workspaces').update({ installation_id: null }).eq('repo_owner', repo.owner.login).eq('repo_name', repo.name);
      }
    }
  } catch (err) {
    console.error('[github-webhook] installation update failed:', err instanceof Error ? err.message : err);
  }
  return NextResponse.json({ ok: true });
}

// ─── workspace resolution ───────────────────────────────────────────────────

type SupabaseAdmin = ReturnType<typeof createSupabaseAdminClient>;
type WorkspaceMatch = Pick<Database['public']['Tables']['workspaces']['Row'], 'id' | 'auto_triage_enabled'>;

/** Match by `installation_id` first (preferred), else by `repo_owner`/`repo_name`. */
async function resolveWorkspaces(
  admin: SupabaseAdmin,
  payload: WebhookPayload,
  repo: { name: string; owner: { login: string } },
): Promise<WorkspaceMatch[]> {
  const installationId = payload.installation?.id;
  if (installationId != null) {
    const { data } = await admin
      .from('workspaces')
      .select('id, auto_triage_enabled')
      .eq('installation_id', installationId);
    if (data && data.length > 0) return data;
  }
  const { data } = await admin
    .from('workspaces')
    .select('id, auto_triage_enabled')
    .eq('repo_owner', repo.owner.login)
    .eq('repo_name', repo.name);
  return data ?? [];
}
