import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceConfigPath } from '../paths.ts';
import { RunStore, testCommandFile } from '../runs/store.ts';
import { RELATED_TESTS_COMMAND } from './templates.ts';

const resolveCheckCommand = vi.fn();
vi.mock('./check-instructions.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), resolveCheckCommand }));
const { RunManager } = await import('./run.ts');

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];
const RULE = 'Run only the tests related to the change.';

/** `runCheckStep` around the shared resolver (`check-instructions.ts`), and the record's lifetime. */
describe('check steps under global instructions', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: InstanceType<typeof RunManager>;
  const saved = process.env.CEZ_DRY_RUN;

  beforeEach(() => {
    resolveCheckCommand.mockReset().mockResolvedValue({ command: 'echo REWRITTEN', changed: true, reason: 'related only' });
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-check-instr-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
    writeFileSync(workspaceConfigPath(), JSON.stringify({ version: 1, systemPrompt: RULE }));
  });

  afterEach(() => {
    manager.dispose();
    store.flush();
    rmSync(workspaceConfigPath(), { force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    if (saved === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = saved;
  });

  type CheckResult = { ok: boolean; output: string; exitCode: number; recordedTests: string };
  type Internals = {
    runCheckStep(runId: string, state: object, step: { id: string; command: string }, emit: (event: { type: string; message?: string }) => void): Promise<CheckResult>;
  };
  const internals = () => manager as unknown as Internals;
  const newRun = () => store.createRun({ title: 't', workflow: 'w', task: 'x', steps: [{ id: 'verify', name: 'Verify', kind: 'check' }] });
  const check = async (runId: string, command: string, state: object = { cwd: repoRoot }) => {
    const notes: string[] = [];
    const result = await internals().runCheckStep(runId, state, { id: 'verify', command }, (event) => {
      if (event.type === 'note' && event.message) notes.push(event.message);
    });
    return { ...result, notes };
  };
  const record = (runId: string, text: string) => {
    const file = testCommandFile(join(repoRoot, '.ai/cezar'), runId);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };

  it('runs the rewritten command, says so first in the output, and reports no record it did not run', async () => {
    const r = newRun();
    record(r.id, 'echo RECORDED\n');
    const { ok, output, recordedTests, notes } = await check(r.id, 'echo ORIGINAL');
    expect(ok).toBe(true);
    expect(output).toMatch(/^cezar: the global instructions changed this check from `echo ORIGINAL` to `echo REWRITTEN` \(related only\)\.\nREWRITTEN$/);
    expect(recordedTests).toBe('');
    expect(notes).toContain('$ echo REWRITTEN');
  }, 20_000);

  // #2519 review: the related-tests command is never handed to the rewriter, and the gate reports its record.
  it('leaves a command that reads the record alone, and reports the record it ran', async () => {
    const r = newRun();
    record(r.id, '# focused\necho RECORDED\n');
    const { output, recordedTests } = await check(r.id, RELATED_TESTS_COMMAND);
    expect(resolveCheckCommand).not.toHaveBeenCalled();
    expect(output).toContain('RECORDED');
    expect(recordedTests).toBe('# focused\necho RECORDED');
  }, 20_000);

  it('asks once per command, instructions and changed files in a run', async () => {
    const r = newRun();
    const state = { cwd: repoRoot };
    await check(r.id, 'echo ORIGINAL', state);
    await check(r.id, 'echo ORIGINAL', state);
    expect(resolveCheckCommand).toHaveBeenCalledTimes(1);
    expect(resolveCheckCommand).toHaveBeenCalledWith(expect.objectContaining({ command: 'echo ORIGINAL', instructions: RULE, repoRoot }));
  }, 20_000);

  it('never lets a fork head steer its own check: its file names are untrusted input', async () => {
    const r = newRun();
    store.updateRun(r.id, { untrustedHead: true });
    expect((await check(r.id, 'echo ORIGINAL')).output).toBe('ORIGINAL');
    expect(resolveCheckCommand).not.toHaveBeenCalled();
  }, 20_000);

  it('makes no call without instructions, or with instructions that never mention checks', async () => {
    rmSync(workspaceConfigPath(), { force: true });
    expect((await check(newRun().id, 'echo ORIGINAL')).output).toBe('ORIGINAL');
    writeFileSync(workspaceConfigPath(), JSON.stringify({ version: 1, systemPrompt: 'Write commit messages in Conventional Commits format.' }));
    expect((await check(newRun().id, 'echo ORIGINAL')).output).toBe('ORIGINAL');
    expect(resolveCheckCommand).not.toHaveBeenCalled();
  }, 20_000);

  // Through the step path: a record left before an agent round is gone when the next check runs.
  it('empties the related-tests record when an agent round starts', async () => {
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    const started = manager.startRun(
      {
        name: 'record-lifetime',
        source: 'file',
        steps: [
          { id: 'seed', name: 'Seed', command: 'echo "npm test -- stale.test.ts" > "$CEZ_TEST_COMMAND_FILE"' },
          { id: 'implement', name: 'Implement', prompt: '{{task}}' },
          { id: 'verify', name: 'Verify', command: 'test ! -e "$CEZ_TEST_COMMAND_FILE"' },
        ],
      },
      { task: 'mock:done go' },
    );
    const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
    const deadline = Date.now() + 25_000;
    while (!terminal.has(store.getRun(started.id)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('run did not finish in time');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(store.getRun(started.id)!.steps.map((step) => [step.id, step.status])).toEqual([['seed', 'done'], ['implement', 'done'], ['verify', 'done']]);
  }, 40_000);
});
