import { dashboardOverviewTaskSchema } from '@open-mercato/cezar-contract';
import type {
  DashboardOverview,
  DashboardOverviewQuery,
  DashboardSnapshot,
  DashboardTaskRow,
} from '@open-mercato/cezar-contract';

/** Current workload plus finish-date outcomes; neither task count nor done implies business acceptance. */
export function buildDashboardOverview(
  rows: DashboardTaskRow[],
  snapshot: DashboardSnapshot,
  query: DashboardOverviewQuery,
): DashboardOverview {
  const at = Date.parse(snapshot.asOf);
  const offset = query.tzOffsetMinutes * 60000;
  const start =
    Math.floor((at - offset) / 86400000) * 86400000 +
    offset -
    (query.period === '7d' ? 6 : 29) * 86400000;
  const selected = (row: DashboardTaskRow, group: DashboardOverviewQuery['group']) => {
    if (group === 'running') return !row.archived && row.status === 'running';
    if (group === 'needs-you')
      return !row.archived && (row.status === 'waiting' || row.status === 'review');
    const finished = Date.parse(row.finishedAt ?? '');
    return (
      row.status === (group === 'completed' ? 'done' : 'failed') &&
      !row.autoResumeAt &&
      finished >= start &&
      finished <= at
    );
  };
  const metrics = (tasks: DashboardTaskRow[]) => {
    const completed = tasks.filter((row) => selected(row, 'completed'));
    const durations = completed
      .flatMap((row) => {
        const hours =
          (Date.parse(row.finishedAt!) - Date.parse(row.startedAt ?? row.createdAt)) / 3600000;
        return Number.isFinite(hours) && hours >= 0 ? [hours] : [];
      })
      .sort((a, b) => a - b);
    const middle = Math.floor(durations.length / 2);
    return {
      running: tasks.filter((row) => selected(row, 'running')).length,
      needsYou: tasks.filter((row) => selected(row, 'needs-you')).length,
      completed: completed.length,
      failed: tasks.filter((row) => selected(row, 'failed')).length,
      timedTasks: durations.length,
      medianCycleHours: durations.length
        ? durations.length % 2
          ? durations[middle]!
          : (durations[middle - 1]! + durations[middle]!) / 2
        : null,
    };
  };
  const details = rows
    .filter(
      (row) =>
        (!query.projectId || row.projectId === query.projectId) && selected(row, query.group),
    )
    .sort((a, b) => {
      if (query.group === 'running' || query.group === 'needs-you')
        return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
      return (b.finishedAt ?? '').localeCompare(a.finishedAt ?? '') || a.id.localeCompare(b.id);
    });
  return {
    snapshotId: snapshot.snapshotId,
    asOf: snapshot.asOf,
    windowStart: new Date(start).toISOString(),
    period: query.period,
    coverage: snapshot.coverage,
    metrics: metrics(rows),
    projects: snapshot.coverage.projects
      .map((project) => ({
        projectId: project.projectId,
        ...metrics(rows.filter((row) => row.projectId === project.projectId)),
      }))
      .sort(
        (a, b) =>
          b.needsYou - a.needsYou ||
          b.running - a.running ||
          a.projectId.localeCompare(b.projectId),
      ),
    page: {
      rows: details
        .slice(query.offset, query.offset + query.limit)
        .map((row) => dashboardOverviewTaskSchema.parse(row)),
      total: details.length,
      nextOffset:
        query.offset + query.limit < details.length ? query.offset + query.limit : null,
    },
  };
}
