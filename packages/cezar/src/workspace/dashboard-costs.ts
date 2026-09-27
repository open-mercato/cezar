import { randomUUID } from 'node:crypto';
import type {
  DashboardCostSeriesPoint,
  DashboardCostTask,
  DashboardCostTotals,
  DashboardCostVisibility,
  DashboardCosts,
  DashboardCostsQuery,
  DashboardCoverage,
} from '@open-mercato/cezar-contract';

export type CostVisibility = DashboardCostVisibility;
type Project = { id: string; root: string };
type Snapshot = {
  id: string;
  at: number;
  tzOffsetMinutes: number;
  period: DashboardCostsQuery['period'];
  windowStart: number | null;
  rows: DashboardCostTask[];
  completionRows: DashboardCostTask[];
  coverage: DashboardCoverage;
  projects: Project[];
  invalidDateTasks: number;
};
const measure = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
/** Explicit allowlist: never expose prompts, weighted counters or step payloads. */
export function projectCostTask(
  projectId: string,
  run: {
    id: string;
    title: string;
    status: DashboardCostTask['status'];
    createdAt: string;
    startedAt?: string;
    finishedAt?: string;
    archived?: boolean;
    dispatch?: { parentRunId?: string };
    inputTokens?: unknown;
    outputTokens?: unknown;
    costUsd?: unknown;
    steps?: Array<{ costUsd?: unknown }>;
  },
): DashboardCostTask {
  let costUsd = run.costUsd;
  if (costUsd === undefined) {
    const reported = (run.steps ?? []).map((s) => s.costUsd).filter(measure);
    if (reported.length) costUsd = reported.reduce((sum, cost) => sum + cost, 0);
  }
  return {
    projectId,
    id: run.id,
    title: run.title,
    status: run.status,
    createdAt: run.createdAt,
    ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
    ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
    archived: run.archived ?? false,
    subtask: Boolean(run.dispatch?.parentRunId),
    ...(measure(run.inputTokens) ? { inputTokens: run.inputTokens } : {}),
    ...(measure(run.outputTokens) ? { outputTokens: run.outputTokens } : {}),
    ...(measure(costUsd) ? { costUsd } : {}),
  };
}
function totals(rows: DashboardCostTask[], visibility: CostVisibility): DashboardCostTotals {
  const result: DashboardCostTotals = { tasks: rows.length };
  for (const key of ['costUsd', 'inputTokens', 'outputTokens'] as const) {
    if (!(key === 'costUsd' ? visibility.cost : visibility.tokens)) continue;
    const values = rows.flatMap((row) => (measure(row[key]) ? [row[key]!] : []));
    const sum = values.reduce((a, b) => a + b, 0);
    result[key] = {
      value: values.length && Number.isFinite(sum) ? sum : null,
      reportedTasks: values.length,
    };
  }
  return result;
}
const identity = (a: DashboardCostTask, b: DashboardCostTask) =>
  a.projectId.localeCompare(b.projectId) || a.id.localeCompare(b.id);
const compare = (a: number | null | undefined, b: number | null | undefined) =>
  a == null ? (b == null ? 0 : 1) : b == null ? -1 : b - a;
/** `tzOffsetMinutes` is `Date.prototype.getTimezoneOffset()`: UTC minus local, in minutes. */
const dayKey = (at: number, tzOffsetMinutes: number) =>
  new Date(at - tzOffsetMinutes * 60000).toISOString().slice(0, 10);
const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
/** One point per day of the period, oldest first, even for days with no tasks — a continuous
 *  trend line needs the gaps. `all` has no fixed window, so it has no series. Cycle time only
 *  ever looks at `done` tasks that actually finished that day. */
function buildSeries(
  snapshot: Snapshot,
  visibility: CostVisibility,
  tzOffsetMinutes: number,
): DashboardCostSeriesPoint[] {
  if (snapshot.period === 'all' || snapshot.windowStart === null) return [];
  const days = snapshot.period === '7d' ? 7 : 30;
  const buckets = new Map<string, DashboardCostTask[]>();
  for (const row of snapshot.rows) {
    const key = dayKey(Date.parse(row.createdAt), tzOffsetMinutes);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else buckets.set(key, [row]);
  }
  const points: DashboardCostSeriesPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = dayKey(snapshot.at - i * 86400000, tzOffsetMinutes);
    const rows = buckets.get(key) ?? [];
    const done = snapshot.completionRows.filter(
      (row) =>
        dayKey(Date.parse(row.finishedAt!), tzOffsetMinutes) === key &&
        row.status === 'done' &&
        row.finishedAt !== undefined &&
        Number.isFinite(Date.parse(row.finishedAt)),
    );
    const cycleHours = done.flatMap((row) => {
      const start = Date.parse(row.startedAt ?? row.createdAt);
      const end = Date.parse(row.finishedAt!);
      return Number.isFinite(start) && end >= start ? [(end - start) / 3600000] : [];
    });
    points.push({
      date: key,
      completed: done.length,
      cycleReportedTasks: cycleHours.length,
      avgCycleHours: cycleHours.length
        ? cycleHours.reduce((a, b) => a + b, 0) / cycleHours.length
        : null,
      medianCycleHours: median(cycleHours),
      ...totals(rows, visibility),
    });
  }
  return points;
}

/** Bounded immutable cohorts. No timer: demand and project lifecycle perform all eviction. */
export class DashboardCostSnapshots {
  private saved: Snapshot[] = [];
  constructor(private readonly now: () => number = Date.now) {}
  clear(): void {
    this.saved = [];
  }
  invalidateProject(id: string): void {
    this.saved = this.saved.filter((s) => !s.projects.some((p) => p.id === id));
  }
  reconcile(projects: Project[]): void {
    const roots = new Map(projects.map((p) => [p.id, p.root]));
    this.saved = this.saved.filter(
      (s) => s.at + 60_000 > this.now() && s.projects.every((p) => roots.get(p.id) === p.root),
    );
  }
  reconcileRows(rows: DashboardCostTask[], coverage: DashboardCoverage): void {
    const retained = new Set(rows.map((row) => JSON.stringify([row.projectId, row.id])));
    const unavailable = new Set(
      coverage.projects.filter((p) => p.state === 'unavailable').map((p) => p.projectId),
    );
    this.saved = this.saved.filter((s) =>
      [...s.rows, ...s.completionRows].every(
        (row) =>
          unavailable.has(row.projectId) ||
          retained.has(JSON.stringify([row.projectId, row.id])),
      ),
    );
    // Captured rows never gain recovered data. Qualifications may become stricter,
    // but only a fresh capture can claim better coverage or include newly registered projects.
    const severity = { complete: 0, partial: 1, unavailable: 2 };
    for (const snapshot of this.saved) {
      const currentCoverage = new Map(coverage.projects.map((p) => [p.projectId, p]));
      snapshot.coverage = {
        projects: snapshot.coverage.projects.map((old) => {
          const current = currentCoverage.get(old.projectId);
          if (!current) return { ...old };
          const qualified = severity[old.state] > severity[current.state] ? old : current;
          return { ...qualified, omittedRuns: Math.max(old.omittedRuns, current.omittedRuns) };
        }),
      };
    }
  }
  capture(
    rows: DashboardCostTask[],
    coverage: DashboardCoverage,
    projects: Project[],
    query: DashboardCostsQuery,
    visibility: CostVisibility,
  ): DashboardCosts {
    const at = this.now();
    const offset = (query.tzOffsetMinutes ?? 0) * 60000;
    const windowStart =
      query.period === 'all'
        ? null
        : Math.floor((at - offset) / 86400000) * 86400000 +
          offset -
          ((query.period === '7d' ? 7 : 30) - 1) * 86400000;
    const unique = [
      ...new Map(rows.map((row) => [JSON.stringify([row.projectId, row.id]), row])).values(),
    ];
    const snapshot: Snapshot = {
      id: randomUUID(),
      at,
      tzOffsetMinutes: query.tzOffsetMinutes ?? 0,
      period: query.period,
      windowStart,
      completionRows: structuredClone(
        unique.filter(
          (row) =>
            row.status === 'done' &&
            row.finishedAt &&
            Number.isFinite(Date.parse(row.finishedAt)) &&
            (windowStart === null || Date.parse(row.finishedAt) >= windowStart) &&
            Date.parse(row.finishedAt) <= at,
        ),
      ),
      rows: structuredClone(
        unique.filter(
          (row) =>
            windowStart === null ||
            (Date.parse(row.createdAt) >= windowStart && Date.parse(row.createdAt) <= at),
        ),
      ),
      coverage: structuredClone(coverage),
      projects: projects.map(({ id, root }) => ({ id, root })),
      invalidDateTasks: unique.filter((row) => !Number.isFinite(Date.parse(row.createdAt)))
        .length,
    };
    this.saved.push(snapshot);
    while (this.saved.length > 3) this.saved.shift();
    return this.response(snapshot, query, visibility);
  }
  read(query: DashboardCostsQuery, visibility: CostVisibility): DashboardCosts | undefined {
    const snapshot = this.saved.find(
      (s) =>
        s.id === query.snapshotId && s.period === query.period && s.at + 60_000 > this.now(),
    );
    return snapshot ? this.response(snapshot, query, visibility) : undefined;
  }
  private response(
    snapshot: Snapshot,
    query: DashboardCostsQuery,
    visibility: CostVisibility,
  ): DashboardCosts {
    const sort =
      !visibility.cost && visibility.tokens
        ? query.sort === 'cost'
          ? 'input'
          : query.sort
        : !visibility.tokens
          ? 'cost'
          : query.sort;
    const key = sort === 'cost' ? 'costUsd' : sort === 'input' ? 'inputTokens' : 'outputTokens';
    const visible = visibility.cost || visibility.tokens;
    const projects = [...new Set(snapshot.rows.map((r) => r.projectId))].map((projectId) => ({
      projectId,
      ...totals(
        snapshot.rows.filter((r) => r.projectId === projectId),
        visibility,
      ),
    }));
    projects.sort(
      (a, b) =>
        (visible ? compare(a[key]?.value, b[key]?.value) : 0) ||
        a.projectId.localeCompare(b.projectId),
    );
    const rows = snapshot.rows
      .filter((r) => !query.projectId || r.projectId === query.projectId)
      .sort((a, b) => (visible ? compare(a[key], b[key]) : 0) || identity(a, b));
    return {
      snapshotId: snapshot.id,
      asOf: new Date(snapshot.at).toISOString(),
      expiresAt: new Date(snapshot.at + 60_000).toISOString(),
      scope: 'retained-task-lifetime',
      period: snapshot.period,
      tzOffsetMinutes: snapshot.tzOffsetMinutes,
      windowStart:
        snapshot.windowStart === null ? null : new Date(snapshot.windowStart).toISOString(),
      sort,
      visibility: { ...visibility },
      coverage: structuredClone(snapshot.coverage),
      invalidDateTasks: snapshot.invalidDateTasks,
      totals: totals(snapshot.rows, visibility),
      series: buildSeries(snapshot, visibility, snapshot.tzOffsetMinutes),
      projects,
      tasks: {
        total: rows.length,
        nextOffset:
          query.offset + query.limit < rows.length ? query.offset + query.limit : null,
        rows: rows.slice(query.offset, query.offset + query.limit).map((row) => {
          const { costUsd, inputTokens, outputTokens, ...base } = row;
          return {
            ...base,
            ...(visibility.cost && costUsd !== undefined ? { costUsd } : {}),
            ...(visibility.tokens && inputTokens !== undefined ? { inputTokens } : {}),
            ...(visibility.tokens && outputTokens !== undefined ? { outputTokens } : {}),
          };
        }),
      },
    };
  }
}
