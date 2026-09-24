import { describe, expect, it } from 'vitest';

import { HANDOFF_INSTRUCTIONS } from './handoff.ts';
import { todoSchema } from './todos.ts';

/**
 * HANDOFF_INSTRUCTIONS is the only thing that tells an agent what to append to todos.json,
 * so a field can be added to todoSchema and still never be written by anyone. `runnable`
 * shipped exactly that way. This pins the contract instead of the prose: every agent-writable
 * schema field has to appear in the instructions.
 */
describe('HANDOFF_INSTRUCTIONS', () => {
  /** The server assigns these on read/start — an agent never writes them. */
  const SERVER_MANAGED = new Set(['id', 'startedTaskId']);

  it('documents every agent-writable field of todoSchema', () => {
    const undocumented = Object.keys(todoSchema.shape)
      .filter((field) => !SERVER_MANAGED.has(field))
      .filter((field) => !HANDOFF_INSTRUCTIONS.includes(`"${field}"`));

    expect(undocumented).toEqual([]);
  });

  it('tells the agent which way to set runnable, so notes are acknowledged and not run', () => {
    expect(HANDOFF_INSTRUCTIONS).toContain('"runnable": false');
    expect(HANDOFF_INSTRUCTIONS).toContain('"runnable": true');
    expect(HANDOFF_INSTRUCTIONS).toContain('Acknowledge');
  });
});

/**
 * #933 — a task that had dispatched sub-agents and was waiting only on them showed as
 * "needs you", with the "paused, waiting for your reply" footer and a browser notification.
 * The transcript evidence put it on the BEHAVIORAL branch: cezar has no sub-agent-completion
 * event, so this paragraph is the only thing that makes the agent declare the state, and the
 * pre-#933 wording ("a sub-agent you dispatched") never said whether a sub-agent that hands
 * control back immediately and reports later still counts.
 *
 * These pin the contract, not the prose: the case has to be named, and the example has to end
 * on the marker — an example whose last line is anything else teaches the wrong shape, since
 * detection is anchored at the end of the turn (`MONITORING_MARKER_RE`).
 */
describe('HANDOFF_INSTRUCTIONS — the still-working marker contract (#933)', () => {
  const paragraph = HANDOFF_INSTRUCTIONS.slice(
    HANDOFF_INSTRUCTIONS.indexOf('Still-working marker:'),
    HANDOFF_INSTRUCTIONS.indexOf('Structured question marker:'),
  );

  it('extracts a non-empty paragraph to assert on', () => {
    expect(paragraph.startsWith('Still-working marker:')).toBe(true);
    expect(paragraph).toContain('CEZ:MONITORING');
  });

  it('names dispatching a sub-agent as the case the marker exists for', () => {
    expect(paragraph).toContain('Dispatching a sub-agent is exactly this case');
  });

  it('covers a sub-agent that reports back after the turn, not only one that finishes inside it', () => {
    expect(paragraph).toContain('background');
    expect(paragraph).toContain('completion notification');
  });

  it('carries a worked example whose last line is exactly the marker', () => {
    const example = paragraph
      .split('\n')
      .filter((line) => line.startsWith('    '))
      .map((line) => line.trim())
      .filter((line) => line !== '');
    expect(example.length).toBeGreaterThanOrEqual(2);
    expect(example[example.length - 1]).toBe('CEZ:MONITORING');
    expect(example[0]).toContain('sub-agents');
  });

  /**
   * The belt to the engine's braces: `run.ts` now tolerates trailing task-reference lines, but
   * the contract should still ask for the ordering that needs no tolerance.
   */
  it('tells the agent to keep task-reference markers above the turn-end markers', () => {
    expect(HANDOFF_INSTRUCTIONS).toContain('above any CEZ:DONE / CEZ:MONITORING line');
  });
});
