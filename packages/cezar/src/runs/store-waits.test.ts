import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runStatusSchema, waitEdgeSchema, waitInputSchema, waitRunStatusSchema, type WaitEdge } from '@open-mercato/cezar-contract';
import { RunStore } from './store.ts';

/** The persisted half of cross-task waits (spec 2026-10-05-cross-task-waits § Data Model). */
describe('RunRecord.waits', () => {
  const edge: WaitEdge = {
    id: 'w-1',
    target: { projectId: 'api', runId: 'run-target' },
    targetTitle: 'Add export endpoint',
    origin: 'agent',
    createdAt: '2026-10-05T10:00:00.000Z',
    deadline: '2026-10-06T10:00:00.000Z',
    state: 'pending',
  };

  it('round-trips through runs.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-store-waits-'));
    try {
      const store = RunStore.open(dir);
      const run = store.createRun({ title: 'Waiter', task: 't', workflow: 'quick-task', steps: [] });
      store.updateRun(run.id, { waits: [edge], waitedBy: { projectId: 'web', runId: 'creator' } });
      store.flush();
      const reopened = RunStore.open(dir).getRun(run.id);
      expect(reopened?.waits).toEqual([edge]);
      expect(reopened?.waitedBy).toEqual({ projectId: 'web', runId: 'creator' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses an old record without the field, and drops a malformed field rather than the index', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-store-waits-'));
    try {
      const store = RunStore.open(dir);
      const run = store.createRun({ title: 'Old', task: 't', workflow: 'quick-task', steps: [] });
      store.flush();
      const file = join(dir, 'runs.json');
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { runs: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
      const runs = Array.isArray(raw) ? raw : raw.runs;
      expect(runs[0]).not.toHaveProperty('waits');
      expect(RunStore.open(dir).getRun(run.id)?.waits).toBeUndefined();
      runs[0]!.waits = [{ id: 7, state: 'nonsense' }];
      writeFileSync(file, JSON.stringify(raw));
      const reread = RunStore.open(dir).getRun(run.id);
      expect(reread?.title).toBe('Old');
      expect(reread?.waits).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('restates exactly the seven run statuses', () => {
    expect(waitRunStatusSchema.options).toEqual(runStatusSchema.options);
  });

  it('accepts target XOR create, never both, and bounds the timeout', () => {
    expect(waitInputSchema.safeParse({ target: { runId: 'abc12345' } }).success).toBe(true);
    expect(waitInputSchema.safeParse({ target: { projectId: 'api', runId: 'abc' }, timeoutMinutes: 10080 }).success).toBe(true);
    expect(waitInputSchema.safeParse({ create: { projectId: 'api', objective: 'do it' } }).success).toBe(true);
    expect(waitInputSchema.safeParse({ target: { runId: 'a' }, create: { projectId: 'api', objective: 'x' } }).success).toBe(false);
    expect(waitInputSchema.safeParse({ target: { runId: 'a' }, timeoutMinutes: 0 }).success).toBe(false);
    expect(waitInputSchema.safeParse({ target: { runId: 'a' }, timeoutMinutes: 10081 }).success).toBe(false);
    // `origin` is the route's to derive — a body that tries to set it is refused.
    expect(waitInputSchema.safeParse({ target: { runId: 'a' }, origin: 'user' }).success).toBe(false);
    expect(waitEdgeSchema.safeParse(edge).success).toBe(true);
  });
});
