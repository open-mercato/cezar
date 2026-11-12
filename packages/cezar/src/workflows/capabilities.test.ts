import { describe, expect, it } from 'vitest';
import { isReadOnlyWorkflow, readOnlyWorkflowRefusal, workflowCapabilities } from './capabilities.ts';
import { advance, graphIssues, graphToSteps, type WorkflowGraph } from './graph.ts';
import { loadWorkflows } from './load.ts';
import { ASSESS_IMPACT_WORKFLOW, FIX_CI, IMPLEMENT_AND_VERIFY, IMPLEMENT_REVIEW_PR, REVIEW_COUNCIL, REVIEW_PR } from './templates.ts';
import { QUICK_TASK_WORKFLOW, type WorkflowDef } from './types.ts';

const ALL = { push: true, openPr: true, postToGithub: true };
const NONE = { push: false, openPr: false, postToGithub: false };

const graphDef = (graph: WorkflowGraph, name = 'g'): WorkflowDef => {
  expect(graphIssues(graph)).toEqual([]);
  return { name, source: 'file', steps: graphToSteps(graph), graph };
};
const oneNode = (node: WorkflowGraph['nodes'][number]): WorkflowDef =>
  graphDef({
    nodes: [{ id: 'start', type: 'start' }, { id: 'look', type: 'check', command: 'git status' }, node],
    edges: [{ from: 'start', to: 'look' }, { from: 'look', to: node.id }],
  });

describe('review-council gates every PR on a human', () => {
  const graph = REVIEW_COUNCIL.graph!;

  it('wires nothing into the draft PR but the gate’s approve', () => {
    const pr = graph.nodes.find((n) => n.type === 'github.draft-pr')!;
    const gate = graph.nodes.find((n) => n.type === 'gate.human')!;
    expect(graph.edges.filter((e) => e.to === pr.id)).toEqual([{ from: `${gate.id}.approve`, to: pr.id }]);
  });

  it('sends the judge’s ship verdict to the gate, not the PR', () => {
    expect(advance(graph, 'judge', 'ship', new Map())).toMatchObject({ kind: 'node', node: { id: 'gate' } });
  });

  it('ends successfully when there is nothing to propose', () => {
    expect(advance(graph, 'pr', 'nothing', new Map())).toMatchObject({ kind: 'end', status: 'success', endNode: 'no-changes' });
  });
});

describe('review-pr', () => {
  const graph = REVIEW_PR.graph!;

  it('has no implement, push, PR or GitHub-posting node', () => {
    const types = new Set(graph.nodes.map((n) => n.type));
    for (const t of ['github.draft-pr', 'git.push', 'github.pr-comment', 'github.issue-comment', 'github.pr-update', 'dispatch', 'workflow', 'git.commit']) {
      expect(types.has(t as never)).toBe(false);
    }
    expect(graph.nodes.some((n) => n.type === 'agent' && !n.allowedTools)).toBe(false);
  });

  it('reviews for correctness, security and tests, then a judge decides approve / changes / reject', () => {
    const judge = graph.nodes.find((n) => n.id === 'judge');
    expect(judge).toMatchObject({ type: 'agent', verdicts: ['approve', 'changes', 'reject'] });
    expect(graph.nodes.filter((n) => n.type === 'agent').map((n) => n.id)).toEqual(['correctness', 'security', 'tests', 'judge']);
  });

  it('can do nothing outside the machine', () => {
    expect(workflowCapabilities(REVIEW_PR)).toEqual(NONE);
    expect(isReadOnlyWorkflow(REVIEW_PR)).toBe(true);
  });

  it('is in the catalog', async () => {
    const { workflows } = await loadWorkflows('/nonexistent-cezar-repo');
    expect(workflows.map((w) => w.name)).toContain('review-pr');
  });
});

describe('workflowCapabilities', () => {
  it('flags every built-in that runs an unrestricted agent as able to do everything', () => {
    for (const def of [QUICK_TASK_WORKFLOW, ASSESS_IMPACT_WORKFLOW, IMPLEMENT_AND_VERIFY, IMPLEMENT_REVIEW_PR, REVIEW_COUNCIL, FIX_CI]) {
      expect([def.name, workflowCapabilities(def)]).toEqual([def.name, ALL]);
    }
  });

  it('reads the system nodes', () => {
    expect(workflowCapabilities(oneNode({ id: 'pr', type: 'github.draft-pr' }))).toEqual({ push: true, openPr: true, postToGithub: false });
    expect(workflowCapabilities(oneNode({ id: 'p', type: 'git.push' }))).toEqual({ push: true, openPr: false, postToGithub: false });
    expect(workflowCapabilities(oneNode({ id: 'c', type: 'github.pr-comment', body: 'hi' }))).toEqual({ push: false, openPr: false, postToGithub: true });
    expect(workflowCapabilities(oneNode({ id: 'c', type: 'github.issue-comment', body: 'hi' }))).toEqual({ push: false, openPr: false, postToGithub: true });
    expect(workflowCapabilities(oneNode({ id: 'u', type: 'github.pr-update', ready: true }))).toEqual({ push: false, openPr: false, postToGithub: true });
    expect(workflowCapabilities(oneNode({ id: 'd', type: 'dispatch', prompt: 'x' }))).toEqual(ALL);
    expect(workflowCapabilities(oneNode({ id: 'g', type: 'gate.human', message: 'ok?' }))).toEqual(NONE);
  });

  it('counts an agent as read-only only when every tool and Bash prefix only reads', () => {
    const agent = (allowedTools?: string[], bashAllowlist?: string[]): WorkflowDef => ({
      name: 'a',
      source: 'file',
      steps: [{ id: 'a', prompt: 'x', ...(allowedTools ? { allowedTools } : {}), ...(bashAllowlist ? { bashAllowlist } : {}) }],
    });
    expect(workflowCapabilities(agent())).toEqual(ALL);
    expect(workflowCapabilities(agent(['Read', 'Bash']))).toEqual(ALL);
    expect(workflowCapabilities(agent(['Read', 'Edit', 'Write', 'Grep']))).toEqual(NONE);
    expect(workflowCapabilities(agent(['Read', 'Bash'], ['gh pr view', 'git diff']))).toEqual(NONE);
    for (const unsafe of ['git', 'gh', 'gh pr', 'git push', 'gh pr create', 'gh pr comment', 'gh api', 'git fetch', 'npm test']) {
      expect([unsafe, workflowCapabilities(agent(['Bash'], ['git diff', unsafe]))]).toEqual([unsafe, ALL]);
    }
    expect(workflowCapabilities(agent(['Read', 'mcp__github__create_pull_request']))).toEqual(ALL);
  });

  it('counts a check as read-only only when every command in it only reads', () => {
    const check = (command: string): WorkflowDef => ({ name: 'c', source: 'file', steps: [{ id: 'c', command }] });
    expect(workflowCapabilities(check('git status && git diff --stat'))).toEqual(NONE);
    expect(workflowCapabilities(check('npm test'))).toEqual(ALL);
    expect(workflowCapabilities(check('git diff; git push'))).toEqual(ALL);
    expect(workflowCapabilities(check('git log $(git push)'))).toEqual(ALL);
  });

  it('resolves a sub-workflow through the catalog, and counts an unknown one as everything', () => {
    const parent = oneNode({ id: 'w', type: 'workflow', workflow: 'review-pr' });
    expect(workflowCapabilities(parent, [REVIEW_PR])).toEqual(NONE);
    expect(workflowCapabilities(parent, [])).toEqual(ALL);
    const self = oneNode({ id: 'w', type: 'workflow', workflow: 'g' });
    expect(workflowCapabilities(self, [self])).toEqual(NONE);
  });
});

describe('readOnlyWorkflowRefusal', () => {
  it('refuses a read-only workflow on a backend that ignores tool limits', () => {
    expect(readOnlyWorkflowRefusal(REVIEW_PR, 'codex')).toMatch(/codex does not enforce .* "review-pr"/);
    expect(readOnlyWorkflowRefusal(REVIEW_PR, 'opencode')).toBeDefined();
  });

  it('lets it run where the limits hold, and never touches a workflow that may publish', () => {
    expect(readOnlyWorkflowRefusal(REVIEW_PR, 'claude')).toBeUndefined();
    expect(readOnlyWorkflowRefusal(REVIEW_PR, 'pi')).toBeUndefined();
    expect(readOnlyWorkflowRefusal(QUICK_TASK_WORKFLOW, 'codex')).toBeUndefined();
    expect(readOnlyWorkflowRefusal(undefined, 'codex')).toBeUndefined();
  });
});
