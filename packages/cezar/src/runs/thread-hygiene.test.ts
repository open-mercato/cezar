import { describe, expect, it } from 'vitest';
import { threadAdmission } from './thread-hygiene.ts';
import { taskAttention, taskEventOf } from '../managers/snapshot.ts';
import { reconcileLoadedRun, type RunRecord } from './store.ts';

describe('work continuation admission', () => {
  it('admits three work resumptions then refuses a fourth without changing the count', () => {
    let state = { continuations: 0, historyKnown: true };
    for (let n = 1; n <= 3; n++) {
      const next = threadAdmission(state, 'work', `operation-${n}`);
      expect(next.accepted).toBe(true); state = next.state;
    }
    const refused = threadAdmission(state, 'automatic', 'operation-4');
    expect(refused.accepted).toBe(false);
    expect(refused.state.continuations).toBe(3);
    expect(refused.state.pending?.reason).toBe('automatic');
    const approved = threadAdmission(refused.state, 'work', 'operation-4', { action: 'continue', expectedCount: 3 });
    expect(approved.accepted).toBe(true);
    expect(approved.state.continuations).toBe(4);
    expect(approved.state.pending).toBeUndefined();
    expect(threadAdmission(approved.state, 'work', 'operation-5').accepted).toBe(false);
    expect(threadAdmission(approved.state, 'work', 'operation-5', { action: 'continue', expectedCount: 3 }).accepted).toBe(false);
  });
  it('deduplicates an accepted operation and honestly retains unknown earlier history', () => {
    const first = threadAdmission(undefined, 'work', 'a');
    expect(first.state).toMatchObject({ continuations: 1, historyKnown: false });
    expect(threadAdmission(first.state, 'work', 'a').state.continuations).toBe(1);
  });
  it('a persisted gate is readable after restart without becoming a paid manager event', () => {
    const run = { id: 'r', title: 't', status: 'running', archived: false, steps: [], createdAt: '2026-11-17T10:00:00Z',
      threadHygiene: { continuations: 3, historyKnown: true, pending: { reason: 'automatic', since: '2026-11-17T11:00:00Z' } },
    } as unknown as RunRecord;
    const cold = reconcileLoadedRun(run);
    expect(cold.status).toBe('waiting'); expect(cold.idleClosedAt).toBeDefined();
    expect(cold.awaitingAnswerSince).toBeUndefined();
    expect(taskAttention('p', [cold], Date.now())).toEqual([]);
    expect(taskEventOf('p', cold)).toBeUndefined();
  });
  it('a hygiene wait never suppresses an independent worktree recovery exception', () => {
    const run = { id: 'r', title: 't', status: 'waiting', archived: false, steps: [], createdAt: '2026-11-17T10:00:00Z',
      threadHygiene: { continuations: 3, historyKnown: true, pending: { reason: 'automatic', since: '2026-11-17T11:00:00Z' } },
      worktreeLifecycle: { needsAttention: true, phase: 'setup', worktreeId: 'w', generation: 1 },
    } as unknown as RunRecord;
    expect(taskAttention('p', [run], Date.now()).map(item => item.kind)).toEqual(['task-needs-you']);
    expect(taskEventOf('p', run)?.state).toBe('needs-you');
  });

});
