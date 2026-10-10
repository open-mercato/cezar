import { describe, expect, it } from 'vitest';
import { missingCockpitMessage } from './cockpit-address.ts';

/** #1080: the same missing `CEZ_API_URL` is an instruction to an agent and a how-to for a person. */
describe('missingCockpitMessage', () => {
  const message = { command: 'cez automation', example: 'cez automation list', insideTask: 'stop and report.' };

  it('keeps the agent instruction inside a task', () => {
    expect(missingCockpitMessage(message, { CEZ_TASK_ID: 'run-1' })).toBe('cez automation: CEZ_API_URL is not set — stop and report.');
  });

  it('tells a person at a shell how to reach a cockpit, never that it only works inside a task', () => {
    const text = missingCockpitMessage(message, {});
    expect(text).toContain('CEZ_API_URL=http://127.0.0.1:4321 cez automation list');
    expect(text).toContain('CEZ_PROJECT_ID');
    expect(text).not.toContain('only works inside a task');
    expect(text).not.toContain('stop and report.');
  });
});
