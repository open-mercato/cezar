import { z } from 'zod';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import type { WorkflowStepDef } from './types.ts';

/**
 * Workflow graphs — the `version: 2` workflow format (spec 2026-09-30-workflow-node-editor).
 *
 * A graph is typed nodes joined by edges from a node's named OUTPUT PORT to the next node. A
 * node finishes by emitting exactly one port; the edge wired to that port is the branch (D5).
 * Exactly one node is active at a time (D1). Cycles are allowed only through a `loop` node,
 * whose per-run counter never resets (D18) — which is what keeps every run finite.
 *
 * Phase 1 node types: `start`, `end`, `loop`, `agent`, `check`. Agent and check nodes carry the
 * same fields as a v1 step, so the executor hands them to the unchanged step runners.
 */

const nodeId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'node ids are letters, digits, "-" and "_" (no dots)');

const nodeBase = { id: nodeId, name: z.string().optional() };

const numericOp = z.enum(['>', '>=', '<', '<=', '==']);
export const conditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('diff-lines'), op: numericOp, value: z.number().nonnegative() }),
  z.object({ kind: z.literal('diff-files'), op: numericOp, value: z.number().nonnegative() }),
  /** True when any changed file matches the glob (`*` within a segment, `**` across). */
  z.object({ kind: z.literal('paths-changed'), glob: z.string().min(1) }),
  /** `ref` is `<node>.<field>`, compared as a number when both sides are numeric. */
  z.object({
    kind: z.literal('output'),
    ref: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*\.[A-Za-z0-9_]+$/, 'ref is <node>.<field>'),
    op: z.enum(['equals', 'not-equals', 'contains', '>', '>=', '<', '<=']),
    value: z.union([z.string(), z.number()]),
  }),
  /** The task's base branch, exactly or by glob. */
  z.object({ kind: z.literal('branch'), op: z.enum(['equals', 'matches']), value: z.string().min(1) }),
]);
export type Condition = z.infer<typeof conditionSchema>;

/** A bounded wait: one minute to one week. */
const waitMs = z.number().int().min(60_000).max(7 * 24 * 60 * 60_000);

const verdictName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'verdicts are letters, digits, "-" and "_"')
  .refine((v) => v !== 'failed' && v !== 'done', 'verdicts cannot be named "done" or "failed"');

export const graphNodeSchema = z.discriminatedUnion('type', [
  z.object({ ...nodeBase, type: z.literal('start') }),
  z.object({ ...nodeBase, type: z.literal('end'), status: z.enum(['success', 'failed']).default('success') }),
  z.object({ ...nodeBase, type: z.literal('loop'), max: z.number().int().positive() }),
  z.object({
    ...nodeBase,
    type: z.literal('agent'),
    prompt: z.string().optional(),
    skill: z.string().optional(),
    model: z.string().optional(),
    runner: z.enum(RUNNER_IDS).optional(),
    allowedTools: z.array(z.string()).optional(),
    bashAllowlist: z.array(z.string()).optional(),
    /** Author-declared outcomes (D10/D17). The agent picks one by ending its turn with
     *  `CEZ:VERDICT <name>`; each becomes an output port in place of `done`. */
    verdicts: z.array(verdictName).min(1).optional(),
    /** Reopen another agent node's session instead of starting fresh (D6). */
    session: z.object({ continue: nodeId }).optional(),
    /** Fork branches only: run as a reviewer (`kind: review` — judges the task branch, never
     *  implements) instead of an implementer. */
    review: z.boolean().optional(),
    /** Fork branches only: the child task's budget, carved from this run's. */
    budgetUsd: z.number().positive().optional(),
  }),
  z.object({
    ...nodeBase,
    type: z.literal('check'),
    command: z.string().min(1),
    /** v1 compatibility: only these non-zero exits are eligible for an onFail retry. */
    retryOn: z.array(z.number().int().positive()).optional(),
  }),
  // ---- phase 1c: nodes cezar executes itself (no agent session) ----
  /** Pause for the user's approve / reject (an ask card with two options). */
  z.object({ ...nodeBase, type: z.literal('gate.human'), message: z.string().min(1), timeoutMs: waitMs.optional() }),
  /** Ask the user a question; the answer is `{{nodes.<id>.answer}}`. */
  z.object({
    ...nodeBase,
    type: z.literal('ask-user'),
    question: z.string().min(1),
    options: z.array(z.string().min(1)).max(6).optional(),
    timeoutMs: waitMs.optional(),
  }),
  /** A child task through the dispatch engine (own worktree, budget carved from this run's). */
  z.object({
    ...nodeBase,
    type: z.literal('dispatch'),
    prompt: z.string().min(1),
    runner: z.enum(RUNNER_IDS).optional(),
    model: z.string().optional(),
    budgetUsd: z.number().positive().optional(),
  }),
  z.object({ ...nodeBase, type: z.literal('git.commit'), message: z.string().min(1) }),
  z.object({ ...nodeBase, type: z.literal('github.draft-pr'), title: z.string().optional() }),
  /** Park until the task PR's checks settle. A timeout is REQUIRED (defaulted) — a wait with no
   *  bounded exit would hold the run forever (AGENTS.md § transitions out of every state). */
  z.object({
    ...nodeBase,
    type: z.literal('github.wait-ci'),
    timeoutMs: waitMs.default(60 * 60_000),
    pollMs: z.number().int().min(10_000).max(30 * 60_000).default(60_000),
  }),
  z.object({ ...nodeBase, type: z.literal('github.pr-comment'), body: z.string().min(1) }),
  // ---- flow: fork/join, branching, composition ----
  /** Fork: 2–4 output ports (`1`…`4`), each wired to an agent node that runs as its own child
   *  task (fresh session, own worktree, carved budget) at the same time as the others. Every
   *  branch agent leads into one `join`. */
  z.object({ ...nodeBase, type: z.literal('fork'), branches: z.number().int().min(2).max(4).default(3) }),
  /** Join: where a fork's branches meet. `all` waits for every branch; `any` takes the first
   *  that succeeds and cancels the rest. */
  z.object({ ...nodeBase, type: z.literal('join'), wait: z.enum(['all', 'any']).default('all') }),
  /** Another workflow, run as a child task (own worktree, carved budget) and awaited. */
  z.object({
    ...nodeBase,
    type: z.literal('workflow'),
    workflow: z.string().min(1),
    prompt: z.string().optional(),
    runner: z.enum(RUNNER_IDS).optional(),
    budgetUsd: z.number().positive().optional(),
  }),
  /** Branch on data: the task's diff, its changed paths, another node's output, the base branch. */
  z.object({ ...nodeBase, type: z.literal('if'), condition: conditionSchema }),
  // ---- more git / GitHub ----
  z.object({ ...nodeBase, type: z.literal('git.push') }),
  /** Merge the freshest base (`origin/<base>`) into the task branch. On conflict the merge is
   *  LEFT in progress and the node leaves by `conflict`, so the next agent sees the conflicts. */
  z.object({ ...nodeBase, type: z.literal('git.sync-base') }),
  z.object({
    ...nodeBase,
    type: z.literal('github.pr-update'),
    ready: z.boolean().optional(),
    addLabels: z.array(z.string().min(1)).optional(),
    reviewers: z.array(z.string().min(1)).optional(),
  }),
  /** Comment on the task's issue (`CEZ:ISSUE`, or the issue the task is about), or on `issue`. */
  z.object({ ...nodeBase, type: z.literal('github.issue-comment'), issue: z.number().int().positive().optional(), body: z.string().min(1) }),
  /** POST to a URL — a network call, so it only runs with `CEZ_WORKFLOW_WEBHOOKS=1`. */
  z.object({ ...nodeBase, type: z.literal('notify.webhook'), url: z.string().url().regex(/^https?:\/\//, 'http(s) URLs only'), body: z.string().optional() }),
]);

/** `from` is `<node>` (its default port) or `<node>.<port>`. */
export const graphEdgeSchema = z.object({ from: z.string().min(1), to: nodeId });

export const workflowGraphSchema = z.object({
  nodes: z.array(graphNodeSchema).min(1),
  edges: z.array(graphEdgeSchema),
  /** Editor-only node positions; the engine never reads them. */
  layout: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).optional(),
});

/** A `version: 2` workflow file. */
export const workflowGraphFileSchema = workflowGraphSchema.extend({
  version: z.literal(2),
  name: z.string().min(1),
  description: z.string().optional(),
});

export type GraphNode = z.infer<typeof graphNodeSchema>;
export type GraphNodeType = GraphNode['type'];
export type GraphEdge = z.infer<typeof graphEdgeSchema>;
export type WorkflowGraph = z.infer<typeof workflowGraphSchema>;
export type WorkflowGraphFile = z.infer<typeof workflowGraphFileSchema>;

/** Output ports per node type; the first is the default a bare `from: <node>` means. */
export const NODE_PORTS: Record<GraphNodeType, readonly string[]> = {
  start: ['next'],
  end: [],
  loop: ['repeat', 'exhausted'],
  agent: ['done', 'failed'],
  check: ['pass', 'fail'],
  'gate.human': ['approve', 'reject'],
  'ask-user': ['answered'],
  dispatch: ['done', 'failed'],
  'git.commit': ['done', 'nothing', 'failed'],
  'github.draft-pr': ['created', 'failed'],
  'github.wait-ci': ['green', 'red', 'timeout', 'failed'],
  'github.pr-comment': ['done', 'failed'],
  fork: ['1', '2', '3'],
  join: ['done', 'failed'],
  workflow: ['done', 'failed'],
  if: ['true', 'false'],
  'git.push': ['done', 'failed'],
  'git.sync-base': ['done', 'conflict', 'failed'],
  'github.pr-update': ['done', 'failed'],
  'github.issue-comment': ['done', 'failed'],
  'notify.webhook': ['done', 'failed'],
};

export interface NodeCatalogEntry {
  type: GraphNodeType;
  category: 'flow' | 'agents' | 'scripts' | 'git';
  label: string;
  description: string;
  /** Default ports; an agent with `verdicts` replaces `done` with one port per verdict. */
  ports: string[];
  /** Fields readable as `{{nodes.<id>.<field>}}` once the node has run. */
  outputs: string[];
}

/** What the editor's palette lists (`GET /workflows/nodes`). Phase-1 types only; the palette
 *  never hard-codes a type, so a later node is one entry here. */
export const NODE_CATALOG: NodeCatalogEntry[] = [
  { type: 'start', category: 'flow', label: 'Start', description: 'Entry point — receives {{task}}.', ports: ['next'], outputs: [] },
  { type: 'end', category: 'flow', label: 'End', description: 'Finishes the run as success or failed.', ports: [], outputs: [] },
  { type: 'loop', category: 'flow', label: 'Loop', description: 'Bounded repeat; every cycle passes through one.', ports: ['repeat', 'exhausted'], outputs: ['iteration', 'max'] },
  { type: 'agent', category: 'agents', label: 'Agent', description: 'One agent session: prompt, skill, runner, model, optional verdicts.', ports: ['done', 'failed'], outputs: ['summary', 'verdict', 'costUsd'] },
  { type: 'check', category: 'scripts', label: 'Check', description: 'Shell command in the worktree — exit 0 passes.', ports: ['pass', 'fail'], outputs: ['exitCode', 'output'] },
  { type: 'gate.human', category: 'flow', label: 'Human gate', description: 'Pause for your approve / reject. Holds no slot while it waits.', ports: ['approve', 'reject'], outputs: ['comment'] },
  { type: 'ask-user', category: 'agents', label: 'Ask user', description: 'Ask a question and continue with the answer.', ports: ['answered'], outputs: ['answer'] },
  { type: 'dispatch', category: 'agents', label: 'Dispatch subtask', description: 'A child task in its own worktree, budget carved from this run.', ports: ['done', 'failed'], outputs: ['runId', 'status', 'summary'] },
  { type: 'git.commit', category: 'git', label: 'Commit', description: 'Commit everything in the worktree.', ports: ['done', 'nothing', 'failed'], outputs: ['sha'] },
  { type: 'github.draft-pr', category: 'git', label: 'Draft PR', description: 'Push the branch and open a draft PR through gh.', ports: ['created', 'failed'], outputs: ['url', 'number'] },
  { type: 'github.wait-ci', category: 'git', label: 'Wait for CI', description: "Park until the PR's checks pass or fail (timeout required).", ports: ['green', 'red', 'timeout', 'failed'], outputs: ['status'] },
  { type: 'github.pr-comment', category: 'git', label: 'PR comment', description: 'Comment on the task PR.', ports: ['done', 'failed'], outputs: [] },
  { type: 'fork', category: 'flow', label: 'Fork', description: 'Split into 2–4 agents that run at once, each a fresh subtask. Wire every branch into one Join.', ports: ['1', '2', '3'], outputs: ['runIds'] },
  { type: 'join', category: 'flow', label: 'Join', description: "Where a fork's agents meet: wait for all, or the first to succeed.", ports: ['done', 'failed'], outputs: ['succeeded', 'failed'] },
  { type: 'if', category: 'flow', label: 'If', description: 'Branch on the diff size, changed paths, a node output or the base branch.', ports: ['true', 'false'], outputs: ['result', 'value'] },
  { type: 'git.push', category: 'git', label: 'Push', description: 'Push the task branch to origin.', ports: ['done', 'failed'], outputs: [] },
  { type: 'git.sync-base', category: 'git', label: 'Sync with base', description: 'Merge the latest base branch in; stops on conflict for an agent to resolve.', ports: ['done', 'conflict', 'failed'], outputs: ['conflicts'] },
  { type: 'github.pr-update', category: 'git', label: 'Update PR', description: 'Mark the task PR ready, add labels, request reviewers.', ports: ['done', 'failed'], outputs: [] },
  { type: 'github.issue-comment', category: 'git', label: 'Issue comment', description: "Comment on the task's issue.", ports: ['done', 'failed'], outputs: ['issue'] },
  { type: 'notify.webhook', category: 'scripts', label: 'Webhook', description: 'POST a message to a URL (needs CEZ_WORKFLOW_WEBHOOKS=1).', ports: ['done', 'failed'], outputs: ['status'] },
  { type: 'workflow', category: 'flow', label: 'Sub-workflow', description: 'Run another saved workflow as a subtask and wait for it.', ports: ['done', 'failed'], outputs: ['runId', 'status', 'summary'] },
];

/** Ports that end the run as `failed` when left unwired; every other unwired port succeeds. */
const FAILURE_PORTS = new Set(['failed', 'fail', 'exhausted', 'reject', 'red', 'timeout', 'conflict']);

export function isFailurePort(port: string): boolean {
  return FAILURE_PORTS.has(port);
}

/** A concrete node's output ports: an agent with verdicts swaps `done` for one port per verdict. */
export function portsOfNode(node: GraphNode): readonly string[] {
  if (node.type === 'agent' && node.verdicts?.length) return [...new Set([...node.verdicts, 'failed'])];
  // A human wait grows a `timeout` port only when it has a timeout to fire.
  if (node.type === 'fork') return Array.from({ length: node.branches }, (_, i) => String(i + 1));
  if ((node.type === 'gate.human' || node.type === 'ask-user') && node.timeoutMs) {
    return [...NODE_PORTS[node.type], 'timeout'];
  }
  return NODE_PORTS[node.type];
}

export function parseEdgeFrom(from: string, nodes: readonly GraphNode[]): { node: string; port: string } | null {
  // Match against known node ids directly rather than splitting on a single dot position:
  // a node compiled from a v1 step may hold a dot itself (`lint.fix` — v1 step ids are any
  // string), and an agent's verdict name is free text with no character restriction, so it
  // may hold one too. The longest node id that is a prefix of `from` wins, since a more
  // specific (longer) id is never itself a port name of a shorter one.
  let best: GraphNode | undefined;
  for (const n of nodes) {
    if (from === n.id || from.startsWith(`${n.id}.`)) {
      if (!best || n.id.length > best.id.length) best = n;
    }
  }
  if (!best) return null;
  if (from === best.id) {
    const port = portsOfNode(best)[0];
    return port ? { node: best.id, port } : null;
  }
  const port = from.slice(best.id.length + 1);
  return portsOfNode(best).includes(port) ? { node: best.id, port } : null;
}

const VERDICT_MARKER_RE = /CEZ:VERDICT[ \t:=]+([A-Za-z0-9][A-Za-z0-9_-]*)\s*$/;

/** The verdict a turn ended with, if it is one the node declared (D17). */
export function parseVerdict(turnText: string, verdicts: readonly string[]): string | null {
  const m = VERDICT_MARKER_RE.exec(turnText.trimEnd());
  return m && verdicts.includes(m[1] as string) ? (m[1] as string) : null;
}

/** Strip a trailing verdict marker from displayed text (same caveat as the other markers). */
export function stripVerdictMarker(text: string): string {
  return text.replace(/\s*CEZ:VERDICT[ \t:=]+[A-Za-z0-9_-]+\s*$/, '');
}

/** The instruction appended to a verdict node's prompt. */
export function verdictInstruction(verdicts: readonly string[]): string {
  const list = verdicts.map((v) => `\`CEZ:VERDICT ${v}\``).join(', ');
  return (
    `When you finish this step, end your final message with exactly one verdict marker on its own ` +
    `last line — one of: ${list}. The workflow branches on it.`
  );
}

const NODE_REF_RE = /\{\{\s*nodes\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_]+)\s*\}\}/g;

/**
 * Structural checks beyond the schema. Returns human-readable problems. Node ids — and only
 * node ids — are double-quoted in them: the editor reads a quoted word as the node to highlight. (empty when the graph is
 * sound). Shared by the file loader and, in phase 2, the editor's validate route.
 */
export function graphIssues(graph: WorkflowGraph): string[] {
  const issues: string[] = [];
  const ids = graph.nodes.map((n) => n.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) issues.push(`duplicate node id "${dup}"`);

  const starts = graph.nodes.filter((n) => n.type === 'start');
  if (starts.length !== 1) issues.push(`a workflow graph needs exactly one start node (found ${starts.length})`);

  // The v1 builder refused to save an empty pipeline; a graph with nothing wired past `start`
  // (or no agent/check anywhere on the walk) passes every other check here yet runs nothing.
  if (starts.length === 1 && graphRailSteps(graph).length === 0) {
    issues.push('a workflow needs at least one agent or check step reachable from start');
  }

  for (const n of graph.nodes) {
    if (n.type === 'if' && n.condition.kind === 'output') {
      const refNode = n.condition.ref.split('.')[0] as string;
      if (!ids.includes(refNode)) issues.push(`if node "${n.id}" reads unknown node "${refNode}"`);
    }
    if (n.type !== 'agent') continue;
    if (!n.prompt && !n.skill) issues.push(`agent node "${n.id}" needs a prompt or a skill`);
    if ((n.review || n.budgetUsd) && !forkOfBranch(graph, n.id)) {
      issues.push(`agent node "${n.id}": review and budget apply only to an agent right after a fork`);
    }
    if (n.verdicts && new Set(n.verdicts).size !== n.verdicts.length) issues.push(`agent node "${n.id}" repeats a verdict`);
    const target = n.session?.continue;
    if (target !== undefined) {
      const t = graph.nodes.find((x) => x.id === target);
      if (!t || t.type !== 'agent') issues.push(`agent node "${n.id}": session.continue must name an agent node (got "${target}")`);
      else if (target === n.id) issues.push(`agent node "${n.id}": session.continue cannot name itself`);
    }
  }

  const wired = new Set<string>();
  for (const e of graph.edges) {
    const from = parseEdgeFrom(e.from, graph.nodes);
    if (!from) {
      issues.push(`edge from "${e.from}": no such node or port`);
      continue;
    }
    const key = `${from.node}.${from.port}`;
    if (wired.has(key)) issues.push(`port "${key}" is wired more than once`);
    wired.add(key);
    const to = graph.nodes.find((n) => n.id === e.to);
    if (!to) issues.push(`edge from "${e.from}": no such target node "${e.to}"`);
    else if (to.type === 'start') issues.push(`edge from "${e.from}": nothing may lead back into the start node "${e.to}"`);
  }

  const joined = new Set<string>();
  let forkIssue = false;
  for (const n of graph.nodes) {
    if (n.type !== 'fork') continue;
    const shape = forkShape(graph, n.id);
    if (typeof shape === 'string') {
      issues.push(shape);
      forkIssue = true;
    } else joined.add(shape.join);
  }
  // A join no fork reaches — reported only when every fork is sound, so one mistake reads once.
  for (const n of graph.nodes) {
    if (n.type === 'join' && !joined.has(n.id) && !forkIssue) issues.push(`join node "${n.id}" has no fork leading into it`);
  }

  // Only a loop's `repeat` port is bounded (its counter never resets, D18), so every cycle must
  // go round through one: look for a cycle in the graph with the `repeat` edges removed. A way
  // back through `exhausted` is NOT bounded — past `max` the loop takes it on every visit.
  const next = new Map<string, string[]>();
  for (const e of graph.edges) {
    const from = parseEdgeFrom(e.from, graph.nodes);
    if (!from) continue;
    const isLoop = graph.nodes.find((n) => n.id === from.node)?.type === 'loop';
    if (isLoop && from.port === 'repeat') continue;
    next.set(from.node, [...(next.get(from.node) ?? []), e.to]);
  }
  const state = new Map<string, 'open' | 'done'>();
  const visit = (id: string): string | null => {
    if (state.get(id) === 'open') return id;
    if (state.get(id) === 'done') return null;
    state.set(id, 'open');
    for (const to of next.get(id) ?? []) {
      const hit = visit(to);
      if (hit) return hit;
    }
    state.set(id, 'done');
    return null;
  };
  for (const id of ids) {
    const hit = visit(id);
    if (hit) {
      issues.push(`the cycle through "${hit}" does not pass a loop node's repeat port — it could run forever`);
      break;
    }
  }

  // `{{nodes.x.y}}` must name a node that exists.
  for (const n of graph.nodes) {
    for (const m of templatedText(n).join('\n').matchAll(NODE_REF_RE)) {
      if (!ids.includes(m[1] as string)) issues.push(`node "${n.id}" references unknown node "${m[1]}"`);
    }
  }
  return issues;
}

/** Agent and check nodes as v1 steps, in walk order from `start` — the run rail and every
 *  step-reading path (continuation, skill hints, resume) keep working on a graph workflow. */
export function graphToSteps(graph: WorkflowGraph): WorkflowStepDef[] {
  const steps: WorkflowStepDef[] = [];
  // A fork's agents run as child tasks, never as steps of this run.
  for (const n of walkOrder(graph)) {
    if (n.type === 'check' || (n.type === 'agent' && !forkOfBranch(graph, n.id))) steps.push(nodeToStep(n));
  }
  return steps;
}

/** Every executable node (not start/end/loop) in walk order, as the run rail lists them. Nodes
 *  cezar runs itself (gates, PRs, CI waits…) ride the rail as `check`-kind rows: they are not
 *  agent sessions, which is the only distinction the rail's `kind` draws. */
export function graphRailSteps(graph: WorkflowGraph): { id: string; name: string; kind: 'agent' | 'check' }[] {
  const label = (type: GraphNodeType) => NODE_CATALOG.find((c) => c.type === type)?.label ?? type;
  return walkOrder(graph)
    .filter((n) => n.type !== 'start' && n.type !== 'end' && n.type !== 'loop' && n.type !== 'join')
    .map((n) => ({ id: n.id, name: n.name ?? (n.type === 'agent' || n.type === 'check' ? n.id : label(n.type)), kind: n.type === 'agent' ? 'agent' : 'check' }));
}

/** Node ids on the path from `from` forward to (and including) `to`, walking actual edges —
 *  used to reopen exactly the rail rows a loop's retry step re-runs. The rail lists nodes in
 *  BFS discovery order from `start`, which does not guarantee `to` comes after `from`, so an
 *  index-range slice of the rail is not reliable here (D-rail-loop-reset). */
export function loopBodyIds(graph: WorkflowGraph, from: string, to: string): ReadonlySet<string> {
  const ids = new Set<string>([from]);
  const queue = [from];
  while (queue.length) {
    const id = queue.shift() as string;
    if (id === to) continue;
    const node = graph.nodes.find((n) => n.id === id);
    for (const port of node ? portsOfNode(node) : []) {
      const edge = graph.edges.find((e) => {
        const f = parseEdgeFrom(e.from, graph.nodes);
        return f?.node === id && f.port === port;
      });
      if (edge && !ids.has(edge.to)) {
        ids.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return ids;
}

/** The text fields of a node that `{{task}}` / `{{nodes.*}}` templates may appear in. */
export function templatedText(n: GraphNode): string[] {
  switch (n.type) {
    case 'agent':
      return [n.prompt ?? ''];
    case 'check':
      return [n.command];
    case 'gate.human':
      return [n.message];
    case 'ask-user':
      return [n.question];
    case 'dispatch':
      return [n.prompt];
    case 'git.commit':
      return [n.message];
    case 'github.draft-pr':
      return [n.title ?? ''];
    case 'github.pr-comment':
      return [n.body];
    case 'workflow':
      return [n.prompt ?? ''];
    case 'github.issue-comment':
      return [n.body];
    case 'notify.webhook':
      return [n.body ?? ''];
    default:
      return [];
  }
}

function walkOrder(graph: WorkflowGraph): GraphNode[] {
  const order: string[] = [];
  const start = graph.nodes.find((n) => n.type === 'start');
  const queue = start ? [start.id] : [];
  const seen = new Set<string>(queue);
  while (queue.length) {
    const id = queue.shift() as string;
    order.push(id);
    const node = graph.nodes.find((n) => n.id === id);
    for (const port of node ? portsOfNode(node) : []) {
      const edge = graph.edges.find((e) => {
        const f = parseEdgeFrom(e.from, graph.nodes);
        return f?.node === id && f.port === port;
      });
      if (edge && !seen.has(edge.to)) {
        seen.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return order.flatMap((id) => graph.nodes.filter((n) => n.id === id));
}

export function nodeToStep(node: Extract<GraphNode, { type: 'agent' | 'check' }>): WorkflowStepDef {
  if (node.type === 'check') {
    const { type, ...rest } = node;
    void type;
    return rest;
  }
  // Graph-only fields stay on the node; a v1 step never carries them.
  const { type, verdicts, session, review, budgetUsd, ...rest } = node;
  void type;
  void verdicts;
  void session;
  void review;
  void budgetUsd;
  return rest;
}

/**
 * v1 steps → an equivalent graph (used to open v1 files in the editor, and by the equivalence
 * tests). `check.onFail {retry, max}` becomes `check.fail → loop(max) → retry target`.
 */
export function compileV1(steps: readonly WorkflowStepDef[]): WorkflowGraph {
  const edges: GraphEdge[] = [];
  const used = new Set(steps.map((s) => s.id));
  const fresh = (base: string) => {
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return id;
  };
  // A v1 step id is any string — `start`, `end`, `lint.fix` — so the structural nodes take ids
  // no step uses, and every edge names its port (see `parseEdgeFrom`).
  const startId = fresh('start');
  const endId = fresh('end');
  const nodes: GraphNode[] = [{ id: startId, type: 'start' }];
  const out = (s: WorkflowStepDef) => `${s.id}.${s.command ? 'pass' : 'done'}`;
  steps.forEach((s, i) => {
    const { onFail, command, ...rest } = s;
    nodes.push(
      command
        ? { ...rest, type: 'check', command, ...(onFail?.retryOn ? { retryOn: onFail.retryOn } : {}) }
        : { ...rest, type: 'agent' },
    );
    edges.push({ from: i === 0 ? `${startId}.next` : out(steps[i - 1]!), to: s.id });
    if (command && onFail) {
      const loopId = fresh(`${s.id}-retry`);
      nodes.push({ id: loopId, type: 'loop', max: onFail.max });
      edges.push({ from: `${s.id}.fail`, to: loopId }, { from: `${loopId}.repeat`, to: onFail.retry });
    }
  });
  nodes.push({ id: endId, type: 'end', status: 'success' });
  edges.push({ from: steps.length ? out(steps[steps.length - 1]!) : `${startId}.next`, to: endId });
  return { nodes, edges };
}

export interface GraphTransition {
  from: string;
  port: string;
  to: string | null;
}

/** A node the executor runs — everything but the structural start / end / loop. */
export type ExecutableNode = Exclude<GraphNode, { type: 'start' | 'end' | 'loop' }>;

export function isExecutableNode(n: GraphNode): n is ExecutableNode {
  return n.type !== 'start' && n.type !== 'end' && n.type !== 'loop';
}

export type GraphStepResult =
  | { kind: 'node'; node: ExecutableNode; transitions: GraphTransition[] }
  | { kind: 'end'; status: 'success' | 'failed'; endNode?: string; transitions: GraphTransition[] };

/**
 * Follow `from.port` to the next executable node, resolving `loop` nodes on the way (each visit
 * bumps that loop's counter in `loopCounts`; `repeat` while the counter is within `max`, else
 * `exhausted`). An unwired port ends the run — `failed` for failure ports, else `success`.
 * Pure apart from `loopCounts`, which the caller owns for the whole run.
 */
export function advance(
  graph: WorkflowGraph,
  from: string,
  port: string,
  loopCounts: Map<string, number>,
): GraphStepResult {
  const transitions: GraphTransition[] = [];
  let cur = from;
  let curPort = port;
  // Each loop visit bumps a counter bounded by its `max`, so this terminates; the guard only
  // protects against a graph that skipped validation.
  for (let guard = 0; guard < 10_000; guard++) {
    const edge = graph.edges.find((e) => {
      const f = parseEdgeFrom(e.from, graph.nodes);
      return f?.node === cur && f.port === curPort;
    });
    if (!edge) {
      transitions.push({ from: cur, port: curPort, to: null });
      return { kind: 'end', status: isFailurePort(curPort) ? 'failed' : 'success', transitions };
    }
    transitions.push({ from: cur, port: curPort, to: edge.to });
    const node = graph.nodes.find((n) => n.id === edge.to);
    if (!node) return { kind: 'end', status: 'failed', transitions };
    if (node.type === 'end') return { kind: 'end', status: node.status, endNode: node.id, transitions };
    if (node.type === 'loop') {
      const count = (loopCounts.get(node.id) ?? 0) + 1;
      loopCounts.set(node.id, count);
      cur = node.id;
      curPort = count <= node.max ? 'repeat' : 'exhausted';
      continue;
    }
    if (node.type === 'start') return { kind: 'end', status: 'failed', transitions };
    return { kind: 'node', node, transitions };
  }
  return { kind: 'end', status: 'failed', transitions };
}

/** First executable node after `start`. */
export function enterGraph(graph: WorkflowGraph, loopCounts: Map<string, number>): GraphStepResult {
  const start = graph.nodes.find((n) => n.type === 'start');
  if (!start) return { kind: 'end', status: 'failed', transitions: [] };
  return advance(graph, start.id, 'next', loopCounts);
}

/**
 * Replace `{{nodes.<id>.<field>}}` from recorded node outputs. A reference to a node that has
 * not produced that field yet renders empty — `graphIssues` already rejected unknown node ids,
 * so an empty value here means "not run yet on this path", never a typo.
 */
export function renderNodeRefs(text: string, outputs: ReadonlyMap<string, Record<string, string | number>>): string {
  return text.replace(NODE_REF_RE, (_, id: string, field: string) => {
    const value = outputs.get(id)?.[field];
    return value === undefined ? '' : String(value);
  });
}

/** `*` matches within a path segment, `**` across segments, `?` one character. */
export function globMatch(glob: string, path: string): boolean {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`).test(path);
}

/** Compare for an `if` node: numerically when both sides are numbers, else as strings. */
export function compareValues(actual: string | number | undefined, op: string, expected: string | number): boolean {
  const a = actual === undefined ? '' : actual;
  const na = typeof a === 'number' ? a : a.trim() !== '' ? Number(a) : NaN;
  const nb = typeof expected === 'number' ? expected : expected.trim() !== '' ? Number(expected) : NaN;
  const numeric = !Number.isNaN(na) && !Number.isNaN(nb);
  switch (op) {
    case 'equals':
    case '==':
      return numeric ? na === nb : String(a) === String(expected);
    case 'not-equals':
      return numeric ? na !== nb : String(a) !== String(expected);
    case 'contains':
      return String(a).includes(String(expected));
    case '>':
      return numeric && na > nb;
    case '>=':
      return numeric && na >= nb;
    case '<':
      return numeric && na < nb;
    case '<=':
      return numeric && na <= nb;
    default:
      return false;
  }
}

/** Whether an agent node is the workflow's interactive tail: its `done` port ends the run
 *  successfully (wired to a success `end`, or unwired). Mirrors v1's "last step is interactive". */
export function isTerminalAgent(graph: WorkflowGraph, nodeIdValue: string): boolean {
  // A verdict node always hands its decision to the graph — it is never the interactive tail.
  const self = graph.nodes.find((n) => n.id === nodeIdValue);
  if (self?.type === 'agent' && self.verdicts?.length) return false;
  const edge = graph.edges.find((e) => {
    const f = parseEdgeFrom(e.from, graph.nodes);
    return f?.node === nodeIdValue && f.port === 'done';
  });
  if (!edge) return true;
  const to = graph.nodes.find((n) => n.id === edge.to);
  return to?.type === 'end' && to.status === 'success';
}

/** The edge wired to `node.port`, if any. */
export function edgeFrom(graph: WorkflowGraph, node: string, port: string): GraphEdge | undefined {
  return graph.edges.find((e) => {
    const f = parseEdgeFrom(e.from, graph.nodes);
    return f?.node === node && f.port === port;
  });
}

/** The fork an agent node is a branch of — the node right behind it, when that is a fork. */
export function forkOfBranch(graph: WorkflowGraph, agentId: string): string | undefined {
  for (const e of graph.edges) {
    if (e.to !== agentId) continue;
    const f = parseEdgeFrom(e.from, graph.nodes);
    if (f && graph.nodes.find((n) => n.id === f.node)?.type === 'fork') return f.node;
  }
  return undefined;
}

export interface ForkShape {
  branches: { port: string; agent: Extract<GraphNode, { type: 'agent' }> }[];
  join: string;
  wait: 'all' | 'any';
}

/**
 * A fork's branches and the join they meet at — or the one problem that makes it unrunnable.
 * The shape is deliberately strict (fork → one agent per port → one join) so what the canvas
 * shows is exactly what the engine runs: each branch agent is one child task.
 */
export function forkShape(graph: WorkflowGraph, forkId: string): ForkShape | string {
  const fork = graph.nodes.find((n) => n.id === forkId);
  if (!fork || fork.type !== 'fork') return `no fork node "${forkId}"`;
  const branches: ForkShape['branches'] = [];
  let join: string | undefined;
  for (const port of portsOfNode(fork)) {
    const edge = edgeFrom(graph, forkId, port);
    if (!edge) return `fork "${forkId}": branch ${port} is not wired to an agent`;
    const agent = graph.nodes.find((n) => n.id === edge.to);
    if (!agent || agent.type !== 'agent') return `fork "${forkId}": branch ${port} must lead to an agent node`;
    if (agent.session || agent.verdicts?.length) {
      return `agent node "${agent.id}" runs as a fork branch — it cannot continue a session or declare verdicts`;
    }
    if (graph.edges.some((e) => e.to === agent.id && parseEdgeFrom(e.from, graph.nodes)?.node !== forkId)) {
      return `agent node "${agent.id}" is a fork branch — nothing else may lead into it`;
    }
    const done = edgeFrom(graph, agent.id, 'done');
    if (!done) return `fork branch "${agent.id}": wire its done port into a join`;
    for (const p of ['done', 'failed']) {
      const out = edgeFrom(graph, agent.id, p);
      if (!out) continue;
      if (graph.nodes.find((n) => n.id === out.to)?.type !== 'join') return `fork branch "${agent.id}": its ${p} port must lead into a join`;
      if (join && out.to !== join) return `fork "${forkId}": every branch must meet at the same join`;
      join = out.to;
    }
    if (branches.some((b) => b.agent.id === agent.id)) return `fork "${forkId}": two branches lead to the same agent "${agent.id}"`;
    branches.push({ port, agent });
  }
  const joinNode = graph.nodes.find((n) => n.id === join);
  if (!joinNode || joinNode.type !== 'join') return `fork "${forkId}" needs a join`;
  const ids = new Set(branches.map((b) => b.agent.id));
  if (graph.edges.some((e) => e.to === joinNode.id && !ids.has(parseEdgeFrom(e.from, graph.nodes)?.node ?? ''))) {
    return `join node "${joinNode.id}" must be reached only from fork "${forkId}"'s agents`;
  }
  return { branches, join: joinNode.id, wait: joinNode.wait };
}
