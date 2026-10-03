import { afterEach, expect, it, vi } from 'vitest';

const execFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile }));
import { clearWorktreeSizeCache, worktreeSizeForRun } from './git-worktree.ts';

afterEach(() => { clearWorktreeSizeCache(); vi.clearAllMocks(); });

it('evicts the oldest finalized worktree size after fifty distinct runs', async () => {
  execFile.mockImplementation((_file, _args, _options, callback) => callback(null, '1\t/worktree\n', ''));
  for (let i = 0; i < 51; i++) {
    expect(await worktreeSizeForRun(`run-${i}`, `/worktree/${i}`, true)).toBe(1024);
  }
  expect(execFile).toHaveBeenCalledTimes(51);
  await worktreeSizeForRun('run-1', '/worktree/1', true);
  await worktreeSizeForRun('run-50', '/worktree/50', true);
  expect(execFile).toHaveBeenCalledTimes(51);
  await worktreeSizeForRun('run-0', '/worktree/0', true);
  expect(execFile).toHaveBeenCalledTimes(52);
});
