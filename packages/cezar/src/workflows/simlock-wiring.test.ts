import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';

/** Against a fake `simlock` on PATH, so the real spawn, parse and release all run (spec 2026-10-30-simlock-zero-config). */
describe('RunManager simlock wiring', () => {
  const saved = { CEZ_SIMLOCK: process.env.CEZ_SIMLOCK, PATH: process.env.PATH, CEZ_HOME: process.env.CEZ_HOME };
  let bin: string;
  let repoRoot: string;
  let home: string;
  let store: RunStore;
  let manager: RunManager;
  const log = () => join(bin, 'calls.log');
  const calls = () => (existsSync(log()) ? readFileSync(log(), 'utf8').trim().split('\n') : []);
  const env = (runId: string) => (manager as unknown as { agentEnv(id: string): Record<string, string> }).agentEnv(runId);

  const installFake = (requesterOf: string) => {
    writeFileSync(join(bin, 'simlock'), `#!/bin/sh
echo "$*" >> "${log()}"
case "$1" in
  daemon) echo '{"devices":[],"leases":[]}' ;;
  list) echo '[{"id":"lse_1","requesterId":"cezar:${requesterOf}"}]' ;;
  release) echo '{"leaseId":"lse_1"}' ;;
esac
`);
    chmodSync(join(bin, 'simlock'), 0o755);
  };

  beforeEach(() => {
    bin = mkdtempSync(join(realpathSync(tmpdir()), 'cez-simlock-bin-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-simlock-repo-'));
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-simlock-home-'));
    process.env.CEZ_HOME = home;
    delete process.env.CEZ_SIMLOCK;
    process.env.PATH = `${bin}${delimiter}${saved.PATH}`;
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    store.flush();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of [bin, repoRoot, home]) rmSync(dir, { recursive: true, force: true });
  });

  const newRun = () => store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });

  it('leaves the agent env untouched without the binary', () => {
    expect(env(newRun().id).SIMLOCK_AGENT_ID).toBeUndefined();
  });

  it('gives every task its own identity once simlock is installed, with no restart', () => {
    const [a, b] = [newRun(), newRun()];
    installFake(a.id);
    expect(env(a.id)).toMatchObject({ SIMLOCK_AGENT_ID: `cezar:${a.id}`, AGENT_DEVICE_SESSION: `cezar-${a.id}` });
    expect(env(b.id).SIMLOCK_AGENT_ID).toBe(`cezar:${b.id}`);
  });

  it('releases the lease once, when the run settles, and notes it', async () => {
    const run = newRun();
    installFake(run.id);
    store.updateRun(run.id, { status: 'running' });
    expect(calls()).toEqual([]);
    store.updateRun(run.id, { status: 'done' });
    await vi.waitFor(() => expect(calls()).toContain('release lse_1'));
    await vi.waitFor(() => expect(JSON.stringify(store.readEvents(run.id))).toContain('released simlock lease lse_1'));
    const count = calls().length;
    store.updateRun(run.id, { title: 'renamed' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls().length).toBe(count);
  });

  it('does not touch a run settled before this process saw it', async () => {
    const run = newRun();
    installFake(run.id);
    const settled = store.getRun(run.id)!;
    (manager as unknown as { simlockUnsettled: Set<string> }).simlockUnsettled.delete(run.id);
    (settled as { status: string }).status = 'done';
    store.emit('run', settled);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls()).toEqual([]);
  });

  it('holds the device across an unanswered question, then releases at the real outcome', async () => {
    const run = newRun();
    installFake(run.id);
    store.updateRun(run.id, { status: 'running' });
    store.updateRun(run.id, { status: 'failed', awaitingAnswerSince: new Date().toISOString() });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls()).toEqual([]);
    store.updateRun(run.id, { status: 'done', awaitingAnswerSince: undefined });
    await vi.waitFor(() => expect(calls()).toContain('release lse_1'));
  });

  it('never spawns with the opt-out set', async () => {
    const run = newRun();
    installFake(run.id);
    process.env.CEZ_SIMLOCK = '0';
    store.updateRun(run.id, { status: 'running' });
    store.updateRun(run.id, { status: 'done' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls()).toEqual([]);
    expect(env(run.id).SIMLOCK_AGENT_ID).toBeUndefined();
  });
});
