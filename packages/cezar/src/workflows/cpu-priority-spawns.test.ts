import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const osMock = vi.hoisted(() => ({ setPriority: vi.fn() }));
vi.mock('node:os', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:os')>()), ...osMock }));

import { constants } from 'node:os';
import { executeLifecycleCommand } from '../worktree-lifecycle/executor.ts';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

/** Spec 2026-10-21-host-resource-limits: check steps and lifecycle commands run at the agent
 *  priority too, since repo test/build commands are often the heaviest CPU users. */
const dirs: string[] = [];
beforeEach(() => {
  osMock.setPriority.mockReset();
  vi.stubEnv('CEZ_DRY_RUN', '0');
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) try { rmSync(d, { recursive: true, force: true }); } catch { /* Windows holds the dir briefly */ }
});

describe('priority on non-agent spawns', () => {
  it('a lifecycle command is reniced after spawn, and left alone by default', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cez-prio-lc-'));
    dirs.push(cwd);
    await executeLifecycleCommand({ command: 'true', cwd, cpuPriority: 'low' });
    expect(osMock.setPriority).toHaveBeenCalledWith(expect.any(Number), constants.priority.PRIORITY_BELOW_NORMAL);
    osMock.setPriority.mockReset();
    await executeLifecycleCommand({ command: 'true', cwd });
    expect(osMock.setPriority).not.toHaveBeenCalled();
  }, 30_000);

  it('a workflow check step is reniced to the configured agent priority', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-prio-check-'));
    dirs.push(root);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@l', 'commit', '--allow-empty', '-q', '-m', 'b'], { cwd: root });
    const store = RunStore.open(join(root, '.ai/cezar'));
    const manager = new RunManager(store, root, {
      semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 2, agentCpuPriority: 'idle' } }),
    });
    const wf: WorkflowDef = { name: 'c', source: 'built-in', steps: [{ id: 'k', command: 'node -e ""' }] };
    try {
      const run = manager.startRun(wf, { task: 'check' });
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && !['done', 'failed'].includes(store.getRun(run.id)?.status ?? '')) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(osMock.setPriority).toHaveBeenCalledWith(expect.any(Number), constants.priority.PRIORITY_LOW);
    } finally {
      store.flush();
      manager.dispose();
    }
  }, 45_000);
});
