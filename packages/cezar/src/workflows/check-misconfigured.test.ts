import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { checkMisconfiguration } from './check-misconfigured.ts';
import { RunManager } from './run.ts';
import { IMPLEMENT_AND_VERIFY, IMPLEMENT_REVIEW_PR, NPM_TEST_CHECK } from './templates.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** What npm 10 prints for `npm test` in a directory with no package.json (exit 254). */
const NPM_ENOENT_OUTPUT = [
  'npm error code ENOENT',
  'npm error syscall open',
  'npm error path /repo/package.json',
  'npm error errno -2',
  "npm error enoent Could not read package.json: Error: ENOENT: no such file or directory, open '/repo/package.json'",
  'npm error enoent This is related to npm not being able to find a file.',
].join('\n');

describe('checkMisconfiguration', () => {
  it('names a command that was not found (exit 127) with the shell wording', () => {
    const reason = checkMisconfiguration('pytest -q', { exitCode: 127, output: 'bash: line 1: pytest: command not found' });
    expect(reason).toContain('`pytest -q`');
    expect(reason).toContain('command not found (exit 127)');
    expect(reason).toContain('bash: line 1: pytest: command not found');
  });

  it('names a command that is not executable (exit 126)', () => {
    expect(checkMisconfiguration('./run-tests.sh', { exitCode: 126, output: 'bash: ./run-tests.sh: Permission denied' })).toContain(
      'not executable (exit 126)',
    );
  });

  it('names a shell that could not be spawned', () => {
    const reason = checkMisconfiguration('npm test', { exitCode: -1, output: 'failed to spawn: spawn bash ENOENT', spawnError: 'spawn bash ENOENT' });
    expect(reason).toBe('`npm test` could not be started (spawn bash ENOENT)');
  });

  it('names npm with no package.json in the working directory', () => {
    expect(checkMisconfiguration('npm test', { exitCode: 254, output: NPM_ENOENT_OUTPUT })).toBe(
      '`npm test` could not run: npm found no package.json in the working directory',
    );
  });

  it('leaves real failures alone: a red test, a signal kill, a timeout', () => {
    expect(checkMisconfiguration('npm test', { exitCode: 1, output: 'FAIL src/a.test.ts\n  expected 1 to be 2' })).toBeUndefined();
    // A killed child reports -1 too, but without a spawn error it is not "could not run".
    expect(checkMisconfiguration('npm test', { exitCode: -1, output: '(no output)' })).toBeUndefined();
    expect(checkMisconfiguration('e2e', { exitCode: 2, output: 'CONFIG_NOT_FOUND' })).toBeUndefined();
  });
});

describe('built-in templates guard npm test on package.json', () => {
  it('uses the guarded command in both test-running templates', () => {
    for (const def of [IMPLEMENT_AND_VERIFY, IMPLEMENT_REVIEW_PR]) {
      const tests = def.graph?.nodes.find((n) => n.id === 'tests');
      expect(tests).toMatchObject({ type: 'check', command: NPM_TEST_CHECK });
    }
  });

  it('skips with a warning and exits 0 when there is no package.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-npm-guard-'));
    try {
      const { stdout } = await run('bash', ['-c', NPM_TEST_CHECK], { cwd: dir });
      expect(stdout).toContain('warning: no package.json');
      expect(stdout).toContain('skipping npm test');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs npm test when there is a package.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-npm-guard-'));
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', private: true, scripts: { test: 'echo RAN_TESTS && exit 3' } }));
      const failed = await run('bash', ['-c', NPM_TEST_CHECK], { cwd: dir }).then(
        () => undefined,
        (err: { code?: number; stdout?: string }) => err,
      );
      // npm's own exit code comes through: the guard never turns a red test green.
      expect(failed?.code).not.toBe(0);
      expect(failed?.stdout).toContain('RAN_TESTS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * Through the engine: a misconfigured check stops the run instead of looping the fixer. Counted
 * in AGENT SESSIONS via `notes.md` (the dry-run mock appends one line per session), as
 * `check-retry-on.test.ts` does.
 */
describe('a check that cannot run stops the workflow as misconfigured', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-misconfigured-'));
    savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
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
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const workflowFor = (command: string): WorkflowDef => ({
    name: 'implement-and-check',
    source: 'file',
    steps: [
      { id: 'implement', name: 'Implement', prompt: '{{task}}' },
      { id: 'tests', name: 'Run tests', command, onFail: { retry: 'implement', max: 2 } },
    ],
  });

  const settle = async (id: string): Promise<void> => {
    const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
    const deadline = Date.now() + 20_000;
    while (!terminal.has(store.getRun(id)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('run did not finish in time');
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  const sessions = () => readFileSync(join(repoRoot, 'notes.md'), 'utf8').trim().split('\n').length;

  it('a command that is not found fails once, names the command, and never runs the fixer', async () => {
    const record = manager.startRun(workflowFor('cez-no-such-test-runner --all'), { task: 'mock:done fix the login bug', worktree: false });
    await settle(record.id);

    const finished = store.getRun(record.id);
    expect(finished?.status).toBe('failed');
    expect(finished?.error).toContain('check "tests" is misconfigured');
    expect(finished?.error).toContain('`cez-no-such-test-runner --all`');
    expect(finished?.error).toContain('command not found');
    const tests = finished?.steps.find((s) => s.id === 'tests');
    expect(tests).toMatchObject({ status: 'failed', iterations: 1 });
    expect(tests?.error).toMatch(/^misconfigured: /);
    expect(finished?.steps.find((s) => s.id === 'implement')?.iterations).toBe(1);
    expect(sessions()).toBe(1);
  }, 30_000);

  it('npm test with no package.json stops as misconfigured (the familywarden case)', async () => {
    const record = manager.startRun(workflowFor('npm test'), { task: 'mock:done fix the login bug', worktree: false });
    await settle(record.id);

    const finished = store.getRun(record.id);
    expect(finished?.status).toBe('failed');
    expect(finished?.error).toContain('npm found no package.json');
    expect(sessions()).toBe(1);
  }, 30_000);

  it('an ordinary red check still loops back to the fixer', async () => {
    const record = manager.startRun(workflowFor('echo FAIL >&2; exit 1'), { task: 'mock:done fix the login bug', worktree: false });
    await settle(record.id);

    const finished = store.getRun(record.id);
    expect(finished?.status).toBe('failed');
    expect(finished?.error).toContain('after 3 attempts');
    expect(finished?.error).not.toContain('misconfigured');
    expect(sessions()).toBe(3);
  }, 40_000);
});
