import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorktreeLifecycleCoordinator } from '../worktree-lifecycle/coordinator.ts';
import { ProjectContexts } from './project-context.ts';

const sweep = vi.hoisted(() => ({ impl: () => Promise.resolve({ orphans: [] as string[], reclaimed: [] as string[] }) }));

vi.mock('../runs/startup-sweep.ts', () => ({
  sweepStartupWorktrees: vi.fn(() => sweep.impl()),
}));
vi.mock('./git.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./git.ts')>()),
  getRepoInfo: vi.fn(async () => ({ branch: 'main' })),
}));

function deferred(): { promise: Promise<{ orphans: string[]; reclaimed: string[] }>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ orphans: string[]; reclaimed: string[] }>((res, rej) => {
    resolve = () => res({ orphans: [], reclaimed: [] });
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flushImmediate = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('ProjectContexts startup sweep ordering', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-ctx-sweep-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  function makeContexts(): ProjectContexts {
    return new ProjectContexts({ listProjects: async () => [{ id: 'a', root, status: 'ok' }] });
  }

  it('starts the lifecycle coordinator only after the startup sweep settles', async () => {
    const start = vi.spyOn(WorktreeLifecycleCoordinator.prototype, 'start').mockImplementation(() => {});
    const pending = deferred();
    sweep.impl = () => pending.promise;
    const contexts = makeContexts();
    await contexts.context('a');
    await flushImmediate();
    expect(start).not.toHaveBeenCalled();
    pending.resolve();
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    contexts.disposeAll();
  });

  it('still starts the coordinator when the sweep fails', async () => {
    const start = vi.spyOn(WorktreeLifecycleCoordinator.prototype, 'start').mockImplementation(() => {});
    const pending = deferred();
    sweep.impl = () => pending.promise;
    const contexts = makeContexts();
    await contexts.context('a');
    pending.reject(new Error('sweep failed'));
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    contexts.disposeAll();
  });

  it('shutdown waits for an in-flight sweep and never starts the coordinator afterwards', async () => {
    const start = vi.spyOn(WorktreeLifecycleCoordinator.prototype, 'start').mockImplementation(() => {});
    const pending = deferred();
    sweep.impl = () => pending.promise;
    const contexts = makeContexts();
    await contexts.context('a');
    let stopped = false;
    const stopping = contexts.shutdownAll().then(() => {
      stopped = true;
    });
    await flushImmediate();
    expect(stopped).toBe(false);
    pending.resolve();
    await stopping;
    await flushImmediate();
    expect(start).not.toHaveBeenCalled();
  });
});
