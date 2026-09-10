import { describe, expect, it } from 'vitest';
import { DISPATCH_PROMPT, REVIEW_PROMPT, composeDispatchPrompt } from './prompts.ts';

/** The prompt is the ONLY place an agent learns the CLI, so it must name every flag the
 *  contract accepts and the rules the engine enforces. */
describe('the dispatch prompt', () => {
  it('teaches the CLI with every task-order flag the contract accepts', () => {
    for (const flag of ['--title', '--kind', '--review-of', '--scope', '--budget', '--success', '--evidence', '--tools', '--runner', '--model']) {
      expect(DISPATCH_PROMPT).toContain(flag);
    }
    expect(DISPATCH_PROMPT).toContain('cez task create');
    expect(DISPATCH_PROMPT).toContain('cez task report');
    expect(DISPATCH_PROMPT).toContain('--verdict');
    expect(DISPATCH_PROMPT).toContain('--suggestions');
  });

  it('says when NOT to dispatch — the task-shape gate the evidence demands', () => {
    expect(DISPATCH_PROMPT).toMatch(/genuinely INDEPENDENT/);
    expect(DISPATCH_PROMPT).toMatch(/NOT for one tightly coupled change/);
    expect(DISPATCH_PROMPT).toMatch(/When in doubt, do it yourself/);
  });

  it('states the mechanics no code enforces: commit before dispatching, disjoint scopes, merge into own branch only', () => {
    expect(DISPATCH_PROMPT).toMatch(/COMMIT before dispatching/);
    expect(DISPATCH_PROMPT).toMatch(/DISJOINT scope/);
    expect(DISPATCH_PROMPT).toContain('git merge --no-ff');
    expect(DISPATCH_PROMPT).toMatch(/Never merge into the repository's base branch/);
    expect(DISPATCH_PROMPT).toMatch(/At most 4 children in flight/);
  });

  it('treats a report as a claim and keeps the Guard and the tree directory', () => {
    expect(DISPATCH_PROMPT).toMatch(/A report is a CLAIM/);
    expect(DISPATCH_PROMPT).toContain('CEZ:ASK');
    expect(DISPATCH_PROMPT).toContain('CEZ:MONITORING');
    expect(DISPATCH_PROMPT).toContain('brief.md');
    expect(DISPATCH_PROMPT).toContain('inbox/root/');
    expect(DISPATCH_PROMPT).toContain('CEZ_TREE_DIR');
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
});
