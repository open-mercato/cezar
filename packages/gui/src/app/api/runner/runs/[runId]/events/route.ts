import { NextResponse } from 'next/server';
import { authRunner, runnerScopesWorkspace } from '../../../_auth';
import type { AgentRunEventType } from '@/lib/supabase/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface IncomingEvent {
  type: AgentRunEventType | string;
  payload?: unknown;
  agentRunId?: string;
  stepId?: string;
  iteration?: number;
  kind?: string;
  backend?: string | null;
  model?: string | null;
  status?: string;
  summary?: string | null;
  error?: string | null;
  tokensUsed?: number;
  startedAt?: string;
  finishedAt?: string | null;
  /** Phase 2: claude session id for this step. Written by the RPC into
   *  `agent_runs.session_id` and (first-non-null) `workflow_runs.session_id`. */
  sessionId?: string;
  /** Phase 5 (migration 0027): runner UUID stamped on `step-start`/`step-end`.
   *  The RPC `coalesce`s onto `agent_runs.runner_id` so the first event that
   *  carries it wins; re-deliveries with an empty/missing field don't clobber
   *  an existing value. */
  runnerId?: string;
}

/**
 * POST /api/runner/runs/:runId/events  { events: IncomingEvent[] }
 *
 * The runner batches events here. The entire batch is processed by a single
 * `ingest_runner_events` RPC (migration 0020): one set-based insert opens
 * agent_runs rows from step-start, one upsert closes them from step-end, one
 * insert appends every event to agent_run_events, and one atomic UPDATE rolls
 * up `tokens_used` + `current_step_id` on workflow_runs. Previously this loop
 * fired ~30-60 sequential statements per 25-event batch, which was the main
 * driver of the 10-16s tail latency under multi-runner load.
 */
export async function POST(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const auth = await authRunner(req);
  if (auth instanceof NextResponse) return auth;
  const { runner, admin } = auth;
  const { runId } = await params;

  const { data: run } = await admin
    .from('workflow_runs')
    .select('id, workspace_id')
    .eq('id', runId)
    .maybeSingle();
  if (!run) return NextResponse.json({ error: 'run not found' }, { status: 404 });
  if (!runnerScopesWorkspace(runner, run.workspace_id))
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  let body: { events?: IncomingEvent[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const events = Array.isArray(body.events) ? body.events : [];
  if (events.length === 0) return NextResponse.json({ ok: true });

  const { error } = await admin.rpc('ingest_runner_events', {
    p_run_id: runId,
    p_workspace_id: run.workspace_id,
    p_events: events,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
