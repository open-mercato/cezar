import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { ClaudeCliRunner } from './claude-cli-runner.ts';
import { createRunner, missingWorkingDirectoryMessage } from './runner-factory.ts';
import { lowDiskSpaceMessage } from '../disk-space.ts';

const disk = vi.hoisted(() => ({ space: undefined as { freeBytes: number; totalBytes: number } | undefined }));
vi.mock('../disk-space.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../disk-space.ts')>();
  // Only the probe is faked; the floor rule and the message are the real ones.
  return { ...actual, diskFloorRefusal: (backend: string, path: string) => actual.diskFloorRefusal(backend, path, () => disk.space) };
});

/** 27d2e432: an agent spawned in a task worktree that no longer exists. */
describe('createRunner refuses a working directory that is gone', () => {
  const gone = join(tmpdir(), 'cez-gone-worktree-27d2e432', 'never-created');

  it.each(RUNNER_IDS)('%s: startSession throws an actionable error before spawning', (id) => {
    const runner = createRunner(id);
    expect(() => runner.startSession({ userPrompt: 'hi', cwd: gone })).toThrow(
      missingWorkingDirectoryMessage(runner.backend, gone),
    );
  });

  it('run() rejects with the same message instead of a misleading "not found on PATH"', async () => {
    await expect(createRunner('claude').run({ userPrompt: 'hi', cwd: gone })).rejects.toThrow(
      /^claude: cannot start — the working directory .* does not exist/,
    );
  });

  it('keeps the concrete runner reachable', () => {
    const runner = createRunner('claude');
    expect(runner).toBeInstanceOf(ClaudeCliRunner);
    expect(runner.backend).toBe('claude');
  });
});

/** 9cdcedc3: an agent spawned on a full disk dies mid-write with a bare ENOSPC. */
describe('createRunner refuses a volume below the free-space floor', () => {
  const cwd = tmpdir();
  const MIB = 1024 ** 2;
  const GIB = 1024 ** 3;

  it.each(RUNNER_IDS)('%s: startSession throws the actionable low-disk message', (id) => {
    disk.space = { freeBytes: 200 * MIB, totalBytes: 500 * GIB };
    const runner = createRunner(id);
    expect(() => runner.startSession({ userPrompt: 'hi', cwd })).toThrow(lowDiskSpaceMessage(runner.backend, cwd, 200 * MIB));
  });

  it('run() rejects with it too', async () => {
    disk.space = { freeBytes: 200 * MIB, totalBytes: 500 * GIB };
    await expect(createRunner('codex').run({ userPrompt: 'hi', cwd })).rejects.toThrow(/^codex: cannot start — only 200 MB free/);
  });

  it('a gone directory still reports as gone, not as a full disk', () => {
    disk.space = { freeBytes: 0, totalBytes: 500 * GIB };
    const gone = join(tmpdir(), 'cez-gone-worktree-27d2e432', 'never-created');
    expect(() => createRunner('claude').startSession({ userPrompt: 'hi', cwd: gone })).toThrow(/does not exist/);
  });

  it.each([
    ['above the floor', { freeBytes: 2 * GIB, totalBytes: 500 * GIB }],
    ['probe unavailable', undefined],
  ])('never blocks %s', (_label, space) => {
    disk.space = space;
    const session = {} as ReturnType<ClaudeCliRunner['startSession']>;
    const spawn = vi.spyOn(ClaudeCliRunner.prototype, 'startSession').mockReturnValue(session);
    try {
      expect(createRunner('claude').startSession({ userPrompt: 'hi', cwd })).toBe(session);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      spawn.mockRestore();
    }
  });
});
