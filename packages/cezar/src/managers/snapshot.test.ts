import { describe, expect, it } from 'vitest';
import type { GithubData, ManagerSnapshot } from '@open-mercato/cezar-contract';
import type { RunRecord } from '../runs/store.ts';
import { buildSnapshot, gateAttention, prAttention, snapshotTasks, taskAttention, type ManagerProjectSource } from './snapshot.ts';

const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const run = (over: Partial<RunRecord> & { id: string }): RunRecord => ({
  title: over.id, status: 'done', archived: false, workflow: 'quick-task', createdAt: '2026-10-31T10:00:00.000Z', steps: [], ...over,
} as unknown as RunRecord);

describe('attention', () => {
  it('keys are stable across snapshots and move with the event', () => {
    const failed = run({ id: 'r1', status: 'failed', finishedAt: '2026-10-31T11:00:00.000Z' });
    const first = taskAttention('p', [failed], NOW);
    expect(first.map((item) => item.kind)).toEqual(['task-failed']);
    expect(taskAttention('p', [failed], NOW + 60_000)[0]?.key).toBe(first[0]?.key);
    const again = taskAttention('p', [{ ...failed, finishedAt: '2026-10-31T11:30:00.000Z' }], NOW)[0];
    expect(again?.key).not.toBe(first[0]?.key);
  });

  it('drops what the user already saw and what is archived', () => {
    const at = '2026-10-31T11:00:00.000Z';
    expect(taskAttention('p', [run({ id: 'r', status: 'review', finishedAt: at, seenAt: '2026-10-31T11:10:00.000Z' })], NOW)).toEqual([]);
    expect(taskAttention('p', [run({ id: 'r', status: 'failed', finishedAt: at, archived: true })], NOW)).toEqual([]);
  });

  it('a dispatched child reaches the user only with a question', () => {
    const dispatch = { rootRunId: 'root', parentRunId: 'root' } as RunRecord['dispatch'];
    const finishedAt = '2026-10-31T11:00:00.000Z';
    expect(taskAttention('p', [run({ id: 'c', status: 'failed', finishedAt, dispatch })], NOW)).toEqual([]);
    const asked = taskAttention('p', [run({ id: 'c', status: 'waiting', awaitingAnswerSince: finishedAt, dispatch })], NOW);
    expect(asked.map((item) => item.kind)).toEqual(['task-needs-you']);
  });

  it('flags a running task with no activity for hours', () => {
    const items = taskAttention('p', [run({ id: 'r', status: 'running', startedAt: '2026-10-31T01:00:00.000Z' })], NOW);
    expect(items.map((item) => item.kind)).toEqual(['task-stalled']);
  });

  it('reads pull requests, and a conflict beats ready', () => {
    const kinds = (pr: Parameters<typeof prAttention>[1][number]) => prAttention('p', [pr]).map((item) => item.kind);
    expect(kinds({ number: 1, title: 't', status: 'ready', mergeable: true })).toEqual(['pr-ready']);
    expect(kinds({ number: 1, title: 't', status: 'ready', mergeable: false })).toEqual(['pr-conflict']);
    expect(kinds({ number: 1, title: 't', status: 'checks-failing' })).toEqual(['pr-checks-failing']);
    expect(kinds({ number: 1, title: 't', status: 'review-required' })).toEqual(['pr-review-requested']);
    expect(kinds({ number: 1, title: 't', status: 'checks-failing', draft: true })).toEqual([]);
  });
});

describe('snapshotTasks', () => {
  it('reads a tree as its root and counts direct children', () => {
    const rows = snapshotTasks([
      run({ id: 'root' }),
      run({ id: 'child', dispatch: { rootRunId: 'root', parentRunId: 'root' } as RunRecord['dispatch'] }),
    ]);
    expect(rows.map((row) => [row.runId, row.childCount])).toEqual([['root', 1]]);
  });
});

describe('buildSnapshot', () => {
  it('a missing PR status blinds the project, so the check keeps its keys', async () => {
    const source = { id: 'p', name: 'p', root: '/p', available: true, runs: () => [], automationFailures: () => [] } as unknown as ManagerProjectSource;
    const github = {
      list: async () => ({ available: true as const, prs: [{ number: 12, title: 't', author: 'a', url: 'u' }] }),
      refStatus: async () => ({ available: false as const, reason: 'offline' }),
    } as never;
    const blip = await buildSnapshot([source], github, 0);
    expect(gateAttention(blip, { 'pr-ready:p:12': 'then' }).kept).toEqual({ 'pr-ready:p:12': 'then' });
  });
});

describe('gateAttention', () => {
  const snapshot = (keys: string[], blind?: string): ManagerSnapshot => ({
    generatedAt: '',
    projects: blind ? [{ projectId: blind, name: blind, available: true, prsUnavailable: 'offline', tasks: [], prs: [] }] : [],
    attention: keys.map((key) => ({ key, kind: 'pr-ready', projectId: 'p', title: key })),
  });

  it('passes only unreported keys', () => {
    const { fresh } = gateAttention(snapshot(['a', 'b']), { a: 'then' });
    expect(fresh.map((item) => item.key)).toEqual(['b']);
  });

  it('forgets a key that went away, so a second occurrence is news again', () => {
    expect(gateAttention(snapshot([]), { 'pr-ready:p:1': 'then' }).kept).toEqual({});
  });

  it('keeps PR keys of a project it could not read, so an outage does not re-report them', () => {
    const { kept } = gateAttention(snapshot([], 'p'), { 'pr-ready:p:1': 'then', 'task-failed:p:r:t': 'then' });
    expect(Object.keys(kept)).toEqual(['pr-ready:p:1']);
  });
});

describe('buildSnapshot', () => {
  const source = (over: Partial<ManagerProjectSource> = {}): ManagerProjectSource => ({
    id: 'p', name: 'p', root: '/p', available: true, runs: () => [], automationFailures: () => [], ...over,
  });
  const empty: GithubData = { available: true, issues: [], prs: [] };

  it('degrades: GitHub unavailable still reports tasks, a missing folder reports nothing', async () => {
    const github = { list: async (): Promise<GithubData> => ({ ...empty, available: false, reason: 'no gh' }), refStatus: async () => { throw new Error('not reached'); } };
    const snapshot = await buildSnapshot(
      [source({ runs: () => [run({ id: 'r1' })] }), source({ id: 'gone', available: false })],
      github,
      NOW,
    );
    expect(snapshot.projects[0]).toMatchObject({ prsUnavailable: 'no gh', tasks: [{ runId: 'r1' }] });
    expect(snapshot.projects[1]).toMatchObject({ projectId: 'gone', available: false });
  });

  it('a throwing forge call is a degraded project, never a failed snapshot', async () => {
    const github = { list: async (): Promise<GithubData> => { throw new Error('boom'); }, refStatus: async () => { throw new Error('boom'); } };
    expect((await buildSnapshot([source()], github, NOW)).projects[0]?.prsUnavailable).toBe('boom');
  });

  it('absent conflict data is unknown, not mergeable', async () => {
    const pr = { kind: 'pr' as const, number: 7, title: 't', author: 'a', createdAt: '', labels: [], url: 'u', comments: 0 };
    const github = {
      list: async (): Promise<GithubData> => ({ ...empty, prs: [pr] }),
      refStatus: async () => ({ available: true as const, prs: { 7: 'ready' as const }, issues: {}, recheckAfterMs: null }),
    };
    const snapshot = await buildSnapshot([source()], github, NOW);
    expect(snapshot.projects[0]?.prs[0]?.mergeable).toBeUndefined();
    expect(snapshot.attention.map((item) => item.kind)).toEqual(['pr-ready']);
  });

  it('turns an erroring automation into a key that moves with the failure', async () => {
    const github = { list: async () => empty, refStatus: async () => { throw new Error('not reached'); } };
    const snapshot = await buildSnapshot([source({ automationFailures: () => [{ id: 'a', name: 'nightly', at: 't1', reason: 'x' }] })], github, NOW);
    expect(snapshot.attention[0]).toMatchObject({ key: 'automation-failing:p:a:t1', kind: 'automation-failing', detail: 'x' });
  });
});
