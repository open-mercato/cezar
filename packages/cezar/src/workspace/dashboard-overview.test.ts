import { expect, it } from 'vitest';
import {
  dashboardOverviewQuerySchema,
  dashboardOverviewSchema,
  type DashboardSnapshot,
  type DashboardTaskRow,
} from '@open-mercato/cezar-contract';
import { buildDashboardOverview } from './dashboard-overview.ts';
const at = '2026-09-19T12:00:00.000Z';
const snapshot: DashboardSnapshot = {
  snapshotId: 's',
  asOf: at,
  expiresAt: '2026-09-19T12:01:00.000Z',
  coverage: {
    projects: [
      { projectId: 'a', state: 'complete', omittedRuns: 0 },
      { projectId: 'b', state: 'unavailable', omittedRuns: 0 },
    ],
  },
  counts: { running: 0, monitoring: 0, questions: 0, reviews: 0, queued: 0, scheduled: 0 },
  questions: { rows: [], total: 0, nextOffset: null },
  reviews: { rows: [], total: 0, nextOffset: null },
};
const row = (id: string, extra: Partial<DashboardTaskRow> = {}): DashboardTaskRow => ({
  id,
  projectId: 'a',
  title: id,
  workflow: 'test',
  archived: false,
  status: 'done',
  createdAt: '2026-09-01T00:00:00Z',
  finishedAt: at,
  ...extra,
});
it('uses finish dates for outcomes, excludes scheduled retries and preserves current attention', () => {
  const rows = [
    row('old-created', { startedAt: '2026-09-19T10:00:00Z' }),
    row('bad-clock', { startedAt: 'bad' }),
    row('failed', { status: 'failed' }),
    row('retry', { status: 'failed', autoResumeAt: at }),
    row('waiting', { status: 'waiting', finishedAt: undefined }),
    row('archived-waiting', { status: 'waiting', archived: true }),
    row('running', { status: 'running', finishedAt: undefined }),
  ];
  const result = buildDashboardOverview(rows, snapshot, dashboardOverviewQuerySchema.parse({}));
  dashboardOverviewSchema.parse(result);
  expect(result.metrics).toEqual({
    running: 1,
    needsYou: 1,
    completed: 2,
    failed: 1,
    timedTasks: 1,
    medianCycleHours: 2,
  });
  expect(result.page.rows.map((r) => r.id)).toEqual(['bad-clock', 'old-created']);
  expect(result.projects[1]?.projectId).toBe('b');
});
it('details match project/group counts and paginate without changing totals', () => {
  const rows = Array.from({ length: 25 }, (_, i) => row(String(i).padStart(2, '0')));
  const result = buildDashboardOverview(
    rows,
    snapshot,
    dashboardOverviewQuerySchema.parse({ offset: 20, projectId: 'a' }),
  );
  expect(result.metrics.completed).toBe(25);
  expect(result.page.total).toBe(25);
  expect(result.page.rows).toHaveLength(5);
  expect(result.page.nextOffset).toBeNull();
  expect(
    buildDashboardOverview(
      rows,
      snapshot,
      dashboardOverviewQuerySchema.parse({ projectId: 'b' }),
    ).page.total,
  ).toBe(0);
});

it('orders outcomes by parsed finish time with deterministic cross-project ties', () => {
  const rows = [
    row('second', { finishedAt: '2026-09-19T11:00:00Z' }),
    row('fraction', { finishedAt: '2026-09-19T11:00:00.500Z' }),
    row('offset', { finishedAt: '2026-09-19T12:00:00+02:00' }),
    row('same', { projectId: 'b', finishedAt: '2026-09-19T11:30:00Z' }),
    row('same', { projectId: 'a', finishedAt: '2026-09-19T11:30:00.000Z' }),
    row('invalid', { finishedAt: 'bad' }),
  ];
  const result = buildDashboardOverview(rows, snapshot, dashboardOverviewQuerySchema.parse({}));
  expect(result.page.rows.map((r) => [r.projectId, r.id])).toEqual([
    ['a', 'same'], ['b', 'same'], ['a', 'fraction'], ['a', 'second'], ['a', 'offset'],
  ]);
});
it('orders current workload by parsed creation time and places invalid dates last', () => {
  const rows = [
    row('fraction', { status: 'running', createdAt: '2026-09-19T11:00:00.500Z' }),
    row('second', { status: 'running', createdAt: '2026-09-19T11:00:00Z' }),
    row('offset', { status: 'running', createdAt: '2026-09-19T12:00:00+02:00' }),
    row('invalid', { status: 'running', createdAt: '' }),
    row('same', { status: 'running', projectId: 'b', createdAt: '2026-09-19T11:30:00Z' }),
    row('same', { status: 'running', projectId: 'a', createdAt: '2026-09-19T11:30:00.000Z' }),
  ];
  const result = buildDashboardOverview(rows, snapshot, dashboardOverviewQuerySchema.parse({ group: 'running' }));
  expect(result.page.rows.map((r) => [r.projectId, r.id])).toEqual([
    ['a', 'offset'], ['a', 'second'], ['a', 'fraction'],
    ['a', 'same'], ['b', 'same'], ['a', 'invalid'],
  ]);
});
