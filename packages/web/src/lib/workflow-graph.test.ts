import { describe, expect, it } from 'vitest'
import type { WorkflowGraph } from '@open-mercato/cezar-api-client'

import {
  addFork,
  advance,
  advanceFork,
  forkBranchIds,
  forkParts,
  setForkBranches,
  autoLayout,
  blankGraph,
  compileSteps,
  connect,
  freeSpot,
  loopEdges,
  routeLanes,
  nodeFootprint,
  graphForWorkflow,
  graphYaml,
  graphYamlFilename,
  skillStackOfGraph,
  stepsFromPlan,
  newNode,
  portsOf,
  portTone,
  removeNode,
  runOverlay,
  targetOf,
  unwiredPorts,
  updateNode,
} from './workflow-graph'

const LOOPING: WorkflowGraph = {
  nodes: [
    { id: 'start', type: 'start' },
    { id: 'implement', type: 'agent', prompt: '{{task}}' },
    { id: 'tests', type: 'check', command: 'npm test' },
    { id: 'retry', type: 'loop', max: 2 },
    { id: 'review', type: 'agent', prompt: 'review', verdicts: ['approve', 'changes'] },
    { id: 'ok', type: 'end', status: 'success' },
    { id: 'no', type: 'end', status: 'failed' },
  ],
  edges: [
    { from: 'start', to: 'implement' },
    { from: 'implement', to: 'tests' },
    { from: 'tests.pass', to: 'review' },
    { from: 'tests.fail', to: 'retry' },
    { from: 'retry.repeat', to: 'implement' },
    { from: 'retry.exhausted', to: 'no' },
    { from: 'review.approve', to: 'ok' },
    { from: 'review.changes', to: 'retry' },
  ],
}

describe('ports', () => {
  it('verdicts replace done; tones follow success / failure / verdict', () => {
    const review = LOOPING.nodes[4]!
    expect(portsOf(review)).toEqual(['approve', 'changes', 'failed'])
    expect(portTone(review, 'approve')).toBe('verdict')
    expect(portTone(review, 'failed')).toBe('failure')
    expect(portTone(LOOPING.nodes[2]!, 'pass')).toBe('success')
  })

  it('lists unwired ports', () => {
    expect(unwiredPorts(LOOPING)).toEqual(['implement.failed', 'review.failed'])
  })

  it('never doubles the failed port for a verdict literally named "failed"', () => {
    // The save-time schema refuses this verdict name, but portsOf also runs live, on every
    // keystroke, before that validation ever fires.
    const n = { ...LOOPING.nodes[4]!, verdicts: ['failed', 'approve'] } as (typeof LOOPING.nodes)[4]
    expect(portsOf(n)).toEqual(['failed', 'approve'])
  })
})

describe('editing', () => {
  it('connect replaces the previous edge of that port', () => {
    const g = connect(LOOPING, 'tests', 'pass', 'ok')
    expect(targetOf(g, 'tests', 'pass')).toBe('ok')
    expect(g.edges.filter((e) => e.from.startsWith('tests.pass'))).toHaveLength(1)
  })

  it('removeNode drops its edges both ways', () => {
    const g = removeNode(LOOPING, 'retry')
    expect(g.edges.some((e) => e.to === 'retry' || e.from.startsWith('retry'))).toBe(false)
  })

  it('renaming a node carries edges, layout and session.continue', () => {
    const withSession: WorkflowGraph = {
      ...LOOPING,
      nodes: [...LOOPING.nodes, { id: 'fix', type: 'agent', prompt: 'x', session: { continue: 'implement' } }],
      layout: { implement: { x: 1, y: 2 } },
    }
    const g = updateNode(withSession, 'implement', { id: 'build', type: 'agent', prompt: '{{task}}' })
    expect(targetOf(g, 'start', 'next')).toBe('build')
    expect(targetOf(g, 'build', 'done')).toBe('tests')
    expect(targetOf(g, 'retry', 'repeat')).toBe('build')
    expect(g.layout).toEqual({ build: { x: 1, y: 2 } })
    expect(g.nodes.find((n) => n.id === 'fix')).toMatchObject({ session: { continue: 'build' } })
  })

  it('dropping a verdict drops the edge from its port', () => {
    const review = LOOPING.nodes[4]!
    if (review.type !== 'agent') throw new Error('fixture')
    const g = updateNode(LOOPING, 'review', { ...review, verdicts: ['approve'] })
    expect(targetOf(g, 'review', 'changes')).toBeUndefined()
    expect(targetOf(g, 'review', 'approve')).toBe('ok')
  })

  it('newNode picks a free id and working defaults', () => {
    expect(newNode('agent', ['agent'])).toEqual({ id: 'agent-2', type: 'agent', prompt: '{{task}}' })
    expect(newNode('loop', [])).toEqual({ id: 'loop', type: 'loop', max: 2 })
  })
})

describe('simulation (mirror of the server advance)', () => {
  it('loops within max, then exhausted — counter never resets', () => {
    const loops = new Map<string, number>()
    expect(advance(LOOPING, 'tests', 'fail', loops)).toMatchObject({ kind: 'node', node: 'implement' })
    expect(advance(LOOPING, 'review', 'changes', loops)).toMatchObject({ kind: 'node', node: 'implement' })
    expect(advance(LOOPING, 'tests', 'fail', loops)).toMatchObject({ kind: 'end', status: 'failed' })
  })

  it('unwired ports end the run by tone', () => {
    expect(advance(LOOPING, 'review', 'failed', new Map())).toMatchObject({ kind: 'end', status: 'failed' })
    expect(advance(LOOPING, 'review', 'approve', new Map())).toMatchObject({ kind: 'end', status: 'success' })
  })
})

describe('opening workflows', () => {
  it('compiles a v1 chain whose ids are not graph-safe into a walkable graph', () => {
    const g = compileSteps([
      { id: 'start', prompt: '{{task}}' },
      { id: 'lint.fix', command: 'npm run lint', onFail: { retry: 'start', max: 1 } },
    ])
    expect(g.nodes.filter((n) => n.type === 'start').map((n) => n.id)).toEqual(['start-2'])
    expect(targetOf(g, 'start-2', 'next')).toBe('start')
    expect(targetOf(g, 'start', 'done')).toBe('lint.fix')
    expect(targetOf(g, 'lint.fix', 'pass')).toBe('end')
    expect(targetOf(g, 'lint.fix-retry', 'repeat')).toBe('start')
  })

  it('compiles v1 onFail into a loop node', () => {
    const g = compileSteps([
      { id: 'implement', prompt: '{{task}}' },
      { id: 'verify', command: 'npm test', onFail: { retry: 'implement', max: 2 } },
    ])
    expect(g.nodes.map((n) => `${n.id}:${n.type}`)).toEqual([
      'start:start',
      'implement:agent',
      'verify:check',
      'verify-retry:loop',
      'end:end',
    ])
    expect(targetOf(g, 'verify-retry', 'repeat')).toBe('implement')
    expect(targetOf(g, 'verify', 'pass')).toBe('end')
  })

  it('auto-layout puts back-edge targets left of their sources', () => {
    const layout = autoLayout(LOOPING, { rowWidth: Infinity })
    expect(layout.start!.x).toBe(Math.min(...Object.values(layout).map((p) => p.x)))
    expect(layout.implement!.x).toBeLessThan(layout.retry!.x)
    expect(layout.ok!.x).toBeGreaterThan(layout.review!.x)
  })

  it('keeps saved positions and fills only the missing ones', () => {
    const g = graphForWorkflow({ steps: [], graph: { ...blankGraph(), layout: { start: { x: 9, y: 9 } } } })
    expect(g.layout?.start).toEqual({ x: 9, y: 9 })
    expect(Object.keys(g.layout ?? {}).sort()).toEqual(['end', 'start', 'work'])
  })
})

describe('graphYaml', () => {
  it('emits the version: 2 shape with nested session and block prompts', () => {
    const yaml = graphYaml('Flow', '', {
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'fix', type: 'agent', prompt: 'line one\nline two', session: { continue: 'start' }, verdicts: ['ok'] },
        { id: 'loop', type: 'loop', max: 3 },
      ],
      edges: [{ from: 'start.next', to: 'fix' }],
      layout: { fix: { x: 10.4, y: 20 } },
    })
    expect(yaml).toBe(
      [
        'version: 2',
        'name: Flow',
        'nodes:',
        '  - id: start',
        '    type: start',
        '  - id: fix',
        '    type: agent',
        '    prompt: |-',
        '      line one',
        '      line two',
        '    session:',
        '      continue: start',
        '    verdicts: [ok]',
        '  - id: loop',
        '    type: loop',
        '    max: 3',
        'edges:',
        '  - { from: start.next, to: fix }',
        'layout:',
        '  fix: { x: 10, y: 20 }',
        '',
      ].join('\n'),
    )
  })

  it('writes multi-line text so it reads back unchanged', () => {
    const promptLines = (value: string) =>
      graphYaml('f', '', { nodes: [{ id: 'a', type: 'agent', prompt: value }], edges: [] }).split('\n').slice(5, -2)
    // No final newline: `|-`, or the import would add one.
    expect(promptLines('one\n\ntwo')).toEqual(['    prompt: |-', '      one', '', '      two'])
    expect(promptLines('one\ntwo\n')).toEqual(['    prompt: |', '      one', '      two'])
    // What a block cannot carry faithfully is quoted instead.
    expect(promptLines('  indented\ntwo')).toEqual(['    prompt: "  indented\\ntwo"'])
    expect(promptLines('one\n\n')).toEqual(['    prompt: "one\\n\\n"'])
  })
})

describe('skillStackOfGraph', () => {
  const STACK = compileSteps([
    { id: 'om-fix', name: 'om-fix', skill: 'om-fix', prompt: '{{task}}' },
    { id: 'om-review', skill: 'om-review' },
  ])

  it('reads a start → skill agents → end graph as its skills, in walk order', () => {
    expect(skillStackOfGraph(STACK)).toEqual(['om-fix', 'om-review'])
    // Layout is the editor's own business — it never makes a stack "richer".
    expect(skillStackOfGraph({ ...STACK, layout: { 'om-fix': { x: 1, y: 2 } } })).toEqual(['om-fix', 'om-review'])
  })

  it('is null for anything the compact form cannot say', () => {
    const edit = (patch: object) => updateNode(STACK, 'om-fix', { ...STACK.nodes[1]!, ...patch } as WorkflowGraph['nodes'][number])
    expect(skillStackOfGraph(edit({ prompt: 'do it my way' }))).toBeNull()
    expect(skillStackOfGraph(edit({ name: 'Fixer' }))).toBeNull()
    expect(skillStackOfGraph(edit({ runner: 'codex' }))).toBeNull()
    expect(skillStackOfGraph(edit({ verdicts: ['ok'] }))).toBeNull()
    // A stray node, a failed-port edge, a failed end, no skill at all.
    expect(skillStackOfGraph({ ...STACK, nodes: [...STACK.nodes, { id: 'c', type: 'check', command: 'true' }] })).toBeNull()
    expect(skillStackOfGraph(connect(STACK, 'om-fix', 'failed', 'end'))).toBeNull()
    expect(skillStackOfGraph(updateNode(STACK, 'end', { id: 'end', type: 'end', status: 'failed' }))).toBeNull()
    expect(skillStackOfGraph(compileSteps([{ id: 'a', prompt: '{{task}}' }]))).toBeNull()
    expect(skillStackOfGraph(compileSteps([]))).toBeNull()
  })

  it('graphYaml writes a stack in the compact form Save uses', () => {
    expect(graphYaml('Ship it', 'Fix then review.', STACK)).toBe(
      ['name: Ship it', 'description: Fix then review.', 'skills:', '  - om-fix', '  - om-review', ''].join('\n'),
    )
  })
})

describe('stepsFromPlan', () => {
  it('gives every planned step a unique id', () => {
    expect(stepsFromPlan([{ id: 'fix', prompt: 'a' }, { id: 'fix', prompt: 'b' }, { id: '', prompt: 'c' }]).map((s) => s.id)).toEqual([
      'fix',
      'fix-2',
      'step',
    ])
  })
})

describe('graphYamlFilename', () => {
  it('slugs the name into a .yaml file name, with a fallback', () => {
    expect(graphYamlFilename(' Implement & Review PR ')).toBe('implement-review-pr.yaml')
    expect(graphYamlFilename('  ')).toBe('workflow.yaml')
  })
})

describe('runOverlay (phase 3)', () => {
  it('folds rail steps, loop counters and taken edges onto the graph', () => {
    const { nodes, edges } = runOverlay(LOOPING, {
      steps: [
        { id: 'implement', status: 'done', iterations: 2, costUsd: 0.4 },
        { id: 'tests', status: 'running', iterations: 2 },
        { id: 'review', status: 'pending' },
      ],
      graphState: {
        loops: { retry: 1 },
        taken: ['start.next->implement', 'implement.done->tests', 'tests.fail->retry', 'retry.repeat->implement', 'implement.done->tests'],
      },
    })
    expect(nodes.get('implement')).toEqual({ status: 'done', iterations: 2, costUsd: 0.4 })
    expect(nodes.get('tests')).toEqual({ status: 'running', iterations: 2 })
    expect(nodes.get('retry')).toEqual({ status: 'reached', loopCount: 1 })
    expect(nodes.get('start')?.status).toBe('reached')
    expect(nodes.get('ok')?.status).toBe('pending')
    expect(edges.get('implement.done->tests')).toBe(2)
    expect(edges.get('tests.pass->review')).toBeUndefined()
  })

  it('a run with no graphState yet shows everything pending', () => {
    const { nodes, edges } = runOverlay(LOOPING, { steps: [] })
    expect([...nodes.values()].every((n) => n.status === 'pending')).toBe(true)
    expect(edges.size).toBe(0)
  })
})

describe('freeSpot', () => {
  it('keeps a free spot and steps down past occupied ones', () => {
    expect(freeSpot({ a: { x: 0, y: 0 } }, { x: 600, y: 0 })).toEqual({ x: 600, y: 0 })
    expect(freeSpot({ a: { x: 0, y: 0 }, b: { x: 0, y: 110 } }, { x: 20, y: 30 })).toEqual({ x: 20, y: 250 })
  })
})

describe('autoLayout (dagre, real footprints)', () => {
  const boxes = (g: WorkflowGraph) => {
    const layout = autoLayout(g)
    return g.nodes.map((n) => {
      const f = nodeFootprint(g, n)
      const p = layout[n.id]!
      return { id: n.id, x0: p.x - f.dx, y0: p.y - f.dy, x1: p.x - f.dx + f.w, y1: p.y - f.dy + f.h }
    })
  }
  const overlaps = (g: WorkflowGraph) => {
    const b = boxes(g)
    const hits: string[] = []
    for (let i = 0; i < b.length; i++)
      for (let j = i + 1; j < b.length; j++) {
        const [p, q] = [b[i]!, b[j]!]
        if (p.x0 < q.x1 && q.x0 < p.x1 && p.y0 < q.y1 && q.y0 < p.y1) hits.push(`${p.id}/${q.id}`)
      }
    return hits
  }
  const BIG: WorkflowGraph = {
    nodes: [
      ...LOOPING.nodes,
      { id: 'fix', type: 'agent', prompt: 'x', session: { continue: 'implement' } },
      { id: 'pr', type: 'github.draft-pr' },
      { id: 'ci', type: 'github.wait-ci', timeoutMs: 3_600_000, pollMs: 60_000 },
      { id: 'fan', type: 'fork', branches: 2 },
      { id: 'a', type: 'agent', prompt: 'x', review: true },
      { id: 'b', type: 'agent', prompt: 'y' },
      { id: 'meet', type: 'join', wait: 'all' },
    ],
    edges: [
      ...LOOPING.edges.filter((e) => e.from !== 'retry.repeat' && e.from !== 'review.approve'),
      { from: 'retry.repeat', to: 'fix' },
      { from: 'fix', to: 'tests' },
      { from: 'review.approve', to: 'fan' },
      { from: 'fan.1', to: 'a' },
      { from: 'fan.2', to: 'b' },
      { from: 'a.done', to: 'meet' },
      { from: 'b.done', to: 'meet' },
      { from: 'meet.done', to: 'pr' },
      { from: 'pr.created', to: 'ci' },
      { from: 'ci.green', to: 'ok' },
      { from: 'ci.red', to: 'retry' },
    ],
  }

  it('never overlaps two nodes, wide cards, captions and port labels included', () => {
    expect(overlaps(LOOPING)).toEqual([])
    expect(overlaps(BIG)).toEqual([])
  })

  it('keeps a simple chain compact — no scrolling to read four nodes', () => {
    const chain = compileSteps([
      { id: 'implement', prompt: '{{task}}' },
      { id: 'verify', command: 'npm test' },
    ])
    const b = boxes(chain)
    expect(Math.max(...b.map((x) => x.x1)) - Math.min(...b.map((x) => x.x0))).toBeLessThan(1000)
    expect(Math.max(...b.map((x) => x.y1)) - Math.min(...b.map((x) => x.y0))).toBeLessThan(200)
  })

  it('reads left to right along the walk; ways back point left', () => {
    const layout = autoLayout(BIG, { rowWidth: Infinity })
    expect(layout.start!.x).toBeLessThan(layout.implement!.x)
    expect(layout.implement!.x).toBeLessThan(layout.tests!.x)
    expect(layout.tests!.x).toBeLessThan(layout.review!.x)
    expect(layout.pr!.x).toBeLessThan(layout.ci!.x)
    // The loop reads forward (tests → retry → fix) and only the way back points left.
    expect(layout.fix!.x).toBeGreaterThan(layout.tests!.x)
  })
})

describe('wrapped rows and loop edges', () => {
  const LONG: WorkflowGraph = {
    nodes: [
      { id: 'start', type: 'start' },
      ...Array.from({ length: 14 }, (_, i) => ({ id: `c${i}`, type: 'check' as const, command: 'true' })),
      { id: 'again', type: 'loop', max: 2 },
      { id: 'end', type: 'end', status: 'success' as const },
    ],
    edges: [
      { from: 'start', to: 'c0' },
      ...Array.from({ length: 13 }, (_, i) => ({ from: `c${i}.pass`, to: `c${i + 1}` })),
      { from: 'c13.pass', to: 'end' },
      { from: 'c13.fail', to: 'again' },
      { from: 'again.repeat', to: 'c0' },
    ],
  }

  it('wraps a long walk into rows about a screen wide, without overlaps', () => {
    const layout = autoLayout(LONG)
    const right = Math.max(...LONG.nodes.map((n) => layout[n.id]!.x + nodeFootprint(LONG, n).w))
    expect(right).toBeLessThan(1900)
    expect(layout.c13!.y).toBeGreaterThan(layout.c0!.y) // later ranks moved to a lower row
  })

  it('marks only real ways back as loop edges — never a row wrap', () => {
    expect([...loopEdges(LONG)]).toEqual(['again.repeat->c0'])
    expect([...loopEdges(LOOPING)].sort()).toEqual(['retry.repeat->implement'])
  })
})

describe('routeLanes', () => {
  const FIX_CI: WorkflowGraph = {
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'ci', type: 'github.wait-ci', timeoutMs: 3_600_000, pollMs: 60_000 },
      { id: 'retry', type: 'loop', max: 3 },
      { id: 'fix', type: 'agent', prompt: 'fix' },
      { id: 'green', type: 'end', status: 'success' },
      { id: 'gave-up', type: 'end', status: 'failed' },
    ],
    edges: [
      { from: 'start', to: 'ci' },
      { from: 'ci.green', to: 'green' },
      { from: 'ci.red', to: 'retry' },
      { from: 'ci.timeout', to: 'gave-up' },
      { from: 'retry.repeat', to: 'fix' },
      { from: 'retry.exhausted', to: 'gave-up' },
      { from: 'fix.done', to: 'ci' },
      { from: 'fix.failed', to: 'retry' },
    ],
  }

  it('puts each way back in a lane clear of every node in its span, and apart from each other', () => {
    const g = { ...FIX_CI, layout: autoLayout(FIX_CI) }
    const requests = [
      { key: 'fix.done->ci', from: 'fix', port: 'done', to: 'ci' },
      { key: 'fix.failed->retry', from: 'fix', port: 'failed', to: 'retry' },
    ]
    const lanes = routeLanes(g, requests)
    const rect = (id: string) => {
      const n = g.nodes.find((x) => x.id === id)!
      const f = nodeFootprint(g, n)
      const p = g.layout[id]!
      return { x0: p.x - f.dx, x1: p.x - f.dx + f.w, y0: p.y, y1: p.y + 64 + f.dy }
    }
    for (const r of requests) {
      const y = lanes.get(r.key)!.y
      const [a, b] = [rect(r.from), rect(r.to)]
      const x0 = Math.min(a.x0, b.x0)
      const x1 = Math.max(a.x1, b.x1)
      for (const n of g.nodes) {
        const q = rect(n.id)
        if (q.x0 < x1 && q.x1 > x0) expect(y < q.y0 || y > q.y1, `${r.key} lane ${y} crosses ${n.id}`).toBe(true)
      }
    }
    expect(Math.abs(lanes.get('fix.done->ci')!.y - lanes.get('fix.failed->retry')!.y)).toBeGreaterThanOrEqual(12)
  })
})

describe('port order', () => {
  it('stacks the targets of one node in the order of the ports that feed them', () => {
    // Listed in reverse on purpose: nothing but the port order may decide the stack.
    const g: WorkflowGraph = {
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'ci', type: 'github.wait-ci', timeoutMs: 3_600_000, pollMs: 60_000 },
        { id: 'gave-up', type: 'end', status: 'failed' },
        { id: 'fix', type: 'check', command: 'x' },
        { id: 'green', type: 'end', status: 'success' },
      ],
      edges: [
        { from: 'start', to: 'ci' },
        { from: 'ci.timeout', to: 'gave-up' },
        { from: 'ci.red', to: 'fix' },
        { from: 'ci.green', to: 'green' },
      ],
    }
    const l = autoLayout(g)
    expect(l.green!.y).toBeLessThan(l.fix!.y)
    expect(l.fix!.y).toBeLessThan(l['gave-up']!.y)
  })
})

describe('routeLanes — whole routes', () => {
  it('no leg of a routed edge crosses a node (loops and blocked forward edges)', () => {
    const base: WorkflowGraph = {
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'ci', type: 'github.wait-ci', timeoutMs: 3_600_000, pollMs: 60_000 },
        { id: 'retry', type: 'loop', max: 3 },
        { id: 'fix', type: 'agent', prompt: 'fix' },
        { id: 'green', type: 'end', status: 'success' },
        { id: 'gave-up', type: 'end', status: 'failed' },
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
    }
    const g = { ...base, layout: autoLayout(base) }
    const reqs = [
      { key: 'fix.done->ci', from: 'fix', port: 'done', to: 'ci' },
      { key: 'ci.timeout->gave-up', from: 'ci', port: 'timeout', to: 'gave-up' },
    ]
    const lanes = routeLanes(g, reqs)
    const tile = (id: string) => {
      const n = g.nodes.find((x) => x.id === id)!
      const p = g.layout[id]!
      const w = n.type === 'agent' ? 216 : 64
      return { x0: p.x, x1: p.x + w, y0: p.y, y1: p.y + 64 }
    }
    const portY = (id: string, port: string) => {
      const n = g.nodes.find((x) => x.id === id)!
      const ports = n.type === 'github.wait-ci' ? ['green', 'red', 'timeout'] : n.type === 'agent' ? ['done', 'failed'] : ['repeat', 'exhausted']
      return g.layout[id]!.y + ((ports.indexOf(port) + 1) / (ports.length + 1)) * 64
    }
    for (const r of reqs) {
      const l = lanes.get(r.key)!
      const ty = g.layout[r.to]!.y + 32
      const segs = [
        [l.outX, portY(r.from, r.port), l.outX, l.y],
        [Math.min(l.outX, l.inX), l.y, Math.max(l.outX, l.inX), l.y],
        [l.inX, l.y, l.inX, ty],
      ]
      for (const n of g.nodes) {
        const t = tile(n.id)
        for (const [x0, y0, x1, y1] of segs) {
          const cross = t.x0 < Math.max(x0!, x1!) && t.x1 > Math.min(x0!, x1!) && t.y0 < Math.max(y0!, y1!) && t.y1 > Math.min(y0!, y1!)
          expect(cross, `${r.key} crosses ${n.id}`).toBe(false)
        }
      }
    }
  })
})

describe('fork scaffolding', () => {
  const base: WorkflowGraph = { nodes: [{ id: 'start', type: 'start' }], edges: [], layout: { start: { x: 0, y: 0 } } }

  it('adds a fork whole: its agents, wired in and into one join, laid out as a fan', () => {
    const { graph, forkId } = addFork(base, { x: 100, y: 0 })
    expect(forkParts(graph, forkId)).toEqual({ agents: ['branch-1', 'branch-2', 'branch-3'], join: 'join' })
    expect(forkBranchIds(graph)).toEqual(new Set(['branch-1', 'branch-2', 'branch-3']))
    const ys = ['branch-1', 'branch-2', 'branch-3'].map((id) => graph.layout?.[id]?.y)
    expect(ys).toEqual([-96, 0, 96])
  })

  it('grows and shrinks a fork, taking the dropped agent with it', () => {
    const { graph, forkId } = addFork(base, { x: 100, y: 0 })
    const four = setForkBranches(graph, forkId, 4)
    expect(forkParts(four, forkId).agents).toHaveLength(4)
    expect(targetOf(four, 'branch-4', 'done')).toBe('join')
    const two = setForkBranches(four, forkId, 2)
    expect(forkParts(two, forkId)).toEqual({ agents: ['branch-1', 'branch-2'], join: 'join' })
    expect(two.nodes.map((n) => n.id)).not.toContain('branch-3')
  })

  it('simulates a fork as one step: out through every branch, on from the join', () => {
    const { graph, forkId } = addFork(base, { x: 100, y: 0 }, 2)
    const r = advanceFork(graph, forkId, 'failed', new Map())
    expect(r.transitions.map((t) => `${t.from}.${t.port}->${t.to ?? ''}`)).toEqual([
      'fork.1->branch-1',
      'branch-1.done->join',
      'fork.2->branch-2',
      'branch-2.done->join',
      'join.failed->',
    ])
    expect(r).toMatchObject({ kind: 'end', status: 'failed' })
  })
})
