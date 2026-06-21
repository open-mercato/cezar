import type { WorkflowRunResult } from './workflow.js';
import type { AutofixBlackboard } from './definitions/autofix.workflow.js';
import type { CiFollowupBlackboard } from './definitions/ci-followup.workflow.js';
import type { OrchestratorOutcome, CiFollowupOutcome } from '../actions/autofix/orchestrator.js';
import type { RootCause } from '../actions/autofix/prompts/analyzer.js';
import type { ReviewVerdict } from '../actions/autofix/prompts/reviewer.js';

/**
 * Phase 3a: translate a `WorkflowRunResult` (the engine's shape) back into the
 * legacy `OrchestratorOutcome` / `CiFollowupOutcome` unions, so the engine path
 * in `AutofixOrchestrator` returns exactly what its callers (GUI, CLI, cron)
 * already expect. Resume-after-pause is NOT a 3a concern — a paused run is
 * reported as `skipped`.
 */

function fullVerdict(v: Required<ReviewVerdict> | undefined): Required<ReviewVerdict> {
  // The blackboard always carries a normalized verdict by the time review runs;
  // synthesize an empty pass only for the impossible "succeeded with no verdict".
  return v ?? { verdict: 'pass', summary: '', issues: [], suggestions: [] };
}

export function workflowResultToAutofixOutcome(
  result: WorkflowRunResult<AutofixBlackboard>,
): OrchestratorOutcome {
  const bb = result.blackboard;
  const rootCause = bb.rootCause as RootCause | undefined;
  const verdict = bb.verdict;

  if (result.status === 'succeeded') {
    // Skip-run path (verify-in-repo / no-action / maintainer declined): the
    // engine ends `succeeded` with a `reason` and no PR.
    if (result.prUrl) {
      return {
        status: 'pr-opened',
        prUrl: result.prUrl,
        prNumber: result.prNumber ?? bb.prNumber ?? 0,
        branch: result.branch ?? '',
        headSha: result.headSha ?? bb.headSha ?? '',
        rootCause: (rootCause ?? {
          summary: '',
          hypothesis: '',
          suspectedFiles: [],
          confidence: 0,
        }) as RootCause,
        verdict: fullVerdict(verdict),
      };
    }
    if (result.reason) {
      return { status: 'skipped', reason: result.reason };
    }
    // Dry-run: review passed, no PR opened.
    if (rootCause && bb.fixReport && verdict) {
      return {
        status: 'dry-run',
        rootCause,
        fixReport: bb.fixReport,
        verdict,
        branch: result.branch ?? '',
        diff: bb.diff ?? '',
      };
    }
    // Succeeded but missing the artifacts a dry-run needs — treat as a skip.
    return { status: 'skipped', reason: 'workflow completed with no actionable result' };
  }

  if (result.status === 'paused') {
    return { status: 'skipped', reason: 'paused — awaiting maintainer decision' };
  }

  // failed | cancelled
  return {
    status: 'failed',
    reason:
      result.reason ?? (result.status === 'cancelled' ? 'workflow cancelled' : 'workflow failed'),
    rootCause,
    fixReport: bb.fixReport,
    verdict,
    branch: result.branch,
  };
}

export function workflowResultToCiFollowupOutcome(
  result: WorkflowRunResult<CiFollowupBlackboard>,
): CiFollowupOutcome {
  const bb = result.blackboard;
  const branch = result.branch ?? bb.seed?.branch;

  if (result.status === 'succeeded') {
    // Pushed: the `push` step ran ⇒ a headSha is on the blackboard.
    if (bb.headSha && bb.fixReport && bb.verdict) {
      return {
        status: 'pushed',
        branch: branch ?? '',
        headSha: bb.headSha,
        verdict: bb.verdict,
        fixReport: bb.fixReport,
      };
    }
    // skip-run (e.g. fixer made no changes — CI failure no longer reproduces).
    return { status: 'skipped', reason: result.reason ?? 'CI follow-up produced no changes' };
  }

  if (result.status === 'paused') {
    return { status: 'skipped', reason: 'paused — awaiting maintainer decision' };
  }

  // failed | cancelled
  return {
    status: 'failed',
    reason:
      result.reason ?? (result.status === 'cancelled' ? 'workflow cancelled' : 'workflow failed'),
    branch,
    verdict: bb.verdict,
    fixReport: bb.fixReport,
  };
}
