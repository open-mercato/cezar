import { graphIssues, graphToSteps, type WorkflowGraph } from './graph.ts';
import type { WorkflowDef } from './types.ts';

/**
 * Built-in graph workflows (spec 2026-09-30-workflow-node-editor, D19): exemplars that show what
 * a graph can do and serve as starting points — open one in the editor, rename, save. They sit in
 * the catalog next to `quick-task`, which stays the default (every default is chosen BY NAME).
 * A repo file with the same name wins, exactly as it does for `quick-task`.
 *
 * No `layout`: the editor lays them out (dagre, `autoLayout`) with the same geometry it draws.
 *
 * Kept deliberately generic: `npm test` is the one command most repos answer, and every agent
 * node leaves the runner to the task's own choice.
 */

function builtIn(name: string, description: string, graph: WorkflowGraph): WorkflowDef {
  const issues = graphIssues(graph);
  if (issues.length) throw new Error(`built-in workflow "${name}" is invalid: ${issues.join('; ')}`);
  return { name, description, source: 'built-in', steps: graphToSteps(graph), graph };
}

export const IMPLEMENT_AND_VERIFY = builtIn(
  'implement-and-verify',
  'Implement the task, run the tests, and loop a fixer on red (up to 3 rounds).',
  {
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'implement', type: 'agent', name: 'Implement', prompt: '{{task}}' },
      { id: 'tests', type: 'check', name: 'Run tests', command: 'npm test' },
      { id: 'retry', type: 'loop', name: 'Retry', max: 3 },
      {
        id: 'fix',
        type: 'agent',
        name: 'Fix failures',
        session: { continue: 'implement' },
        prompt: 'The tests failed (round {{nodes.retry.iteration}}/{{nodes.retry.max}}):\n\n{{nodes.tests.output}}\n\nFix the cause, not the tests.',
      },
      { id: 'done', type: 'end', name: 'Done', status: 'success' },
      { id: 'gave-up', type: 'end', name: 'Gave up', status: 'failed' },
    ],
    edges: [
      { from: 'start', to: 'implement' },
      { from: 'implement.done', to: 'tests' },
      { from: 'tests.pass', to: 'done' },
      { from: 'tests.fail', to: 'retry' },
      { from: 'retry.repeat', to: 'fix' },
      { from: 'retry.exhausted', to: 'gave-up' },
      { from: 'fix.done', to: 'tests' },
    ],
  },
);

export const IMPLEMENT_REVIEW_PR = builtIn(
  'implement-review-pr',
  'Implement, test, get an AI review with verdicts, pass your gate, then open a draft PR.',
  {
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'implement', type: 'agent', name: 'Implement', prompt: '{{task}}' },
      { id: 'tests', type: 'check', name: 'Run tests', command: 'npm test' },
      { id: 'test-retry', type: 'loop', name: 'Test retry', max: 2 },
      {
        id: 'fix',
        type: 'agent',
        name: 'Fix failures',
        session: { continue: 'implement' },
        prompt: 'The tests failed:\n\n{{nodes.tests.output}}\n\nFix the cause.',
      },
      {
        id: 'review',
        type: 'agent',
        name: 'AI review',
        prompt: 'Review the changes made for: {{task}}. Look for real correctness, security and test gaps only.',
        verdicts: ['approve', 'changes'],
      },
      { id: 'review-retry', type: 'loop', name: 'Review rounds', max: 2 },
      {
        id: 'address',
        type: 'agent',
        name: 'Address review',
        session: { continue: 'implement' },
        prompt: 'The reviewer asked for changes:\n\n{{nodes.review.summary}}\n\nMake them.',
      },
      { id: 'gate', type: 'gate.human', name: 'Your review', message: 'Review verdict: {{nodes.review.verdict}}. Open a draft PR for “{{task}}”?' },
      { id: 'pr', type: 'github.draft-pr', name: 'Draft PR' },
      { id: 'done', type: 'end', name: 'PR opened', status: 'success' },
      { id: 'stopped', type: 'end', name: 'Stopped', status: 'failed' },
    ],
    edges: [
      { from: 'start', to: 'implement' },
      { from: 'implement.done', to: 'tests' },
      { from: 'tests.pass', to: 'review' },
      { from: 'tests.fail', to: 'test-retry' },
      { from: 'test-retry.repeat', to: 'fix' },
      { from: 'test-retry.exhausted', to: 'stopped' },
      { from: 'fix.done', to: 'tests' },
      { from: 'review.approve', to: 'gate' },
      { from: 'review.changes', to: 'review-retry' },
      { from: 'review-retry.repeat', to: 'address' },
      { from: 'review-retry.exhausted', to: 'gate' },
      { from: 'address.done', to: 'tests' },
      { from: 'gate.approve', to: 'pr' },
      { from: 'gate.reject', to: 'stopped' },
      { from: 'pr.created', to: 'done' },
    ],
  },
);

export const FIX_CI = builtIn(
  'fix-ci',
  "Wait for the task PR's CI and loop an agent on red until it is green (up to 3 rounds).",
  {
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'ci', type: 'github.wait-ci', name: 'Wait for CI', timeoutMs: 60 * 60_000, pollMs: 60_000 },
      { id: 'retry', type: 'loop', name: 'Fix rounds', max: 3 },
      {
        id: 'fix',
        type: 'agent',
        name: 'Fix CI',
        prompt:
          'CI on this task’s PR is red. Read the failing checks (`gh pr checks`, then the job logs), fix the cause, commit and push. Task: {{task}}',
      },
      { id: 'green', type: 'end', name: 'Green', status: 'success' },
      { id: 'gave-up', type: 'end', name: 'Gave up', status: 'failed' },
    ],
    edges: [
      { from: 'start', to: 'ci' },
      { from: 'ci.green', to: 'green' },
      { from: 'ci.red', to: 'retry' },
      { from: 'ci.timeout', to: 'gave-up' },
      { from: 'retry.repeat', to: 'fix' },
      { from: 'retry.exhausted', to: 'gave-up' },
      { from: 'fix.done', to: 'ci' },
    ],
  },
);

const REVIEWER = (focus: string) =>
  `Review the changes on this task's branch for: {{task}}.\n\nYour focus: ${focus}. Report only real problems, each with the file and line, and say plainly when you found none.`;

export const REVIEW_COUNCIL = builtIn(
  'review-council',
  'Implement, then three fresh reviewers at once; a judge weighs their reports and ships or sends it back (up to 2 rounds).',
  {
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'implement', type: 'agent', name: 'Implement', prompt: '{{task}}' },
      { id: 'council', type: 'fork', name: 'Council', branches: 3 },
      { id: 'correctness', type: 'agent', name: 'Correctness', review: true, prompt: REVIEWER('correctness — logic errors, edge cases, broken behavior') },
      { id: 'security', type: 'agent', name: 'Security', review: true, prompt: REVIEWER('security — injection, secrets, unsafe input, permissions') },
      { id: 'tests', type: 'agent', name: 'Tests', review: true, prompt: REVIEWER('tests — is the change covered, and do the tests prove it') },
      { id: 'verdicts', type: 'join', name: 'All reports', wait: 'all' },
      {
        id: 'judge',
        type: 'agent',
        name: 'Judge',
        verdicts: ['ship', 'fix'],
        prompt:
          'Three reviewers checked the work on: {{task}}.\n\n' +
          '## Correctness ({{nodes.correctness.status}})\n{{nodes.correctness.summary}}\n\n' +
          '## Security ({{nodes.security.status}})\n{{nodes.security.summary}}\n\n' +
          '## Tests ({{nodes.tests.status}})\n{{nodes.tests.summary}}\n\n' +
          'Consolidate their findings: drop duplicates and anything not a real problem. Decide ship or fix, and when fixing list exactly what must change.',
      },
      { id: 'rounds', type: 'loop', name: 'Fix rounds', max: 2 },
      {
        id: 'address',
        type: 'agent',
        name: 'Address findings',
        session: { continue: 'implement' },
        prompt: 'The review council asked for changes (round {{nodes.rounds.iteration}}/{{nodes.rounds.max}}):\n\n{{nodes.judge.summary}}\n\nMake them.',
      },
      { id: 'gate', type: 'gate.human', name: 'Your call', message: 'The council still wants changes after 2 rounds:\n\n{{nodes.judge.summary}}\n\nOpen a draft PR anyway?' },
      { id: 'pr', type: 'github.draft-pr', name: 'Draft PR' },
      { id: 'done', type: 'end', name: 'PR opened', status: 'success' },
      { id: 'stopped', type: 'end', name: 'Stopped', status: 'failed' },
    ],
    edges: [
      { from: 'start', to: 'implement' },
      { from: 'implement.done', to: 'council' },
      { from: 'council.1', to: 'correctness' },
      { from: 'council.2', to: 'security' },
      { from: 'council.3', to: 'tests' },
      { from: 'correctness.done', to: 'verdicts' },
      { from: 'security.done', to: 'verdicts' },
      { from: 'tests.done', to: 'verdicts' },
      // A reviewer that crashed still reaches the judge, who sees its status.
      { from: 'verdicts.done', to: 'judge' },
      { from: 'verdicts.failed', to: 'judge' },
      { from: 'judge.ship', to: 'pr' },
      { from: 'judge.fix', to: 'rounds' },
      { from: 'rounds.repeat', to: 'address' },
      { from: 'rounds.exhausted', to: 'gate' },
      { from: 'address.done', to: 'council' },
      { from: 'gate.approve', to: 'pr' },
      { from: 'gate.reject', to: 'stopped' },
      { from: 'pr.created', to: 'done' },
    ],
  },
);

export const BUILT_IN_GRAPH_WORKFLOWS: readonly WorkflowDef[] = [IMPLEMENT_AND_VERIFY, IMPLEMENT_REVIEW_PR, REVIEW_COUNCIL, FIX_CI];
