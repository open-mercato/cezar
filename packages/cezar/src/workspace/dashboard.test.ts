import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import * as usage from '../core/process-usage.ts';
import { DashboardReader } from './dashboard.ts';

const roots: string[] = [];
const root = () => {
  const p = mkdtempSync(join(tmpdir(), 'cez-dashboard-'));
  roots.push(p);
  return p;
};
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
const record = (id: string, status = 'waiting') => ({
  id,
  title: id,
  workflow: 'build',
  task: 't',
  status,
  createdAt: '2026-09-01T00:00:00Z',
  tokensUsed: 0,
  archived: false,
  steps: [],
});
function disk(p: string, value: unknown) {
  mkdirSync(join(p, '.ai/cezar'), { recursive: true });
  writeFileSync(join(p, '.ai/cezar/runs.json'), JSON.stringify(value));
}

describe('dashboard complete summary snapshots', () => {
  it('orders mixed timestamp precision numerically before applying the feed cap', async () => {
    const p = root();
    const now = Date.parse('2026-09-18T12:01:00Z');
    disk(p, [{ ...record('newer', 'done'), finishedAt: '2026-09-18T12:00:00.500Z' }]);
    const github = async () => ({
      rows: Array.from({ length: 60 }, (_, i) => ({
        kind: 'github-created' as const,
        key: `github:github.com/o/r:issue:${i + 1}`,
        at: '2026-09-18T12:00:00Z',
        repo: 'github.com/o/r',
        projectIds: ['p'],
        itemKind: 'issue' as const,
        number: i + 1,
        title: 'older',
        url: `https://github.com/o/r/issues/${i + 1}`,
      })),
      sources: [{ key: 'github:github.com/o/r:issue', state: 'ready' as const, truncated: false }],
    });
    const reader = new DashboardReader({
      projects: async () => [{ id: 'p', root: p }],
      now: () => now,
      github,
    });
    const feed = await reader.feed('all');
    expect(feed.rows).toHaveLength(60);
    expect(feed.rows[0]?.key).toBe('task:p:newer');
    expect(feed.sources.find((s) => s.key === 'github:github.com/o/r:issue')?.truncated).toBe(true);
    reader.dispose();
  });
  it('does not attach store listeners when project discovery resolves after disposal', async () => {
    const p = root();
    const store = RunStore.open(join(p, '.ai/cezar'));
    const before = store.listenerCount('run');
    let resolve!: (projects: Array<{ id: string; root: string; store: RunStore }>) => void;
    const discovery = new Promise<Array<{ id: string; root: string; store: RunStore }>>((done) => {
      resolve = done;
    });
    const reader = new DashboardReader({ projects: () => discovery });
    const pending = reader.snapshot();
    const rejected = expect(pending).rejects.toThrow('Dashboard reader disposed');
    reader.dispose();
    resolve([{ id: 'p', root: p, store }]);
    await rejected;
    expect(store.listenerCount('run')).toBe(before);
    store.flush();
  });
  it('does not republish a throttled refresh after disposal', async () => {
    vi.useFakeTimers();
    const p = root();
    const store = RunStore.open(join(p, '.ai/cezar'));
    const before = store.listenerCount('run');
    const r = store.createRun({ title: 'q', workflow: 'build', task: 't', steps: [] });
    store.updateRun(r.id, { status: 'waiting' });
    const reader = new DashboardReader({ projects: async () => [{ id: 'p', root: p, store }] });
    await reader.snapshot();
    store.updateRun(r.id, { status: 'review' });
    const pending = reader.snapshot();
    const rejected = expect(pending).rejects.toThrow('Dashboard reader disposed');
    await vi.advanceTimersByTimeAsync(0);
    reader.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(store.listenerCount('run')).toBe(before);
    store.flush();
  });
  it('retries a pending throttled refresh after demand discovers a removed project', async () => {
    vi.useFakeTimers();
    const p = root();
    const store = RunStore.open(join(p, '.ai/cezar'));
    const before = store.listenerCount('run');
    const r = store.createRun({ title: 'q', workflow: 'build', task: 't', steps: [] });
    store.updateRun(r.id, { status: 'waiting' });
    let projects = [{ id: 'p', root: p, store }];
    const reader = new DashboardReader({ projects: async () => projects });
    const first = await reader.snapshot();
    store.updateRun(r.id, { status: 'review' });
    const pending = reader.snapshot();
    await vi.advanceTimersByTimeAsync(0);
    projects = [];
    expect(await reader.tasks(first.snapshotId, 'questions', 0, 20)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    const current = await pending;
    expect(current.coverage.projects).toEqual([]);
    expect(current.counts.reviews).toBe(0);
    expect(store.listenerCount('run')).toBe(before);
    reader.dispose();
    store.flush();
  });
  it('retains failed owned-store load coverage rather than claiming an empty complete project', async () => {
    const p = root();
    disk(p, [record('valid-review', 'review'), { broken: true }]);
    const store = RunStore.open(join(p, '.ai/cezar'));
    const reader = new DashboardReader({ projects: async () => [{ id: 'p', root: p, store }] });
    const s = await reader.snapshot();
    expect(s.counts.reviews).toBe(0); // The owning manager does not have this row.
    expect(s.coverage.projects[0]).toMatchObject({ state: 'unavailable', omittedRuns: 2 });
    reader.dispose();
    store.flush();
  });
  it('invalidates removal immediately even when the same registry identity is re-added before demand', async () => {
    const p = root();
    disk(p, [record('review', 'review')]);
    const reader = new DashboardReader({ projects: async () => [{ id: 'p', root: p }] });
    const old = await reader.snapshot();
    reader.invalidateProject('p');
    expect(await reader.tasks(old.snapshotId, 'reviews', 0, 20)).toBeUndefined();
    reader.dispose();
  });
  it('reconciles an owned dirty projection within one second for concurrent demand', async () => {
    vi.useFakeTimers();
    const p = root();
    const store = RunStore.open(join(p, '.ai/cezar'));
    const r = store.createRun({ title: 'q', workflow: 'build', task: 't', steps: [] });
    store.updateRun(r.id, { status: 'waiting' });
    const reader = new DashboardReader({ projects: async () => [{ id: 'p', root: p, store }] });
    await reader.snapshot();
    store.updateRun(r.id, { status: 'review' });
    const pending = Promise.all([reader.snapshot(), reader.snapshot()]);
    await vi.advanceTimersByTimeAsync(1000);
    const [a, b] = await pending;
    expect(a.counts.questions).toBe(0);
    expect(a.counts.reviews).toBe(1);
    expect(a.snapshotId).toBe(b.snapshotId);
    reader.dispose();
    store.flush();
  });
  it('counts monitoring as a running subset, includes subtasks, and evicts the fourth old snapshot', async () => {
    const p = root();
    const store = RunStore.open(join(p, '.ai/cezar'));
    for (const patch of [
      { status: 'running' as const, activity: 'monitoring' as const },
      { status: 'running' as const },
      { status: 'queued' as const },
      { status: 'failed' as const, autoResumeAt: '2026-09-19T00:00:00Z' },
      { status: 'failed' as const },
      { status: 'review' as const, pinned: true },
    ]) {
      const r = store.createRun({ title: 'r', workflow: 'build', task: 't', steps: [] });
      store.updateRun(r.id, {
        ...patch,
        dispatch: { rootRunId: 'root', parentRunId: 'root', kind: 'implement' },
      });
    }
    let now = Date.now();
    const reader = new DashboardReader({
      projects: async () => [{ id: 'p', root: p, store }],
      now: () => now,
    });
    const first = await reader.snapshot();
    expect(first.counts).toEqual({
      running: 2,
      monitoring: 1,
      queued: 1,
      scheduled: 1,
      questions: 0,
      reviews: 1,
    });
    for (let i = 0; i < 3; i++) {
      store.createRun({ title: `new ${i}`, workflow: 'build', task: 't', steps: [] });
      now += 1001;
      await reader.snapshot();
    }
    expect(await reader.tasks(first.snapshotId, 'running', 0, 20)).toBeUndefined();
    reader.dispose();
    store.flush();
  });
  it('telemetry uses only running owned samples and never calls the disk-project supplier', async () => {
    const p = root();
    const store = RunStore.open(join(p, '.ai/cezar'));
    const running = store.createRun({ title: 'running', workflow: 'build', task: 't', steps: [] });
    store.updateRun(running.id, { status: 'running' });
    store.createRun({ title: 'queued', workflow: 'build', task: 't', steps: [] });
    const sampledAt = '2026-09-18T10:00:00.000Z';
    vi.spyOn(usage, 'currentTimedUsage').mockReturnValue({
      sampledAt,
      cpuPct: null,
      rssBytes: 42,
      procCount: 1,
    });
    const projects = vi.fn(async () => {
      throw new Error('No disk scan');
    });
    const reader = new DashboardReader({
      projects,
      telemetryProjects: async () => [{ id: 'p', root: p, store }],
    });
    expect((await reader.telemetry()).samples).toEqual([
      { projectId: 'p', runId: running.id, sampledAt, cpuPct: null, rssBytes: 42, procCount: 1 },
    ]);
    expect(projects).not.toHaveBeenCalled();
    reader.dispose();
    store.flush();
  });

  it('counts old tasks beyond 200 archived rows, redistributes queue places, excludes telemetry', async () => {
    const p = root();
    const store = RunStore.open(join(p, '.ai/cezar'));
    for (let n = 0; n < 205; n++) {
      const r = store.createRun({ title: 'archive', workflow: 'build', task: 't', steps: [] });
      store.updateRun(r.id, { archived: true });
    }
    for (let n = 0; n < 8; n++) {
      const r = store.createRun({ title: `${n}`, workflow: 'build', task: 't', steps: [] });
      store.updateRun(r.id, { status: 'waiting', createdAt: `2026-09-0${n + 1}T00:00:00Z` });
    }
    const reader = new DashboardReader({ projects: async () => [{ id: 'p', root: p, store }] });
    const s = await reader.snapshot();
    expect(s.counts.questions).toBe(8);
    expect(s.questions.rows).toHaveLength(6);
    expect(s.questions.nextOffset).toBe(6);
    expect(s.questions.rows[0]).not.toHaveProperty('steps');
    expect(s.questions.rows[0]).not.toHaveProperty('usage');
    reader.dispose();
    store.flush();
  });
  it('pages the same ordered identities exactly with totals before paging and exhausted offsets', async () => {
    const p = root();
    const store = RunStore.open(join(p, '.ai/cezar'));
    const ids: string[] = [];
    for (let i = 0; i < 27; i++) {
      const r = store.createRun({ title: `${i}`, workflow: 'build', task: 't', steps: [] });
      ids.push(r.id);
      store.updateRun(r.id, { status: 'waiting', createdAt: new Date(1000 + i).toISOString() });
    }
    const reader = new DashboardReader({ projects: async () => [{ id: 'p', root: p, store }] });
    const s = await reader.snapshot();
    const a = await reader.tasks(s.snapshotId, 'questions', 0, 20);
    const b = await reader.tasks(s.snapshotId, 'questions', 20, 20);
    expect(a?.page.total).toBe(27);
    expect(a?.page.nextOffset).toBe(20);
    expect(b?.page.total).toBe(27);
    expect(b?.page.nextOffset).toBeNull();
    expect([...(a?.page.rows ?? []), ...(b?.page.rows ?? [])].map((r) => r.id)).toEqual(ids);
    expect((await reader.tasks(s.snapshotId, 'questions', 99, 20))?.page).toEqual({
      rows: [],
      total: 27,
      nextOffset: null,
    });
    reader.dispose();
    store.flush();
  });
  it('holds pages immutable across changes, shares revisions, expires and invalidates removed projects', async () => {
    const p = root();
    const store = RunStore.open(join(p, '.ai/cezar'));
    const r = store.createRun({ title: 'before', workflow: 'build', task: 't', steps: [] });
    store.updateRun(r.id, { status: 'waiting' });
    let now = Date.parse('2026-09-18T10:00:00Z');
    let projects = [{ id: 'p', root: p, store }];
    const reader = new DashboardReader({ projects: async () => projects, now: () => now });
    const a = await reader.snapshot();
    expect((await reader.snapshot()).snapshotId).toBe(a.snapshotId);
    store.updateRun(r.id, { title: 'after', status: 'done' });
    now += 1001;
    const b = await reader.snapshot();
    expect(b.snapshotId).not.toBe(a.snapshotId);
    expect((await reader.tasks(a.snapshotId, 'questions', 0, 20))?.page.rows[0]?.title).toBe(
      'before',
    );
    projects = [];
    expect(await reader.tasks(a.snapshotId, 'questions', 0, 20)).toBeUndefined();
    projects = [{ id: 'p', root: p, store }];
    const c = await reader.snapshot();
    now += 60_001;
    expect(await reader.tasks(c.snapshotId, 'questions', 0, 20)).toBeUndefined();
    reader.dispose();
    store.flush();
  });
  it('invalidates cold cache on corrupt replacement and keeps source coverage explicit', async () => {
    const p = root();
    disk(p, [record('review', 'review')]);
    const reader = new DashboardReader({ projects: async () => [{ id: 'cold', root: p }] });
    expect((await reader.snapshot()).counts.reviews).toBe(1);
    disk(p, { broken: true });
    const s = await reader.snapshot();
    expect(s.counts.questions).toBe(0);
    expect(s.coverage.projects[0]?.state).toBe('unavailable');
    reader.dispose();
  });
  it('keeps archived recent results in the feed while excluding archived work from fleet and queue', async () => {
    const p = root();
    const now = Date.parse('2026-09-18T10:00:00Z');
    disk(p, [
      {
        ...record('archived-result', 'done'),
        archived: true,
        finishedAt: new Date(now).toISOString(),
      },
      { ...record('archived-review', 'review'), archived: true },
    ]);
    const reader = new DashboardReader({
      projects: async () => [{ id: 'p', root: p }],
      now: () => now,
    });
    expect((await reader.feed('tasks')).rows.map((r) => r.key)).toEqual(['task:p:archived-result']);
    expect((await reader.snapshot()).counts.reviews).toBe(0);
    reader.dispose();
  });
  it('reports a partially salvaged project as a stale feed source, not unavailable', async () => {
    const p = root();
    disk(p, [record('good', 'done'), { garbage: true }]);
    const reader = new DashboardReader({ projects: async () => [{ id: 'cold', root: p }] });
    const feed = await reader.feed('tasks');
    expect(feed.sources.find((s) => s.key === 'tasks:cold')?.state).toBe('stale');
    reader.dispose();
  });
  it('filters task results before the cap and never reads GitHub for Tasks', async () => {
    const p = root();
    const now = Date.parse('2026-09-18T10:00:00Z');
    disk(
      p,
      Array.from({ length: 65 }, (_, i) => ({
        ...record(`result-${i}`, 'done'),
        finishedAt: new Date(now - i * 1000).toISOString(),
      })),
    );
    const github = vi.fn(async () => ({ rows: [], sources: [] }));
    const reader = new DashboardReader({
      projects: async () => [{ id: 'p', root: p }],
      now: () => now,
      github,
    });
    const feed = await reader.feed('tasks');
    expect(feed.rows).toHaveLength(60);
    expect(feed.truncated).toBe(true);
    expect(feed.sources[0]?.truncated).toBe(true);
    expect(github).not.toHaveBeenCalled();
    reader.dispose();
  });
});


it('keeps cold live records as observations without inventing recent failures', async () => {
  const p = root();
  disk(p, ['waiting', 'queued', 'running'].map((status) => record(status, status)));
  const reader = new DashboardReader({ projects: async () => [{ id: 'cold', root: p }] });
  try {
    const snapshot = await reader.snapshot();
    expect(snapshot.counts).toMatchObject({ questions: 1, queued: 1, running: 1 });
    expect(snapshot.coverage.projects[0]).toMatchObject({ state: 'partial', omittedRuns: 0 });
    expect(snapshot.coverage.projects[0]?.reason).toContain('live state');
    const overview = await reader.overview({ period: '7d', group: 'failed', offset: 0, limit: 20, tzOffsetMinutes: 0 });
    expect(overview?.metrics.failed).toBe(0);
    expect((await reader.feed('tasks')).rows).toEqual([]);
    expect(snapshot.questions.rows[0]?.finishedAt).toBeUndefined();
  } finally { reader.dispose(); }
});

it('refreshes cold root access failures after permissions recover without index changes', async () => {
  const p = root();
  disk(p, [record('review', 'review')]);
  chmodSync(p, 0o300);
  const reader = new DashboardReader({ projects: async () => [{ id: 'cold', root: p }] });
  try {
    expect((await reader.snapshot()).coverage.projects[0]?.state).toBe('unavailable');
    chmodSync(p, 0o700);
    const recovered = await reader.snapshot();
    expect(recovered.coverage.projects[0]?.state).toBe('complete');
    expect(recovered.counts.reviews).toBe(1);
    chmodSync(p, 0o300);
    expect((await reader.snapshot()).coverage.projects[0]?.state).toBe('unavailable');
  } finally {
    chmodSync(p, 0o700);
    reader.dispose();
  }
});

it('orders attention by parsed creation time, then identity, with invalid dates last', async () => {
  const a = root();
  const b = root();
  disk(a, [
    { ...record('fraction'), createdAt: '2026-09-19T11:00:00.500Z' },
    { ...record('second'), createdAt: '2026-09-19T11:00:00Z' },
    { ...record('offset'), createdAt: '2026-09-19T12:00:00+02:00' },
    { ...record('invalid'), createdAt: '' },
    { ...record('same'), createdAt: '2026-09-19T11:30:00Z' },
  ]);
  disk(b, [{ ...record('same'), createdAt: '2026-09-19T11:30:00.000Z' }]);
  const reader = new DashboardReader({
    projects: async () => [{ id: 'b', root: b }, { id: 'a', root: a }],
  });
  try {
    const snapshot = await reader.snapshot();
    const tasks = await reader.tasks(snapshot.snapshotId, 'questions', 0, 20);
    expect(tasks?.page.rows.map((r) => [r.projectId, r.id])).toEqual([
      ['a', 'offset'], ['a', 'second'], ['a', 'fraction'],
      ['a', 'same'], ['b', 'same'], ['a', 'invalid'],
    ]);
  } finally { reader.dispose(); }
});
