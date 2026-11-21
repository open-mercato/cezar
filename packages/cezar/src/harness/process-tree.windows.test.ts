import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const killers = vi.hoisted(() => ({ calls: [] as Array<[string, string[]]>, spawned: [] as EventEmitter[] }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (file: string, argv: string[]) => {
      const killer = Object.assign(new EventEmitter(), { unref: () => undefined });
      killers.calls.push([file, argv]);
      killers.spawned.push(killer);
      return killer;
    },
  };
});

const { signalAgentProcessTree } = await import('./process-tree.ts');

/** the Windows half of the process-tree teardown. */
describe('signalAgentProcessTree on Windows', () => {
  const platform = process.platform;
  beforeEach(() => {
    killers.calls.length = 0;
    killers.spawned.length = 0;
    Object.defineProperty(process, 'platform', { value: 'win32' });
  });
  afterEach(() => Object.defineProperty(process, 'platform', { value: platform }));

  const leader = () => ({ pid: 4321, kill: vi.fn(() => true) }) as unknown as ChildProcess & { kill: ReturnType<typeof vi.fn> };

  it('forces the graceful step too — a windowless console CLI refuses a plain taskkill', () => {
    signalAgentProcessTree(leader(), 'SIGTERM');
    expect(killers.calls).toEqual([['taskkill', ['/pid', '4321', '/t', '/f']]]);
  });

  it('survives a missing taskkill instead of crashing the server, and stops the leader itself', () => {
    const child = leader();
    signalAgentProcessTree(child, 'SIGTERM');
    const enoent = Object.assign(new Error('spawn taskkill ENOENT'), { code: 'ENOENT' });
    expect(() => killers.spawned[0]!.emit('error', enoent)).not.toThrow();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
