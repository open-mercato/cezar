import { describe, it, expect } from 'vitest';
import { runBaseBranchControl, parseCheckRunUrl, type CheckRunSummary } from '@cezar/core';

const check = (
  name: string,
  conclusion: string | null,
  status: CheckRunSummary['status'] = 'completed',
): CheckRunSummary => ({
  name,
  status,
  conclusion,
  htmlUrl: null,
  startedAt: null,
  completedAt: null,
});

describe('runBaseBranchControl', () => {
  it('returns allPreExisting when every PR-failing check also fails on base', () => {
    const result = runBaseBranchControl(
      [check('lint', 'failure'), check('test', 'failure')],
      [check('lint', 'failure'), check('test', 'failure'), check('build', 'success')],
    );
    expect(result.allPreExisting).toBe(true);
    expect(result.preExistingChecks).toEqual(['lint', 'test']);
    expect(result.nonPreExistingChecks).toHaveLength(0);
  });

  it('separates pre-existing from new failures', () => {
    const result = runBaseBranchControl(
      [check('lint', 'failure'), check('test', 'failure')],
      [check('lint', 'failure'), check('test', 'success')],
    );
    expect(result.allPreExisting).toBe(false);
    expect(result.preExistingChecks).toEqual(['lint']);
    expect(result.nonPreExistingChecks.map((c) => c.name)).toEqual(['test']);
  });

  it('base checks still pending are not considered pre-existing — pending is not a decisive signal', () => {
    const result = runBaseBranchControl(
      [check('test', 'failure')],
      [check('test', null, 'in_progress')],
    );
    expect(result.allPreExisting).toBe(false);
    expect(result.preExistingChecks).toEqual([]);
  });

  it('treats timed_out and cancelled on base as pre-existing failures', () => {
    const result = runBaseBranchControl(
      [check('a', 'failure'), check('b', 'failure')],
      [check('a', 'timed_out'), check('b', 'cancelled')],
    );
    expect(result.allPreExisting).toBe(true);
  });

  it('allPreExisting is false when no failed checks were supplied', () => {
    const result = runBaseBranchControl([], [check('lint', 'failure')]);
    expect(result.allPreExisting).toBe(false);
  });

  it('all failures non-pre-existing when base has no checks at all', () => {
    const result = runBaseBranchControl([check('test', 'failure')], []);
    expect(result.allPreExisting).toBe(false);
    expect(result.nonPreExistingChecks).toHaveLength(1);
  });
});

describe('parseCheckRunUrl', () => {
  it('parses standard Actions check-run URLs', () => {
    expect(parseCheckRunUrl('https://github.com/o/r/actions/runs/123/job/456')).toEqual({
      runId: 123,
      jobId: 456,
    });
  });

  it('tolerates the /jobs/ plural variant', () => {
    expect(parseCheckRunUrl('https://github.com/o/r/actions/runs/123/jobs/456')).toEqual({
      runId: 123,
      jobId: 456,
    });
  });

  it('strips deep-link fragments', () => {
    expect(parseCheckRunUrl('https://github.com/o/r/actions/runs/999/job/1#step:2:10')).toEqual({
      runId: 999,
      jobId: 1,
    });
  });

  it('returns null for non-Actions URLs (external CI providers)', () => {
    expect(parseCheckRunUrl('https://circleci.com/gh/o/r/123')).toBeNull();
    expect(parseCheckRunUrl(null)).toBeNull();
    expect(parseCheckRunUrl(undefined)).toBeNull();
  });
});
