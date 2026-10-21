import { describe, expect, it } from 'vitest';
import type { FleetJob, FleetNode } from '@open-mercato/cezar-contract';
import { LEASE_MS, applyReport, cancelJob, expireLeases, planAssignments } from './scheduler.ts';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const at = (ms: number) => new Date(ms).toISOString();

const job = (id: string, over: Partial<FleetJob> = {}): FleetJob => ({
  id, repoUrl: 'https://github.com/a/b', task: 't', openPr: true, status: 'pending', attempts: 0,
  createdAt: at(NOW - 1000 + Number(id.replace(/\D/g, '') || 0)), updatedAt: at(NOW), ...over,
});
const node = (nodeId: string, free: number, seenAgo = 1000): FleetNode => ({
  nodeId, lastSeen: at(NOW - seenAgo), capacity: { free, max: 4 }, host: {}, version: '1',
});

describe('planAssignments', () => {
  it('gives FIFO jobs to the node with the most free capacity first', () => {
    const plan = planAssignments([job('j1'), job('j2'), job('j3')], [node('a', 1), node('b', 3)], NOW);
    expect([...plan]).toEqual([['j1', 'b'], ['j2', 'b'], ['j3', 'a']]);
  });
  it("never assigns beyond a node's free capacity", () => {
    const plan = planAssignments([job('j1'), job('j2'), job('j3')], [node('a', 1), node('b', 1)], NOW);
    expect(plan.size).toBe(2);
    expect(plan.has('j3')).toBe(false);
  });
  it('skips full and silent nodes', () => {
    const plan = planAssignments([job('j1')], [node('full', 0), node('gone', 4, 120_000)], NOW);
    expect(plan.size).toBe(0);
  });
  it('ignores jobs that are not pending', () => {
    expect(planAssignments([job('j1', { status: 'running' })], [node('a', 2)], NOW).size).toBe(0);
  });
  it('is deterministic on ties (node id order)', () => {
    expect(planAssignments([job('j1')], [node('b', 2), node('a', 2)], NOW).get('j1')).toBe('a');
  });
});

describe('expireLeases', () => {
  const held = (over: Partial<FleetJob> = {}) =>
    job('j1', { status: 'running', nodeId: 'n1', runId: 'r', leaseExpiresAt: at(NOW - 1), ...over });
  it('requeues a held job whose lease ran out and counts the attempt', () => {
    const [next] = expireLeases([held()], NOW);
    expect(next).toMatchObject({ status: 'pending', attempts: 1 });
    expect(next).not.toHaveProperty('nodeId');
    expect(next).not.toHaveProperty('runId');
  });
  it('fails the job on the third lost attempt', () => {
    const [next] = expireLeases([held({ attempts: 2 })], NOW);
    expect(next).toMatchObject({ status: 'failed', attempts: 3 });
    expect(next?.error).toContain('n1');
  });
  it('leaves live leases, pending and terminal jobs alone', () => {
    const jobs = [held({ leaseExpiresAt: at(NOW + LEASE_MS) }), job('j2'), job('j3', { status: 'done' })];
    expect(expireLeases(jobs, NOW)).toEqual([]);
  });
});

describe('applyReport', () => {
  const owned = job('j1', { status: 'assigned', nodeId: 'n1', leaseExpiresAt: at(NOW + 10) });
  it('folds a report in and renews the lease', () => {
    const out = applyReport(owned, 'n1', { id: 'j1', status: 'running', runId: 'r1', branch: 'cez/x' }, NOW);
    expect(out).toMatchObject({ action: 'ok', changed: true, job: { status: 'running', runId: 'r1', branch: 'cez/x', leaseExpiresAt: at(NOW + LEASE_MS) } });
  });
  it('reports no change for an identical re-report (idempotent)', () => {
    const first = applyReport(owned, 'n1', { id: 'j1', status: 'running', runId: 'r1' }, NOW);
    if (first.action !== 'ok') throw new Error('expected ok');
    const again = applyReport(first.job, 'n1', { id: 'j1', status: 'running', runId: 'r1' }, NOW + 5000);
    expect(again).toMatchObject({ action: 'ok', changed: false });
  });
  it('drops a job the node does not own, an unknown one, a requeued one and a finished one', () => {
    const r = { id: 'j1', status: 'running' as const };
    expect(applyReport(owned, 'other', r, NOW)).toEqual({ action: 'drop' });
    expect(applyReport(undefined, 'n1', r, NOW)).toEqual({ action: 'drop' });
    expect(applyReport(job('j1'), 'n1', r, NOW)).toEqual({ action: 'drop' });
    expect(applyReport({ ...owned, status: 'done' }, 'n1', r, NOW)).toEqual({ action: 'drop' });
  });
  it('tells the owner to cancel a cancelled job', () => {
    expect(applyReport({ ...owned, status: 'cancelled' }, 'n1', { id: 'j1', status: 'running' }, NOW)).toEqual({ action: 'cancel' });
  });
  it('clears the lease on a terminal report', () => {
    const out = applyReport(owned, 'n1', { id: 'j1', status: 'done', prUrl: 'https://x/pull/1' }, NOW);
    if (out.action !== 'ok') throw new Error('expected ok');
    expect(out.job.status).toBe('done');
    expect(out.job.leaseExpiresAt).toBeUndefined();
  });
});

describe('cancelJob', () => {
  it('cancels pending and held jobs and keeps the owner so it hears about it', () => {
    expect(cancelJob(job('j1'), NOW).status).toBe('cancelled');
    expect(cancelJob(job('j2', { status: 'running', nodeId: 'n1' }), NOW)).toMatchObject({ status: 'cancelled', nodeId: 'n1' });
  });
  it('leaves finished jobs alone', () => {
    const done = job('j1', { status: 'done' });
    expect(cancelJob(done, NOW)).toBe(done);
  });
});
