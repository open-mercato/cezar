import { describe, expect, it } from 'vitest';
import {
  advance,
  compileV1,
  edgeFrom,
  forkOfBranch,
  forkShape,
  graphIssues,
  graphRailSteps,
  graphToSteps,
  isTerminalAgent,
  loopBodyIds,
  parseEdgeFrom,
  portsOfNode,
  workflowGraphSchema,
  type GraphEdge,
  type GraphNode,
  type GraphStepResult,
  type WorkflowGraph,
} from './graph.ts';

// The lookups in graph.ts answer from a per-call index instead of rescanning every edge (and,
// per edge, every node). These tests pin that the index answers exactly as the scans did —
// first match in array order, duplicates included — and that a large graph loads quickly.

/** A sound synthetic graph: `stages` × (implement → test ⇄ fix loop → verdict review → fork of
 *  two agents → join → human gate), 11 nodes and 23 edges per stage. */
function syntheticGraph(stages: number): WorkflowGraph {
  const nodes: GraphNode[] = [{ id: 'start', type: 'start' }];
  const edges: GraphEdge[] = [];
  const wire = (from: string, to: string) => edges.push({ from, to });
  for (let k = 0; k < stages; k++) {
    const id = (name: string) => `${name}-${k}`;
    nodes.push(
      { id: id('impl'), type: 'agent', prompt: `stage ${k}: {{task}}` },
      { id: id('test'), type: 'check', command: 'npm test' },
      { id: id('retry'), type: 'loop', max: 2 },
      { id: id('fix'), type: 'agent', prompt: `fix {{nodes.test-${k}.output}}` },
      { id: id('review'), type: 'agent', prompt: 'review', verdicts: ['ship', 'redo'] },
      { id: id('again'), type: 'loop', max: 1 },
      { id: id('fork'), type: 'fork', branches: 2 },
      { id: id('a'), type: 'agent', prompt: 'branch a', review: true },
      { id: id('b'), type: 'agent', prompt: 'branch b', budgetUsd: 1 },
      { id: id('join'), type: 'join', wait: 'all' },
      { id: id('gate'), type: 'gate.human', message: 'continue?' },
    );
    wire(k === 0 ? 'start' : `gate-${k - 1}.approve`, id('impl'));
    wire(`${id('impl')}.done`, id('test'));
    wire(`${id('impl')}.failed`, 'failed');
    wire(`${id('test')}.pass`, id('review'));
    wire(`${id('test')}.fail`, id('retry'));
    wire(`${id('retry')}.repeat`, id('fix'));
    wire(`${id('retry')}.exhausted`, 'failed');
    wire(`${id('fix')}.done`, id('test'));
    wire(`${id('fix')}.failed`, 'failed');
    wire(`${id('review')}.ship`, id('fork'));
    wire(`${id('review')}.redo`, id('again'));
    wire(`${id('review')}.failed`, 'failed');
    wire(`${id('again')}.repeat`, id('impl'));
    wire(`${id('again')}.exhausted`, 'failed');
    wire(`${id('fork')}.1`, id('a'));
    wire(`${id('fork')}.2`, id('b'));
    wire(`${id('a')}.done`, id('join'));
    wire(`${id('a')}.failed`, id('join'));
    wire(`${id('b')}.done`, id('join'));
    wire(`${id('b')}.failed`, id('join'));
    wire(`${id('join')}.done`, id('gate'));
    wire(`${id('join')}.failed`, 'failed');
    wire(`${id('gate')}.reject`, 'failed');
  }
  nodes.push({ id: 'ok', type: 'end', status: 'success' }, { id: 'failed', type: 'end', status: 'failed' });
  wire(`gate-${stages - 1}.approve`, 'ok');
  return workflowGraphSchema.parse({ nodes, edges });
}

// ---- reference implementations: the linear scans the index replaced ----

const scanEdgeFrom = (g: WorkflowGraph, node: string, port: string) =>
  g.edges.find((e) => {
    const f = parseEdgeFrom(e.from, g.nodes);
    return f?.node === node && f.port === port;
  });

function scanForkOfBranch(g: WorkflowGraph, agentId: string): string | undefined {
  for (const e of g.edges) {
    if (e.to !== agentId) continue;
    const f = parseEdgeFrom(e.from, g.nodes);
    if (f && g.nodes.find((n) => n.id === f.node)?.type === 'fork') return f.node;
  }
  return undefined;
}

/** Breadth-first from `from` over each node's ports, as walkOrder / loopBodyIds did. */
function scanBfs(g: WorkflowGraph, from: string, stopAt?: string): string[] {
  const order: string[] = [];
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const id = queue.shift() as string;
    order.push(id);
    if (id === stopAt) continue;
    const node = g.nodes.find((n) => n.id === id);
    for (const port of node ? portsOfNode(node) : []) {
      const edge = scanEdgeFrom(g, id, port);
      if (edge && !seen.has(edge.to)) {
        seen.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return order;
}

function scanAdvance(g: WorkflowGraph, from: string, port: string, loopCounts: Map<string, number>): GraphStepResult {
  const transitions: GraphStepResult['transitions'] = [];
  let cur = from;
  let curPort = port;
  for (let guard = 0; guard < 10_000; guard++) {
    const edge = scanEdgeFrom(g, cur, curPort);
    if (!edge) {
      transitions.push({ from: cur, port: curPort, to: null });
      return { kind: 'end', status: ['failed', 'fail', 'exhausted', 'reject', 'red', 'timeout', 'conflict'].includes(curPort) ? 'failed' : 'success', transitions };
    }
    transitions.push({ from: cur, port: curPort, to: edge.to });
    const node = g.nodes.find((n) => n.id === edge.to);
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

/** Seeded so a failing case replays. */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Break a graph the ways an editor can: drop, retarget or double an edge, rewrite an edge's
 *  `from`, give a node another node's id, drop a node. */
function mutate(graph: WorkflowGraph, seed: number): WorkflowGraph {
  const r = rng(seed);
  const g = structuredClone(graph);
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(r() * a.length)] as T;
  for (let k = 0, ops = 1 + Math.floor(r() * 3); k < ops; k++) {
    const op = Math.floor(r() * 6);
    if (op === 0 && g.edges.length) g.edges.splice(Math.floor(r() * g.edges.length), 1);
    else if (op === 1 && g.edges.length) pick(g.edges).to = r() < 0.2 ? 'ghost' : pick(g.nodes).id;
    else if (op === 2 && g.edges.length) g.edges.splice(Math.floor(r() * g.edges.length), 0, { ...pick(g.edges) });
    else if (op === 3) pick(g.nodes).id = pick(g.nodes).id;
    else if (op === 4 && g.nodes.length > 2) g.nodes.splice(Math.floor(r() * g.nodes.length), 1);
    else if (op === 5 && g.edges.length) {
      const port = pick(['', '.done', '.failed', '.pass', '.fail', '.repeat', '.exhausted', '.approve', '.1', '.x']);
      pick(g.edges).from = `${pick(g.nodes).id}${port}`;
    }
  }
  return g;
}

/** Graphs whose lookups disagree easily: v1 ids with dots and a step named `start`, a port
 *  wired twice, a repeated node id. */
const DOTTED = compileV1([
  { id: 'lint', prompt: 'a' },
  { id: 'lint.fix', command: 'npm run lint', onFail: { retry: 'lint', max: 2 } },
  { id: 'start', prompt: 'b' },
  { id: 'lint.fix.again', command: 'x', onFail: { retry: 'lint.fix', max: 1 } },
]);
const SMALL = syntheticGraph(2);
const CASES: [string, WorkflowGraph][] = [
  ['synthetic', SMALL],
  ['dotted v1 ids', DOTTED],
  ...Array.from({ length: 40 }, (_, s): [string, WorkflowGraph] => [`mutated synthetic #${s}`, mutate(SMALL, 100 + s)]),
  ...Array.from({ length: 20 }, (_, s): [string, WorkflowGraph] => [`mutated dotted #${s}`, mutate(DOTTED, 500 + s)]),
];

describe('graph lookups answer as the linear scans did', () => {
  it.each(CASES)('%s', (_name, g) => {
    const start = g.nodes.find((n) => n.type === 'start');
    const ids = [...new Set(g.nodes.map((n) => n.id)), 'ghost'];
    for (const n of g.nodes) {
      for (const port of [...portsOfNode(n), 'no-such-port']) {
        expect(edgeFrom(g, n.id, port)).toBe(scanEdgeFrom(g, n.id, port));
        const [a, b] = [new Map([[n.id, 1]]), new Map([[n.id, 1]])];
        expect(advance(g, n.id, port, a)).toEqual(scanAdvance(g, n.id, port, b));
        expect(a).toEqual(b);
      }
      expect(forkOfBranch(g, n.id)).toBe(scanForkOfBranch(g, n.id));
      if (n.type === 'agent') {
        const done = scanEdgeFrom(g, n.id, 'done');
        const to = done && g.nodes.find((x) => x.id === done.to);
        const self = g.nodes.find((x) => x.id === n.id);
        const verdictNode = self?.type === 'agent' && !!self.verdicts?.length;
        const terminal = !verdictNode && (!done || (to?.type === 'end' && to.status === 'success'));
        expect(isTerminalAgent(g, n.id)).toBe(terminal);
      }
    }
    const walk = start ? scanBfs(g, start.id).flatMap((id) => g.nodes.filter((n) => n.id === id)) : [];
    const rail = walk.filter((n) => !['start', 'end', 'loop', 'join'].includes(n.type)).map((n) => n.id);
    expect(graphRailSteps(g).map((s) => s.id)).toEqual(rail);
    const steps = walk.filter((n) => n.type === 'check' || (n.type === 'agent' && !scanForkOfBranch(g, n.id))).map((n) => n.id);
    expect(graphToSteps(g).map((s) => s.id)).toEqual(steps);
    for (const from of ids) {
      for (const to of ids) expect([...loopBodyIds(g, from, to)].sort()).toEqual(scanBfs(g, from, to).sort());
    }
  });

  it('keeps the first of two edges wired to the same port, and the first of two nodes with one id', () => {
    const g: WorkflowGraph = {
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'a', type: 'agent', prompt: 'first' },
        { id: 'a', type: 'agent', prompt: 'second', verdicts: ['x'] },
        { id: 'b', type: 'check', command: 'true' },
        { id: 'c', type: 'check', command: 'true' },
      ],
      edges: [
        { from: 'start', to: 'a' },
        { from: 'a', to: 'b' },
        { from: 'a.done', to: 'c' },
        { from: 'a.x', to: 'c' },
      ],
    };
    expect(edgeFrom(g, 'a', 'done')?.to).toBe('b');
    // The second `a` declares verdict `x`, but ports resolve against the first `a`, as before.
    expect(edgeFrom(g, 'a', 'x')).toBeUndefined();
    // The walk lists every node carrying a reached id.
    expect(graphToSteps(g).map((s) => s.prompt ?? s.command)).toEqual(['first', 'second', 'true']);
    expect(graphIssues(g)).toEqual([
      'duplicate node id "a"',
      'port "a.done" is wired more than once',
      'edge from "a.x": no such node or port',
    ]);
  });

  it('resolves a dotted `from` to the longest matching node id', () => {
    expect(edgeFrom(DOTTED, 'lint.fix', 'fail')?.to).toBe('lint.fix-retry');
    expect(edgeFrom(DOTTED, 'lint.fix.again', 'fail')?.to).toBe('lint.fix.again-retry');
    expect(edgeFrom(DOTTED, 'lint', 'fail')).toBeUndefined();
  });

  it('reports forkShape problems in the same order', () => {
    const g = structuredClone(SMALL);
    g.edges.push({ from: 'impl-0.failed', to: 'a-1' });
    expect(forkShape(g, 'fork-1')).toBe('agent node "a-1" is a fork branch — nothing else may lead into it');
    expect(forkShape(g, 'no-such-fork')).toBe('no fork node "no-such-fork"');
  });
});

describe('large graphs', () => {
  it('validates, compiles and walks a 500-node graph well inside a second', () => {
    const g = syntheticGraph(45);
    expect(g.nodes.length).toBe(498);
    expect(g.edges.length).toBe(1036);
    const t0 = performance.now();
    expect(graphIssues(g)).toEqual([]);
    expect(graphToSteps(g)).toHaveLength(45 * 4);
    expect(graphRailSteps(g)).toHaveLength(45 * 8);
    expect(loopBodyIds(g, 'impl-0', 'review-0').size).toBeGreaterThan(1);
    // The scan-based lookups took tens of seconds here (nodes × edges² per walk); a generous
    // bound keeps a slow CI runner green while still failing on a return to that.
    expect(performance.now() - t0).toBeLessThan(1_000);
  });
});
