import { getActiveWorkspace } from '@/lib/workspace';
import { PageContainer } from '@/components/ui/page-container';
import { loadAnalytics } from './load-analytics';
import type { WeekBucket, DistributionEntry } from './load-analytics';

export default async function AnalyticsPage() {
  const workspace = await getActiveWorkspace();
  if (!workspace) {
    return (
      <PageContainer>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Analytics</h1>
        <p className="mt-2 text-sm text-fg-muted">No workspace selected.</p>
      </PageContainer>
    );
  }

  const data = await loadAnalytics(workspace.id);
  if (!data) {
    return (
      <PageContainer>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Analytics</h1>
        <p className="mt-2 text-sm text-fg-muted">Failed to load analytics.</p>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <header className="mb-8 border-b border-border pb-5">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Analytics</h1>
        <p className="mt-1 text-sm text-fg-muted">
          {workspace.repoOwner}/{workspace.repoName}
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Issue Velocity (12 weeks)">
          <VelocityChart buckets={data.velocity} />
        </Card>

        <Card title="Workflow-run Outcomes">
          {data.runOutcomes.length > 0 ? (
            <HBar entries={data.runOutcomes.map((r) => ({ label: r.status, count: r.count }))} />
          ) : (
            <Empty>No workflow runs yet</Empty>
          )}
        </Card>

        <Card title="Priority Distribution">
          {data.priorityDist.length > 0 ? (
            <HBar entries={data.priorityDist} colorMap={PRIORITY_COLORS} />
          ) : (
            <Empty>Run priority action first</Empty>
          )}
        </Card>

        <Card title="Issue Type Distribution">
          {data.typeDist.length > 0 ? (
            <HBar entries={data.typeDist} colorMap={TYPE_COLORS} />
          ) : (
            <Empty>Run bug-detector first</Empty>
          )}
        </Card>

        <Card title="Top Labels">
          {data.labelDist.length > 0 ? (
            <HBar entries={data.labelDist} />
          ) : (
            <Empty>No labels yet</Empty>
          )}
        </Card>

        <Card title="Agent Cost Tracking">
          <div className="mb-3 flex items-baseline gap-2">
            <span className="text-lg font-semibold text-fg">
              {data.totalTokens.toLocaleString()}
            </span>
            <span className="text-xs text-fg-subtle">
              total tokens across {data.costs.length} runs
            </span>
          </div>
          {data.costs.length > 0 ? (
            <div className="max-h-48 space-y-1 overflow-y-auto">
              {data.costs.slice(0, 20).map((c) => (
                <div key={c.runId} className="flex items-center justify-between text-xs">
                  <span className="text-fg-muted">
                    {c.workflow} {c.issueNumber != null ? `#${c.issueNumber}` : ''}
                  </span>
                  <span className="text-fg-subtle">{c.tokensUsed.toLocaleString()} tokens</span>
                  <StatusDot status={c.status} />
                </div>
              ))}
            </div>
          ) : (
            <Empty>No runs yet</Empty>
          )}
        </Card>
      </div>
    </PageContainer>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-bg-elevated p-5">
      <h3 className="mb-4 text-xs font-medium uppercase tracking-wider text-fg-subtle">{title}</h3>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="py-4 text-center text-xs text-fg-subtle">{children}</div>;
}

function VelocityChart({ buckets }: { buckets: WeekBucket[] }) {
  const max = Math.max(1, ...buckets.map((b) => b.opened));
  return (
    <div className="flex items-end gap-1" style={{ height: 120 }}>
      {buckets.map((b) => (
        <div key={b.week} className="flex min-w-0 flex-1 flex-col items-center gap-1">
          <div
            className="w-full rounded-sm bg-accent transition-all"
            style={{ height: `${Math.max(2, (b.opened / max) * 100)}px` }}
            title={`${b.week}: ${b.opened} opened`}
          />
          <span className="truncate text-[10px] text-fg-subtle sm:text-[9px]">{b.week}</span>
        </div>
      ))}
    </div>
  );
}

const PRIORITY_COLORS: Record<string, string> = {
  critical: 'bg-danger',
  high: 'bg-orange-500',
  medium: 'bg-yellow-500',
  low: 'bg-fg-subtle',
};

const TYPE_COLORS: Record<string, string> = {
  bug: 'bg-danger',
  feature: 'bg-accent',
  question: 'bg-yellow-500',
  other: 'bg-fg-subtle',
};

function HBar({
  entries,
  colorMap,
}: {
  entries: DistributionEntry[];
  colorMap?: Record<string, string>;
}) {
  const max = Math.max(1, ...entries.map((e) => e.count));
  return (
    <div className="space-y-2">
      {entries.map((e) => (
        <div key={e.label} className="flex items-center gap-3">
          <span className="w-20 truncate text-right text-xs text-fg-muted sm:w-24">{e.label}</span>
          <div className="flex-1">
            <div
              className={`h-4 rounded-sm ${colorMap?.[e.label] ?? 'bg-accent/70'} transition-all`}
              style={{ width: `${(e.count / max) * 100}%` }}
            />
          </div>
          <span className="w-8 text-right text-xs text-fg-subtle">{e.count}</span>
        </div>
      ))}
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === 'pr-opened' || status === 'succeeded'
      ? 'bg-accent'
      : status === 'failed'
        ? 'bg-danger'
        : 'bg-fg-subtle';
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} title={status} />;
}
