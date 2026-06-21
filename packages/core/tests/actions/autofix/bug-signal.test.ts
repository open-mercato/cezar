import { describe, expect, it } from 'vitest';
import { detectBugSignal } from '../../../src/actions/autofix/bug-signal.js';
import type { StoredIssue } from '../../../src/store/store.model.js';

function makeIssue(
  overrides: Partial<StoredIssue> & { analysis?: Partial<StoredIssue['analysis']> },
): StoredIssue {
  return {
    number: 1,
    title: 'something happened',
    body: '',
    state: 'open',
    labels: [],
    assignees: [],
    author: 'tester',
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    htmlUrl: 'https://example.com',
    contentHash: 'h',
    commentCount: 0,
    reactions: 0,
    comments: [],
    commentsFetchedAt: null,
    digest: null,
    ...overrides,
    analysis: {
      issueType: null,
      bugConfidence: null,
      autofixStatus: null,
      ...overrides.analysis,
    } as StoredIssue['analysis'],
  };
}

describe('detectBugSignal', () => {
  const opts = { minConfidence: 0.6 };

  it('accepts when classifier is confident', () => {
    const r = detectBugSignal(
      makeIssue({ analysis: { issueType: 'bug', bugConfidence: 0.9 } }),
      opts,
    );
    expect(r.isBug).toBe(true);
    expect(r.isHighConfidence).toBe(true);
    expect(r.reason).toContain('bug-detector confident');
  });

  it('accepts unclassified issues that carry a `bug` label', () => {
    const r = detectBugSignal(makeIssue({ labels: ['bug', 'priority:high'] }), opts);
    expect(r.isBug).toBe(true);
    expect(r.reason).toContain("'bug' label");
  });

  it('accepts label variants like `type:bug` and `kind/bug`', () => {
    expect(detectBugSignal(makeIssue({ labels: ['type:bug'] }), opts).isBug).toBe(true);
    expect(detectBugSignal(makeIssue({ labels: ['kind/bug'] }), opts).isBug).toBe(true);
    expect(detectBugSignal(makeIssue({ labels: ['Bug: regression'] }), opts).isBug).toBe(true);
  });

  it('accepts a `bug:` title prefix even with no label and no classifier run', () => {
    const r = detectBugSignal(
      makeIssue({ title: 'bug: [SECURITY] Stale session state across browser tabs' }),
      opts,
    );
    expect(r.isBug).toBe(true);
    expect(r.reason).toContain('title prefix');
  });

  it('accepts `[BUG] ...` and `[Bug] -` prefixes', () => {
    expect(detectBugSignal(makeIssue({ title: '[BUG] crash on save' }), opts).isBug).toBe(true);
    expect(detectBugSignal(makeIssue({ title: '[Bug] - unexpected logout' }), opts).isBug).toBe(
      true,
    );
  });

  it('rejects when nothing matches', () => {
    const r = detectBugSignal(
      makeIssue({ title: 'add support for ...', labels: ['enhancement'] }),
      opts,
    );
    expect(r.isBug).toBe(false);
    expect(r.reason).toContain('not classified as a bug');
  });

  it('label fallback overrides a low-confidence classifier verdict', () => {
    const r = detectBugSignal(
      makeIssue({
        labels: ['bug'],
        analysis: { issueType: 'bug', bugConfidence: 0.2 },
      }),
      opts,
    );
    expect(r.isBug).toBe(true);
    // Should rely on the label even when classifier confidence is sub-threshold.
    expect(r.reason).toContain("'bug' label");
  });

  it('rejects when classifier ran with non-bug verdict and no label/title fallback', () => {
    const r = detectBugSignal(
      makeIssue({
        title: 'how do I configure X?',
        analysis: { issueType: 'question', bugConfidence: null },
      }),
      opts,
    );
    expect(r.isBug).toBe(false);
    expect(r.reason).toContain("'question'");
  });

  it('does not match generic words that contain `bug` (e.g. `debugging`)', () => {
    const r = detectBugSignal(makeIssue({ title: 'debugging hint: ...' }), opts);
    expect(r.isBug).toBe(false);
  });
});
