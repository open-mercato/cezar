import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK_CODEX = join(HERE, '..', 'core', '__fixtures__', 'codex', 'mock-codex-app-server.mjs');

describe('recover() contains backend session failures (#562)', () => {
  let repoRoot: string;
  let store: RunStore;
  const savedBin = process.env.CEZ_CODEX_BIN;
  const savedPassthrough = process.env.CEZ_ENV_PASSTHROUGH;
  const savedReject = process.env.MOCK_CODEX_REJECT_RESUME;

  beforeEach(async () => {
    process.env.CEZ_CODEX_BIN = MOCK_CODEX;
    process.env.CEZ_ENV_PASSTHROUGH = 'MOCK_CODEX_REJECT_RESUME';
    process.env.MOCK_CODEX_REJECT_RESUME = '1';
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-recover-session-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });

  afterEach(() => {
    if (savedBin === undefined) delete process.env.CEZ_CODEX_BIN;
    else process.env.CEZ_CODEX_BIN = savedBin;
    if (savedPassthrough === undefined) delete process.env.CEZ_ENV_PASSTHROUGH;
    else process.env.CEZ_ENV_PASSTHROUGH = savedPassthrough;
    if (savedReject === undefined) delete process.env.MOCK_CODEX_REJECT_RESUME;
    else process.env.MOCK_CODEX_REJECT_RESUME = savedReject;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('marks one recovery continuation failed and does not retry it on the next boot', async () => {
    const record = store.createRun({
      title: 't',
      workflow: 'quick-task',
      task: 'continue safely',
      runner: 'codex',
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
    });
    store.updateStep(record.id, 'work', {
      status: 'running',
      iterations: 1,
      sessionId: 'missing-thread',
      backend: 'codex',
    });
    store.updateRun(record.id, { status: 'running', currentStepId: 'work' });

    const firstManager = new RunManager(store, repoRoot);
    await firstManager.recover();
    await expect
      .poll(() => store.getRun(record.id)?.error, { timeout: 5_000 })
      .toContain('no rollout found for thread id missing-thread');
    expect(store.getRun(record.id)?.status).toBe('failed');
    expect(store.getRun(record.id)?.error).toContain('no rollout found for thread id missing-thread');
    expect(store.getRun(record.id)?.steps.filter((step) => step.id.startsWith('continue-'))).toHaveLength(1);
    firstManager.dispose();

    const secondManager = new RunManager(store, repoRoot);
    await secondManager.recover();
    expect(store.getRun(record.id)?.steps.filter((step) => step.id.startsWith('continue-'))).toHaveLength(1);
    secondManager.dispose();
  });
});
