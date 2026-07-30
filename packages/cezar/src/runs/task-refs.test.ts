import { describe, expect, it } from 'vitest';
import { extractTaskRefs, refineTaskRefs, titleRefNumber } from './task-refs.ts';

/** Spec 2026-07-17-task-auto-naming step 0 — the regex layer the namer is cross-checked against. */
describe('extractTaskRefs', () => {
  it('reads the GitHub-tab templates verbatim', () => {
    expect(extractTaskRefs('Address GitHub pull request #454: show CI status\n\nhttps://github.com/open-mercato/cezar/pull/454')).toEqual({
      prNumber: 454,
    });
    expect(extractTaskRefs('Fix GitHub issue #432: bad titles\n\nhttps://github.com/open-mercato/cezar/issues/432')).toEqual({
      issueNumber: 432,
    });
  });

  it('URLs are the strongest signal and set the kind', () => {
    expect(extractTaskRefs('see https://github.com/open-mercato/cezar/pull/441 please')).toEqual({ prNumber: 441 });
    expect(extractTaskRefs('see https://github.com/o-m/repo.name/issues/12')).toEqual({ issueNumber: 12 });
  });

  it('worded references: pr / pull request / issue, with or without #', () => {
    expect(extractTaskRefs('review pr 437 with autofix')).toEqual({ prNumber: 437 });
    expect(extractTaskRefs('review PR#437')).toEqual({ prNumber: 437 });
    expect(extractTaskRefs('continue pull request 468')).toEqual({ prNumber: 468 });
    expect(extractTaskRefs('triage issue #471 today')).toEqual({ issueNumber: 471 });
  });

  it('a bare-number task is ambiguous', () => {
    expect(extractTaskRefs('469')).toEqual({ ambiguousNumber: 469 });
    expect(extractTaskRefs('  #469  ')).toEqual({ ambiguousNumber: 469 });
  });

  it('falls back to the first #N anywhere, only when nothing stronger matched', () => {
    expect(extractTaskRefs('implement the plan from #479 end to end')).toEqual({ ambiguousNumber: 479 });
    expect(extractTaskRefs('fix issue #12 referenced from #479')).toEqual({ issueNumber: 12 });
  });

  it('finds nothing in plain prose and rejects absurd numbers', () => {
    expect(extractTaskRefs('rename the settings page')).toEqual({});
    expect(extractTaskRefs('#99999999999')).toEqual({});
  });

  it('a task naming both a PR and an issue keeps both', () => {
    expect(extractTaskRefs('port the fix from pr 441 onto issue #438')).toEqual({ prNumber: 441, issueNumber: 438 });
  });
});

describe('titleRefNumber', () => {
  it('prefers pr, then issue, then ambiguous', () => {
    expect(titleRefNumber({ prNumber: 1, issueNumber: 2, ambiguousNumber: 3 })).toBe(1);
    expect(titleRefNumber({ issueNumber: 2, ambiguousNumber: 3 })).toBe(2);
    expect(titleRefNumber({ ambiguousNumber: 3 })).toBe(3);
    expect(titleRefNumber({})).toBeUndefined();
  });
});

describe('refineTaskRefs', () => {
  it('classifies a bare number by the skill it was handed to', () => {
    expect(refineTaskRefs({ ambiguousNumber: 469 }, 'om-auto-review-pr')).toEqual({ prNumber: 469 });
    expect(refineTaskRefs({ ambiguousNumber: 469 }, 'om-auto-continue-pr-loop')).toEqual({ prNumber: 469 });
    expect(refineTaskRefs({ ambiguousNumber: 438 }, 'om-auto-fix-issue')).toEqual({ issueNumber: 438 });
  });

  it('never overrides explicit refs and passes through without a hint', () => {
    expect(refineTaskRefs({ prNumber: 1, ambiguousNumber: 9 }, 'om-auto-fix-issue')).toEqual({
      prNumber: 1,
      issueNumber: 9,
    });
    expect(refineTaskRefs({ ambiguousNumber: 9 }, undefined)).toEqual({ ambiguousNumber: 9 });
    expect(refineTaskRefs({ ambiguousNumber: 9 }, 'om-spec-writing')).toEqual({ ambiguousNumber: 9 });
  });
});
