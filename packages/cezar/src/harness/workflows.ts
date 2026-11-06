import type { WorkflowDef } from '../workflows/types.js';

/**
 * The two built-in harness workflows (spec 2026-07-23-harness-orchestration).
 *
 * Their `steps` are the standard-profile phase list — real entries so
 * `createRun` seeds the step rail, `workflowDef` revival works after a
 * restart, and every steps consumer renders truthfully. Execution is NOT the
 * linear walker's: `execute()` dispatches harness workflows to the phase
 * driver, which runs agent phases through `runAgentStep` (fresh session per
 * phase) and op phases through the harness runtime bridge. The op steps'
 * `command` strings are placeholders for `stepKind()`/the rail glyph only and
 * are never handed to a shell.
 */

export const HARNESS_FIX_ISSUE = 'harness-fix-issue';
export const HARNESS_IMPLEMENT_FEATURE = 'harness-implement-feature';
/** No phase reads an attachment, so a harness run refuses one rather than drop it. */
export const HARNESS_TEXT_ONLY_ERROR =
  'multi-model runs accept text only — no phase would see the attachment; attach it to a regular task instead';
export const HARNESS_MODELS_LOCKED_ERROR =
  'Multi-model lineups need model selection unlocked. Turn off the native model lock first.';

export function isHarnessWorkflowName(name: string): boolean {
  return name === HARNESS_FIX_ISSUE || name === HARNESS_IMPLEMENT_FEATURE;
}

/** A built-in harness workflow. A user's workflow file under the same name stays an ordinary
 *  workflow and is never routed to the phase driver. */
export function isHarnessWorkflow(workflow: Pick<WorkflowDef, 'name' | 'source'>): boolean {
  return workflow.source === 'built-in' && isHarnessWorkflowName(workflow.name);
}

const OP = (id: string) => `harness:${id}`;

const FIX_ISSUE_DEF: WorkflowDef = {
  name: HARNESS_FIX_ISSUE,
  description:
    'Multi-model staged run: qualify, diagnose, fix, validate, and review a tracker issue end to end. Always stops at a verified staged diff — publishing stays yours.',
  source: 'built-in',
  steps: [
    { id: 'preflight', name: 'Preflight', command: OP('preflight') },
    { id: 'qualify', name: 'Qualify', prompt: '{{task}}' },
    { id: 'capture', name: 'Capture', command: OP('capture') },
    { id: 'diagnose', name: 'Diagnose', prompt: '{{task}}' },
    { id: 'implement', name: 'Implement', prompt: '{{task}}' },
    { id: 'validate', name: 'Validate', command: OP('validate') },
    { id: 'review', name: 'Review', prompt: '{{task}}' },
    { id: 'stage', name: 'Stage', command: OP('stage') },
  ],
};

const IMPLEMENT_FEATURE_DEF: WorkflowDef = {
  name: HARNESS_IMPLEMENT_FEATURE,
  description:
    'Multi-model staged run: spec first, then implement, validate, and review — sized for long, one-shot builds like a whole module. Always stops at a verified staged diff.',
  source: 'built-in',
  steps: [
    { id: 'preflight', name: 'Preflight', command: OP('preflight') },
    { id: 'capture', name: 'Capture', command: OP('capture') },
    { id: 'spec', name: 'Specify', prompt: '{{task}}' },
    { id: 'pre-implement', name: 'Pre-implementation audit', prompt: '{{task}}' },
    { id: 'implement', name: 'Implement', prompt: '{{task}}' },
    { id: 'validate', name: 'Validate', command: OP('validate') },
    { id: 'review', name: 'Review', prompt: '{{task}}' },
    { id: 'stage', name: 'Stage', command: OP('stage') },
  ],
};

export function harnessWorkflowDefs(): WorkflowDef[] {
  return [FIX_ISSUE_DEF, IMPLEMENT_FEATURE_DEF].map((def) => ({
    ...def,
    steps: def.steps.map((s) => ({ ...s })),
  }));
}
