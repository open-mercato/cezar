import { describe, expect, it } from 'vitest';
import {
  CHILD_DISPATCH_PROMPT,
  DISPATCH_PROMPT,
  REVIEW_PROMPT,
  composeChildDispatchPrompt,
  composeDispatchPrompt,
  dispatchIntentPrompt,
  dispatchSessionPrompt,
} from './prompts.ts';

/** The prompts carry the DECISIONS; the flag reference is `cez task --help` (`task-cli.test.ts`
 *  pins that it names every flag the contract accepts). */
describe('the dispatch prompt', () => {
  it('routes every command through the cockpit’s own binary and points at the on-demand reference', () => {
    // The first live run found an older `cez` on the agents' PATH.
    expect(DISPATCH_PROMPT).toContain('node "$CEZ_BIN" task create');
    expect(DISPATCH_PROMPT).toContain('node "$CEZ_BIN" task --help');
  });

  it('leaves the flag-by-flag reference to --help', () => {
    for (const flag of ['--title', '--review-of', '--success', '--evidence', '--tools', '--runner', '--model', '--retry-limit']) {
      expect(DISPATCH_PROMPT).not.toContain(flag);
    }
    expect(DISPATCH_PROMPT.length).toBeLessThan(2500);
  });

  it('never lets an uncapped parent invent a cap for its children', () => {
    expect(DISPATCH_PROMPT).toContain('Never invent a --budget');
  });

  it('says when NOT to dispatch — the task-shape gate the evidence demands', () => {
    expect(DISPATCH_PROMPT).toMatch(/genuinely INDEPENDENT/);
    expect(DISPATCH_PROMPT).toMatch(/NOT for one tightly coupled change/);
    expect(DISPATCH_PROMPT).toMatch(/When in doubt, do it yourself/);
  });

  it('states the mechanics no code enforces: commit before dispatching, disjoint scopes, merge into own branch only', () => {
    expect(DISPATCH_PROMPT).toMatch(/COMMIT first/);
    expect(DISPATCH_PROMPT).toMatch(/DISJOINT --scope/);
    expect(DISPATCH_PROMPT).toContain('git merge --no-ff');
    expect(DISPATCH_PROMPT).toMatch(/Never merge into the repository's base branch/);
  });

  it('treats a report as a claim the parent still checks before merging, and keeps the Guard and the tree directory', () => {
    expect(DISPATCH_PROMPT).toMatch(/A report is a CLAIM/);
    // Scope check is attached only for a scoped child that settled successfully — the prompt must
    // hedge, or a parent would re-derive nothing and trust a verdict a failed child never carried.
    expect(DISPATCH_PROMPT).toMatch(/its own scope check\. Do not re-derive any of those/);
    expect(DISPATCH_PROMPT).toContain('read its diff and run the tests it names before merging');
    expect(DISPATCH_PROMPT).toContain('CEZ:ASK');
    expect(DISPATCH_PROMPT).toContain('CEZ:MONITORING');
    expect(DISPATCH_PROMPT).toContain('CEZ_TREE_DIR');
    expect(DISPATCH_PROMPT).toContain('inbox/<id8>/');
  });

  it('composes the review addendum only for a review task', () => {
    expect(composeDispatchPrompt(undefined)).toBe(DISPATCH_PROMPT);
    expect(composeDispatchPrompt('implement')).toBe(DISPATCH_PROMPT);
    const review = composeDispatchPrompt('review');
    expect(review.startsWith(DISPATCH_PROMPT)).toBe(true);
    expect(review).toContain(REVIEW_PROMPT);
    expect(REVIEW_PROMPT).toMatch(/FALSIFY/);
    expect(REVIEW_PROMPT).toMatch(/The verdict is required/);
  });

  describe('the intent block (the composer’s Dispatch toggle)', () => {
    it('is appended to the root’s prompt only when an intent is given', () => {
      expect(composeDispatchPrompt(undefined)).not.toContain('Dispatch mode.');
      const withIntent = composeDispatchPrompt(undefined, {});
      expect(withIntent.startsWith(DISPATCH_PROMPT)).toBe(true);
      expect(withIntent).toContain('Dispatch mode. The user started this task expecting it to be split.');
      expect(withIntent).toContain('CEZ:MONITORING');
    });

    it('turns the user’s limits and child defaults into sentences the agent can plan by', () => {
      const block = dispatchIntentPrompt({ maxSubtasks: 10, inFlight: 2, runner: 'claude', model: 'sonnet', budgetUsd: 2 });
      expect(block).toContain('at most 10 subtasks in total and 2 in flight at once; a dispatch past them is refused');
      expect(block).toContain('--runner claude --model sonnet --budget 2');
      // The bare toggle names no limits and no defaults — and says nothing about either.
      const bare = dispatchIntentPrompt({});
      expect(bare).not.toContain('Limits set by the user');
      expect(bare).not.toContain('Subtasks run with');
    });
  });
});

describe('the child prompt', () => {
  it('tells a dispatched task how to report, and keeps the Guard, without the fan-out tutorial', () => {
    expect(CHILD_DISPATCH_PROMPT).toContain('You were dispatched.');
    expect(CHILD_DISPATCH_PROMPT).toContain('node "$CEZ_BIN" task report --status done|partial|failed|blocked');
    expect(CHILD_DISPATCH_PROMPT).toContain('CEZ:ASK');
    expect(CHILD_DISPATCH_PROMPT).toContain('CEZ_TREE_DIR');
    expect(CHILD_DISPATCH_PROMPT).not.toContain('task create');
    expect(CHILD_DISPATCH_PROMPT).not.toContain('git merge');
    expect(CHILD_DISPATCH_PROMPT.length).toBeLessThan(DISPATCH_PROMPT.length);
  });

  it('keeps the door to nested dispatch open through the reference', () => {
    expect(CHILD_DISPATCH_PROMPT).toMatch(/may be dispatched in turn — node "\$CEZ_BIN" task --help/);
  });

  it('composes the review addendum for a review child', () => {
    expect(composeChildDispatchPrompt(undefined)).toBe(CHILD_DISPATCH_PROMPT);
    expect(composeChildDispatchPrompt('review')).toBe(`${CHILD_DISPATCH_PROMPT}\n\n${REVIEW_PROMPT}`);
  });
});

describe('dispatchSessionPrompt', () => {
  it('picks the root prompt for a plain task or a root, with the root’s intent', () => {
    expect(dispatchSessionPrompt(undefined)).toBe(DISPATCH_PROMPT);
    expect(dispatchSessionPrompt({ rootRunId: 'r' })).toBe(DISPATCH_PROMPT);
    expect(dispatchSessionPrompt({ rootRunId: 'r', intent: {} })).toContain('Dispatch mode.');
  });

  it('picks the child prompt for a dispatched run and never hands it the root’s intent', () => {
    expect(dispatchSessionPrompt({ rootRunId: 'r', parentRunId: 'r', intent: {} })).toBe(CHILD_DISPATCH_PROMPT);
    expect(dispatchSessionPrompt({ rootRunId: 'r', parentRunId: 'r', kind: 'review' })).toBe(composeChildDispatchPrompt('review'));
  });
});
