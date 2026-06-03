import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getActiveWorkspace } from '@/lib/workspace';
import type { Database, DbWorkflowRunStatus } from '@/lib/supabase/types';

type WorkflowRunRow = Database['public']['Tables']['workflow_runs']['Row'];
type EventRow = Database['public']['Tables']['agent_run_events']['Row'];

interface ActivityItem {
  id: string;
  type: 'run_started' | 'run_completed' | 'lifecycle';
  message: string;
  status?: DbWorkflowRunStatus;
  issueNumber?: number | null;
  runId?: string;
  timestamp: string;
}

/** Only surface activity from the last 30 days so the queries stay bounded as
 *  `agent_run_events` grows. */
const ACTIVITY_WINDOW_DAYS = 30;

async function loadActivity(workspaceId: string): Promise<ActivityItem[]> {
  const supabase = await createSupabaseServerClient();
  const since = new Date(Date.now() - ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const [{ data: runs }, { data: events }] = await Promise.all([
    supabase
      .from('workflow_runs')
      .select('id, workflow, issue_number, status, outcome, started_at, finished_at, pr_url, reason')
      .eq('workspace_id', workspaceId)
      .gte('started_at', since)
      .order('started_at', { ascending: false })
      .limit(50),
    supabase
      .from('agent_run_events')
      .select('id, workflow_run_id, type, payload, created_at')
      .eq('workspace_id', workspaceId)
      .eq('type', 'lifecycle')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(100),
  ]);

  const items: ActivityItem[] = [];

  for (const r of (runs ?? []) as WorkflowRunRow[]) {
    const isTerminal = r.status === 'succeeded' || r.status === 'failed' || r.status === 'cancelled';
    const issueRef = r.issue_number != null ? `#${r.issue_number}` : '(no issue)';

    items.push({
      id: `run-${r.id}`,
      type: 'run_started',
      message: `${r.workflow} started for ${issueRef}`,
      status: r.status,
      issueNumber: r.issue_number,
      runId: r.id,
      timestamp: r.started_at ?? r.finished_at ?? new Date().toISOString(),
    });

    if (isTerminal && r.finished_at) {
      const prSuffix = r.pr_url ? ` — ${r.pr_url}` : '';
      const msg =
        r.status === 'failed'
          ? `${r.workflow} failed for ${issueRef}: ${r.reason ?? 'unknown'}`
          : r.pr_url
            ? `${r.workflow} opened a PR for ${issueRef}${prSuffix}`
            : `${r.workflow} ${r.status} for ${issueRef}`;

      items.push({
        id: `run-done-${r.id}`,
        type: 'run_completed',
        message: msg,
        status: r.status,
        issueNumber: r.issue_number,
        runId: r.id,
        timestamp: r.finished_at,
      });
    }
  }

  for (const e of (events ?? []) as EventRow[]) {
    const payload = e.payload as { message?: string } | null;
    const msg = payload?.message;
    // Lifecycle messages arrive in two shapes — the workflow engine prefixes
    // `[#<issue>] …`, while triage-pass and action jobs emit a plain string.
    // Surface any non-empty message rather than gating on the `[#` prefix,
    // which silently dropped the triage events.
    if (!msg || typeof msg !== 'string') continue;
    items.push({
      id: `event-${e.id}`,
      type: 'lifecycle',
      message: msg,
      runId: e.workflow_run_id ?? undefined,
      timestamp: e.created_at,
    });
  }

  items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return items.slice(0, 100);
}

export default async function ActivityPage() {
  const workspace = await getActiveWorkspace();
  if (!workspace) {
    return (
      <div className="px-8 py-6">
        <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
        <p className="mt-2 text-sm text-fg-muted">No workspace selected.</p>
      </div>
    );
  }

  const items = await loadActivity(workspace.id);

  return (
    <div className="px-8 py-6">
      <header className="mb-8 border-b border-border pb-5">
        <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Recent events — {workspace.repoOwner}/{workspace.repoName}
        </p>
      </header>

      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-bg-elevated p-8 text-center text-sm text-fg-muted">
          No activity yet. Sync issues or run a workflow to generate events.
        </div>
      ) : (
        <div className="space-y-0">
          {items.map((item) => (
            <div key={item.id} className="flex gap-4 border-l-2 border-border py-2 pl-4">
              <div className="w-16 shrink-0 text-right text-xs text-fg-subtle">
                {formatTime(item.timestamp)}
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <TypeIcon type={item.type} status={item.status} />
                  <span className="text-xs text-fg">{item.message}</span>
                </div>
                {item.runId && (
                  <a
                    href={`/cockpit/${item.runId}`}
                    className="mt-0.5 inline-block text-xs text-fg-subtle hover:text-accent"
                  >
                    view run
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TypeIcon({ type, status }: { type: string; status?: DbWorkflowRunStatus }) {
  if (type === 'run_completed' && status === 'failed') return <span className="text-xs text-danger">✗</span>;
  if (type === 'run_completed') return <span className="text-xs text-accent">✓</span>;
  if (type === 'run_started') return <span className="text-xs text-fg-muted">▸</span>;
  return <span className="text-xs text-fg-subtle">·</span>;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'now';
  if (diffMins < 60) return `${diffMins}m`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs}h`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
