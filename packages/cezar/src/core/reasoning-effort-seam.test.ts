import { describe, expect, it } from 'vitest';
import { REASONING_EFFORT_UNSUPPORTED_ERROR, RUNNER_IDS } from './agent-runner.ts';
import { createRunner } from './runner-factory.ts';

// The engine refuses first; this keeps a direct runner caller from having the setting dropped.
describe('reasoning effort at the runner seam', () => {
  it.each(RUNNER_IDS.filter((id) => id !== 'codex'))('%s refuses an effort before spawning', (id) => {
    expect(() =>
      createRunner(id).startSession!({ userPrompt: 'x', cwd: process.cwd(), reasoningEffort: 'high' }),
    ).toThrow(REASONING_EFFORT_UNSUPPORTED_ERROR);
  });
});
