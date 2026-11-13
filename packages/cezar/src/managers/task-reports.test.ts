import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { RunRecord, RunStore } from '../runs/store.ts';
import { taskAttention, taskEventOf } from './snapshot.ts';
import { watchTaskReports } from './task-reports.ts';

const run = (over: Partial<RunRecord> & { id: string }): RunRecord =>
  ({ title: 't', status: 'running', workflow: 'quick-task', createdAt: '2026-11-13T08:00:00.000Z', steps: [], tokensUsed: 0, ...over }) as RunRecord;

describe('followed-task events', () => {
  it('keys an event the way the watch does, and one success across review → done', () => {
    const at = '2026-11-13T08:10:00.000Z';
    const now = Date.parse(at) + 60_000;
    for (const status of ['review', 'done', 'failed'] as const) {
      const settled = run({ id: 'r', status, finishedAt: at });
      expect(taskEventOf('p', settled)?.attentionKeys).toEqual(expect.arrayContaining(taskAttention('p', [settled], now).map((item) => item.key)));
    }
    const waiting = run({ id: 'r', status: 'waiting', waitingSince: at });
    expect(taskEventOf('p', waiting)).toMatchObject({ state: 'needs-you', at, attentionKeys: taskAttention('p', [waiting], now).map((item) => item.key) });
    expect(taskEventOf('p', run({ id: 'r', status: 'review', finishedAt: at }))?.ledger).toBe(taskEventOf('p', run({ id: 'r', status: 'done', finishedAt: at }))?.ledger);
    expect(taskEventOf('p', run({ id: 'r', status: 'cancelled', finishedAt: at }))).toMatchObject({ state: 'cancelled', attentionKeys: [] });
    // Still working, monitoring its children, or queued: nothing to hear.
    expect(taskEventOf('p', run({ id: 'r', status: 'running', activity: 'monitoring' }))).toBeUndefined();
    expect(taskEventOf('p', run({ id: 'r', status: 'queued' }))).toBeUndefined();
  });

  it('hands the engine every change of event, never a repeat, and the whole list at attach', async () => {
    const existing = run({ id: 'old', status: 'done', finishedAt: '2026-11-13T07:00:00.000Z' });
    const store = Object.assign(new EventEmitter(), { listRuns: () => [existing], getRun: () => undefined }) as unknown as RunStore;
    const changed: string[] = [];
    const reconciled: number[] = [];
    const off = watchTaskReports({
      projectId: () => 'alpha',
      dataDir: '/data',
      store,
      engine: { taskChanged: (_project, _dir, changedRun) => changed.push(`${changedRun.id}:${changedRun.status}`), reconcileProject: (_project, _dir, runs) => reconciled.push(runs.length) },
      enabled: () => true,
    });
    const emit = (over: Partial<RunRecord> & { id: string }) => store.emit('run', run(over));
    emit({ id: 'old', status: 'done', finishedAt: '2026-11-13T07:00:00.000Z' });
    emit({ id: 'new', status: 'running' });
    emit({ id: 'new', status: 'running', activity: 'monitoring' });
    emit({ id: 'new', status: 'review', finishedAt: '2026-11-13T08:00:00.000Z' });
    emit({ id: 'new', status: 'done', finishedAt: '2026-11-13T08:00:00.000Z' });
    emit({ id: 'new', status: 'failed', finishedAt: '2026-11-13T08:05:00.000Z' });
    await vi.waitFor(() => expect(changed).toEqual(['new:review', 'new:failed']));
    expect(reconciled).toEqual([1]);
    off();
    expect(store.listenerCount('run')).toBe(0);
  });
});
