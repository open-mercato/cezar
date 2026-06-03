import { createSupabaseServerClient } from '@/lib/supabase/server';

export interface WeekBucket {
  week: string;
  opened: number;
  closed: number;
}

export interface RunOutcomeBucket {
  status: string;
  count: number;
}

export interface CostEntry {
  runId: string;
  workflow: string;
  issueNumber: number | null;
  tokensUsed: number;
  status: string;
  createdAt: string;
}

export interface DistributionEntry {
  label: string;
  count: number;
}

export interface AnalyticsData {
  velocity: WeekBucket[];
  runOutcomes: RunOutcomeBucket[];
  costs: CostEntry[];
  totalTokens: number;
  priorityDist: DistributionEntry[];
  typeDist: DistributionEntry[];
  labelDist: DistributionEntry[];
}

export async function loadAnalytics(workspaceId: string): Promise<AnalyticsData | null> {
  try {
    const supabase = await createSupabaseServerClient();

    // Velocity only needs the last 12 weeks; cap the runs fetch so the page
    // stays O(recent activity) instead of O(workspace history).
    const since = new Date(Date.now() - 12 * 7 * 24 * 60 * 60 * 1000).toISOString();

    const [{ data: issues }, { data: runs }] = await Promise.all([
      supabase.from('issues').select('number, state, labels, analysis, created_at').eq('workspace_id', workspaceId).gte('created_at', since),
      supabase.from('workflow_runs').select('id, workflow, issue_number, status, tokens_used, started_at').eq('workspace_id', workspaceId).order('started_at', { ascending: false }).limit(200),
    ]);

    const allIssues = issues ?? [];
    const allRuns = runs ?? [];

    // Velocity: issues opened per week (last 12 weeks)
    const velocity = buildVelocity(allIssues);

    // Run outcomes
    const outcomeCounts = new Map<string, number>();
    for (const r of allRuns) {
      outcomeCounts.set(r.status, (outcomeCounts.get(r.status) ?? 0) + 1);
    }
    const runOutcomes = [...outcomeCounts.entries()].map(([status, count]) => ({ status, count }));

    // Cost tracking
    const costs: CostEntry[] = allRuns.map((r) => ({
      runId: r.id,
      workflow: r.workflow,
      issueNumber: r.issue_number,
      tokensUsed: r.tokens_used ?? 0,
      status: r.status,
      createdAt: r.started_at ?? '',
    }));
    const totalTokens = costs.reduce((s, c) => s + c.tokensUsed, 0);

    // Priority distribution
    const priCounts = new Map<string, number>();
    for (const i of allIssues) {
      const pri = (i.analysis as any)?.priority;
      if (pri) priCounts.set(pri, (priCounts.get(pri) ?? 0) + 1);
    }
    const priorityDist = [...priCounts.entries()].map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);

    // Type distribution
    const typeCounts = new Map<string, number>();
    for (const i of allIssues) {
      const t = (i.analysis as any)?.issueType;
      if (t) typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
    }
    const typeDist = [...typeCounts.entries()].map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);

    // Top labels
    const labelCounts = new Map<string, number>();
    for (const i of allIssues) {
      for (const l of (i.labels as string[]) ?? []) {
        labelCounts.set(l, (labelCounts.get(l) ?? 0) + 1);
      }
    }
    const labelDist = [...labelCounts.entries()].map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12);

    return { velocity, runOutcomes, costs, totalTokens, priorityDist, typeDist, labelDist };
  } catch (err) {
    console.error('loadAnalytics failed', err);
    return null;
  }
}

function buildVelocity(issues: Array<{ state: string; created_at: string }>): WeekBucket[] {
  const weeks = 12;
  const now = Date.now();
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  const buckets: WeekBucket[] = [];

  for (let i = weeks - 1; i >= 0; i--) {
    const start = now - (i + 1) * msPerWeek;
    const end = now - i * msPerWeek;
    const weekLabel = new Date(start).toISOString().slice(5, 10);
    const opened = issues.filter((is) => {
      const t = new Date(is.created_at).getTime();
      return t >= start && t < end;
    }).length;
    buckets.push({ week: weekLabel, opened, closed: 0 });
  }

  return buckets;
}
