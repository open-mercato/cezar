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
  const savedRejectStart = process.env.MOCK_CODEX_REJECT_START;
  const savedDisableRepoLock = process.env.CEZ_DISABLE_REPO_LOCK;

  beforeEach(async () => {
    process.env.CEZ_CODEX_BIN = MOCK_CODEX;
    process.env.CEZ_ENV_PASSTHROUGH = 'MOCK_CODEX_REJECT_RESUME,MOCK_CODEX_REJECT_START';
    process.env.MOCK_CODEX_REJECT_RESUME = '1';
    delete process.env.MOCK_CODEX_REJECT_START;
    process.env.CEZ_DISABLE_REPO_LOCK = '1';
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
    if (savedRejectStart === undefined) delete process.env.MOCK_CODEX_REJECT_START;
    else process.env.MOCK_CODEX_REJECT_START = savedRejectStart;
    if (savedDisableRepoLock === undefined) delete process.env.CEZ_DISABLE_REPO_LOCK;
    else process.env.CEZ_DISABLE_REPO_LOCK = savedDisableRepoLock;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('falls back once for a missing session and does not retry it on the next boot', async () => {
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
    await expect.poll(() => store.getRun(record.id)?.status, { timeout: 5_000 }).toBe('waiting');
    expect(store.getRun(record.id)?.error).toBeUndefined();
    expect(store.getRun(record.id)?.steps.filter((step) => step.id.startsWith('continue-'))).toHaveLength(1);
    expect(store.getRun(record.id)?.steps.find((step) => step.id === 'continue-1')?.status).toBe('waiting');
    firstManager.dispose();

    const secondManager = new RunManager(store, repoRoot);
    await secondManager.recover();
    expect(store.getRun(record.id)?.status).toBe('done');
    expect(store.getRun(record.id)?.steps.filter((step) => step.id.startsWith('continue-'))).toHaveLength(1);
    secondManager.dispose();
  });

  it('keeps recovery failed when the fresh fallback session has a genuine nonmissing failure', async () => {
    process.env.MOCK_CODEX_REJECT_START = '1';
    const record = store.createRun({
      title: 'fallback failure', workflow: 'quick-task', task: 'continue safely', runner: 'codex',
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
    });
    store.updateStep(record.id, 'work', {
      status: 'running', iterations: 1, sessionId: 'missing-thread', backend: 'codex',
    });
    store.updateRun(record.id, { status: 'running', currentStepId: 'work' });
    const manager = new RunManager(store, repoRoot);
    await manager.recover();
    await expect.poll(() => store.getRun(record.id)?.status, { timeout: 5_000 }).toBe('failed');
    expect(store.getRun(record.id)?.error).toContain('authentication failed: session token missing');
    expect(store.getRun(record.id)?.steps.filter((step) => step.id.startsWith('continue-'))).toHaveLength(1);
    manager.dispose();
  });
});
