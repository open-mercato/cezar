import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { liveCheckCount } from './check-process.ts';
import { RunManager } from './run.ts';

const git = promisify(execFile);

it.skipIf(process.platform === 'win32')('uses the check run marker and closes the check on cancellation', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'cez-check-cancel-'));
  vi.stubEnv('CEZ_DRY_RUN', '1');
  vi.stubEnv('CEZ_TASK_ID', 'outer-task');
  vi.stubEnv('cez_task_id', 'outer-task');
  let store: RunStore | undefined;
  let manager: RunManager | undefined;
  try {
    await git('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await git('git', ['add', '-A'], { cwd: repoRoot });
    await git('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
    const record = manager.startRun({
      name: 'check-only',
      source: 'file',
      steps: [{
        id: 'verify',
        name: 'Verify',
        command: 'printf "%s\\n" "$CEZ_RUN_ID" "${CEZ_TASK_ID-unset}" "${cez_task_id-unset}" > check-context; exec sleep 30',
      }],
    }, { task: 'x', worktree: false });

    try {
      await vi.waitFor(() => {
        expect(readFileSync(join(repoRoot, 'check-context'), 'utf8')).toBe(`${record.id}\nunset\nunset\n`);
      }, { timeout: 10_000 });
      expect(liveCheckCount()).toBe(1);
    } finally {
      expect(await manager.cancelAndWait(record.id)).toBe(true);
      await vi.waitFor(() => expect(liveCheckCount()).toBe(0), { timeout: 10_000 });
    }
    expect(store.getRun(record.id)?.status).toBe('cancelled');
  } finally {
    manager?.dispose();
    store?.flush();
    vi.unstubAllEnvs();
    rmSync(repoRoot, { recursive: true, force: true });
  }
}, 30_000);
