import { describe, it, expect } from 'vitest';
import { summarizeCi, type CheckRunSummary } from '@cezar/core';

const check = (
  name: string,
  status: CheckRunSummary['status'],
  conclusion: string | null,
): CheckRunSummary => ({
  name,
  status,
  conclusion,
  htmlUrl: `https://github.com/o/r/runs/${name}`,
  startedAt: null,
  completedAt: null,
});

describe('summarizeCi', () => {
  it('returns unknown when no checks', () => {
    expect(summarizeCi([]).overall).toBe('unknown');
  });

  it('pending while any check is still running', () => {
    const r = summarizeCi([
      check('lint', 'completed', 'success'),
      check('test', 'in_progress', null),
    ]);
    expect(r.overall).toBe('pending');
    expect(r.failedChecks).toHaveLength(0);
  });

  it('failure short-circuits pending — a known red is a decisive signal', () => {
    const r = summarizeCi([
      check('lint', 'completed', 'failure'),
      check('test', 'in_progress', null),
    ]);
    expect(r.overall).toBe('failure');
    expect(r.failedChecks.map((c) => c.name)).toEqual(['lint']);
  });

  it('success when all completed and passed', () => {
    const r = summarizeCi([
      check('lint', 'completed', 'success'),
      check('test', 'completed', 'success'),
    ]);
    expect(r.overall).toBe('success');
  });

  it('neutral when mix of success and skipped, no failures', () => {
    const r = summarizeCi([
      check('lint', 'completed', 'success'),
      check('optional', 'completed', 'skipped'),
    ]);
    expect(r.overall).toBe('neutral');
  });

  it('timed_out and cancelled count as failures', () => {
    const r = summarizeCi([
      check('a', 'completed', 'timed_out'),
      check('b', 'completed', 'cancelled'),
    ]);
    expect(r.overall).toBe('failure');
    expect(r.failedChecks).toHaveLength(2);
  });
});
