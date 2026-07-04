import { createSupabaseAdminClient } from '@/lib/supabase/server';
import type { InboxItem, DecisionItem, Finding, SkillTag, FindingBody } from './mock-data';

// ─────────────────────────────────────────────────────────────────────
// Server-side loader for the inbox. Reads three sources in parallel:
//   1. pending_decisions  — agent findings awaiting human accept/dismiss
//   2. workflow_runs      — paused (waiting at human-gate) + failed (24h)
//   3. pull_requests      — open, non-draft, **and** opened by a Cezar
//                           workflow_run (a row exists in workflow_runs
//                           pointing at the same pr_number). Random
//                           human-authored PRs in the repo aren't ours.
// and projects them into the InboxItem union the client view already uses.
// ─────────────────────────────────────────────────────────────────────

interface PendingRow {
  id: string;
  action_id: string;
  issue_number: number | null;
  pr_number: number | null;
  target_kind: 'issue' | 'pr';
  target_title: string;
  effect: string;
  effect_args: unknown;
  summary: string;
  confidence: number;
  created_at: string;
}

interface ActionRow {
  id: string;
  name: string;
}

interface PausedRunRow {
  id: string;
  workflow: string;
  issue_number: number | null;
  pr_number: number | null;
  current_step_id: string | null;
  started_at: string;
}

interface FailedRunRow {
  id: string;
  workflow: string;
  issue_number: number | null;
  pr_number: number | null;
  reason: string | null;
  finished_at: string | null;
  started_at: string;
}

interface PrRow {
  id: string;
  number: number;
  title: string;
  author: string;
  html_url: string;
  pr_created_at: string | null;
  pr_updated_at: string | null;
}

export interface ActionFilterOption {
  id: string;
  name: string;
}

export interface LoadedInbox {
  items: InboxItem[];
  syncedAt: number;
  healthAlerts: { id: string; text: string; severity: 'warn' | 'error' }[];
  /** Deduplicated list of action names currently producing visible pending
   *  decisions. Drives the Skill filter dropdown (replaces the hardcoded
   *  enum the mock used). */
  actionNames: ActionFilterOption[];
}

export async function loadInbox(workspaceId: string): Promise<LoadedInbox> {
  const supabase = createSupabaseAdminClient();
  const failedSince = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const nowIso = new Date().toISOString();

  const [pendingRes, pausedRes, failedRes, cezarPrRunsRes] = await Promise.all([
    supabase
      .from('pending_decisions')
      .select(
        'id, action_id, issue_number, pr_number, target_kind, target_title, effect, effect_args, summary, confidence, created_at',
      )
      .eq('workspace_id', workspaceId)
      .eq('status', 'pending')
      // Snoozed rows have `expires_at` set to a future timestamp. Rows that
      // are not snoozed (null) or whose snooze has passed (lt now) appear.
      .or(`expires_at.is.null,expires_at.lt.${nowIso}`)
      .order('created_at', { ascending: false })
      .limit(100)
      .returns<PendingRow[]>(),
    supabase
      .from('workflow_runs')
      .select('id, workflow, issue_number, pr_number, current_step_id, started_at')
      .eq('workspace_id', workspaceId)
      .eq('status', 'paused')
      .order('started_at', { ascending: false })
      .limit(20)
      .returns<PausedRunRow[]>(),
    supabase
      .from('workflow_runs')
      .select('id, workflow, issue_number, pr_number, reason, finished_at, started_at')
      .eq('workspace_id', workspaceId)
      .eq('status', 'failed')
      .gte('finished_at', failedSince)
      .order('finished_at', { ascending: false })
      .limit(20)
      .returns<FailedRunRow[]>(),
    // Cezar's "I opened a PR" trail. Pull every workflow_run that recorded
    // a pr_number — the resulting (pr_number → workflow) map is what we use
    // both to filter `pull_requests` (only Cezar's show up in the inbox)
    // and to label each row with the right workflow name.
    supabase
      .from('workflow_runs')
      .select('pr_number, workflow, created_at')
      .eq('workspace_id', workspaceId)
      .not('pr_number', 'is', null)
      .order('created_at', { ascending: true })
      .returns<{ pr_number: number; workflow: string; created_at: string }[]>(),
  ]);

  // Build pr_number → workflow. Later writes win, so iterating in
  // chronological order leaves the most recent workflow as the label
  // (e.g. ci-followup overrides the original autofix label).
  const cezarPrWorkflow = new Map<number, string>();
  for (const r of cezarPrRunsRes.data ?? []) {
    cezarPrWorkflow.set(r.pr_number, r.workflow);
  }
  const cezarPrNumbers = Array.from(cezarPrWorkflow.keys());

  // Now fetch the open, non-draft PRs constrained to Cezar's set. Skipping
  // the round trip entirely when there are no Cezar PRs avoids a wasted
  // `in()` with an empty array (which Supabase treats as "match all").
  const prsRes =
    cezarPrNumbers.length > 0
      ? await supabase
          .from('pull_requests')
          .select('id, number, title, author, html_url, pr_created_at, pr_updated_at')
          .eq('workspace_id', workspaceId)
          .eq('state', 'open')
          .eq('draft', false)
          .in('number', cezarPrNumbers)
          .order('pr_updated_at', { ascending: false })
          .limit(20)
          .returns<PrRow[]>()
      : { data: [] as PrRow[] };

  // Resolve action_id → action.name in one round trip so we can render skill tags.
  const actionIds = Array.from(new Set((pendingRes.data ?? []).map((p) => p.action_id)));
  const actionNamesById = new Map<string, string>();
  if (actionIds.length > 0) {
    const { data: actionRows } = await supabase
      .from('actions')
      .select('id, name')
      .in('id', actionIds)
      .returns<ActionRow[]>();
    for (const a of actionRows ?? []) actionNamesById.set(a.id, a.name);
  }

  const items: InboxItem[] = [];
  items.push(...buildFailedItems(failedRes.data ?? []));
  items.push(...buildPausedItems(pausedRes.data ?? []));
  items.push(...buildPrItems(prsRes.data ?? [], cezarPrWorkflow));
  items.push(...buildDecisionItems(pendingRes.data ?? [], actionNamesById));

  // Dedup the action filter options across whatever pending rows landed.
  // Only actions whose findings are actually visible become filter chips —
  // i.e. an action that produced nothing today doesn't clutter the dropdown.
  const actionNames: ActionFilterOption[] = [];
  const seenActionIds = new Set<string>();
  for (const row of pendingRes.data ?? []) {
    if (seenActionIds.has(row.action_id)) continue;
    const name = actionNamesById.get(row.action_id);
    if (!name) continue;
    seenActionIds.add(row.action_id);
    actionNames.push({ id: row.action_id, name });
  }
  actionNames.sort((a, b) => a.name.localeCompare(b.name));

  return {
    items,
    syncedAt: Date.now(),
    healthAlerts: buildHealthAlerts(),
    actionNames,
  };
}

// ─────────────────────────────────────────────────────────────────────
function ageMinutes(ts: string | null): number {
  if (!ts) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 60_000));
}

function buildFailedItems(rows: FailedRunRow[]): InboxItem[] {
  return rows.map((r) => ({
    kind: 'failed' as const,
    id: r.id,
    runNumber: shortRunId(r.id),
    workflow: r.workflow,
    reason: r.reason ?? 'no reason recorded',
    ageMin: ageMinutes(r.finished_at ?? r.started_at),
  }));
}

function buildPausedItems(rows: PausedRunRow[]): InboxItem[] {
  return rows.map((r) => ({
    kind: 'paused' as const,
    id: r.id,
    runNumber: shortRunId(r.id),
    workflow: r.workflow,
    step: r.current_step_id ?? 'unknown-step',
    ageMin: ageMinutes(r.started_at),
  }));
}

function buildPrItems(rows: PrRow[], cezarPrWorkflow: Map<number, string>): InboxItem[] {
  return rows.map((r) => ({
    kind: 'pr' as const,
    id: r.id,
    prNumber: r.number,
    title: r.title,
    // The filter upstream guarantees every row is in the map; fall back to
    // 'autofix' only as a defensive default that should never fire.
    agent: cezarPrWorkflow.get(r.number) ?? 'autofix',
    ageMin: ageMinutes(r.pr_created_at ?? r.pr_updated_at),
  }));
}

/**
 * Group pending_decisions rows by issue_number — multiple findings on the
 * same issue collapse into one card with multiple findings inside.
 */
function buildDecisionItems(rows: PendingRow[], actionNamesById: Map<string, string>): InboxItem[] {
  const byIssue = new Map<number, { title: string; findings: Finding[]; firstSeen: string }>();
  for (const r of rows) {
    const issueNumber = r.issue_number ?? r.pr_number;
    if (issueNumber == null) continue;
    // `actionName` is the canonical key the dynamic filter sorts/filters on;
    // `skill` is the legacy visual tag that drives color/icon. Both derive
    // from the same source — only the filter axis changed.
    const actionName = actionNamesById.get(r.action_id) ?? r.effect;
    const skill = actionNameToSkillTag(actionName);
    const finding: Finding = {
      id: r.id,
      actionName,
      skill,
      body: deriveFindingBody(r),
      confidence: r.confidence,
    };
    const entry = byIssue.get(issueNumber);
    if (entry) {
      entry.findings.push(finding);
    } else {
      byIssue.set(issueNumber, {
        title: r.target_title,
        findings: [finding],
        firstSeen: r.created_at,
      });
    }
  }

  const items: DecisionItem[] = [];
  for (const [issueNumber, e] of byIssue) {
    items.push({
      kind: 'decision',
      id: `decision-${issueNumber}`,
      issueNumber,
      issueTitle: e.title,
      findings: e.findings,
    });
  }
  return items;
}

/**
 * Best-effort mapping from action name to a colored skill tag in the UI.
 * Unknown actions fall back to a generic tag.
 */
function actionNameToSkillTag(actionName: string): SkillTag {
  const n = actionName.toLowerCase();
  if (n.includes('dup')) return 'DUPLICATES';
  if (n.includes('log')) return 'LOG_ANALYZER';
  if (n.includes('semantic') || n.includes('search')) return 'SEMANTIC_SEARCH';
  if (n.includes('lint')) return 'LINT_MASTER';
  if (n.includes('bug')) return 'BUG_DETECTOR';
  if (n.includes('priority')) return 'PRIORITY';
  if (n.includes('label')) return 'AUTO_LABEL';
  return 'BUG_DETECTOR';
}

/**
 * Synthesise a FindingBody for the renderer from the raw effect + args.
 * The runner-side summary is plain text; we project it into one of the
 * shapes the renderer already knows about. For new/unknown effects we
 * fall back to a "bug"-shaped body since it just renders the summary.
 */
function deriveFindingBody(r: PendingRow): FindingBody {
  const args = (r.effect_args ?? {}) as Record<string, unknown>;
  switch (r.effect) {
    case 'link-duplicate': {
      const dup = Number(args.duplicateOf ?? args.dup ?? args.of);
      if (Number.isFinite(dup)) return { kind: 'dup', dupNumber: dup };
      break;
    }
    case 'set-priority': {
      const v = String(args.priority ?? 'P2');
      const value = (['P0', 'P1', 'P2', 'P3'] as const).includes(v as never) ? (v as 'P0') : 'P2';
      return { kind: 'priority', value, note: r.summary };
    }
    case 'label.add': {
      const label = typeof args.label === 'string' ? args.label : 'label';
      return { kind: 'label', labels: [label] };
    }
    case 'label.set': {
      const labels = Array.isArray(args.labels)
        ? (args.labels.filter((l) => typeof l === 'string') as string[])
        : [];
      return { kind: 'label', labels: labels.length > 0 ? labels : ['(none)'] };
    }
    case 'suggest-workflow': {
      // Args carry only { flowId, reason } — display the reason (cheap; no
      // flows join). The flow name shows up in the summary on accept.
      const reason =
        typeof args.reason === 'string' && args.reason.trim() ? args.reason : r.summary;
      return { kind: 'workflow', reason };
    }
  }
  return { kind: 'bug', note: r.summary };
}

/**
 * UUID → short numeric-ish hash for the inbox row label. workflow_runs has
 * UUID ids; we want a stable short string like "Run #1704" for display
 * parity with the mock. Use the last 4 hex chars as a base-16 number.
 */
function shortRunId(uuid: string): number {
  const tail = uuid.replace(/-/g, '').slice(-4);
  return parseInt(tail, 16);
}

function buildHealthAlerts(): { id: string; text: string; severity: 'warn' | 'error' }[] {
  const alerts: { id: string; text: string; severity: 'warn' | 'error' }[] = [];
  if (!process.env.GITHUB_APP_WEBHOOK_SECRET) {
    alerts.push({
      id: 'webhook-secret',
      text: 'GitHub App webhook secret not configured — events ignored',
      severity: 'warn',
    });
  }
  return alerts;
}
