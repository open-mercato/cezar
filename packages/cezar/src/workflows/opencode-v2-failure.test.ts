import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';

describe('Cezar task outcome for OpenCode V2 internal execution failures', () => {
  let root: string | undefined;
  let store: RunStore | undefined;
  let manager: RunManager | undefined;

  afterEach(() => {
    manager?.dispose();
    store?.flush();
    vi.unstubAllEnvs();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('marks the task failed after HTTP 200 when the native agent execution fails, and never runs the next check', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '0');
    vi.stubEnv('CEZ_OPENCODE_BIN', join(dirname(fileURLToPath(import.meta.url)), '../core/__fixtures__/opencode/mock-opencode-v2-serve.mjs'));
    root = mkdtempSync(join(tmpdir(), 'cez-v2-execution-failure-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    writeFileSync(join(root, 'README.md'), 'fixture\n');
    execFileSync('git', ['add', 'README.md'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'base'], { cwd: root });
    store = RunStore.open(join(root, '.ai/cezar'));
    manager = new RunManager(store, root, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 1 } }) });
    const task = manager.startRun({
      name: 'V2 internal failure', source: 'built-in', steps: [
        { id: 'agent', runner: 'opencode', prompt: '{{task}}' },
        { id: 'check', command: 'touch incorrectly-succeeded' },
      ],
    }, { task: '#error', runner: 'opencode', model: 'mock/mock-model#high', worktree: false });
    await expect.poll(() => store!.getRun(task.id)?.status, { timeout: 10_000 }).toBe('failed');
    expect(store.getRun(task.id)?.steps[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('invalid API key') });
    expect(store.getRun(task.id)?.steps[1]?.status).not.toBe('done');
    expect(existsSync(join(root, 'incorrectly-succeeded'))).toBe(false);
  }, 15_000);
});
