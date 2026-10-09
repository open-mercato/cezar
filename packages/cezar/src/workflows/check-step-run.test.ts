import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const TERMINAL = new Set(['done', 'review', 'failed', 'cancelled']);

describe('check steps are bounded in time, output and environment', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const savedEnv: Record<string, string | undefined> = {};
  const setEnv = (key: string, value: string) => {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    process.env[key] = value;
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-check-bounds-'));
    setEnv('CEZ_DRY_RUN', '1');
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    manager.dispose();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      delete savedEnv[key];
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const settle = async (id: string, ms: number) => {
    const deadline = Date.now() + ms;
    while (!TERMINAL.has(store.getRun(id)?.status ?? '')) {
      if (Date.now() > deadline) {
        manager.cancel(id);
        throw new Error(`run still ${store.getRun(id)?.status} after ${ms} ms`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    return store.getRun(id)!;
  };

  it('injects a bounded, ANSI-free failure into the retried prompt for a 200 KB burst', async () => {
    const stdinFile = join(repoRoot, 'stdin.ndjson');
    setEnv('CEZ_MOCK_STDIN_FILE', stdinFile);
    let burst = '';
    while (burst.length < 200_000) burst += `\u001b[31mFAIL\u001b[0m src/x.test.ts > case ${burst.length}\n`;
    burst += 'AssertionError: expected 1 to be 2\n';
    writeFileSync(join(repoRoot, 'burst.txt'), burst);
    const workflow: WorkflowDef = {
      name: 'implement-verify',
      source: 'file',
      steps: [
        { id: 'implement', prompt: '{{task}}' },
        { id: 'verify', command: 'cat burst.txt; exit 1', onFail: { retry: 'implement', max: 1 } },
      ],
    };
    const record = manager.startRun(workflow, { task: 'mock:done fix it', worktree: false });
    const settled = await settle(record.id, 30_000);
    expect(settled.status).toBe('failed');

    const prompts = readFileSync(stdinFile, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).userText as string);
    const retry = prompts[1]!;
    const injected = retry.slice(retry.indexOf('A verification command failed'));
    expect(injected.length).toBeLessThanOrEqual(20_500);
    expect(injected).not.toContain('\u001b');
    expect(injected).toContain('$ cat burst.txt; exit 1\n(exit code 1)');
    expect(injected.trimEnd().endsWith('AssertionError: expected 1 to be 2')).toBe(true);
    expect(injected).toMatch(/… \d+ lines omitted …/);
  }, 40_000);

  it('runs the command without host variables outside the allowlist', async () => {
    setEnv('CEZ_TEST_UNLISTED_HOST_SECRET_XYZ', 'kept');
    setEnv('UNLISTED_HOST_SECRET_XYZ', 'leaked');
    const workflow: WorkflowDef = {
      name: 'env',
      source: 'file',
      steps: [{ id: 'verify', command: 'test -z "${UNLISTED_HOST_SECRET_XYZ:-}" && test -n "$CEZ_TEST_UNLISTED_HOST_SECRET_XYZ" && test -n "$PATH"' }],
    };
    const record = manager.startRun(workflow, { task: 'x', worktree: false });
    const settled = await settle(record.id, 20_000);
    expect(settled.steps.map((s) => s.status)).toEqual(['done']);
  }, 30_000);

  it.skipIf(process.platform === 'win32')('fails a hung check at its timeout and frees the run', async () => {
    const pidFile = join(repoRoot, 'bg.pid');
    const workflow: WorkflowDef = {
      name: 'hang',
      source: 'file',
      steps: [{ id: 'verify', command: `sleep 600 & echo $! > ${pidFile}; sleep 600`, timeoutMs: 300 }],
    };
    const record = manager.startRun(workflow, { task: 'x', worktree: false });
    const settled = await settle(record.id, 10_000);
    expect(settled.status).toBe('failed');
    expect(settled.steps[0]?.error).toMatch(/timed out after 300 ms and was killed$/);
    const bg = Number(readFileSync(pidFile, 'utf8').trim());
    await new Promise((r) => setTimeout(r, 100));
    expect(() => process.kill(bg, 0)).toThrow();
  }, 20_000);
});
