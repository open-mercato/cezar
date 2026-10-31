import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listTaskProcesses } from '../core/task-processes.ts';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';

/** #1411: a process a task left running — re-parented by `setsid`, as in the issue — is stopped. */
describe.runIf(process.platform === 'linux')('recover() reaps processes left by settled tasks', () => {
  let dataRoot: string;
  let store: RunStore;
  const spawned: string[] = [];

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'cez-leftover-'));
    mkdirSync(join(dataRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(dataRoot, '.ai/cezar'));
  });

  afterEach(async () => {
    store.flush();
    for (const p of await listTaskProcesses()) {
      if (!spawned.includes(p.taskId)) continue;
      try {
        process.kill(p.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    spawned.length = 0;
    delete process.env.CEZ_TASK_PROCESS_REAP;
    rmSync(dataRoot, { recursive: true, force: true });
  });

  const leave = async (taskId: string): Promise<void> => {
    spawned.push(taskId);
    spawn('setsid', ['sleep', '100000'], { env: { ...process.env, CEZ_TASK_ID: taskId }, detached: true, stdio: 'ignore' }).unref();
    await until(async () => await running(taskId));
  };
  const running = async (taskId: string): Promise<boolean> =>
    (await listTaskProcesses()).some((p) => p.taskId === taskId && p.command.includes('sleep 100000'));
  const until = async (check: () => Promise<boolean>, ms = 8_000): Promise<boolean> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };
  const lifecycle = (id: string): string[] => {
    const file = join(dataRoot, '.ai/cezar/runs', `${id}.ndjson`);
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; message?: string })
      .filter((e) => e.type === 'lifecycle')
      .map((e) => String(e.message));
  };
  const makeRun = (status: 'done' | 'queued'): string => {
    const { id } = store.createRun({ title: 't', workflow: 'quick-task', task: 'x', steps: [{ id: 'work', name: 'Work', kind: 'agent' }] });
    store.updateRun(id, { status });
    return id;
  };
  const manager = () => new RunManager(store, dataRoot, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }) });

  it('stops a settled run’s leftover and notes it, leaving live and foreign tasks alone', async () => {
    const settled = makeRun('done');
    const queued = makeRun('queued');
    const foreign = randomUUID();
    await leave(settled);
    await leave(queued);
    await leave(foreign);

    await manager().recover();

    expect(await until(async () => !(await running(settled)))).toBe(true);
    expect(await until(async () => lifecycle(settled).some((m) => m.startsWith('stopped 1 process: sleep 100000')))).toBe(true);
    expect(await running(queued)).toBe(true);
    expect(await running(foreign)).toBe(true);
  });

  it('reaps nothing with CEZ_TASK_PROCESS_REAP=0', async () => {
    process.env.CEZ_TASK_PROCESS_REAP = '0';
    const settled = makeRun('done');
    await leave(settled);

    await manager().recover();
    await new Promise((r) => setTimeout(r, 1_000));

    expect(await running(settled)).toBe(true);
    expect(lifecycle(settled).some((m) => m.startsWith('stopped'))).toBe(false);
  });
});
