import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

/**
 * The check step as the ENGINE uses it (#landing-check S1): the seam's
 * outcomes must survive the trip through the workflow run loop, and the three
 * that are not exit codes — the dry-run skip, the per-command timeout and the
 * gate deadline — must never end a run green.
 *
 * The seam's own mechanics live in `check-runner.test.ts`; this file is about
 * the run record, the step rail's vocabulary and the config keys a user sets.
 */
const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const posix = describe.skipIf(process.platform === 'win32');

let repoRoot: string;
let configPath: string;
let store: RunStore;
let manager: RunManager;
let currentId: string | undefined;
const savedEnv: Record<string, string | undefined> = {};

const TERMINAL = new Set(['done', 'review', 'failed', 'cancelled']);

const waitFor = async (id: string, predicate: (record: RunRecord | undefined) => boolean, ms = 30_000) => {
  const deadline = Date.now() + ms;
  while (!predicate(store.getRun(id))) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 50));
  }
};

const settle = (id: string): Promise<void> => waitFor(id, (r) => TERMINAL.has(r?.status ?? ''));

const events = (id: string): Array<Record<string, unknown>> =>
  readFileSync(join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

beforeEach(async () => {
  repoRoot = mkdtempSync(join(tmpdir(), 'cez-check-step-'));
  savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
  delete process.env.CEZ_DRY_RUN;
  await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
  await run('git', ['add', '-A'], { cwd: repoRoot });
  await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
  mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
  configPath = join(repoRoot, '.ai/cezar/config.json');
  store = RunStore.open(join(repoRoot, '.ai/cezar'));
  manager = new RunManager(store, repoRoot);
  currentId = undefined;
});

afterEach(() => {
  if (currentId) manager.cancel(currentId);
  manager.dispose();
  if (savedEnv.CEZ_DRY_RUN === undefined) delete process.env.CEZ_DRY_RUN;
  else process.env.CEZ_DRY_RUN = savedEnv.CEZ_DRY_RUN;
  store.flush();
  rmSync(repoRoot, { recursive: true, force: true });
});

const checkWorkflow = (...commands: string[]): WorkflowDef => ({
  name: 'check-steps',
  source: 'built-in',
  steps: commands.map((command, i) => ({ id: `check-${i + 1}`, name: `Check ${i + 1}`, command })),
});

posix('check steps through the run loop', () => {
  it('still runs a passing check to a green run (the ordinary path is untouched)', async () => {
    const record = manager.startRun(checkWorkflow('echo all good'), { task: 'verify', worktree: false });
    currentId = record.id;
    await settle(record.id);
    expect(store.getRun(record.id)?.status).toBe('done');
    expect(store.getRun(record.id)?.steps.map((s) => s.status)).toEqual(['done']);
    const output = events(record.id).find((e) => e.type === 'check-output');
    expect(output?.exitCode).toBe(0);
    expect(output?.status).toBe('passed');
    expect(String(output?.text)).toContain('all good');
  });

  it('CEZ_DRY_RUN=1 spawns nothing, records a skipped step and never reports the run green', async () => {
    process.env.CEZ_DRY_RUN = '1';
    const record = manager.startRun(
      checkWorkflow(`node -e "require('fs').writeFileSync('ran', 'yes')"`),
      { task: 'verify', worktree: false },
    );
    currentId = record.id;
    await settle(record.id);

    // Nothing ran — the observable proof is the file the command would have made.
    expect(existsSync(join(repoRoot, 'ran'))).toBe(false);

    const final = store.getRun(record.id);
    expect(final?.status).toBe('failed');
    expect(final?.error).toMatch(/skipped \(CEZ_DRY_RUN=1\)/);
    expect(final?.steps.map(({ id, status }) => ({ id, status }))).toEqual([{ id: 'check-1', status: 'skipped' }]);

    // The skip is on the wire too, and it is not an exit-code-zero pass.
    const output = events(record.id).find((e) => e.type === 'check-output');
    expect(output?.status).toBe('skipped');
    expect(output?.exitCode).toBe(-1);
    expect(String(output?.text)).toMatch(/nothing was run/);
    expect(final?.status === 'done').toBe(false);
  }, 30_000);

  it('a command that outlives "checkTimeoutMs" fails the step with a distinct, non-green outcome', async () => {
    writeFileSync(configPath, JSON.stringify({ checkTimeoutMs: 400, checkGateTimeoutMs: 60_000 }));
    const started = Date.now();
    const record = manager.startRun(
      checkWorkflow(`node -e "setInterval(() => {}, 1000)"`),
      { task: 'verify', worktree: false },
    );
    currentId = record.id;
    await settle(record.id);

    const final = store.getRun(record.id);
    expect(final?.status).toBe('failed');
    expect(final?.error).toMatch(/timed out/);
    expect(final?.steps[0]?.error).toMatch(/timed out/);
    expect(Date.now() - started).toBeLessThan(20_000);

    const output = events(record.id).find((e) => e.type === 'check-output');
    expect(output?.status).toBe('timed-out');
    expect(output?.exitCode).toBe(-1);
    expect(String(output?.text)).toMatch(/timed out/);
  }, 30_000);

  it('bounds the SUM of the checks: the gate deadline armed on the first check still holds for the second', async () => {
    writeFileSync(configPath, JSON.stringify({ checkTimeoutMs: 60_000, checkGateTimeoutMs: 1_200 }));
    const record = manager.startRun(checkWorkflow('sleep 0.4', 'sleep 2'), { task: 'verify', worktree: false });
    currentId = record.id;
    await settle(record.id);

    const final = store.getRun(record.id);
    expect(final?.status).toBe('failed');
    expect(final?.error).toMatch(/timed out/);
    // The first command really ran (its own limit was 60 s); only the second
    // hit the gate — which is the difference between "a limit" and "a deadline".
    expect(final?.steps.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'check-1', status: 'done' },
      { id: 'check-2', status: 'failed' },
    ]);
    const outputs = events(record.id).filter((e) => e.type === 'check-output');
    expect(outputs[1]?.status).toBe('timed-out');
    expect(String(outputs[1]?.text)).toMatch(/whole-gate deadline/);
  }, 30_000);

  it('is dry-run aware by DEFAULT: `checkTimeoutMs` and `checkGateTimeoutMs` are the documented defaults', async () => {
    const config = await loadConfig(repoRoot);
    expect(config.checkTimeoutMs).toBe(20 * 60_000);
    expect(config.checkGateTimeoutMs).toBe(45 * 60_000);
    // 0 is the documented "no limit" spelling, and it must survive the schema.
    writeFileSync(configPath, JSON.stringify({ checkTimeoutMs: 0, checkGateTimeoutMs: 0 }));
    const off = await loadConfig(repoRoot);
    expect(off.checkTimeoutMs).toBe(0);
    expect(off.checkGateTimeoutMs).toBe(0);
    // A bad value degrades to the default instead of discarding the config.
    writeFileSync(configPath, JSON.stringify({ checkTimeoutMs: -5, maxParallel: 1 }));
    const degraded = await loadConfig(repoRoot);
    expect(degraded.checkTimeoutMs).toBe(20 * 60_000);
    expect(degraded.maxParallel).toBe(1);
  });
});
