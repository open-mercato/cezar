import dagre from '@dagrejs/dagre'
import type { WorkflowGraph, WorkflowGraphNode, WorkflowStepDef } from '@open-mercato/cezar-api-client'

/**
 * Pure model helpers for the workflow node editor (spec 2026-09-30-workflow-node-editor, phase 2).
 *
 * The server owns the rules (`packages/cezar/src/workflows/graph.ts`) and validates every edit
 * through `POST /workflows/validate`; what lives here is only what the canvas needs locally and
 * instantly: ports per node, edge normalization, opening v1 files as graphs, layout, the path
 * simulator and the YAML preview. `advance`/`compileSteps` mirror the server's `advance`/
 * `compileV1` — the tests pin the same scenarios on both sides.
 */

export type GraphNodeType = WorkflowGraphNode['type']
export type AgentNode = Extract<WorkflowGraphNode, { type: 'agent' }>
export type PortTone = 'success' | 'failure' | 'verdict' | 'neutral'

const PORTS: Record<GraphNodeType, readonly string[]> = {
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
}
const FAILURE_PORTS = new Set(['failed', 'fail', 'exhausted', 'reject', 'red', 'timeout', 'conflict'])

export function portsOf(node: WorkflowGraphNode): readonly string[] {
  if (node.type === 'agent' && node.verdicts?.length) return [...node.verdicts, 'failed']
  if (node.type === 'fork') return Array.from({ length: node.branches }, (_, i) => String(i + 1))
  if ((node.type === 'gate.human' || node.type === 'ask-user') && node.timeoutMs) return [...PORTS[node.type], 'timeout']
  return PORTS[node.type]
}

export function portTone(node: WorkflowGraphNode, port: string): PortTone {
  if (FAILURE_PORTS.has(port)) return 'failure'
  if (node.type === 'agent' && node.verdicts?.includes(port)) return 'verdict'
  if (node.type === 'start' || node.type === 'fork' || port === 'nothing' || port === 'false') return 'neutral'
  return 'success'
}

/** `<node>` or `<node>.<port>` → both halves, or null when the node/port does not exist. */
export function parseFrom(from: string, nodes: readonly WorkflowGraphNode[]): { node: string; port: string } | null {
  // The port follows the LAST dot — a node compiled from a v1 step may hold dots itself
  // (mirror of the server's `parseEdgeFrom`).
  const dot = from.lastIndexOf('.')
  const split = dot < 0 ? undefined : nodes.find((n) => n.id === from.slice(0, dot))
  if (split) {
    const port = from.slice(dot + 1)
    return portsOf(split).includes(port) ? { node: split.id, port } : null
  }
  if (dot >= 0) return null
  const node = nodes.find((n) => n.id === from)
  const port = node ? portsOf(node)[0] : undefined
  return node && port ? { node: node.id, port } : null
}

/** The target wired to `node.port`, if any. */
export function targetOf(graph: WorkflowGraph, node: string, port: string): string | undefined {
  return graph.edges.find((e) => {
    const f = parseFrom(e.from, graph.nodes)
    return f?.node === node && f.port === port
  })?.to
}

/** Wire `node.port → to`, replacing whatever that port was wired to (one edge per port). */
export function connect(graph: WorkflowGraph, node: string, port: string, to: string): WorkflowGraph {
  const edges = graph.edges.filter((e) => {
    const f = parseFrom(e.from, graph.nodes)
    return !(f?.node === node && f.port === port)
  })
  return { ...graph, edges: [...edges, { from: `${node}.${port}`, to }] }
}

export function disconnect(graph: WorkflowGraph, node: string, port: string): WorkflowGraph {
  return {
    ...graph,
    edges: graph.edges.filter((e) => {
      const f = parseFrom(e.from, graph.nodes)
      return !(f?.node === node && f.port === port)
    }),
  }
}

export function removeNode(graph: WorkflowGraph, id: string): WorkflowGraph {
  const layout = { ...graph.layout }
  delete layout[id]
  return {
    nodes: graph.nodes.filter((n) => n.id !== id),
    edges: graph.edges.filter((e) => e.to !== id && parseFrom(e.from, graph.nodes)?.node !== id),
    layout,
  }
}

/** Replace a node; a changed id is carried through every edge, the layout and `session.continue`. */
export function updateNode(graph: WorkflowGraph, id: string, next: WorkflowGraphNode): WorkflowGraph {
  const renamed = next.id !== id
  const nodes = graph.nodes.map((n) => {
    if (n.id === id) return next
    if (renamed && n.type === 'agent' && n.session?.continue === id) return { ...n, session: { continue: next.id } }
    return n
  })
  // Normalize edges against the OLD node list first, so ports removed by this edit (a verdict
  // renamed away) drop their edges instead of dangling.
  const edges = graph.edges.flatMap((e) => {
    const f = parseFrom(e.from, graph.nodes)
    if (!f) return []
    const fromNode = f.node === id ? next.id : f.node
    const source = nodes.find((n) => n.id === fromNode)
    if (!source || !portsOf(source).includes(f.port)) return []
    return [{ from: `${fromNode}.${f.port}`, to: e.to === id ? next.id : e.to }]
  })
  const layout = { ...graph.layout }
  if (renamed && layout[id]) {
    layout[next.id] = layout[id]
    delete layout[id]
  }
  return { nodes, edges, layout }
}

export function uniqueId(base: string, taken: Iterable<string>): string {
  const ids = new Set(taken)
  if (!ids.has(base)) return base
  for (let n = 2; ; n++) if (!ids.has(`${base}-${n}`)) return `${base}-${n}`
}

/** A freshly dropped node with working defaults. */
export function newNode(type: GraphNodeType, taken: Iterable<string>): WorkflowGraphNode {
  switch (type) {
    case 'start':
      return { id: uniqueId('start', taken), type }
    case 'end':
      return { id: uniqueId('end', taken), type, status: 'success' }
    case 'loop':
      return { id: uniqueId('loop', taken), type, max: 2 }
    case 'check':
      return { id: uniqueId('check', taken), type, command: 'npm test' }
    case 'agent':
      return { id: uniqueId('agent', taken), type, prompt: '{{task}}' }
    case 'gate.human':
      return { id: uniqueId('gate', taken), type, message: 'Approve the changes for {{task}}?' }
    case 'ask-user':
      return { id: uniqueId('ask', taken), type, question: 'What should I do next?' }
    case 'dispatch':
      return { id: uniqueId('subtask', taken), type, prompt: '{{task}}' }
    case 'git.commit':
      return { id: uniqueId('commit', taken), type, message: 'chore: {{task}}' }
    case 'github.draft-pr':
      return { id: uniqueId('pr', taken), type }
    case 'github.wait-ci':
      return { id: uniqueId('ci', taken), type, timeoutMs: 60 * 60_000, pollMs: 60_000 }
    case 'github.pr-comment':
      return { id: uniqueId('comment', taken), type, body: 'Update: {{task}}' }
    case 'fork':
      return { id: uniqueId('fork', taken), type, branches: 3 }
    case 'join':
      return { id: uniqueId('join', taken), type, wait: 'all' }
    case 'workflow':
      return { id: uniqueId('subflow', taken), type, workflow: 'quick-task' }
    case 'if':
      return { id: uniqueId('if', taken), type, condition: { kind: 'diff-lines', op: '>', value: 500 } }
    case 'git.push':
      return { id: uniqueId('push', taken), type }
    case 'git.sync-base':
      return { id: uniqueId('sync', taken), type }
    case 'github.pr-update':
      return { id: uniqueId('pr-update', taken), type, ready: true }
    case 'github.issue-comment':
      return { id: uniqueId('issue-comment', taken), type, body: 'Update from cezar: {{task}}' }
    case 'notify.webhook':
      return { id: uniqueId('webhook', taken), type, url: 'https://example.com/hook', body: 'cezar: {{task}}' }
  }
}

/** A fork's branch agents (port order) and the join they meet at, read off the edges. */
export function forkParts(graph: WorkflowGraph, forkId: string): { agents: string[]; join?: string } {
  const fork = graph.nodes.find((n) => n.id === forkId)
  if (!fork || fork.type !== 'fork') return { agents: [] }
  const agents = portsOf(fork).flatMap((p) => targetOf(graph, forkId, p) ?? [])
  const join = agents.map((a) => targetOf(graph, a, 'done')).find((t) => graph.nodes.find((n) => n.id === t)?.type === 'join')
  return { agents, ...(join ? { join } : {}) }
}

/** Agent nodes that run as a fork's branches (child tasks) — the inspector shows their extras. */
export function forkBranchIds(graph: WorkflowGraph): Set<string> {
  return new Set(graph.nodes.flatMap((n) => (n.type === 'fork' ? forkParts(graph, n.id).agents : [])))
}

const BRANCH_DY = 96
const BRANCH_DX = 150

function branchAgent(id: string, n: number): WorkflowGraphNode {
  return { id, type: 'agent', name: `Branch ${n}`, prompt: '{{task}}' }
}

/**
 * A fork arrives whole: the fork, one agent per branch and the join they meet at, wired and laid
 * out as a fan. A lone fork is unrunnable, and wiring the fan by hand is the tedious part.
 */
export function addFork(graph: WorkflowGraph, at: { x: number; y: number }, branches = 3): { graph: WorkflowGraph; forkId: string } {
  const ids = graph.nodes.map((n) => n.id)
  const fork = newNode('fork', ids) as Extract<WorkflowGraphNode, { type: 'fork' }>
  const join = newNode('join', [...ids, fork.id])
  const taken = [...ids, fork.id, join.id]
  const agents: WorkflowGraphNode[] = []
  for (let i = 1; i <= branches; i++) {
    const agent = branchAgent(uniqueId(`branch-${i}`, taken), i)
    taken.push(agent.id)
    agents.push(agent)
  }
  const layout = { ...graph.layout, [fork.id]: at }
  agents.forEach((a, i) => {
    layout[a.id] = { x: at.x + TILE + BRANCH_DX, y: at.y + (i - (branches - 1) / 2) * BRANCH_DY }
  })
  layout[join.id] = { x: at.x + TILE + BRANCH_DX + WIDE_WIDTH + BRANCH_DX, y: at.y }
  return {
    forkId: fork.id,
    graph: {
      nodes: [...graph.nodes, { ...fork, branches }, ...agents, join],
      edges: [
        ...graph.edges,
        ...agents.flatMap((a, i) => [
          { from: `${fork.id}.${i + 1}`, to: a.id },
          { from: `${a.id}.done`, to: join.id },
        ]),
      ],
      layout,
    },
  }
}

/** Change a fork's branch count: a new branch is an agent wired in and into the join; a dropped
 *  one takes its agent with it. */
export function setForkBranches(graph: WorkflowGraph, forkId: string, count: number): WorkflowGraph {
  const fork = graph.nodes.find((n) => n.id === forkId)
  if (!fork || fork.type !== 'fork') return graph
  const { agents, join } = forkParts(graph, forkId)
  let next = graph
  for (let i = count + 1; i <= fork.branches; i++) {
    const agent = targetOf(next, forkId, String(i))
    next = agent ? removeNode(next, agent) : disconnect(next, forkId, String(i))
  }
  next = { ...next, nodes: next.nodes.map((n) => (n.id === forkId ? { ...fork, branches: count } : n)) }
  const last = agents.length ? next.layout?.[agents[agents.length - 1]!] : undefined
  for (let i = fork.branches + 1; i <= count; i++) {
    const agent = branchAgent(uniqueId(`branch-${i}`, next.nodes.map((n) => n.id)), i)
    const at = last ? { x: last.x, y: last.y + (i - fork.branches) * BRANCH_DY } : undefined
    next = {
      nodes: [...next.nodes, agent],
      edges: [...next.edges, { from: `${forkId}.${i}`, to: agent.id }, ...(join ? [{ from: `${agent.id}.done`, to: join }] : [])],
      layout: at ? { ...next.layout, [agent.id]: freeSpot(next.layout, at) } : next.layout,
    }
  }
  return next
}

/** A new workflow's canvas: start → agent → success end. */
function blankGraphNodes(): WorkflowGraph {
  return {
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'work', type: 'agent', name: 'Do the task', prompt: '{{task}}' },
      { id: 'end', type: 'end', status: 'success' },
    ],
    edges: [
      { from: 'start.next', to: 'work' },
      { from: 'work.done', to: 'end' },
    ],
  }
}

/** A new workflow's canvas, laid out like any other graph. */
export function blankGraph(): WorkflowGraph {
  const graph = blankGraphNodes()
  return { ...graph, layout: autoLayout(graph) }
}

/** v1 steps → the equivalent graph (mirror of the server's `compileV1`). */
export function compileSteps(steps: readonly WorkflowStepDef[]): WorkflowGraph {
  const edges: WorkflowGraph['edges'] = []
  const used = new Set(steps.map((s) => s.id))
  const fresh = (base: string) => {
    const id = uniqueId(base, used)
    used.add(id)
    return id
  }
  // Structural ids no step uses, and a named port on every edge (a v1 step id is any string).
  const startId = fresh('start')
  const endId = fresh('end')
  const nodes: WorkflowGraphNode[] = [{ id: startId, type: 'start' }]
  const out = (s: WorkflowStepDef) => `${s.id}.${s.command ? 'pass' : 'done'}`
  steps.forEach((s, i) => {
    const { onFail, command, ...rest } = s
    nodes.push(command ? { ...rest, type: 'check', command } : { ...rest, type: 'agent' })
    edges.push({ from: i === 0 ? `${startId}.next` : out(steps[i - 1]!), to: s.id })
    if (command && onFail) {
      const loopId = fresh(`${s.id}-retry`)
      nodes.push({ id: loopId, type: 'loop', max: onFail.max })
      edges.push({ from: `${s.id}.fail`, to: loopId }, { from: `${loopId}.repeat`, to: onFail.retry })
    }
  })
  nodes.push({ id: endId, type: 'end', status: 'success' })
  edges.push({ from: steps.length ? out(steps[steps.length - 1]!) : `${startId}.next`, to: endId })
  return { nodes, edges }
}

/**
 * The skills of a graph that is nothing but a stack of them — start → agents that each apply one
 * skill to `{{task}}` → a success end — or null for anything richer. Such a graph saves in the
 * portable compact `skills:` form (spec 012; mirror of the server's `skillStackOf`), so a stack
 * built here still drops into another repo as three lines of YAML.
 */
export function skillStackOfGraph(graph: WorkflowGraph): string[] | null {
  const starts = graph.nodes.filter((n) => n.type === 'start')
  if (starts.length !== 1) return null
  const skills: string[] = []
  let cur = targetOf(graph, starts[0]!.id, 'next')
  for (;;) {
    const node = graph.nodes.find((n) => n.id === cur)
    if (!node) return null
    if (node.type === 'end') {
      if (node.status !== 'success' || node.name !== undefined) return null
      break
    }
    // More agents than nodes means the walk came round: not a stack.
    if (node.type !== 'agent' || !node.skill || skills.length >= graph.nodes.length) return null
    const plain = Object.keys(node).every((k) => ['id', 'type', 'name', 'prompt', 'skill'].includes(k))
    if (!plain || (node.prompt !== undefined && node.prompt !== '{{task}}')) return null
    if ((node.name !== undefined && node.name !== node.skill) || targetOf(graph, node.id, 'failed')) return null
    skills.push(node.skill)
    cur = targetOf(graph, node.id, 'done')
  }
  // Nothing beside the stack: no stray nodes, no second edge.
  if (!skills.length || graph.nodes.length !== skills.length + 2 || graph.edges.length !== skills.length + 1) return null
  return skills
}

/** A planner's proposed chain (`POST /plan`) as steps with unique ids, ready to open as a graph. */
export function stepsFromPlan(steps: readonly WorkflowStepDef[]): WorkflowStepDef[] {
  const used = new Set<string>()
  return steps.map((step) => {
    const id = uniqueId(step.id || 'step', used)
    used.add(id)
    return { ...step, id }
  })
}

/** Node geometry, shared with the canvas renderer (`graph-node.tsx`) so the layout sizes a node
 *  exactly as it is drawn. */
export const TILE = 64
export const WIDE_WIDTH = 216
/** Nodes drawn as a wide card (title + subtitle inside) rather than an icon tile with a caption. */
export const WIDE_TYPES: ReadonlySet<GraphNodeType> = new Set(['agent', 'dispatch', 'workflow'])
/** Caption under an icon tile: centred, this wide, two short lines. */
export const CAPTION_WIDTH = 128
const CAPTION_HEIGHT = 40
/** Port label pill beside a multi-port node's dot. (A free port's `+` stub is ~50px and lives in
 *  the gap between columns, which is wider than that — it never needs space of its own.) */
const PORT_LABEL_GAP = 9
const PORT_CHAR = 6.2
/** Horizontal gap between columns, vertical gap between nodes in a column. */
const RANK_GAP = 60
const NODE_GAP = 8

/** Vertical rhythm for placing one node under the rest (click-add). */
export const LAYOUT_DY = 130

/**
 * The canvas area a node really occupies — its tile or card, the caption under a tile, the port
 * labels and `+` stubs sticking out on the right — and where the tile sits inside it (`dx`: the
 * caption is wider than a tile and hangs over its left edge).
 */
export function nodeFootprint(
  graph: WorkflowGraph,
  node: WorkflowGraphNode,
): { w: number; h: number; dx: number; dy: number } {
  void graph
  const wide = WIDE_TYPES.has(node.type)
  const tileW = wide ? WIDE_WIDTH : TILE
  const ports = portsOf(node)
  const labels = ports.length > 1 ? PORT_LABEL_GAP + Math.max(...ports.map((p) => p.length)) * PORT_CHAR + 8 : 0
  const right = tileW + labels
  // A tile's caption overhangs both of its sides; a wide card has no caption.
  const overhang = wide ? 0 : (CAPTION_WIDTH - TILE) / 2
  const w = Math.max(right, tileW + overhang) + overhang
  // Symmetric about the TILE's centre (the caption's height mirrored above it), so dagre, which
  // centres footprints in a rank, lines the tiles and cards up on one axis.
  const below = wide ? 18 : CAPTION_HEIGHT
  return { w, h: TILE + 2 * below, dx: overhang, dy: below }
}

/**
 * Layered layout (dagre) for graphs without saved positions and for "Tidy up": left to right in
 * the order the walk runs, each node sized by its real footprint so nothing overlaps while the
 * gaps stay tight, and node order chosen to minimise edge crossings. Loop edges are reversed for
 * ranking only — the main path reads straight to the right and every way back returns leftwards.
 * Failure edges weigh less than the happy path, so the happy path is the one that stays straight.
 */
export function autoLayout(
  graph: WorkflowGraph,
  opts: { rowWidth?: number } = {},
): NonNullable<WorkflowGraph['layout']> {
  const rowWidth = opts.rowWidth ?? ROW_WIDTH
  const g = new dagre.graphlib.Graph({ multigraph: true })
  g.setGraph({ rankdir: 'LR', ranksep: RANK_GAP, nodesep: NODE_GAP, edgesep: 14, marginx: 0, marginy: 0, ranker: 'network-simplex' })
  g.setDefaultEdgeLabel(() => ({}))
  const feet = new Map(graph.nodes.map((n) => [n.id, nodeFootprint(graph, n)]))
  for (const n of graph.nodes) {
    const f = feet.get(n.id)!
    g.setNode(n.id, { width: f.w, height: f.h })
  }
  for (const n of graph.nodes) {
    for (const port of portsOf(n)) {
      const to = targetOf(graph, n.id, port)
      if (!to || !feet.has(to)) continue
      g.setEdge(n.id, to, { weight: FAILURE_PORTS.has(port) ? 1 : 3, minlen: 1 }, `${n.id}.${port}`)
    }
  }
  dagre.layout(g)
  const placed = graph.nodes.map((n) => {
    const at = g.node(n.id)
    const f = feet.get(n.id)!
    return { id: n.id, cx: at?.x ?? 0, top: (at?.y ?? 0) - f.h / 2, left: (at?.x ?? 0) - f.w / 2, f }
  })

  orderByPorts(graph, placed)

  // Wrap a long walk into rows, like text — but only where it stays readable: a cut between two
  // ranks is made where the FEWEST edges cross it (ideally just the main path), looked for once a
  // row is past ~55% of a screen and no later than a full one. Cutting inside a loop would send
  // its edges back and forth between rows, which is worse than a wide canvas.
  const ranks = [...new Set(placed.map((p) => Math.round(p.cx)))].sort((a, b) => a - b)
  const rankIndex = new Map(ranks.map((cx, i) => [cx, i]))
  const rankOfNode = new Map(placed.map((p) => [p.id, rankIndex.get(Math.round(p.cx)) ?? 0]))
  const spans = graph.nodes.flatMap((n) =>
    portsOf(n).flatMap((port) => {
      const to = targetOf(graph, n.id, port)
      if (!to || !rankOfNode.has(to)) return []
      const a = rankOfNode.get(n.id) ?? 0
      const b = rankOfNode.get(to) ?? 0
      return [[Math.min(a, b), Math.max(a, b)] as const]
    }),
  )
  const crossing = (boundary: number) => spans.filter(([lo, hi]) => lo <= boundary && boundary < hi).length
  const rankLeft = ranks.map((cx) => Math.min(...placed.filter((p) => Math.round(p.cx) === cx).map((p) => p.left)))
  const rankRight = ranks.map((cx) => Math.max(...placed.filter((p) => Math.round(p.cx) === cx).map((p) => p.left + p.f.w)))
  const cuts: number[] = [] // a cut after rank i starts a new row at rank i + 1
  let rowStart = 0
  while (rowStart < ranks.length) {
    let best = -1
    let bestCross = Infinity
    let i = rowStart
    for (; i < ranks.length - 1; i++) {
      const width = rankRight[i]! - rankLeft[rowStart]!
      if (width > rowWidth) break
      if (width >= rowWidth * 0.55) {
        const c = crossing(i)
        if (c <= bestCross) {
          best = i
          bestCross = c
        }
      }
    }
    if (i >= ranks.length - 1) break // the rest fits on this row
    if (best < 0) best = Math.max(rowStart, i - 1) // one rank alone is wider than a row
    cuts.push(best)
    rowStart = best + 1
  }
  const bandOf = new Map<number, number>()
  ranks.forEach((cx, i) => bandOf.set(cx, cuts.filter((c) => c < i).length))
  const bands = [...new Set(bandOf.values())].sort((a, b) => a - b)
  const layout: NonNullable<WorkflowGraph['layout']> = {}
  let yOffset = 0
  for (const b of bands) {
    const members = placed.filter((p) => bandOf.get(Math.round(p.cx)) === b)
    const minX = Math.min(...members.map((p) => p.left))
    const minY = Math.min(...members.map((p) => p.top))
    const maxY = Math.max(...members.map((p) => p.top + p.f.h))
    for (const p of members) {
      layout[p.id] = { x: Math.round(p.left - minX + p.f.dx), y: Math.round(p.top - minY + p.f.dy + yOffset) }
    }
    yOffset += maxY - minY + ROW_GAP
  }
  return layout
}

/**
 * Dagre orders a column to cut crossings, but it does not know port order: a node fed by a
 * lower port can end up above one fed by a higher port of the same source, and their edges
 * cross right at the ports. Walk the columns left to right and stack each by the height of the
 * port that feeds it (from the nearest column on the left), level with that port where there is
 * room, keeping the column where dagre put it.
 * Nodes nothing earlier feeds keep their own height as the key, so they stay put.
 */
function orderByPorts(
  graph: WorkflowGraph,
  placed: { id: string; cx: number; top: number; f: { h: number; dy: number } }[],
): void {
  const byId = new Map(placed.map((p) => [p.id, p]))
  const portY = (id: string, port: string) => {
    const p = byId.get(id)
    const node = graph.nodes.find((n) => n.id === id)
    if (!p || !node) return 0
    const ports = portsOf(node)
    const i = Math.max(0, ports.indexOf(port))
    return p.top + p.f.dy + ((i + 1) / (ports.length + 1)) * TILE
  }
  const columns = [...new Set(placed.map((p) => Math.round(p.cx)))].sort((a, b) => a - b)
  for (const cx of columns) {
    const members = placed.filter((p) => Math.round(p.cx) === cx)
    if (members.length < 2) continue
    // A node fed from several columns follows the NEAREST one: that is where its edges fan in
    // side by side; a feed from far left arrives as a long edge whatever the order here.
    const key = (m: (typeof members)[number]) => {
      const feeds = graph.nodes.flatMap((n) => {
        const src = byId.get(n.id)
        if (!src || Math.round(src.cx) >= cx) return [] // only edges coming from the left
        return portsOf(n)
          .filter((port) => targetOf(graph, n.id, port) === m.id)
          .map((port) => ({ col: Math.round(src.cx), y: portY(n.id, port) }))
      })
      if (!feeds.length) return m.top + m.f.dy + TILE / 2
      const nearest = Math.max(...feeds.map((f) => f.col))
      return Math.min(...feeds.filter((f) => f.col === nearest).map((f) => f.y))
    }
    const keyed = members.map((m) => ({ m, k: key(m) })).sort((a, b) => a.k - b.k)
    // Each node sits level with the port that feeds it — its edge runs nearly flat — and only
    // moves down as far as it must to clear the node above it.
    let floor = -Infinity
    for (const { m, k } of keyed) {
      m.top = Math.max(k - TILE / 2 - m.f.dy, floor)
      floor = m.top + m.f.h + NODE_GAP
    }
  }
}

/** A row of the wrapped layout is about one screen of canvas; rows are this far apart. */
const ROW_WIDTH = 1800
const ROW_GAP = 90

/**
 * The edges that close a cycle — the ways back — found from the graph, not from where nodes
 * happen to sit: a depth-first walk from `start` along the ports in order; an edge into a node
 * still on the walk's stack goes back. Drawn dashed. A row-wrapped layout also has edges running
 * leftwards, and those are NOT loops, so position alone must never decide this.
 */
export function loopEdges(graph: WorkflowGraph): Set<string> {
  const back = new Set<string>()
  const state = new Map<string, 'open' | 'done'>()
  const visit = (id: string) => {
    state.set(id, 'open')
    const node = graph.nodes.find((n) => n.id === id)
    for (const port of node ? portsOf(node) : []) {
      const to = targetOf(graph, id, port)
      if (!to) continue
      if (state.get(to) === 'open') back.add(`${id}.${port}->${to}`)
      else if (!state.has(to)) visit(to)
    }
    state.set(id, 'done')
  }
  const start = graph.nodes.find((n) => n.type === 'start')
  if (start) visit(start.id)
  for (const n of graph.nodes) if (!state.has(n.id)) visit(n.id)
  return back
}

/** The graph a catalog entry opens as: its own graph, or its v1 steps compiled; laid out. */
export function graphForWorkflow(def: { steps: readonly WorkflowStepDef[]; graph?: WorkflowGraph }): WorkflowGraph {
  const graph = def.graph ?? compileSteps(def.steps)
  const complete = graph.layout && graph.nodes.every((n) => graph.layout?.[n.id])
  return complete ? graph : { ...graph, layout: { ...autoLayout(graph), ...graph.layout } }
}

export interface SimTransition {
  from: string
  port: string
  to: string | null
}

export type SimResult =
  | { kind: 'node'; node: string; transitions: SimTransition[] }
  | { kind: 'end'; status: 'success' | 'failed'; transitions: SimTransition[] }

/** Follow `from.port` through loop nodes to the next agent/check node or the end (mirror of the
 *  server's `advance`). `loops` holds per-loop counters for the whole simulated run. */
export function advance(graph: WorkflowGraph, from: string, port: string, loops: Map<string, number>): SimResult {
  const transitions: SimTransition[] = []
  let cur = from
  let curPort = port
  for (let guard = 0; guard < 10_000; guard++) {
    const to = targetOf(graph, cur, curPort)
    transitions.push({ from: cur, port: curPort, to: to ?? null })
    if (!to) return { kind: 'end', status: FAILURE_PORTS.has(curPort) ? 'failed' : 'success', transitions }
    const node = graph.nodes.find((n) => n.id === to)
    if (!node || node.type === 'start') return { kind: 'end', status: 'failed', transitions }
    if (node.type === 'end') return { kind: 'end', status: node.status, transitions }
    if (node.type === 'loop') {
      const count = (loops.get(node.id) ?? 0) + 1
      loops.set(node.id, count)
      cur = node.id
      curPort = count <= node.max ? 'repeat' : 'exhausted'
      continue
    }
    return { kind: 'node', node: node.id, transitions }
  }
  return { kind: 'end', status: 'failed', transitions }
}

/** Simulate a fork as a whole: out through every branch agent, then on from its join by
 *  `outcome` (`done` / `failed`) — the branches run at once, so one choice covers them. */
export function advanceFork(graph: WorkflowGraph, forkId: string, outcome: string, loops: Map<string, number>): SimResult {
  const fork = graph.nodes.find((n) => n.id === forkId)
  const { agents, join } = forkParts(graph, forkId)
  const out: SimTransition[] = agents.flatMap((a, i) => [
    { from: forkId, port: fork?.type === 'fork' ? portsOf(fork)[i]! : String(i + 1), to: a },
    { from: a, port: 'done', to: join ?? null },
  ])
  if (!join) return { kind: 'end', status: 'failed', transitions: out }
  const r = advance(graph, join, outcome, loops)
  return { ...r, transitions: [...out, ...r.transitions] }
}

/** Unwired output ports, as `node.port` — shown on the canvas, never blocking a save. */
export function unwiredPorts(graph: WorkflowGraph): string[] {
  return graph.nodes.flatMap((n) => portsOf(n).filter((p) => !targetOf(graph, n.id, p)).map((p) => `${n.id}.${p}`))
}

function yamlScalar(v: unknown): string {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  const s = String(v)
  const plain = /^[A-Za-z0-9._][A-Za-z0-9 ._/-]*$/.test(s) && !s.endsWith(' ')
  const looksTyped = /^(true|false|yes|no|on|off|null|~)$/i.test(s) || /^[-+.]?\d/.test(s)
  return plain && !looksTyped ? s : JSON.stringify(s)
}

function yamlField(key: string, value: unknown, pad: string): string[] {
  if (value === undefined) return []
  if (Array.isArray(value)) return [`${pad}${key}: [${value.map(yamlScalar).join(', ')}]`]
  if (value && typeof value === 'object') {
    return [`${pad}${key}:`, ...Object.entries(value).flatMap(([k, v]) => yamlField(k, v, `${pad}  `))]
  }
  // A block scalar must read back as the same string: `|-` when the text has no final newline
  // (a plain `|` would add one on import), `|` when it has exactly one. Anything a block cannot
  // carry faithfully (leading whitespace, several trailing newlines) falls through to a quoted string.
  if (typeof value === 'string' && value.includes('\n') && !/^\s/.test(value) && !/\n\n$/.test(value) && !value.includes('\r')) {
    const keep = value.endsWith('\n')
    const lines = (keep ? value.slice(0, -1) : value).split('\n')
    return [`${pad}${key}: ${keep ? '|' : '|-'}`, ...lines.map((l) => (l ? `${pad}  ${l}` : ''))]
  }
  return [`${pad}${key}: ${yamlScalar(value)}`]
}

/** The file the YAML tab previews and Export downloads — what Save writes: the compact `skills:`
 *  form for a pure skill stack, a `version: 2` graph otherwise (same keys the server writes). */
export function graphYaml(name: string, description: string, graph: WorkflowGraph): string {
  const head = [`name: ${yamlScalar(name.trim() || 'my-workflow')}`]
  if (description.trim()) head.push(...yamlField('description', description.trim(), ''))
  const stack = skillStackOfGraph(graph)
  if (stack) return `${[...head, 'skills:', ...stack.map((s) => `  - ${yamlScalar(s)}`)].join('\n')}\n`
  const lines = ['version: 2', ...head]
  lines.push('nodes:')
  for (const n of graph.nodes) {
    const { id, ...rest } = n
    lines.push(`  - id: ${yamlScalar(id)}`, ...Object.entries(rest).flatMap(([k, v]) => yamlField(k, v, '    ')))
  }
  lines.push('edges:')
  for (const e of graph.edges) lines.push(`  - { from: ${yamlScalar(e.from)}, to: ${yamlScalar(e.to)} }`)
  if (graph.layout && Object.keys(graph.layout).length) {
    lines.push('layout:')
    for (const [id, p] of Object.entries(graph.layout)) {
      lines.push(`  ${yamlScalar(id)}: { x: ${Math.round(p.x)}, y: ${Math.round(p.y)} }`)
    }
  }
  return `${lines.join('\n')}\n`
}

/** The file name Export downloads a workflow as — the same slug the server saves it under. */
export function graphYamlFilename(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${slug || 'workflow'}.yaml`
}

/** One node's state in a live run (phase 3 — the task view's graph tab). */
export interface NodeRunState {
  status: 'pending' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled' | 'skipped' | 'reached'
  iterations?: number
  costUsd?: number
  /** Loop nodes: how many times the walk came through. */
  loopCount?: number
}

/** What the run record says about a graph's walk. `graphState` / `steps` as `ApiRun` carries them. */
export interface RunWalk {
  currentStepId?: string
  steps: readonly { id: string; status: string; iterations?: number; costUsd?: number }[]
  graphState?: { loops: Record<string, number>; taken: readonly string[] }
}

/**
 * Fold a run record onto its graph: per-node state and per-edge traversal counts. Executable
 * nodes read their rail step; structural ones (start, end, loop) are `reached` once any taken
 * edge leads into them (start: once anything was taken).
 */
export function runOverlay(
  graph: WorkflowGraph,
  run: RunWalk,
): { nodes: Map<string, NodeRunState>; edges: Map<string, number> } {
  const taken = run.graphState?.taken ?? []
  const edges = new Map<string, number>()
  const entered = new Set<string>()
  for (const key of taken) {
    edges.set(key, (edges.get(key) ?? 0) + 1)
    const to = key.slice(key.indexOf('->') + 2)
    if (to) entered.add(to)
  }
  const nodes = new Map<string, NodeRunState>()
  for (const n of graph.nodes) {
    const step = run.steps.find((s) => s.id === n.id)
    if (step) {
      nodes.set(n.id, {
        status: step.status as NodeRunState['status'],
        ...(step.iterations ? { iterations: step.iterations } : {}),
        ...(step.costUsd ? { costUsd: step.costUsd } : {}),
      })
    } else if (n.type === 'loop') {
      const count = run.graphState?.loops[n.id]
      nodes.set(n.id, { status: entered.has(n.id) ? 'reached' : 'pending', ...(count ? { loopCount: count } : {}) })
    } else {
      const reached = n.type === 'start' ? taken.length > 0 : entered.has(n.id)
      nodes.set(n.id, { status: reached ? 'reached' : 'pending' })
    }
  }
  return { nodes, edges }
}

/**
 * The nearest free spot at or below `at`: steps down one row until no laid-out node sits within
 * a node's footprint of it. Used when the editor places a node for you (a port's `+`).
 */
export function freeSpot(
  layout: WorkflowGraph['layout'],
  at: { x: number; y: number },
  footprint = { w: 240, h: 110 },
): { x: number; y: number } {
  const taken = Object.values(layout ?? {})
  const spot = { ...at }
  for (let guard = 0; guard < 200; guard++) {
    const clash = taken.some((p) => Math.abs(p.x - spot.x) < footprint.w && Math.abs(p.y - spot.y) < footprint.h)
    if (!clash) return spot
    spot.y += footprint.h
  }
  return spot
}

export interface LaneRequest {
  key: string
  from: string
  port: string
  to: string
}

/** A routed edge: the lane it runs along and where its two vertical legs stand. */
export interface Lane {
  y: number
  outX: number
  inX: number
}

/**
 * Orthogonal routes for edges that cannot run straight (loops, leftward edges, forward edges a
 * node stands in the way of). Each route is: out of the port — past its label — down or up a
 * vertical leg to a horizontal LANE, along it, and a vertical leg into the target from the left.
 * Candidate lanes are above everything in the edge's span, below everything, and every free gap
 * between nodes in it; the shortest route whose three segments cross no tile or caption wins.
 * Lanes already taken over an overlapping span are kept a step apart.
 */
export function routeLanes(graph: WorkflowGraph, requests: readonly LaneRequest[]): Map<string, Lane> {
  const layout = graph.layout ?? {}
  const rects = graph.nodes.flatMap((n) => {
    const p = layout[n.id]
    if (!p) return []
    const f = nodeFootprint(graph, n)
    const wide = WIDE_TYPES.has(n.type)
    const tileW = wide ? WIDE_WIDTH : TILE
    // The tile, its caption under it, and its port labels to the right.
    return [{
      id: n.id,
      x0: p.x - (wide ? 0 : (CAPTION_WIDTH - TILE) / 2),
      x1: p.x - f.dx + f.w,
      y0: p.y,
      y1: p.y + TILE + (wide ? 0 : CAPTION_HEIGHT - 6),
      tileRight: p.x + tileW,
    }]
  })
  const byId = new Map(rects.map((r) => [r.id, r]))
  const portY = (id: string, port: string) => {
    const node = graph.nodes.find((n) => n.id === id)
    const ports = node ? portsOf(node) : []
    const i = Math.max(0, ports.indexOf(port))
    return (layout[id]?.y ?? 0) + ((i + 1) / (ports.length + 1)) * TILE
  }
  const PAD = 10
  const hits = (x0: number, y0: number, x1: number, y1: number, skip: ReadonlySet<string>) =>
    rects.some((r) => !skip.has(r.id) && r.x0 - PAD < Math.max(x0, x1) && r.x1 + PAD > Math.min(x0, x1) && r.y0 - PAD < Math.max(y0, y1) && r.y1 + PAD > Math.min(y0, y1))
  const lanes = new Map<string, Lane>()
  const used: { x0: number; x1: number; y: number }[] = []
  const STEP = 12
  for (const r of requests) {
    const src = byId.get(r.from)
    const dst = byId.get(r.to)
    if (!src || !dst) continue
    const sy = portY(r.from, r.port)
    const ty = (layout[r.to]?.y ?? 0) + TILE / 2
    const outX = src.x1 + 12 // past the port labels
    const inX = dst.x0 - 14
    const [lo, hi] = [Math.min(outX, inX), Math.max(outX, inX)]
    const span = rects.filter((x) => x.x0 - PAD < hi && x.x1 + PAD > lo)
    // Candidate lanes: over and under the whole span, and the middle of every free band inside it.
    const bands = span.map((x) => [x.y0 - PAD, x.y1 + PAD] as const).sort((a, b) => a[0] - b[0])
    const candidates = [Math.min(...bands.map((b) => b[0])) - 8, Math.max(...bands.map((b) => b[1])) + 8]
    let reach = -Infinity
    for (const [b0, b1] of bands) {
      if (reach !== -Infinity && b0 - reach >= 14) candidates.push((reach + b0) / 2)
      reach = Math.max(reach, b1)
    }
    const valid = (y: number) =>
      !hits(outX, sy, outX, y, new Set([r.from])) && // leg out of the source
      !hits(lo, y, hi, y, new Set()) && // the lane itself
      !hits(inX, y, inX, ty, new Set([r.to])) // leg into the target
    const cost = (y: number) => Math.abs(y - sy) + Math.abs(y - ty) + (hi - lo)
    const ranked = [...new Set(candidates)].sort((a, b) => cost(a) - cost(b))
    let y = ranked.find(valid) ?? ranked[0]!
    const down = y >= (sy + ty) / 2
    while (used.some((u) => u.x0 < hi && u.x1 > lo && Math.abs(u.y - y) < STEP)) y += down ? STEP : -STEP
    used.push({ x0: lo, x1: hi, y })
    lanes.set(r.key, { y, outX, inX })
  }
  return lanes
}

/** An orthogonal path through `points` with rounded corners of radius `r` (SVG `d`). */
export function roundedPath(points: readonly { x: number; y: number }[], r = 12): string {
  if (points.length < 2) return ''
  let d = `M ${points[0]!.x} ${points[0]!.y}`
  for (let i = 1; i < points.length - 1; i++) {
    const [p, c, n] = [points[i - 1]!, points[i]!, points[i + 1]!]
    const inLen = Math.hypot(c.x - p.x, c.y - p.y)
    const outLen = Math.hypot(n.x - c.x, n.y - c.y)
    const k = Math.min(r, inLen / 2, outLen / 2)
    const a = { x: c.x - ((c.x - p.x) / (inLen || 1)) * k, y: c.y - ((c.y - p.y) / (inLen || 1)) * k }
    const b = { x: c.x + ((n.x - c.x) / (outLen || 1)) * k, y: c.y + ((n.y - c.y) / (outLen || 1)) * k }
    d += ` L ${a.x} ${a.y} Q ${c.x} ${c.y} ${b.x} ${b.y}`
  }
  const last = points[points.length - 1]!
  return `${d} L ${last.x} ${last.y}`
}
