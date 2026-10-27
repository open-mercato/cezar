import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { ClaudeCliRunner } from './claude-cli-runner.ts';
import { createRunner, missingWorkingDirectoryMessage } from './runner-factory.ts';

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
