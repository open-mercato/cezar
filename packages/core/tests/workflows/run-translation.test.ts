import { describe, it, expect } from 'vitest';
import {
  workflowResultToAutofixOutcome,
  workflowResultToCiFollowupOutcome,
} from '../../src/workflows/run-translation.js';
import type { WorkflowRunResult } from '../../src/workflows/workflow.js';
import type { AutofixBlackboard } from '../../src/workflows/definitions/autofix.workflow.js';
import type { CiFollowupBlackboard } from '../../src/workflows/definitions/ci-followup.workflow.js';

const verdict = { verdict: 'pass' as const, summary: 'looks good', issues: [], suggestions: [] };
const rootCause = { summary: 'rc', hypothesis: 'h', suspectedFiles: ['a.ts'], confidence: 0.9 };
const fixReport = { approach: 'fix it', changedFiles: ['a.ts'] } as AutofixBlackboard['fixReport'];

function autofixResult(
  over: Partial<WorkflowRunResult<AutofixBlackboard>>,
): WorkflowRunResult<AutofixBlackboard> {
  return { status: 'succeeded', blackboard: {}, runRecords: [], tokensUsed: 0, ...over };
}

describe('workflowResultToAutofixOutcome', () => {
  it('maps a PR-opened run', () => {
    const out = workflowResultToAutofixOutcome(
      autofixResult({
        prUrl: 'http://pr/1',
        prNumber: 1,
        branch: 'autofix/1',
        headSha: 'abc',
        blackboard: { rootCause, verdict },
      }),
    );
    expect(out).toMatchObject({
      status: 'pr-opened',
      prUrl: 'http://pr/1',
      prNumber: 1,
      branch: 'autofix/1',
      headSha: 'abc',
    });
  });

  it('maps a dry-run (succeeded, no PR, no reason)', () => {
    const out = workflowResultToAutofixOutcome(
      autofixResult({
        branch: 'autofix/1',
        blackboard: { rootCause, fixReport, verdict, diff: 'diff' },
      }),
    );
    expect(out).toMatchObject({ status: 'dry-run', branch: 'autofix/1', diff: 'diff' });
  });

  it('maps a skip-run (succeeded with a reason)', () => {
    const out = workflowResultToAutofixOutcome(autofixResult({ reason: 'not a real defect' }));
    expect(out).toEqual({ status: 'skipped', reason: 'not a real defect' });
  });

  it('maps a paused run to skipped', () => {
    const out = workflowResultToAutofixOutcome(
      autofixResult({ status: 'paused', reason: 'awaiting decision' }),
    );
    expect(out).toEqual({ status: 'skipped', reason: 'paused — awaiting maintainer decision' });
  });

  it('maps a failed run', () => {
    const out = workflowResultToAutofixOutcome(
      autofixResult({
        status: 'failed',
        reason: 'boom',
        branch: 'autofix/1',
        blackboard: { rootCause },
      }),
    );
    expect(out).toMatchObject({ status: 'failed', reason: 'boom', branch: 'autofix/1', rootCause });
  });
});

describe('workflowResultToCiFollowupOutcome', () => {
  function ciResult(
    over: Partial<WorkflowRunResult<CiFollowupBlackboard>>,
  ): WorkflowRunResult<CiFollowupBlackboard> {
    return { status: 'succeeded', blackboard: {}, runRecords: [], tokensUsed: 0, ...over };
  }

  it('maps a pushed run', () => {
    const out = workflowResultToCiFollowupOutcome(
      ciResult({
        branch: 'autofix/1',
        blackboard: {
          headSha: 'abc',
          fixReport: fixReport as CiFollowupBlackboard['fixReport'],
          verdict,
        },
      }),
    );
    expect(out).toMatchObject({ status: 'pushed', branch: 'autofix/1', headSha: 'abc' });
  });

  it('maps a skip-run', () => {
    const out = workflowResultToCiFollowupOutcome(ciResult({ reason: 'no changes' }));
    expect(out).toEqual({ status: 'skipped', reason: 'no changes' });
  });

  it('maps a failed run', () => {
    const out = workflowResultToCiFollowupOutcome(
      ciResult({ status: 'failed', reason: 'boom', branch: 'autofix/1' }),
    );
    expect(out).toMatchObject({ status: 'failed', reason: 'boom', branch: 'autofix/1' });
  });
});
