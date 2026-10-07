import { describe, expect, it } from 'vitest';
import {
  advance,
  compareValues,
  compileV1,
  enterGraph,
  forkShape,
  globMatch,
  graphIssues,
  graphRailSteps,
  graphToSteps,
  isTerminalAgent,
  parseVerdict,
  portsOfNode,
  renderNodeRefs,
  stripVerdictMarker,
  workflowGraphFileSchema,
  type WorkflowGraph,
} from './graph.ts';

/** The spec's example, trimmed to phase-1 node types. */
const EXAMPLE: WorkflowGraph = {
  nodes: [
    { id: 'start', type: 'start' },
    { id: 'implement', type: 'agent', prompt: '{{task}}' },
    { id: 'tests', type: 'check', command: 'npm test' },
    { id: 'retry', type: 'loop', max: 2 },
    { id: 'fix', type: 'agent', prompt: 'attempt {{nodes.retry.iteration}}: {{nodes.tests.output}}' },
    { id: 'ok', type: 'end', status: 'success' },
    { id: 'gave-up', type: 'end', status: 'failed' },
  ],
  edges: [
    { from: 'start', to: 'implement' },
    { from: 'implement.done', to: 'tests' },
    { from: 'tests.pass', to: 'ok' },
    { from: 'tests.fail', to: 'retry' },
    { from: 'retry.repeat', to: 'fix' },
    { from: 'retry.exhausted', to: 'gave-up' },
    { from: 'fix', to: 'tests' },
  ],
};

describe('graphIssues', () => {
  it('accepts a sound graph', () => {
    expect(graphIssues(EXAMPLE)).toEqual([]);
  });

  it('rejects a cycle that does not pass a loop node', () => {
    const g: WorkflowGraph = {
      ...EXAMPLE,
      edges: EXAMPLE.edges.map((e) => (e.from === 'tests.fail' ? { from: 'tests.fail', to: 'fix' } : e)),
    };
    expect(graphIssues(g).join()).toMatch(/does not pass a loop node/);
  });

  it('rejects a cycle that comes back through a loop\'s exhausted port — only repeat is bounded', () => {
    // tests.fail → retry; exhausted → escalate → tests: past `max` the loop takes `exhausted` on
    // every visit, so this lap never ends.
    const g: WorkflowGraph = {
      nodes: [...EXAMPLE.nodes, { id: 'escalate', type: 'agent', prompt: 'try harder' }],
      edges: [
        ...EXAMPLE.edges.filter((e) => e.from !== 'retry.exhausted'),
        { from: 'retry.exhausted', to: 'escalate' },
        { from: 'escalate.done', to: 'tests' },
      ],
    };
    expect(graphIssues(g).join()).toMatch(/does not pass a loop node's repeat port/);
    // …and the walk it would have allowed really is endless: no end after far more than `max` laps.
    const loops = new Map<string, number>();
    for (let lap = 0; lap < 20; lap++) expect(advance(g, 'tests', 'fail', loops).kind).toBe('node');
  });

  it('rejects unknown ports, double-wired ports, missing start and unknown node refs', () => {
    const g: WorkflowGraph = {
      nodes: [
        { id: 'a', type: 'agent', prompt: '{{nodes.ghost.output}}' },
        { id: 'b', type: 'check', command: 'true' },
      ],
      edges: [
        { from: 'a.nope', to: 'b' },
        { from: 'b.pass', to: 'a' },
        { from: 'b', to: 'a' },
      ],
    };
    const issues = graphIssues(g).join('\n');
    expect(issues).toMatch(/exactly one start node/);
    expect(issues).toMatch(/edge from "a.nope"/);
    expect(issues).toMatch(/"b.pass" is wired more than once/);
    expect(issues).toMatch(/unknown node "ghost"/);
  });

  it('rejects an agent node with neither prompt nor skill', () => {
    const g: WorkflowGraph = {
      nodes: [{ id: 'start', type: 'start' }, { id: 'a', type: 'agent' }],
      edges: [{ from: 'start', to: 'a' }],
    };
    expect(graphIssues(g)).toEqual(['agent node "a" needs a prompt or a skill']);
  });
});

describe('advance', () => {
  it('walks the happy path to a success end', () => {
    const loops = new Map<string, number>();
    const first = enterGraph(EXAMPLE, loops);
    expect(first).toMatchObject({ kind: 'node', node: { id: 'implement' } });
    expect(advance(EXAMPLE, 'implement', 'done', loops)).toMatchObject({ kind: 'node', node: { id: 'tests' } });
    expect(advance(EXAMPLE, 'tests', 'pass', loops)).toMatchObject({ kind: 'end', status: 'success', endNode: 'ok' });
  });

  it('repeats through the loop within max, then takes exhausted (counter never resets)', () => {
    const loops = new Map<string, number>();
    expect(advance(EXAMPLE, 'tests', 'fail', loops)).toMatchObject({ kind: 'node', node: { id: 'fix' } });
    expect(advance(EXAMPLE, 'tests', 'fail', loops)).toMatchObject({ kind: 'node', node: { id: 'fix' } });
    const third = advance(EXAMPLE, 'tests', 'fail', loops);
    expect(third).toMatchObject({ kind: 'end', status: 'failed', endNode: 'gave-up' });
    expect(third.transitions.map((t) => `${t.from}.${t.port}`)).toEqual(['tests.fail', 'retry.exhausted']);
    expect(loops.get('retry')).toBe(3);
  });

  it('ends on an unwired port: failed for failure ports, success otherwise', () => {
    const g: WorkflowGraph = {
      nodes: [{ id: 'start', type: 'start' }, { id: 'c', type: 'check', command: 'x' }],
      edges: [{ from: 'start', to: 'c' }],
    };
    expect(advance(g, 'c', 'fail', new Map())).toMatchObject({ kind: 'end', status: 'failed' });
    expect(advance(g, 'c', 'pass', new Map())).toMatchObject({ kind: 'end', status: 'success' });
  });
});

describe('compileV1', () => {
  it('turns onFail into check.fail → loop(max) → retry target and preserves retryOn', () => {
    const g = compileV1([
      { id: 'implement', prompt: '{{task}}' },
      { id: 'verify', command: 'npm test', onFail: { retry: 'implement', max: 2, retryOn: [1] } },
    ]);
    expect(graphIssues(g)).toEqual([]);
    expect(g.nodes.find((n) => n.id === 'verify')).toMatchObject({ retryOn: [1] });
    const loops = new Map<string, number>();
    expect(advance(g, 'verify', 'fail', loops)).toMatchObject({ kind: 'node', node: { id: 'implement' } });
    expect(advance(g, 'verify', 'fail', loops)).toMatchObject({ kind: 'node', node: { id: 'implement' } });
    // v1: after `max` retries the run fails.
    expect(advance(g, 'verify', 'fail', loops)).toMatchObject({ kind: 'end', status: 'failed' });
    expect(advance(g, 'verify', 'pass', loops)).toMatchObject({ kind: 'end', status: 'success' });
  });

  it('walks every step of a v1 chain whose ids are not graph-safe (`start`, `end`, a dot)', () => {
    // v1 step ids are any string, and every v1 workflow runs through this compile.
    const steps = [
      { id: 'start', prompt: '{{task}}' },
      { id: 'lint.fix', command: 'npm run lint', onFail: { retry: 'start', max: 1 } },
      { id: 'end', prompt: 'wrap up' },
    ];
    const g = compileV1(steps);
    expect(graphIssues(g)).toEqual([]);
    const loops = new Map<string, number>();
    expect(enterGraph(g, loops)).toMatchObject({ kind: 'node', node: { id: 'start', type: 'agent' } });
    // The first step is not the interactive tail: its `done` leads on, not to the end.
    expect(isTerminalAgent(g, 'start')).toBe(false);
    expect(advance(g, 'start', 'done', loops)).toMatchObject({ kind: 'node', node: { id: 'lint.fix' } });
    expect(advance(g, 'lint.fix', 'fail', loops)).toMatchObject({ kind: 'node', node: { id: 'start', type: 'agent' } });
    expect(advance(g, 'lint.fix', 'pass', loops)).toMatchObject({ kind: 'node', node: { id: 'end', type: 'agent' } });
    expect(isTerminalAgent(g, 'end')).toBe(true);
    expect(advance(g, 'end', 'done', loops)).toMatchObject({ kind: 'end', status: 'success' });
    expect(graphToSteps(g).map((s) => s.id)).toEqual(['start', 'lint.fix', 'end']);
  });

  it('round-trips the steps back out in order', () => {
    const steps = [
      { id: 'a', prompt: '{{task}}' },
      { id: 'b', command: 'true' },
    ];
    expect(graphToSteps(compileV1(steps))).toEqual(steps);
  });
});

describe('helpers', () => {
  it('graphToSteps lists agent/check nodes in walk order', () => {
    expect(graphToSteps(EXAMPLE).map((s) => s.id)).toEqual(['implement', 'tests', 'fix']);
  });

  it('renderNodeRefs fills known outputs and blanks not-yet-produced ones', () => {
    const outputs = new Map([['tests', { output: 'boom', exitCode: 1 }]]);
    expect(renderNodeRefs('{{nodes.tests.output}}/{{ nodes.tests.exitCode }}/{{nodes.retry.iteration}}', outputs)).toBe(
      'boom/1/',
    );
  });

  it('isTerminalAgent: done → success end (or unwired) is the interactive tail', () => {
    expect(isTerminalAgent(EXAMPLE, 'implement')).toBe(false);
    const tail: WorkflowGraph = {
      nodes: [{ id: 'start', type: 'start' }, { id: 'a', type: 'agent', prompt: 'x' }],
      edges: [{ from: 'start', to: 'a' }],
    };
    expect(isTerminalAgent(tail, 'a')).toBe(true);
  });

  it('the file schema requires version 2 and rejects dotted node ids', () => {
    expect(workflowGraphFileSchema.safeParse({ version: 2, name: 'x', ...EXAMPLE }).success).toBe(true);
    expect(workflowGraphFileSchema.safeParse({ name: 'x', ...EXAMPLE }).success).toBe(false);
    const dotted = { version: 2, name: 'x', nodes: [{ id: 'a.b', type: 'start' }], edges: [] };
    expect(workflowGraphFileSchema.safeParse(dotted).success).toBe(false);
  });
});

describe('verdicts (D10/D17)', () => {
  const REVIEW: WorkflowGraph = {
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'review', type: 'agent', prompt: 'review', verdicts: ['approve', 'changes'] },
      { id: 'ok', type: 'end', status: 'success' },
      { id: 'no', type: 'end', status: 'failed' },
    ],
    edges: [
      { from: 'start', to: 'review' },
      { from: 'review.approve', to: 'ok' },
      { from: 'review.changes', to: 'no' },
    ],
  };

  it('replaces done with one port per verdict (plus failed)', () => {
    expect(portsOfNode(REVIEW.nodes[1]!)).toEqual(['approve', 'changes', 'failed']);
    expect(graphIssues(REVIEW)).toEqual([]);
    expect(graphIssues({ ...REVIEW, edges: [...REVIEW.edges, { from: 'review.done', to: 'ok' }] }).join()).toMatch(
      /edge from "review.done"/,
    );
    expect(advance(REVIEW, 'review', 'changes', new Map())).toMatchObject({ kind: 'end', status: 'failed', endNode: 'no' });
  });

  it('a verdict node is never the interactive tail', () => {
    expect(isTerminalAgent(REVIEW, 'review')).toBe(false);
  });

  it('parses only a trailing, declared verdict', () => {
    expect(parseVerdict('looks good\n\nCEZ:VERDICT approve\n', ['approve', 'changes'])).toBe('approve');
    expect(parseVerdict('CEZ:VERDICT: changes', ['approve', 'changes'])).toBe('changes');
    expect(parseVerdict('CEZ:VERDICT maybe', ['approve'])).toBeNull();
    expect(parseVerdict('CEZ:VERDICT approve\nthen more text', ['approve'])).toBeNull();
    expect(stripVerdictMarker('done.\n\nCEZ:VERDICT approve')).toBe('done.');
  });

  it('rejects reserved and repeated verdict names', () => {
    const bad = { version: 2, name: 'x', nodes: [{ id: 'a', type: 'agent', prompt: 'x', verdicts: ['failed'] }], edges: [] };
    expect(workflowGraphFileSchema.safeParse(bad).success).toBe(false);
    const rep: WorkflowGraph = {
      ...REVIEW,
      nodes: REVIEW.nodes.map((n) => (n.id === 'review' ? { ...n, verdicts: ['approve', 'approve'] } : n)),
    };
    expect(graphIssues(rep).join()).toMatch(/repeats a verdict/);
  });
});

describe('session.continue (D6)', () => {
  it('must name another agent node', () => {
    const g: WorkflowGraph = {
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'a', type: 'agent', prompt: 'x', session: { continue: 'a' } },
        { id: 'c', type: 'check', command: 'true' },
        { id: 'b', type: 'agent', prompt: 'x', session: { continue: 'c' } },
      ],
      edges: [{ from: 'start', to: 'a' }, { from: 'a', to: 'c' }, { from: 'c', to: 'b' }],
    };
    const issues = graphIssues(g).join('\n');
    expect(issues).toMatch(/"a": session.continue cannot name itself/);
    expect(issues).toMatch(/"b": session.continue must name an agent node/);
  });
});

describe('if-node helpers', () => {
  it('globMatch: * stays in a segment, ** crosses them', () => {
    expect(globMatch('packages/web/**', 'packages/web/src/app.tsx')).toBe(true)
    expect(globMatch('packages/*/package.json', 'packages/web/package.json')).toBe(true)
    expect(globMatch('packages/*/package.json', 'packages/web/src/package.json')).toBe(false)
    expect(globMatch('**/*.md', 'docs/reference.md')).toBe(true)
    expect(globMatch('release/*', 'release/1.2')).toBe(true)
    expect(globMatch('src/a.ts', 'src/aXts')).toBe(false)
  })

  it('compareValues: numeric when both sides are numbers, string otherwise', () => {
    expect(compareValues('42', '>', 10)).toBe(true)
    expect(compareValues(3.5, '<=', '3.5')).toBe(true)
    expect(compareValues('approve', 'equals', 'approve')).toBe(true)
    expect(compareValues('changes', 'not-equals', 'approve')).toBe(true)
    expect(compareValues('tests failed: 3', 'contains', 'failed')).toBe(true)
    expect(compareValues('abc', '>', 1)).toBe(false)
    expect(compareValues(undefined, 'equals', '')).toBe(true)
  })
})

describe('fork / join shape', () => {
  const base = (): WorkflowGraph => ({
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'f', type: 'fork', branches: 2 },
      { id: 'a', type: 'agent', prompt: 'A', review: true },
      { id: 'b', type: 'agent', prompt: 'B' },
      { id: 'j', type: 'join', wait: 'all' },
    ],
    edges: [
      { from: 'start', to: 'f' },
      { from: 'f.1', to: 'a' },
      { from: 'f.2', to: 'b' },
      { from: 'a.done', to: 'j' },
      { from: 'b.done', to: 'j' },
    ],
  });

  it('accepts fork → one agent per port → one join, and keeps branch agents off the v1 steps', () => {
    const g = base();
    expect(graphIssues(g)).toEqual([]);
    expect(forkShape(g, 'f')).toMatchObject({ join: 'j', wait: 'all', branches: [{ port: '1' }, { port: '2' }] });
    expect(graphToSteps(g)).toEqual([]);
    expect(graphRailSteps(g).map((s) => s.id)).toEqual(['f', 'a', 'b']);
  });

  it('a fork has one port per branch', () => {
    expect(portsOfNode({ id: 'f', type: 'fork', branches: 4 })).toEqual(['1', '2', '3', '4']);
  });

  it('rejects an unwired branch, a non-agent branch, two joins and verdict branches', () => {
    const unwired = base();
    unwired.edges = unwired.edges.filter((e) => e.from !== 'f.2');
    expect(graphIssues(unwired).join()).toMatch(/branch 2 is not wired/);

    const check = base();
    check.nodes[3] = { id: 'b', type: 'check', command: 'x' };
    check.edges = check.edges.map((e) => (e.from === 'b.done' ? { from: 'b.pass', to: 'j' } : e));
    expect(graphIssues(check).join()).toMatch(/must lead to an agent node/);

    const split = base();
    split.nodes.push({ id: 'j2', type: 'join', wait: 'all' });
    split.edges = split.edges.map((e) => (e.from === 'b.done' ? { from: 'b.done', to: 'j2' } : e));
    expect(graphIssues(split).join()).toMatch(/same join/);

    const verdicts = base();
    verdicts.nodes[2] = { id: 'a', type: 'agent', prompt: 'A', verdicts: ['ok'] };
    verdicts.edges = verdicts.edges.map((e) => (e.from === 'a.done' ? { from: 'a.ok', to: 'j' } : e));
    expect(graphIssues(verdicts).join()).toMatch(/cannot continue a session or declare verdicts/);
  });

  it('review / budget only on a fork branch; a join with no fork is reported', () => {
    const g: WorkflowGraph = {
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'a', type: 'agent', prompt: 'A', review: true },
        { id: 'j', type: 'join', wait: 'all' },
      ],
      edges: [{ from: 'start', to: 'a' }],
    };
    const issues = graphIssues(g).join('\n');
    expect(issues).toMatch(/only to an agent right after a fork/);
    expect(issues).toMatch(/join node "j" has no fork/);
  });
});
