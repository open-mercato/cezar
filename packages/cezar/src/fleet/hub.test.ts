import { describe, expect, it } from 'vitest';
import type { FleetHeartbeat } from '@open-mercato/cezar-contract';
import { FleetHub } from './hub.ts';
import { LEASE_MS } from './scheduler.ts';

function setup() {
  const clock = { now: Date.parse('2026-10-21T12:00:00Z') };
  let n = 0;
  const saved: unknown[] = [];
  const hub = new FleetHub({ now: () => clock.now, newId: () => `job-${++n}`, persist: (jobs) => saved.push(jobs) });
  const beat = (nodeId: string, free: number, jobs: FleetHeartbeat['jobs'] = []): FleetHeartbeat => ({
    nodeId, version: '1', capacity: { free, max: 4 }, host: {}, jobs,
  });
  return { clock, hub, beat, saved };
}
const submit = (hub: FleetHub, task = 't') => hub.submit({ repoUrl: 'https://github.com/a/b', task });

describe('FleetHub', () => {
  it('hands pending jobs to a heartbeating node up to its free capacity', () => {
    const { hub, beat } = setup();
    submit(hub); submit(hub); submit(hub);
    const res = hub.heartbeat(beat('n1', 2));
    expect(res.assigned.map((j) => j.id)).toEqual(['job-1', 'job-2']);
    expect(hub.getJob('job-3')?.status).toBe('pending');
    expect(hub.getJob('job-1')).toMatchObject({ status: 'assigned', nodeId: 'n1' });
  });

  it('splits work toward the least-loaded node', () => {
    const { hub, beat } = setup();
    hub.heartbeat(beat('big', 3));
    hub.heartbeat(beat('small', 1));
    submit(hub); submit(hub); submit(hub); submit(hub);
    expect(hub.heartbeat(beat('small', 1)).assigned).toHaveLength(1);
    expect(hub.heartbeat(beat('big', 3)).assigned).toHaveLength(3);
  });

  it('redelivers an assignment the node never acknowledged', () => {
    const { hub, beat } = setup();
    submit(hub);
    expect(hub.heartbeat(beat('n1', 1)).assigned).toHaveLength(1);
    expect(hub.heartbeat(beat('n1', 1)).assigned.map((j) => j.id)).toEqual(['job-1']);
    expect(hub.heartbeat(beat('n1', 0, [{ id: 'job-1', status: 'running' }])).assigned).toEqual([]);
  });

  it('requeues work from a node that went silent, and tells it to drop the job when it returns', () => {
    const { hub, beat, clock } = setup();
    submit(hub);
    hub.heartbeat(beat('n1', 1));
    hub.heartbeat(beat('n1', 0, [{ id: 'job-1', status: 'running', runId: 'r1' }]));
    clock.now += LEASE_MS + 1000;
    const takeover = hub.heartbeat(beat('n2', 1));
    expect(takeover.assigned.map((j) => j.id)).toEqual(['job-1']);
    expect(hub.getJob('job-1')).toMatchObject({ nodeId: 'n2', attempts: 1 });
    const late = hub.heartbeat(beat('n1', 1, [{ id: 'job-1', status: 'running', runId: 'r1' }]));
    expect(late.drop).toEqual(['job-1']);
  });

  it('fails a job after three lost attempts', () => {
    const { hub, beat, clock } = setup();
    submit(hub);
    for (let i = 0; i < 3; i++) {
      hub.heartbeat(beat('n1', 1));
      clock.now += LEASE_MS + 1000;
      hub.sweep();
    }
    expect(hub.getJob('job-1')).toMatchObject({ status: 'failed', attempts: 3 });
  });

  it('cancels a pending job outright and tells the holder of a running one', () => {
    const { hub, beat } = setup();
    submit(hub); submit(hub);
    hub.heartbeat(beat('n1', 1));
    hub.heartbeat(beat('n1', 0, [{ id: 'job-1', status: 'running' }]));
    expect(hub.cancel('job-2')?.status).toBe('cancelled');
    hub.cancel('job-1');
    const res = hub.heartbeat(beat('n1', 0, [{ id: 'job-1', status: 'running' }]));
    expect(res.cancel).toEqual(['job-1']);
    expect(hub.cancel('missing')).toBeUndefined();
  });

  it('records results and persists only real changes', () => {
    const { hub, beat, saved } = setup();
    submit(hub);
    hub.heartbeat(beat('n1', 1));
    const writes = saved.length;
    const running = [{ id: 'job-1', status: 'running' as const, runId: 'r1' }];
    hub.heartbeat(beat('n1', 0, running));
    const afterFirst = saved.length;
    hub.heartbeat(beat('n1', 0, running));
    expect(saved.length).toBe(afterFirst);
    expect(afterFirst).toBe(writes + 1);
    hub.heartbeat(beat('n1', 0, [{ id: 'job-1', status: 'done', runId: 'r1', prUrl: 'https://x/pull/9' }]));
    expect(hub.getJob('job-1')).toMatchObject({ status: 'done', prUrl: 'https://x/pull/9' });
  });

  it('gives restored held jobs a fresh lease after a restart', () => {
    const { hub, beat, clock } = setup();
    submit(hub);
    hub.heartbeat(beat('n1', 1));
    const restored = new FleetHub({ initialJobs: hub.status().jobs, now: () => clock.now + 3_600_000 });
    restored.sweep();
    expect(restored.getJob('job-1')?.status).toBe('assigned');
  });

  it('lists nodes with the capacity they reported', () => {
    const { hub, beat } = setup();
    hub.heartbeat(beat('n1', 2));
    expect(hub.status().nodes).toMatchObject([{ nodeId: 'n1', capacity: { free: 2, max: 4 } }]);
  });
});
