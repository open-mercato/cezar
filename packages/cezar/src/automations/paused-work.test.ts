import { describe, expect, it } from 'vitest';
import type { RunRecord } from '../runs/store.ts';
import { automationWork, launchingAutomationId, pausedAutomationHold, queuedToCancel } from './paused-work.ts';

const at = '2026-11-04T15:00:00.000Z';
const trigger = (automationId: string, kind: 'schedule' | 'catch-up' | 'manual' = 'schedule') =>
  ({ automationId, automationRevision: 1, receiptId: `r-${automationId}`, trigger: kind, occurrenceAt: at });

function run(id: string, extra: Partial<RunRecord> = {}): RunRecord {
  return { id, title: `task ${id}`, workflow: '(planned)', task: 't', status: 'queued', createdAt: at, steps: [], ...extra } as RunRecord;
}

describe('paused automation work (#1980)', () => {
  it('attributes schedule, GitHub and tracker launches, never a by-hand Run now', () => {
    expect(launchingAutomationId(run('a', { automationTrigger: trigger('s') }))).toBe('s');
    expect(launchingAutomationId(run('b', { automationTrigger: trigger('s', 'catch-up') }))).toBe('s');
    expect(launchingAutomationId(run('c', { automationTrigger: trigger('s', 'manual') }))).toBeUndefined();
    expect(launchingAutomationId(run('d', { automation: { automationId: 'g', automationRevision: 1, receiptId: 'r', event: 'pull_request', githubUrl: 'https://github.com/o/r/pull/1' } }))).toBe('g');
    expect(launchingAutomationId(run('e', { automationTracker: { automationId: 't', automationRevision: 1, receiptId: 'r', provider: 'jira', key: 'K-1', url: 'https://x.atlassian.net/browse/K-1' } }))).toBe('t');
    expect(launchingAutomationId(run('f'))).toBeUndefined();
  });

  const runs = [
    run('root', { status: 'running', automationTrigger: trigger('s'), dispatch: { rootRunId: 'root' } }),
    run('fresh', { dispatch: { rootRunId: 'root', parentRunId: 'root' } }),
    run('resume', { dispatch: { rootRunId: 'root', parentRunId: 'root' }, steps: [{ id: 'task', name: 'Task', status: 'done', sessionId: 'sess' }] as RunRecord['steps'] }),
    run('kid', { status: 'waiting', dispatch: { rootRunId: 'root', parentRunId: 'resume' } }),
    run('done', { status: 'cancelled', dispatch: { rootRunId: 'root', parentRunId: 'root' } }),
    run('queued-root', { automationTrigger: trigger('s') }),
    run('by-hand', { automationTrigger: trigger('s', 'manual') }),
    run('other', { automationTrigger: trigger('x') }),
  ];

  it('splits a tree into never-started and continuation queued work, and active work', () => {
    const work = automationWork(runs, 's');
    expect(work.queued).toEqual([
      { id: 'fresh', title: 'task fresh', status: 'queued', rootRunId: 'root', kind: 'never-started' },
      { id: 'resume', title: 'task resume', status: 'queued', rootRunId: 'root', kind: 'continuation' },
      { id: 'queued-root', title: 'task queued-root', status: 'queued', kind: 'never-started' },
    ]);
    expect(work.active.map((r) => r.id)).toEqual(['root', 'kid']);
    expect(automationWork(runs, 'nobody')).toEqual({ queued: [], active: [] });
  });

  it('keeps a queued parent whose children still run — cancelling it would stop them', () => {
    expect(queuedToCancel(runs, 's')).toEqual({ cancel: ['fresh', 'queued-root'], keep: ['resume'] });
  });

  it('holds dispatch anywhere in a paused tree, and only there', () => {
    const paused = (id: string) => id === 's';
    for (const id of ['root', 'kid', 'queued-root']) expect(pausedAutomationHold(runs, runs.find((r) => r.id === id)!, paused)).toMatch(/paused/);
    expect(pausedAutomationHold(runs, runs.find((r) => r.id === 'kid')!, () => false)).toBeUndefined();
    expect(pausedAutomationHold(runs, runs.find((r) => r.id === 'by-hand')!, paused)).toBeUndefined();
    expect(pausedAutomationHold(runs, runs.find((r) => r.id === 'other')!, paused)).toBeUndefined();
  });
});
