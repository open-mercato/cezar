import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';

const { spawnMock, resolveCheckShellMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  resolveCheckShellMock: vi.fn(() => String.raw`C:\Program Files\Git\bin\bash.exe`),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
}));
vi.mock('./check-shell.ts', () => ({ resolveCheckShell: resolveCheckShellMock }));

type CheckState = {
  cwd: string;
  cancelled: boolean;
  interrupt: () => void;
};

type CheckRunner = {
  runCheckStep(
    state: CheckState,
    step: { id: string; command: string },
    emit: (event: Record<string, unknown>) => void,
  ): Promise<{ ok: boolean; output: string; exitCode: number }>;
};

function childProcess() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
  return child;
}

describe('runCheckStep shell boundary', () => {
  afterEach(() => {
    spawnMock.mockReset();
    resolveCheckShellMock.mockClear();
  });

  it('passes the selected Windows executable, original args and cwd to one check process', async () => {
    const child = childProcess();
    spawnMock.mockReturnValueOnce(child);
    const root = mkdtempSync(join(tmpdir(), 'cez-check-shell-'));
    const manager = new RunManager(RunStore.open(join(root, '.ai/cezar')), root);
    try {
      const state: CheckState = { cwd: root, cancelled: false, interrupt: () => undefined };
      const resultPromise = (manager as unknown as CheckRunner).runCheckStep(
        state,
        { id: 'verify', command: 'echo CEZ_CHECK_OK' },
        () => undefined,
      );
      child.stdout.emit('data', Buffer.from('CEZ_CHECK_OK\n'));
      child.emit('close', 7);
      await expect(resultPromise).resolves.toEqual({ ok: false, output: 'CEZ_CHECK_OK', exitCode: 7 });
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock).toHaveBeenCalledWith(
        String.raw`C:\Program Files\Git\bin\bash.exe`,
        ['-lc', 'echo CEZ_CHECK_OK'],
        { cwd: root, env: process.env },
      );
    } finally {
      manager.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps cancellation wired to SIGTERM', async () => {
    const child = childProcess();
    spawnMock.mockReturnValueOnce(child);
    const root = mkdtempSync(join(tmpdir(), 'cez-check-shell-'));
    const manager = new RunManager(RunStore.open(join(root, '.ai/cezar')), root);
    try {
      const state: CheckState = { cwd: root, cancelled: false, interrupt: () => undefined };
      const resultPromise = (manager as unknown as CheckRunner).runCheckStep(
        state,
        { id: 'verify', command: 'sleep 1' },
        () => undefined,
      );
      state.interrupt();
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      child.emit('close', null);
      await expect(resultPromise).resolves.toMatchObject({ ok: false, exitCode: -1 });
    } finally {
      manager.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
