import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import {
  MAX_AUTO_CONTINUES,
  MONITORING_PR_PROBE_TIMEOUT_MS,
  MONITORING_PR_QUIET_CHECKS,
  RunManager,
  type PrWatchProbe,
} from './run.ts';
import type { WorkflowDef } from './types.ts';

// #2040: a monitoring wake-up on a run with a declared PR spends a model turn only when the PR
// changed since the park; a fake forge stands in for `gh`, the mock agent for the model.
const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const SINGLE_STEP: WorkflowDef = {
  name: 'quick-task',
  source: 'built-in',
  steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
};
const TICK = 5 * 60_000;
const PR = 4242;

interface WatchState {
  monitoringWakeTimer?: NodeJS.Timeout;
  monitoringWakeups?: number;
  session?: { open: boolean };
}

describe('a monitoring wake-up on a watched PR', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let currentId: string | undefined;
  let savedDryRun: string | undefined;
  let savedSwitch: string | undefined;
  let fingerprint: string | null;
  let probes: number[];

  const boot = (probe: PrWatchProbe = async (_root, pr) => {
    probes.push(pr);
    return fingerprint;
  }) => {
    manager?.dispose();
    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { monitoringWakeIntervalMinutes: 5 } }),
      prWatchProbe: probe,
    });
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-monitor-pr-'));
    savedDryRun = process.env.CEZ_DRY_RUN;
    savedSwitch = process.env.CEZ_MONITORING_PR_WATCH;
    process.env.CEZ_DRY_RUN = '1';
    delete process.env.CEZ_MONITORING_PR_WATCH;
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    currentId = undefined;
    fingerprint = 'pending';
    probes = [];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (currentId) manager.cancel(currentId);
    manager.dispose();
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    if (savedSwitch === undefined) delete process.env.CEZ_MONITORING_PR_WATCH;
    else process.env.CEZ_MONITORING_PR_WATCH = savedSwitch;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const waitFor = async (pred: () => boolean, ms = 15_000) => {
    const deadline = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error('condition not met in time');
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const settle = () => new Promise((r) => setTimeout(r, 300));
  const stateOf = (id: string) => (manager as unknown as { active: Map<string, WatchState> }).active.get(id);
  const notes = (id: string) => {
    const path = join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`);
    if (!existsSync(path)) return [] as string[];
    return readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; message?: string })
      .filter((event) => event.type === 'note')
      .map((event) => String(event.message));
  };
  const wakes = (id: string) => notes(id).filter((n) => n.startsWith('automatic monitoring wake-up ('));
  const quietChecks = (id: string) => notes(id).filter((n) => n.startsWith('automatic monitoring check ('));
  const isMonitoring = (r: RunRecord | undefined) => r?.activity === 'monitoring';
  const startMonitor = async (task = `mock:monitoring-sticky wait for CI on PR #${PR}`) => {
    const record = manager.startRun(SINGLE_STEP, { task, worktree: false });
    currentId = record.id;
    await waitFor(() => isMonitoring(store.getRun(record.id)) && stateOf(record.id)?.monitoringWakeTimer !== undefined);
    return record.id;
  };
  /** One interval: the timer fires, the fake forge answers, the run re-parks either way. */
  const tick = async (id: string) => {
    vi.advanceTimersByTime(TICK);
    await settle();
    await waitFor(() => isMonitoring(store.getRun(id)) && stateOf(id)?.monitoringWakeTimer !== undefined);
  };

  it('observes a pending PR without starting a model turn', async () => {
    boot();
    const id = await startMonitor();
    expect(store.getRun(id)?.prNumber).toBe(PR);
    for (let n = 0; n < 3; n += 1) await tick(id);
    expect(wakes(id)).toEqual([]);
    expect(quietChecks(id)).toEqual([1, 2, 3].map(
      (n) => `automatic monitoring check (${n}/${MAX_AUTO_CONTINUES}): PR #${PR} unchanged — no model turn`,
    ));
    // Quiet checks keep today's ceiling: they are counted like the wake-ups they replace.
    expect(stateOf(id)?.monitoringWakeups).toBe(3);
    expect(probes.every((pr) => pr === PR)).toBe(true);
  }, 60_000);

  it.each([
    ['a check finishing', 'failed'],
    ['a new head', 'head-2'],
  ])('wakes the agent once on %s', async (_name, next) => {
    boot();
    const id = await startMonitor();
    await tick(id);
    fingerprint = next;
    await tick(id);
    expect(wakes(id)).toEqual([`automatic monitoring wake-up (2/${MAX_AUTO_CONTINUES})`]);
    // The woken turn re-parked on the new state; it is the baseline now, so no follow-up wake.
    await tick(id);
    await tick(id);
    expect(wakes(id)).toHaveLength(1);
    expect(quietChecks(id)).toHaveLength(3);
  }, 60_000);

  it('degrades to a wake-up every interval when the forge cannot answer', async () => {
    fingerprint = null;
    boot();
    const id = await startMonitor();
    await tick(id);
    await tick(id);
    expect(wakes(id)).toEqual([1, 2].map((n) => `automatic monitoring wake-up (${n}/${MAX_AUTO_CONTINUES})`));
    expect(quietChecks(id)).toEqual([]);
  }, 60_000);

  it('degrades the same when the probe itself throws', async () => {
    boot(async () => {
      throw new Error('gh exploded');
    });
    const id = await startMonitor();
    await tick(id);
    expect(wakes(id)).toEqual([`automatic monitoring wake-up (1/${MAX_AUTO_CONTINUES})`]);
  }, 60_000);

  it('wakes as before when the forge never answers, instead of losing the park’s only exit', async () => {
    let calls = 0;
    boot(async () => {
      calls += 1;
      return calls === 1 ? 'pending' : new Promise<string>(() => {});
    });
    const id = await startMonitor();
    vi.advanceTimersByTime(TICK);
    await waitFor(() => calls === 2);
    expect(wakes(id)).toEqual([]);
    vi.advanceTimersByTime(MONITORING_PR_PROBE_TIMEOUT_MS);
    await waitFor(() => wakes(id).length === 1);
    expect(wakes(id)).toEqual([`automatic monitoring wake-up (1/${MAX_AUTO_CONTINUES})`]);
  }, 60_000);

  it('still wakes after a run of quiet checks, for waits the fingerprint cannot see', async () => {
    boot();
    const id = await startMonitor();
    for (let n = 0; n < MONITORING_PR_QUIET_CHECKS; n += 1) await tick(id);
    expect(wakes(id)).toEqual([]);
    await tick(id);
    expect(wakes(id)).toEqual([`automatic monitoring wake-up (${MONITORING_PR_QUIET_CHECKS + 1}/${MAX_AUTO_CONTINUES})`]);
  }, 60_000);

  it('hands off at the cap exactly as today when quiet checks spend it', async () => {
    boot();
    const id = await startMonitor();
    const state = stateOf(id);
    if (!state) throw new Error('no active state');
    state.monitoringWakeups = MAX_AUTO_CONTINUES - 1;
    vi.advanceTimersByTime(TICK);
    await waitFor(() => store.getRun(id)?.status === 'waiting');
    expect(state.monitoringWakeups).toBe(MAX_AUTO_CONTINUES);
    expect(quietChecks(id)).toHaveLength(1);
    expect(store.getRun(id)?.monitoringWakeCapReached).toBe(true);
    expect(wakes(id)).toEqual([]);
  }, 60_000);

  it('a user message during an in-flight check wins; the late answer wakes nothing', async () => {
    let release: (value: string) => void = () => {};
    let calls = 0;
    boot(async () => {
      calls += 1;
      // The baseline answers at once; the timer's check hangs until released.
      if (calls === 2) return new Promise<string>((resolve) => { release = resolve; });
      return 'pending';
    });
    const id = await startMonitor();
    vi.advanceTimersByTime(TICK);
    await waitFor(() => calls === 2);
    expect(manager.sendMessage(id, [{ type: 'text', text: 'status?' }])).toBe(true);
    await waitFor(() => isMonitoring(store.getRun(id)) && stateOf(id)?.monitoringWakeTimer !== undefined);
    release('changed');
    await settle();
    expect(wakes(id)).toEqual([]);
    expect(quietChecks(id)).toEqual([]);
    expect(stateOf(id)?.monitoringWakeups).toBe(0);
  }, 60_000);

  it('keeps today’s wake-up on every interval for a run with no PR', async () => {
    boot();
    const id = await startMonitor('mock:monitoring-sticky watch the build');
    expect(store.getRun(id)?.prNumber).toBeUndefined();
    await tick(id);
    expect(wakes(id)).toEqual([`automatic monitoring wake-up (1/${MAX_AUTO_CONTINUES})`]);
    expect(probes).toEqual([]);
  }, 60_000);

  it('keeps today’s wake-up when CEZ_MONITORING_PR_WATCH=0', async () => {
    process.env.CEZ_MONITORING_PR_WATCH = '0';
    boot();
    const id = await startMonitor();
    await tick(id);
    expect(wakes(id)).toEqual([`automatic monitoring wake-up (1/${MAX_AUTO_CONTINUES})`]);
    expect(probes).toEqual([]);
  }, 60_000);
});
