import { describe, expect, it } from 'vitest';
import { DashboardCostSnapshots, projectCostTask } from './dashboard-costs.ts';

const now = Date.parse('2026-09-19T12:00:00Z');
const visibility = { tokens: true, cost: true };
const query = {
  period: 'all' as const,
  sort: 'cost' as const,
  offset: 0,
  limit: 20,
};
const row = (id: string, extra = {}) =>
  projectCostTask('p', {
    id,
    title: id,
    status: 'done',
    createdAt: new Date(now).toISOString(),
    ...extra,
  })!;
const coverage = {
  projects: [{ projectId: 'p', state: 'complete' as const, omittedRuns: 0 }],
};
const projects = [{ id: 'p', root: '/p' }];
describe('reported lifetime costs', () => {
  it('preserves measured zero, raw counters, archive/children and excludes invalid measures', () => {
    expect(row('zero', { steps: [{ costUsd: 0 }], tokensUsed: 999 })).toMatchObject({
      costUsd: 0,
    });
    expect(row('missing', { tokensUsed: 999 })).not.toHaveProperty('inputTokens');
    expect(row('positive', { costUsd: 2, steps: [{ costUsd: 0 }] }).costUsd).toBe(2);
    expect(row('historical', { steps: [{ costUsd: 1 }, { costUsd: 2 }] }).costUsd).toBe(3);
    expect(
      row('bad', { costUsd: -1, inputTokens: Infinity, outputTokens: -2 }),
    ).not.toHaveProperty('costUsd');
    const registry = new DashboardCostSnapshots(() => now);
    const result = registry.capture(
      [
        row('zero', { costUsd: 0, inputTokens: 3, archived: true }),
        row('child', { dispatch: { parentRunId: 'zero' }, outputTokens: 4 }),
        row('missing'),
      ],
      coverage,
      projects,
      query,
      visibility,
    );
    expect(result.totals).toEqual({
      tasks: 3,
      costUsd: { value: 0, reportedTasks: 1 },
      inputTokens: { value: 3, reportedTasks: 1 },
      outputTokens: { value: 4, reportedTasks: 1 },
    });
    expect(result.tasks.rows.find((r) => r.id === 'child')?.subtask).toBe(true);
  });
  it('captures every retained task once and fixes cohort, paging and current visibility', () => {
    const registry = new DashboardCostSnapshots(() => now);
    const rows = Array.from({ length: 240 }, (_, i) =>
      row(String(i).padStart(3, '0'), { costUsd: i, inputTokens: 240 - i }),
    );
    const first = registry.capture([...rows, rows[0]!], coverage, projects, query, visibility);
    expect(first.totals.tasks).toBe(240);
    expect(first.tasks.rows[0]?.id).toBe('239');
    rows[239]!.costUsd = 9999;
    const second = registry.read(
      { ...query, snapshotId: first.snapshotId, offset: 20 },
      visibility,
    )!;
    expect(second.tasks.rows[0]?.id).toBe('219');
    expect(second.totals.costUsd?.value).toBe(28680);
    for (const policy of [
      { tokens: true, cost: false },
      { tokens: false, cost: true },
      { tokens: false, cost: false },
    ]) {
      const result = registry.read({ ...query, snapshotId: first.snapshotId }, policy)!;
      expect('costUsd' in result.totals).toBe(policy.cost);
      expect('inputTokens' in result.tasks.rows[0]!).toBe(policy.tokens);
      expect('costUsd' in result.projects[0]!).toBe(policy.cost);
      expect(result.tasks.rows[0]?.id).toBe(policy.cost ? '239' : '000');
    }
    expect(
      registry.read({ ...query, period: '7d', snapshotId: first.snapshotId }, visibility),
    ).toBeUndefined();
  });
  it('filters detail rows without changing cohort totals and sorts missing reports last', () => {
    const registry = new DashboardCostSnapshots(() => now);
    const result = registry.capture(
      [
        row('unknown'),
        row('zero', { costUsd: 0 }),
        { ...row('other', { costUsd: 5 }), projectId: 'q' },
      ],
      coverage,
      projects,
      { ...query, projectId: 'p' },
      visibility,
    );
    expect(result.tasks.rows.map((row) => row.id)).toEqual(['zero', 'unknown']);
    expect(result.totals.tasks).toBe(3);
    expect(result.projects.map((project) => project.projectId)).toEqual(['q', 'p']);
    expect(result.totals.costUsd).toEqual({ value: 5, reportedTasks: 2 });
  });
  it('keeps invalid dates only in all time and includes the exact period boundary', () => {
    const registry = new DashboardCostSnapshots(() => now);
    const rows = [
      row('boundary', {
        createdAt: new Date(now - 6 * 86400000 - 12 * 3600000).toISOString(),
      }),
      row('old', { createdAt: new Date(now - 6 * 86400000 - 12 * 3600000 - 1).toISOString() }),
      row('future', { createdAt: new Date(now + 1).toISOString() }),
      row('invalid', { createdAt: 'bad' }),
    ];
    expect(registry.capture(rows, coverage, projects, query, visibility).totals.tasks).toBe(4);
    const dated = registry.capture(
      rows,
      coverage,
      projects,
      { ...query, period: '7d' },
      visibility,
    );
    expect(dated.totals.tasks).toBe(1);
    expect(dated.invalidDateTasks).toBe(1);
    expect(dated.totals.costUsd).toEqual({ value: null, reportedTasks: 0 });
  });
  it('invalidates deleted task snapshots but refreshes current source warnings', () => {
    const registry = new DashboardCostSnapshots(() => now);
    const first = registry.capture([row('a')], coverage, projects, query, visibility);
    const current = {
      projects: [{ projectId: 'p', state: 'partial' as const, omittedRuns: 1 }],
    };
    registry.reconcileRows([row('a')], current);
    expect(
      registry.read({ ...query, snapshotId: first.snapshotId }, visibility)?.coverage,
    ).toEqual(current);
    registry.reconcileRows([], current);
    expect(
      registry.read({ ...query, snapshotId: first.snapshotId }, visibility),
    ).toBeUndefined();
  });
  it('has no series for all time, and buckets 7d by local day with cost gating and done-only cycle time', () => {
    const registry = new DashboardCostSnapshots(() => now);
    const allTime = registry.capture([row('a')], coverage, projects, query, visibility);
    expect(allTime.series).toEqual([]);
    const day = 86400000;
    const rows = [
      row('today-done', {
        createdAt: new Date(now).toISOString(),
        startedAt: new Date(now - 3600000).toISOString(),
        finishedAt: new Date(now).toISOString(),
        status: 'done',
        costUsd: 1,
      }),
      row('today-running', {
        createdAt: new Date(now).toISOString(),
        status: 'running',
        costUsd: 2,
      }),
      row('yesterday-done', {
        createdAt: new Date(now - day).toISOString(),
        startedAt: new Date(now - day - 2 * 3600000).toISOString(),
        finishedAt: new Date(now - day).toISOString(),
        status: 'done',
      }),
    ];
    const result = registry.capture(
      rows,
      coverage,
      projects,
      { ...query, period: '7d' },
      visibility,
    );
    expect(result.series).toHaveLength(7);
    expect(result.series.at(-1)).toMatchObject({
      date: new Date(now).toISOString().slice(0, 10),
      tasks: 2,
      completed: 1,
      avgCycleHours: 1,
      medianCycleHours: 1,
      costUsd: { value: 3, reportedTasks: 2 },
    });
    expect(result.series.at(-2)).toMatchObject({
      date: new Date(now - day).toISOString().slice(0, 10),
      tasks: 1,
      completed: 1,
      avgCycleHours: 2,
    });
    expect(result.series[0]).toMatchObject({ tasks: 0, completed: 0, avgCycleHours: null });
    const hidden = registry.capture(
      rows,
      coverage,
      projects,
      { ...query, period: '7d' },
      { tokens: true, cost: false },
    );
    expect(hidden.series.at(-1)).not.toHaveProperty('costUsd');
    expect(hidden.series.at(-1)).toMatchObject({ completed: 1, avgCycleHours: 1 });
    const shifted = registry.capture(
      rows,
      coverage,
      projects,
      { ...query, period: '7d', tzOffsetMinutes: -720 },
      visibility,
    );
    expect(shifted.series.at(-1)?.tasks).toBe(2);
    expect(shifted.tzOffsetMinutes).toBe(-720);
    expect(registry.read({ ...query, period: '7d', snapshotId: shifted.snapshotId, tzOffsetMinutes: 0 }, visibility)?.tzOffsetMinutes).toBe(-720);
  });
  it('bounds snapshot lifetime and count and invalidates removed or replaced projects', () => {
    let clock = now;
    const registry = new DashboardCostSnapshots(() => clock);
    const create = () => registry.capture([row('a')], coverage, projects, query, visibility);
    const first = create();
    create();
    create();
    create();
    expect(
      registry.read({ ...query, snapshotId: first.snapshotId }, visibility),
    ).toBeUndefined();
    const latest = create();
    clock += 60000;
    expect(
      registry.read({ ...query, snapshotId: latest.snapshotId }, visibility),
    ).toBeUndefined();
    const replaced = create();
    registry.reconcile([{ id: 'p', root: '/different' }]);
    expect(
      registry.read({ ...query, snapshotId: replaced.snapshotId }, visibility),
    ).toBeUndefined();
  });
});

it('separates finish cohorts, aligns totals, and ignores invalid durations', () => {
  const rows = [
    row('old', {
      createdAt: '2026-09-01T00:00:00Z',
      startedAt: 'bad',
      finishedAt: '2026-09-19T10:00:00Z',
      costUsd: 99,
    }),
    row('cross', {
      createdAt: '2026-09-18T00:00:00Z',
      startedAt: '2026-09-18T10:00:00Z',
      finishedAt: '2026-09-19T10:00:00Z',
      costUsd: 30,
    }),
    row('edge', { createdAt: '2026-09-12T18:00:00Z', costUsd: 50 }),
  ];
  const result = new DashboardCostSnapshots(() => now).capture(
    rows,
    coverage,
    projects,
    { ...query, period: '7d' },
    visibility,
  );
  expect(result.totals.costUsd?.value).toBe(30);
  expect(result.series.reduce((n, p) => n + (p.costUsd?.value ?? 0), 0)).toBe(30);
  expect(result.series.at(-1)).toMatchObject({
    completed: 2,
    cycleReportedTasks: 1,
    avgCycleHours: 24,
  });
  expect(result.series.at(-2)?.completed).toBe(0);
});


it('keeps incomplete captured coverage after recovery while a fresh snapshot includes recovered tasks', () => {
  const registry = new DashboardCostSnapshots(() => now);
  const incomplete = { projects: [{ projectId: 'p', state: 'unavailable' as const, omittedRuns: 2, reason: 'Unreadable index' }] };
  const first = registry.capture([], incomplete, projects, query, visibility);
  registry.reconcileRows([row('recovered', { costUsd: 42 })], coverage);
  const retained = registry.read({ ...query, snapshotId: first.snapshotId }, visibility)!;
  expect(retained.coverage).toEqual(incomplete);
  expect(retained.totals.tasks).toBe(0);
  expect(retained.asOf).toBe(first.asOf);
  expect(registry.capture([row('recovered', { costUsd: 42 })], coverage, projects, query, visibility).totals.tasks).toBe(1);
});


it('excludes an explicitly empty start from cycle time while absent starts use creation time', () => {
  const result = new DashboardCostSnapshots(() => now).capture(
    [
      row('invalid-start', { createdAt: '2026-09-19T00:00:00Z', startedAt: '', finishedAt: '2026-09-19T12:00:00Z' }),
      row('absent-start', { createdAt: '2026-09-19T10:00:00Z', finishedAt: '2026-09-19T12:00:00Z' }),
    ],
    coverage,
    projects,
    { ...query, period: '7d' },
    visibility,
  );
  expect(result.series.at(-1)).toMatchObject({
    completed: 2,
    cycleReportedTasks: 1,
    avgCycleHours: 2,
    medianCycleHours: 2,
  });
});
