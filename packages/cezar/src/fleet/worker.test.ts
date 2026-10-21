import { describe, expect, it } from 'vitest';
import type { FleetHeartbeat, FleetHeartbeatResponse, FleetJob } from '@open-mercato/cezar-contract';
import { localCapacity } from './index.ts';
import { repoKey } from './runs.ts';
import { FleetWorker, type FleetRunHost } from './worker.ts';

const job = (id: string, over: Partial<FleetJob> = {}): FleetJob => ({
  id, repoUrl: 'a/b', task: 't', openPr: true, status: 'assigned', nodeId: 'n1', attempts: 0,
  createdAt: '2026-10-21T12:00:00.000Z', updatedAt: '2026-10-21T12:00:00.000Z', ...over,
});

function setup(over: Partial<FleetRunHost> = {}) {
  const runs = new Map<string, { status: string; branch?: string; error?: string }>();
  const calls: string[] = [];
  const host: FleetRunHost = {
    start: async (j) => { runs.set(`run-${j.id}`, { status: 'running', branch: 'cez/abc' }); return `run-${j.id}`; },
    get: (id) => runs.get(id),
    cancel: (id) => { calls.push(`cancel ${id}`); },
    recover: async () => [],
    publish: async () => ({ ok: true, url: 'https://github.com/a/b/pull/1' }),
    ...over,
  };
  const sent: FleetHeartbeat[] = [];
  let reply: FleetHeartbeatResponse = { assigned: [], cancel: [], drop: [] };
  const worker = new FleetWorker({
    nodeId: 'n1', version: '1', host,
    transport: async (hb) => { sent.push(hb); const r = reply; reply = { assigned: [], cancel: [], drop: [] }; return r; },
    capacity: () => ({ free: 2, max: 2 }),
  });
  return { host, worker, runs, sent, calls, reply: (r: Partial<FleetHeartbeatResponse>) => { reply = { assigned: [], cancel: [], drop: [], ...r }; } };
}
const settle = () => new Promise((r) => setTimeout(r, 0));
const last = (s: FleetHeartbeat[]) => s[s.length - 1] as FleetHeartbeat;
/** Latest report per job across every heartbeat (a finished job is only reported once). */
const reported = (s: FleetHeartbeat[]) => Object.fromEntries(s.flatMap((hb) => hb.jobs).map((j) => [j.id, j]));

describe('FleetWorker', () => {
  it('starts an assigned job and reports its run', async () => {
    const t = setup();
    t.reply({ assigned: [job('j1')] });
    await t.worker.tick();
    await settle();
    await t.worker.tick();
    expect(last(t.sent).jobs).toEqual([{ id: 'j1', status: 'running', runId: 'run-j1', branch: 'cez/abc' }]);
  });

  it('subtracts jobs still being set up (cloning) from the free capacity it advertises', async () => {
    let release: (id: string) => void = () => {};
    const t = setup({ start: () => new Promise((r) => { release = r; }) });
    t.reply({ assigned: [job('j1')] });
    await t.worker.tick();
    await t.worker.tick();
    expect(last(t.sent).capacity).toEqual({ free: 1, max: 2 });
    release('run-j1');
    await settle();
    await t.worker.tick();
    expect(last(t.sent).capacity.free).toBe(2);
  });

  it('does not start an assignment it already holds (redelivery)', async () => {
    let starts = 0;
    const t = setup();
    const start = t.host.start;
    t.host.start = async (j) => { starts++; return start(j); };
    t.reply({ assigned: [job('j1')] });
    await t.worker.tick();
    t.reply({ assigned: [job('j1')] });
    await t.worker.tick();
    expect(starts).toBe(1);
  });

  it('maps a settled run to done with the draft PR url, then forgets it once the hub has seen it', async () => {
    const t = setup();
    t.reply({ assigned: [job('j1')] });
    await t.worker.tick();
    await settle();
    t.runs.set('run-j1', { status: 'done', branch: 'cez/abc' });
    await t.worker.tick();
    expect(last(t.sent).jobs[0]).toMatchObject({ status: 'review' });
    await settle();
    await t.worker.tick();
    expect(last(t.sent).jobs[0]).toMatchObject({ status: 'done', prUrl: 'https://github.com/a/b/pull/1' });
    expect(t.worker.heldJobIds()).toEqual([]);
  });

  it('finishes without a PR when openPr is false or the agent changed nothing', async () => {
    const t = setup({ publish: async () => ({ ok: false, error: 'nothing to propose — cez/abc has no commits' }) });
    t.reply({ assigned: [job('j1'), job('j2', { openPr: false })] });
    await t.worker.tick();
    await settle();
    t.runs.set('run-j1', { status: 'done' });
    t.runs.set('run-j2', { status: 'done' });
    await t.worker.tick();
    await settle();
    await t.worker.tick();
    expect(Object.values(reported(t.sent)).map((j) => [j.id, j.status])).toEqual([['j1', 'done'], ['j2', 'done']]);
  });

  it('maps failed and locally cancelled runs, and PR errors, to failed', async () => {
    const t = setup({ publish: async () => ({ ok: false, error: 'gh not found' }) });
    t.reply({ assigned: [job('j1'), job('j2'), job('j3')] });
    await t.worker.tick();
    await settle();
    t.runs.set('run-j1', { status: 'failed', error: 'boom' });
    t.runs.set('run-j2', { status: 'cancelled' });
    t.runs.set('run-j3', { status: 'done' });
    await t.worker.tick();
    await settle();
    await t.worker.tick();
    const byId = reported(t.sent);
    expect(byId.j1).toMatchObject({ status: 'failed', error: 'boom' });
    expect(byId.j2).toMatchObject({ status: 'failed' });
    expect(byId.j3).toMatchObject({ status: 'failed', error: 'gh not found' });
  });

  it('fails a job whose repo cannot be resolved', async () => {
    const t = setup({ start: async () => { throw new Error('could not clone'); } });
    t.reply({ assigned: [job('j1')] });
    await t.worker.tick();
    await settle();
    await t.worker.tick();
    expect(last(t.sent).jobs[0]).toMatchObject({ status: 'failed', error: 'could not clone' });
  });

  it('cancels the local run on cancel and drop', async () => {
    const t = setup();
    t.reply({ assigned: [job('j1'), job('j2')] });
    await t.worker.tick();
    await settle();
    await t.worker.tick();
    t.reply({ cancel: ['j1'], drop: ['j2'] });
    await t.worker.tick();
    expect(t.calls).toEqual(['cancel run-j1', 'cancel run-j2']);
    expect(t.worker.heldJobIds()).toEqual([]);
  });

  it('cancels the run when the hub cancels a job while its repo is still cloning', async () => {
    let finishClone: (id: string) => void = () => {};
    const t = setup({ start: () => new Promise((r) => { finishClone = r; }) });
    t.reply({ assigned: [job('j1')] });
    await t.worker.tick();
    t.reply({ cancel: ['j1'] });
    await t.worker.tick();
    expect(t.calls).toEqual([]);
    finishClone('run-late');
    await settle();
    expect(t.calls).toEqual(['cancel run-late']);
  });

  it('fails a job past the runtime limit and cancels its run', async () => {
    const clock = { now: 0 };
    const t = setup();
    const worker = new FleetWorker({
      nodeId: 'n1', version: '1', host: t.host, jobTimeoutMs: 1000, now: () => clock.now,
      transport: async (hb) => { t.sent.push(hb); return t.sent.length === 1 ? { assigned: [job('j1')], cancel: [], drop: [] } : { assigned: [], cancel: [], drop: [] }; },
      capacity: () => ({ free: 2, max: 2 }),
    });
    await worker.tick();
    await settle();
    clock.now = 5000;
    await worker.tick();
    expect(last(t.sent).jobs[0]).toMatchObject({ id: 'j1', status: 'failed' });
    expect(last(t.sent).jobs[0]?.error).toContain('limit');
    expect(t.calls).toEqual(['cancel run-j1']);
  });

  it('counts a run queued behind the local semaphore as used capacity', async () => {
    const t = setup();
    t.reply({ assigned: [job('j1')] });
    await t.worker.tick();
    await settle();
    t.runs.set('run-j1', { status: 'queued' });
    await t.worker.tick();
    expect(last(t.sent).capacity.free).toBe(1);
  });

  it('adopts a recovered run: reports it, and keeps it while the hub still assigns it here', async () => {
    const t = setup();
    t.runs.set('run-old', { status: 'running', branch: 'cez/old' });
    t.worker.adopt([{ jobId: 'j9', runId: 'run-old', openPr: true }]);
    await t.worker.tick();
    expect(last(t.sent).jobs).toEqual([{ id: 'j9', status: 'running', runId: 'run-old', branch: 'cez/old' }]);
    expect(t.calls).toEqual([]);
    expect(t.worker.heldJobIds()).toEqual(['j9']);
  });

  it('cancels an adopted run the hub no longer assigns to this node', async () => {
    const t = setup();
    t.runs.set('run-old', { status: 'running' });
    t.worker.adopt([{ jobId: 'j9', runId: 'run-old', openPr: true }]);
    t.reply({ drop: ['j9'] });
    await t.worker.tick();
    expect(t.calls).toEqual(['cancel run-old']);
    expect(t.worker.heldJobIds()).toEqual([]);
  });

  it('publishes an adopted run that finished while the node was down', async () => {
    const t = setup();
    t.runs.set('run-old', { status: 'review' });
    t.worker.adopt([{ jobId: 'j9', runId: 'run-old', openPr: true }]);
    await t.worker.tick();
    await settle();
    await t.worker.tick();
    expect(reported(t.sent).j9).toMatchObject({ status: 'done', prUrl: 'https://github.com/a/b/pull/1' });
  });

  it('reports a pushed branch page for hosts without pull requests', async () => {
    const t = setup({ publish: async () => ({ ok: true, branchUrl: 'https://gitlab.com/g/r/-/tree/cez/x' }) });
    t.reply({ assigned: [job('j1')] });
    await t.worker.tick();
    await settle();
    t.runs.set('run-j1', { status: 'done', branch: 'cez/x' });
    await t.worker.tick();
    await settle();
    await t.worker.tick();
    expect(reported(t.sent).j1).toMatchObject({ status: 'done', branch: 'cez/x', branchUrl: 'https://gitlab.com/g/r/-/tree/cez/x' });
    expect(reported(t.sent).j1).not.toHaveProperty('prUrl');
  });

  it('survives an unreachable hub and keeps its jobs for the next beat', async () => {
    let down = false;
    const t = setup();
    const flaky = new FleetWorker({
      nodeId: 'n1', version: '1',
      host: { start: async () => 'r', get: () => ({ status: 'running' }), cancel: () => {}, recover: async () => [], publish: async () => ({ ok: false, error: 'x' }) },
      transport: async () => {
        if (down) throw new Error('down');
        return { assigned: [job('j1')], cancel: [], drop: [] };
      },
      capacity: () => ({ free: 1, max: 1 }),
    });
    await flaky.tick();
    down = true;
    await expect(flaky.tick()).resolves.toBeUndefined();
    expect(flaky.heldJobIds()).toEqual(['j1']);
    expect(t.worker.heldJobIds()).toEqual([]);
  });
});

describe('localCapacity', () => {
  it('is max minus busy, never negative', () => {
    expect(localCapacity({ maxParallel: () => 4, busy: () => 1 })).toEqual({ free: 3, max: 4 });
    expect(localCapacity({ maxParallel: () => 2, busy: () => 5 })).toEqual({ free: 0, max: 2 });
  });
  it('prefers the main pool when the semaphore has per-pool limits', () => {
    expect(localCapacity({
      maxParallel: () => 9, busy: () => 9, freeCapacity: () => ({ main: 2 }), effectiveLimits: () => ({ main: 3 }),
    })).toEqual({ free: 2, max: 3 });
  });
});

describe('repoKey', () => {
  it('gives one key to every spelling of a GitHub remote', () => {
    const keys = ['https://github.com/Acme/Demo.git', 'git@github.com:acme/demo.git', 'ssh://git@github.com/acme/demo', 'acme/demo'].map(repoKey);
    expect(new Set(keys)).toEqual(new Set(['github.com/acme/demo']));
  });
  it('is null for something that is not a repo', () => {
    expect(repoKey('/local/path')).toBeNull();
  });
});
