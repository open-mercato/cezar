import '@xyflow/react/dist/style.css'

import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  DownloadIcon,
  LayoutGridIcon,
  PlayIcon,
  PlusIcon,
  RotateCcwIcon,
  SaveIcon,
  Settings2Icon,
  SquareIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { useParams } from 'react-router'

import {
  ApiError,
  createWorkflow,
  deleteWorkflow,
  parseWorkflow,
  postPlan,
  saveWorkflowGraph,
  validateWorkflowGraph,
} from '@/api/client'
import { queryKeys, useSkills, useWorkflowNodes, useWorkflows } from '@/api/queries'
import type { WorkflowGraph, WorkflowGraphNode } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { useNavigate } from '@/lib/project-router'
import { cn } from '@/lib/utils'
import {
  advance,
  autoLayout,
  blankGraph,
  connect,
  disconnect,
  freeSpot,
  uniqueId,
  graphForWorkflow,
  graphYaml,
  graphYamlFilename,
  LAYOUT_DY,
  loopEdges,
  newNode,
  addFork,
  advanceFork,
  forkBranchIds,
  setForkBranches,
  skillStackOfGraph,
  stepsFromPlan,
  portsOf,
  portTone,
  removeNode,
  targetOf,
  unwiredPorts,
  updateNode,
  type GraphNodeType,
  type NodeRunState,
} from '@/lib/workflow-graph'

import { WorkflowsLoading } from '../workflows/workflows-loading'
import { backLanes, CATEGORY_ORDER, edgeStyle, edgeTypes, GraphNodeView, ICONS, type InnerStep, TILE, TONE, WIDE_WIDTH } from './graph-node'

/**
 * The workflow node editor (spec 2026-09-30-workflow-node-editor), at
 * /p/:projectId/workflows[/:name].
 *
 * Minimal by design: the top bar and the canvas are all that is always on screen. The node
 * palette and the inspector are floating panels that open when you add or edit something and
 * close again (✕, Escape, or a click on the empty canvas).
 *
 * State: one `WorkflowGraph` is the source of truth for the WORKFLOW. React Flow owns its own
 * node objects (positions, measured sizes, selection) through `applyNodeChanges`; the graph is
 * folded into them without dropping what React Flow measured, and a drag writes the layout back
 * only when it ends. Rebuilding every node object per drag frame is what made the canvas flicker —
 * a node without its `measured` size is hidden until React Flow measures it again.
 */

const RUNNERS = ['claude', 'codex', 'opencode', 'cursor', 'pi'] as const
const DRAG_MIME = 'application/x-cezar-node'

type FlowNodeData = {
  node: WorkflowGraphNode
  wired: string[]
  issue: boolean
  status?: NodeRunState['status']
  loopCount?: number
  onAddFromPort?: (port: string) => void
}

function EditorNode({ data, selected }: NodeProps<Node<FlowNodeData>>) {
  const inner = useSubflowSteps(data.node)
  return (
    <GraphNodeView
      inner={inner}
      node={data.node}
      wired={data.wired}
      selected={selected}
      issue={data.issue}
      status={data.status}
      loopCount={data.loopCount}
      onAddFromPort={data.onAddFromPort}
    />
  )
}

const nodeTypes = { graph: EditorNode }

/** A sub-workflow node's steps, read from the catalog, so the card says what it will run. */
function useSubflowSteps(node: WorkflowGraphNode): InnerStep[] | undefined {
  const workflows = useWorkflows({ enabled: node.type === 'workflow' })
  if (node.type !== 'workflow') return undefined
  const def = workflows.data?.workflows.find((w) => w.name === node.workflow)
  if (!def) return undefined
  const steps = def.graph
    ? def.graph.nodes
        .filter((n) => n.type !== 'start' && n.type !== 'end' && n.type !== 'loop' && n.type !== 'join')
        .map((n) => ({ id: n.id, name: n.name ?? n.id }))
    : def.steps.map((st) => ({ id: st.id, name: st.name ?? st.id }))
  return steps.length ? steps : undefined
}

export interface SimState {
  cursor: string | null
  visited: string[]
  taken: string[]
  loops: Map<string, number>
  log: string[]
  finished?: 'success' | 'failed'
}

function applySim(s: SimState, r: ReturnType<typeof advance>): SimState {
  const taken = [...s.taken, ...r.transitions.filter((t) => t.to).map((t) => `${t.from}.${t.port}->${t.to}`)]
  const log = [...s.log, ...r.transitions.map((t) => `${t.from}.${t.port} → ${t.to ?? '(ends run)'}`)]
  const visited = [...s.visited, ...r.transitions.flatMap((t) => (t.to ? [t.to] : []))]
  if (r.kind === 'end') return { ...s, cursor: null, taken, log, visited, finished: r.status }
  return { ...s, cursor: r.node, taken, log, visited }
}

/** One simulated outcome. Pure — `advance` bumps loop counters in place, so it gets a copy:
 *  React may run a state updater twice (StrictMode), and a shared map would count twice. */
export function simStep(graph: WorkflowGraph, s: SimState, node: string, port: string): SimState {
  const loops = new Map(s.loops)
  // A fork runs its branches at once: one outcome covers them, and the walk goes on from the join.
  const forked = graph.nodes.find((n) => n.id === node)?.type === 'fork'
  return applySim({ ...s, loops }, forked ? advanceFork(graph, node, port, loops) : advance(graph, node, port, loops))
}

export function startSim(graph: WorkflowGraph): SimState {
  const loops = new Map<string, number>()
  const start = graph.nodes.find((n) => n.type === 'start')
  const base: SimState = { cursor: null, visited: [], taken: [], loops, log: [] }
  if (!start) return { ...base, finished: 'failed', log: ['no start node'] }
  return applySim({ ...base, visited: [start.id] }, advance(graph, start.id, 'next', loops))
}

/** Simulation state of one node, in the live view's vocabulary. */
function simStatus(sim: SimState | null, id: string): NodeRunState['status'] | undefined {
  if (!sim) return undefined
  if (sim.cursor === id) return 'running'
  return sim.visited.includes(id) ? 'reached' : 'pending'
}

export function WorkflowGraphRoute() {
  return (
    <ReactFlowProvider>
      <WorkflowGraphEditor />
    </ReactFlowProvider>
  )
}

/** A floating panel over the canvas — the only chrome besides the top bar. */
export function FloatingPanel({
  side,
  title,
  onClose,
  children,
  label,
}: {
  side: 'left' | 'right'
  title: ReactNode
  onClose: () => void
  children: ReactNode
  label: string
}) {
  return (
    <aside
      aria-label={label}
      className={cn(
        'absolute top-3 bottom-3 z-10 flex flex-col overflow-hidden rounded-xl border border-border bg-card/95 shadow-xl backdrop-blur',
        side === 'left' ? 'left-3 w-60' : 'right-3 w-80',
      )}
    >
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border pr-1 pl-3 text-[12px] font-medium">
        <span className="min-w-0 truncate">{title}</span>
        <Button size="sm" variant="ghost" onClick={onClose} aria-label={`Close ${label.toLowerCase()}`}>
          <XIcon />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </aside>
  )
}

function WorkflowGraphEditor() {
  const { name: routeName } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const workflows = useWorkflows()
  const catalog = useWorkflowNodes()
  const flow = useReactFlow()


  const [graph, setGraph] = useState<WorkflowGraph>(blankGraph)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [dirty, setDirty] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  // Skills load once the palette first opens — the canvas itself never needs them.
  const [skillsWanted, setSkillsWanted] = useState(false)
  if (paletteOpen && !skillsWanted) setSkillsWanted(true)
  const skills = useSkills(skillsWanted)
  const [skillQuery, setSkillQuery] = useState('')
  /** The right panel: the selected node, the workflow's own settings, or nothing. */
  const [workflowPanel, setWorkflowPanel] = useState(false)
  const [sim, setSim] = useState<SimState | null>(null)
  const [issues, setIssues] = useState<string[]>([])
  const [importText, setImportText] = useState('')
  const [planText, setPlanText] = useState('')
  const [rfNodes, setRfNodes] = useState<Node<FlowNodeData>[]>([])
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null)
  /** Set by a port's `+`: the next node picked in the palette is placed after it and wired to it. */
  const [attach, setAttach] = useState<{ node: string; port: string } | null>(null)
  // One stable callback per node id, so the node data (and its memoized view) stays stable.
  const startAttach = useCallback((node: string, port: string) => {
    setAttach({ node, port })
    setPaletteOpen(true)
    setSelectedId(null)
    setWorkflowPanel(false)
  }, [])
  const attachHandlers = useRef(new Map<string, (port: string) => void>())
  const attachFor = useCallback(
    (id: string) => {
      let fn = attachHandlers.current.get(id)
      if (!fn) {
        fn = (port: string) => startAttach(id, port)
        attachHandlers.current.set(id, fn)
      }
      return fn
    },
    [startAttach],
  )
  const loadedFor = useRef<string | null>(null)
  /** Fit the view once React Flow has MEASURED the nodes — fitting before that frames nothing. */
  const pendingFit = useRef(true)
  const nodesInitialized = useNodesInitialized()
  /** A pending confirmation: replace an existing file on save, or leave unsaved edits. */
  const [confirm, setConfirm] = useState<
    { kind: 'overwrite' } | { kind: 'shadow' } | { kind: 'discard'; to: string } | { kind: 'delete'; name: string } | null
  >(null)

  // Load once per route name — a background refetch must never clobber edits in progress.
  useEffect(() => {
    const key = routeName ?? '(new)'
    if (loadedFor.current === key) return
    if (routeName && !workflows.data) return
    loadedFor.current = key
    const def = routeName ? workflows.data?.workflows.find((w) => w.name === routeName) : undefined
    setGraph(def ? graphForWorkflow(def) : blankGraph())
    // A built-in is a template: its canvas saves as your own copy unless you rename it back.
    setName(def ? (def.source === 'built-in' ? `${def.name}-copy` : def.name) : '')
    setDescription(def?.description ?? '')
    setDirty(false)
    setSelectedId(null)
    setSim(null)
    if (routeName && !def) toast(`No workflow named “${routeName}” — starting a new one.`, { tone: 'danger' })
    pendingFit.current = true
  }, [routeName, workflows.data])

  useEffect(() => {
    if (!nodesInitialized || !pendingFit.current || rfNodes.length === 0) return
    pendingFit.current = false
    void flow.fitView({ padding: 0.2, maxZoom: 1.2 })
  }, [nodesInitialized, rfNodes, flow])

  const edit = useCallback((fn: (g: WorkflowGraph) => WorkflowGraph) => {
    setGraph((g) => fn(g))
    setDirty(true)
    setSim(null)
  }, [])

  // Live validation, debounced: the server owns the rules. Keyed on nodes + edges only, so
  // dragging a node (a layout change) never re-validates.
  const { nodes: graphNodes, edges: graphEdges } = graph
  useEffect(() => {
    const t = setTimeout(() => {
      validateWorkflowGraph({ nodes: graphNodes, edges: graphEdges })
        .then((r) => setIssues(r.issues))
        .catch((err: unknown) => setIssues([err instanceof Error ? err.message : String(err)]))
    }, 350)
    return () => clearTimeout(t)
  }, [graphNodes, graphEdges])

  const issueNodes = useMemo(() => {
    const ids = new Set<string>()
    for (const i of issues) for (const m of i.matchAll(/"([A-Za-z0-9_-]+)"/g)) ids.add(m[1] as string)
    return ids
  }, [issues])

  // Fold the workflow into React Flow's own node objects, KEEPING what React Flow measured.
  useEffect(() => {
    setRfNodes((prev) =>
      graph.nodes.map((n) => {
        const old = prev.find((p) => p.id === n.id)
        const data: FlowNodeData = {
          node: n,
          wired: portsOf(n).filter((p) => targetOf(graph, n.id, p) !== undefined),
          issue: issueNodes.has(n.id),
          status: simStatus(sim, n.id),
          loopCount: sim?.loops.get(n.id),
          // No `+` stubs while simulating — the canvas is read-only then.
          ...(sim ? {} : { onAddFromPort: attachFor(n.id) }),
        }
        const position = graph.layout?.[n.id] ?? old?.position ?? { x: 0, y: 0 }
        return old
          ? { ...old, position, data, selected: n.id === selectedId }
          : { id: n.id, type: 'graph', position, data, selected: n.id === selectedId }
      }),
    )
  }, [graph, issueNodes, sim, selectedId, attachFor])

  const loops = useMemo(() => loopEdges({ nodes: graphNodes, edges: graphEdges }), [graphNodes, graphEdges])
  const lanes = useMemo(() => backLanes(graph, loops), [graph, loops])
  const rfEdges: Edge[] = useMemo(
    () =>
      graph.nodes.flatMap((n) =>
        portsOf(n).flatMap((port) => {
          const to = targetOf(graph, n.id, port)
          if (!to) return []
          const tone = portTone(n, port)
          // Dashed = a real way back (a loop), from the graph; a leftward edge in a wrapped layout is
          // just the walk continuing on the next row, drawn solid with right angles.
          const back = loops.has(`${n.id}.${port}->${to}`)
          const leftward = (graph.layout?.[to]?.x ?? 0) <= (graph.layout?.[n.id]?.x ?? 0)
          const key = `${n.id}.${port}->${to}`
          const style = edgeStyle({
            tone,
            back,
            ...(sim ? { emphasis: sim.taken.includes(key) ? ('taken' as const) : ('dim' as const) } : {}),
          })
          return [
            {
              id: key,
              source: n.id,
              sourceHandle: port,
              target: to,
              type: back || leftward || lanes.has(key) ? 'lane' : 'default',
              // A way back, or an edge that would cross a node, runs in its own lane around them.
              ...(lanes.has(key) ? { data: { lane: lanes.get(key) } } : {}),
              selected: key === selectedEdge,
              style: key === selectedEdge ? { ...style, stroke: 'var(--primary)', strokeWidth: 2.5 } : style,
              markerEnd: { type: MarkerType.ArrowClosed, color: style.stroke, width: 14, height: 14 },
            },
          ]
        }),
      ),
    [graph, sim, selectedEdge, loops, lanes],
  )

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<FlowNodeData>>[]) => {
      setRfNodes((nds) => applyNodeChanges(changes, nds))
      for (const c of changes) {
        if (c.type === 'position' && c.position && !c.dragging) {
          // The drag ended: now the workflow's layout learns the new spot (once, not per frame).
          const { id, position } = c
          setGraph((g) => ({ ...g, layout: { ...g.layout, [id]: position } }))
          setDirty(true)
        } else if (c.type === 'remove') {
          edit((g) => removeNode(g, c.id))
          setSelectedId((s) => (s === c.id ? null : s))
        } else if (c.type === 'select') {
          if (c.selected) {
            setSelectedId(c.id)
            setWorkflowPanel(false)
          } else setSelectedId((s) => (s === c.id ? null : s))
        }
      }
    },
    [edit],
  )

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      for (const c of changes) {
        if (c.type === 'select') setSelectedEdge(c.selected ? c.id : null)
        if (c.type !== 'remove') continue
        const from = c.id.split('->')[0] ?? ''
        const dot = from.lastIndexOf('.')
        edit((g) => disconnect(g, from.slice(0, dot), from.slice(dot + 1)))
        setSelectedEdge(null)
      }
    },
    [edit],
  )

  const onConnect = useCallback(
    (c: Connection) => {
      const { source, target, sourceHandle } = c
      if (!source || !target || !sourceHandle) return
      edit((g) => connect(g, source, sourceHandle, target))
    },
    [edit],
  )

  const addNode = useCallback(
    (type: GraphNodeType, position?: { x: number; y: number }, skill?: string) => {
      // A fork arrives with its agents and join, wired — from a port's `+`, the fan hangs off it.
      if (type === 'fork') {
        const source = attach ? graph.layout?.[attach.node] : undefined
        const spots = Object.values(graph.layout ?? {})
        const at =
          position ??
          (source
            ? { x: source.x + WIDE_WIDTH + 170, y: source.y }
            : { x: spots.length ? Math.min(...spots.map((p) => p.x)) : 0, y: spots.length ? Math.max(...spots.map((p) => p.y)) + LAYOUT_DY * 2 : 0 })
        const target = attach
        edit((g) => {
          const added = addFork(g, at)
          return target ? connect(added.graph, target.node, target.port, added.forkId) : added.graph
        })
        setAttach(null)
        setPaletteOpen(false)
        setWorkflowPanel(false)
        void flow.setCenter(at.x + 300, at.y + TILE / 2, { zoom: flow.getZoom(), duration: 250 })
        return
      }
      const base = newNode(type, graph.nodes.map((n) => n.id))
      // A skill from the palette is an agent node applying that skill to the task (the old
      // builder's "stack of skills", one block at a time).
      const node: WorkflowGraphNode =
        skill && base.type === 'agent'
          ? { ...base, id: uniqueId(skill.replace(/[^A-Za-z0-9_-]/g, '-'), graph.nodes.map((n) => n.id)), name: skill, skill }
          : base
      // Added from a port's `+`: place it right of that port and wire it in one edit.
      if (attach && !position) {
        const source = graph.nodes.find((n) => n.id === attach.node)
        const from = graph.layout?.[attach.node]
        if (source && from) {
          const ports = portsOf(source)
          const index = Math.max(0, ports.indexOf(attach.port))
          const width = source.type === 'agent' || source.type === 'dispatch' ? WIDE_WIDTH : TILE
          const at = freeSpot(graph.layout, { x: from.x + width + 170, y: from.y + (index - (ports.length - 1) / 2) * 110 })
          const { node: sourceId, port } = attach
          edit((g) => connect({ ...g, nodes: [...g.nodes, node], layout: { ...g.layout, [node.id]: at } }, sourceId, port, node.id))
          setAttach(null)
          setPaletteOpen(false)
          setSelectedId(node.id)
          void flow.setCenter(at.x + TILE, at.y + TILE / 2, { zoom: flow.getZoom(), duration: 250 })
          return
        }
      }
      // A click-added node lands in a free row under everything, never on top of a node.
      const spots = Object.values(graph.layout ?? {})
      const at = position ?? {
        x: spots.length ? Math.min(...spots.map((p) => p.x)) : 0,
        y: spots.length ? Math.max(...spots.map((p) => p.y)) + LAYOUT_DY : 0,
      }
      edit((g) => ({ ...g, nodes: [...g.nodes, node], layout: { ...g.layout, [node.id]: at } }))
      setSelectedId(node.id)
      setWorkflowPanel(false)
      if (!position) void flow.setCenter(at.x + TILE, at.y + TILE / 2, { zoom: flow.getZoom(), duration: 250 })
    },
    [attach, edit, flow, graph.nodes, graph.layout],
  )

  const onDrop = (event: DragEvent) => {
    const type = event.dataTransfer.getData(DRAG_MIME) as GraphNodeType
    if (!type) return
    event.preventDefault()
    const p = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY })
    const half = (type === 'agent' || type === 'dispatch' ? WIDE_WIDTH : TILE) / 2
    addNode(type, { x: p.x - half, y: p.y - TILE / 2 })
  }

  const closePanels = useCallback(() => {
    setSelectedId(null)
    setWorkflowPanel(false)
    setPaletteOpen(false)
  }, [])

  // Escape closes whatever floats over the canvas, innermost first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || confirm) return
      // Escape inside a field belongs to the field (and the target may be the window itself).
      if (e.target instanceof Element && e.target.closest('input, textarea, select')) return
      if (selectedId || workflowPanel) {
        setSelectedId(null)
        setWorkflowPanel(false)
      } else {
        setPaletteOpen(false)
        setAttach(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirm, selectedId, workflowPanel])

  const save = useMutation({
    mutationFn: (overwrite: boolean) => {
      const head = { name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) }
      // A pure stack of skills stays in the portable compact form (spec 012); anything richer is
      // a `version: 2` graph.
      const stack = skillStackOfGraph(graph)
      return stack
        ? createWorkflow({ ...head, skills: stack, ...(overwrite ? { overwrite: true } : {}) })
        : saveWorkflowGraph({ ...head, graph, overwrite })
    },
    onSuccess: (res) => {
      setDirty(false)
      toast(`Saved ${res.path.split('/').pop() ?? res.path}`)
      void queryClient.invalidateQueries({ queryKey: queryKeys.workflows })
      if (res.name !== routeName) {
        loadedFor.current = res.name
        void navigate(`/workflows/${encodeURIComponent(res.name)}`)
      }
    },
    onError: (err, overwrite) => {
      if (!overwrite && err instanceof ApiError && err.exists) {
        setConfirm({ kind: 'overwrite' })
        return
      }
      toast(err instanceof Error ? err.message : String(err), { tone: 'danger' })
    },
  })

  const importYaml = useMutation({
    mutationFn: () => parseWorkflow(importText),
    onSuccess: (parsed) => {
      edit(() => graphForWorkflow(parsed))
      setName(parsed.name)
      setDescription(parsed.description ?? '')
      setImportText('')
      pendingFit.current = true
    },
    onError: (err) => toast(err instanceof Error ? err.message : String(err), { tone: 'danger' }),
  })

  // The planner turns a plain-language brief into a proposed chain, opened on the canvas to
  // review and Save (#414). It never hard-fails: a degraded answer is a one-step plan.
  const autoPlan = useMutation({
    mutationFn: () => postPlan(planText.trim()),
    onSuccess: (plan) => {
      edit(() => graphForWorkflow({ steps: stepsFromPlan(plan.steps) }))
      if (plan.name?.trim()) setName(plan.name.trim())
      setPlanText('')
      pendingFit.current = true
      toast(
        plan.fallback ? 'Planner unavailable — added a single step. Edit, then Save.' : 'Built a workflow — review, tweak, then Save.',
        plan.fallback ? { tone: 'danger' } : undefined,
      )
    },
    onError: (err) => toast(err instanceof Error ? err.message : String(err), { tone: 'danger' }),
  })

  const del = useMutation({
    mutationFn: (workflowName: string) => deleteWorkflow(workflowName),
    onSuccess: (_, workflowName) => {
      toast(`Deleted “${workflowName}”.`)
      setDirty(false)
      void queryClient.invalidateQueries({ queryKey: queryKeys.workflows })
      void navigate('/workflows')
    },
    onError: (err) => toast(err instanceof Error ? err.message : String(err), { tone: 'danger' }),
  })

  // Export is the canvas as it stands — unsaved edits included — in the file the server would write.
  const exportYaml = () => {
    const url = URL.createObjectURL(new Blob([graphYaml(name, description, graph)], { type: 'application/yaml;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = graphYamlFilename(name)
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  if (catalog.isPending || (routeName && workflows.isPending)) return <WorkflowsLoading />
  if (catalog.isError) {
    return (
      <CenteredState
        icon={<AlertTriangleIcon />}
        tone="neutral"
        title="The node catalog did not load"
        subtitle={catalog.error instanceof Error ? catalog.error.message : 'Try again in a moment.'}
      />
    )
  }

  const selected = graph.nodes.find((n) => n.id === selectedId) ?? null
  const cursorNode = sim?.cursor ? graph.nodes.find((n) => n.id === sim.cursor) : undefined
  const unwired = unwiredPorts(graph)
  const canSave = name.trim().length > 0 && issues.length === 0 && !save.isPending
  // Re-saving the file this canvas was opened from overwrites silently; the confirm is only for
  // a name that collides with ANOTHER file (or a built-in-shadowing new one).
  const opened = routeName ? workflows.data?.workflows.find((w) => w.name === routeName) : undefined
  const savingOwnFile = opened?.source === 'file' && name.trim() === routeName
  // A file named like a built-in (`quick-task`) REPLACES it for every task in the repo.
  const shadowsBuiltIn = Boolean(workflows.data?.workflows.some((w) => w.name === name.trim() && w.source === 'built-in'))

  return (
    <div data-route="workflows" className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
        <select
          aria-label="Open workflow"
          className="h-8 max-w-44 rounded-md border border-transparent bg-transparent px-1.5 text-[13px] font-medium outline-none hover:border-border focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          value={routeName ?? ''}
          onChange={(e) => {
            const to = e.target.value ? `/workflows/${encodeURIComponent(e.target.value)}` : '/workflows'
            if (dirty) setConfirm({ kind: 'discard', to })
            else void navigate(to)
          }}
        >
          <option value="">New workflow</option>
          <optgroup label="This repo">
            {workflows.data?.workflows
              .filter((w) => w.source === 'file')
              .map((w) => (
                <option key={w.name} value={w.name}>
                  {w.name}
                  {w.graph ? '' : ' (v1)'}
                </option>
              ))}
          </optgroup>
          <optgroup label="Built-in templates">
            {workflows.data?.workflows
              .filter((w) => w.source === 'built-in')
              .map((w) => (
                <option key={w.name} value={w.name}>
                  {w.name}
                </option>
              ))}
          </optgroup>
        </select>
        <span className="text-muted-foreground/60">/</span>
        <Input
          aria-label="Workflow name"
          placeholder="name this workflow"
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            setDirty(true)
          }}
          className="h-8 w-52 border-transparent bg-transparent text-[13px] shadow-none hover:border-border"
        />
        {dirty && <span className="size-1.5 rounded-full bg-primary" title="Unsaved changes" aria-label="Unsaved changes" />}
        <button
          type="button"
          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] hover:bg-accent"
          style={{ color: issues.length ? TONE.failure : 'var(--muted-foreground)' }}
          title={issues.join('\n') || 'The server validated this workflow'}
          onClick={() => {
            setSelectedId(null)
            setWorkflowPanel(true)
          }}
        >
          {issues.length ? <AlertTriangleIcon className="size-3.5" /> : <CheckCircle2Icon className="size-3.5" />}
          {issues.length ? `${issues.length} issue${issues.length > 1 ? 's' : ''}` : 'valid'}
        </button>
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            variant={paletteOpen ? 'primary' : 'ghost'}
            onClick={() => {
              setAttach(null)
              setPaletteOpen((o) => !o)
            }}
          >
            <PlusIcon /> Add node
          </Button>
          <Button
            size="sm"
            variant="ghost"
            title="Tidy up the layout"
            aria-label="Tidy up"
            onClick={() => {
              edit((g) => ({ ...g, layout: autoLayout(g) }))
              pendingFit.current = true
            }}
          >
            <LayoutGridIcon />
          </Button>
          <Button size="sm" variant={sim ? 'primary' : 'ghost'} onClick={() => setSim((s) => (s ? null : startSim(graph)))}>
            {sim ? <SquareIcon /> : <PlayIcon />} {sim ? 'Stop' : 'Simulate'}
          </Button>
          <Button
            size="sm"
            variant={workflowPanel ? 'primary' : 'ghost'}
            title="Workflow settings, YAML and import"
            aria-label="Workflow settings"
            onClick={() => {
              setSelectedId(null)
              setWorkflowPanel((o) => !o)
            }}
          >
            <Settings2Icon />
          </Button>
          <Button size="sm" variant="ghost" title="Export as a .yaml file" aria-label="Export YAML" onClick={exportYaml}>
            <DownloadIcon />
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!canSave}
            onClick={() => (shadowsBuiltIn ? setConfirm({ kind: 'shadow' }) : save.mutate(savingOwnFile))}
          >
            <SaveIcon /> Save
          </Button>
        </div>
      </header>

      <div className="relative min-h-0 flex-1" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onPaneClick={() => {
            setSelectedId(null)
            setSelectedEdge(null)
            setWorkflowPanel(false)
          }}
          nodesDraggable={!sim}
          nodesConnectable={!sim}
          deleteKeyCode={['Backspace', 'Delete']}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
          minZoom={0.2}
          colorMode="system"
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          <Controls showInteractive={false} position="bottom-left" />
        </ReactFlow>

        {paletteOpen && (
          <FloatingPanel
            side="left"
            label="Node palette"
            title={
              attach ? (
                <span>
                  Add after <span className="text-muted-foreground">{attach.node}</span> →{' '}
                  <span style={{ color: TONE.success }}>{attach.port}</span>
                </span>
              ) : (
                'Add a node'
              )
            }
            onClose={() => {
              setPaletteOpen(false)
              setAttach(null)
            }}
          >
            <div className="p-2">
              {CATEGORY_ORDER.map((cat) => {
                const entries = catalog.data.nodes.filter((n) => n.category === cat.id)
                if (!entries.length) return null
                return (
                  <section key={cat.id} className="mb-3">
                    <h2 className="px-1.5 pb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                      {cat.label}
                    </h2>
                    {entries.map((entry) => {
                      const Icon = ICONS[entry.type]
                      return (
                        <button
                          key={entry.type}
                          type="button"
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.setData(DRAG_MIME, entry.type)
                            e.dataTransfer.effectAllowed = 'move'
                          }}
                          onClick={() => addNode(entry.type)}
                          className="flex w-full cursor-grab items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left hover:bg-accent"
                          title={`${entry.description} — drag onto the canvas, or click to add`}
                        >
                          <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-background">
                            <Icon className="size-4" style={{ color: cat.color }} strokeWidth={1.75} />
                          </span>
                          <span className="min-w-0">
                            <span className="block text-[12px] leading-tight font-medium">{entry.label}</span>
                            <span className="block truncate text-[10px] text-muted-foreground">{entry.description}</span>
                          </span>
                        </button>
                      )
                    })}
                  </section>
                )
              })}
              <section className="mb-1">
                <h2 className="px-1.5 pb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">Skills</h2>
                <Input
                  aria-label="Search skills"
                  placeholder="search skills…"
                  value={skillQuery}
                  onChange={(e) => setSkillQuery(e.target.value)}
                  className="mb-1 h-7 text-[12px]"
                />
                {skills.isPending ? (
                  <p className="px-1.5 text-[11px] text-muted-foreground">Loading skills…</p>
                ) : (
                  (skills.data ?? [])
                    .filter((sk) => {
                      const q = skillQuery.trim().toLowerCase()
                      return !q || sk.name.toLowerCase().includes(q) || (sk.description ?? '').toLowerCase().includes(q)
                    })
                    .slice(0, 40)
                    .map((sk) => (
                      <button
                        key={`${sk.source}:${sk.name}`}
                        type="button"
                        onClick={() => addNode('agent', undefined, sk.name)}
                        className="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1 text-left hover:bg-accent"
                        title={sk.description ?? sk.name}
                      >
                        <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-background text-[11px] text-muted-foreground">
                          /
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-[12px] leading-tight">{sk.name}</span>
                          {sk.description ? (
                            <span className="block truncate text-[10px] text-muted-foreground">{sk.description}</span>
                          ) : null}
                        </span>
                      </button>
                    ))
                )}
              </section>
            </div>
          </FloatingPanel>
        )}

        {selected ? (
          <FloatingPanel
            side="right"
            label="Inspector"
            title={selected.name ?? selected.id}
            onClose={() => setSelectedId(null)}
          >
            <Inspector
              key={selected.id}
              node={selected}
              graph={graph}
              onGraphEdit={edit}
              onChange={(next) => {
                edit((g) => updateNode(g, selected.id, next))
                if (next.id !== selected.id) setSelectedId(next.id)
              }}
              onDelete={() => {
                edit((g) => removeNode(g, selected.id))
                setSelectedId(null)
              }}
            />
          </FloatingPanel>
        ) : workflowPanel ? (
          <FloatingPanel side="right" label="Workflow settings" title="Workflow" onClose={() => setWorkflowPanel(false)}>
            <div className="space-y-4 p-4 text-[12px]">
              <Field label="description">
                <Textarea
                  value={description}
                  rows={3}
                  onChange={(e) => {
                    setDescription(e.target.value)
                    setDirty(true)
                  }}
                />
              </Field>
              {(issues.length > 0 || unwired.length > 0) && (
                <div className="space-y-1.5">
                  {issues.map((i) => (
                    <div key={i} className="flex gap-1.5 text-[11px]" style={{ color: TONE.failure }}>
                      <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
                      {i}
                    </div>
                  ))}
                  {unwired.length > 0 && (
                    <div className="text-[11px] text-muted-foreground">Unwired — end the run: {unwired.join(', ')}</div>
                  )}
                </div>
              )}
              <div>
                <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>YAML</span>
                  <button
                    type="button"
                    className="hover:text-foreground"
                    onClick={() => void navigator.clipboard?.writeText(graphYaml(name, description, graph))}
                  >
                    Copy
                  </button>
                </div>
                <pre className="max-h-64 overflow-auto rounded-md bg-muted/40 p-2 text-[10.5px] leading-relaxed">
                  {graphYaml(name, description, graph)}
                </pre>
              </div>
              <Field label="import YAML (v1 or v2)">
                <Textarea
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                  rows={4}
                  className="font-mono text-[11px]"
                  placeholder="paste a workflow file…"
                />
              </Field>
              <Button
                size="sm"
                variant="outline"
                disabled={!importText.trim() || importYaml.isPending}
                onClick={() => importYaml.mutate()}
              >
                Import
              </Button>
              <Field label="build from a description — replaces the canvas">
                <Textarea
                  value={planText}
                  onChange={(e) => setPlanText(e.target.value)}
                  rows={3}
                  placeholder="implement, run the tests, then review…"
                />
              </Field>
              <Button size="sm" variant="outline" disabled={!planText.trim() || autoPlan.isPending} onClick={() => autoPlan.mutate()}>
                {autoPlan.isPending ? 'Building…' : 'Build workflow'}
              </Button>
              {opened?.source === 'file' && (
                <div className="border-t border-border pt-3">
                  <Button
                    size="sm"
                    variant="danger-ghost"
                    disabled={del.isPending}
                    onClick={() => setConfirm({ kind: 'delete', name: opened.name })}
                  >
                    <Trash2Icon /> Delete workflow
                  </Button>
                </div>
              )}
            </div>
          </FloatingPanel>
        ) : null}

        {sim && (
          <div className="absolute bottom-4 left-1/2 z-20 w-[min(520px,90%)] -translate-x-1/2 rounded-xl border border-border bg-card/95 p-3 shadow-xl backdrop-blur">
            {sim.finished || !cursorNode ? (
              <div className="flex items-center gap-2 text-[13px]">
                <CheckCircle2Icon className="size-4" style={{ color: sim.finished === 'failed' ? TONE.failure : TONE.success }} />
                Run ends <b>{sim.finished}</b> after {sim.taken.length} steps.
                <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSim(startSim(graph))}>
                  <RotateCcwIcon /> Restart
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[12px] text-muted-foreground">
                  <b className="text-foreground">{cursorNode.name ?? cursorNode.id}</b> ends with
                </span>
                {(cursorNode.type === 'fork' ? ['done', 'failed'] : portsOf(cursorNode)).map((p) => (
                  <Button
                    key={p}
                    size="sm"
                    variant="outline"
                    style={{ color: TONE[cursorNode.type === 'fork' ? (p === 'failed' ? 'failure' : 'success') : portTone(cursorNode, p)] }}
                    onClick={() => setSim((s) => (s ? simStep(graph, s, cursorNode.id, p) : s))}
                  >
                    {cursorNode.type === 'fork' ? (p === 'done' ? 'all branches done' : 'a branch failed') : p}
                  </Button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent data-slot="wg-confirm-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.kind === 'overwrite'
                ? `“${name.trim()}” already exists`
                : confirm?.kind === 'shadow'
                  ? `Replace the built-in “${name.trim()}”?`
                  : confirm?.kind === 'delete'
                    ? `Delete “${confirm.name}”?`
                    : 'Discard unsaved changes?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === 'overwrite'
                ? 'Saving replaces the existing workflow file — including a v1 file of the same name. There is no undo.'
                : confirm?.kind === 'shadow'
                  ? 'A saved file with a built-in name takes its place for every task in this repository, including tasks that use the default. Rename it to keep the built-in; delete the file to bring it back.'
                  : confirm?.kind === 'delete'
                    ? 'This removes the workflow file from the repository. Tasks already started with it keep running; there is no undo.'
                    : 'The edits on this canvas have not been saved.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              data-slot="wg-confirm-action"
              onClick={() => {
                if (confirm?.kind === 'overwrite') save.mutate(true)
                else if (confirm?.kind === 'shadow') save.mutate(false)
                else if (confirm?.kind === 'delete') del.mutate(confirm.name)
                else if (confirm?.kind === 'discard') {
                  setDirty(false)
                  void navigate(confirm.to)
                }
                setConfirm(null)
              }}
            >
              {confirm?.kind === 'overwrite'
                ? 'Overwrite'
                : confirm?.kind === 'shadow'
                  ? 'Replace built-in'
                  : confirm?.kind === 'delete'
                    ? 'Delete'
                    : 'Discard'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** The agent's skill: a pick from the repo's skills, keeping any name the list does not know
 *  (a team skill not cached yet, or a file workflow from another repo) instead of erasing it. */
function SkillField({ value, onChange }: { value: string | undefined; onChange: (skill: string | undefined) => void }) {
  const skills = useSkills()
  const names = (skills.data ?? []).map((s) => s.name)
  const known = value === undefined || names.includes(value)
  return (
    <Field label="skill">
      <select
        className="w-full rounded-md border border-input bg-card px-2 py-1 text-[12px] shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || undefined)}
      >
        <option value="">no skill</option>
        {!known && <option value={value}>{value} (not in this repo)</option>}
        {names.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </Field>
  )
}

/** A comma-separated list edited as text, committed on blur. */
function ListField({ label, value, onChange }: { label: string; value: string[] | undefined; onChange: (v: string[] | undefined) => void }) {
  return (
    <Field label={label}>
      <Input
        defaultValue={value?.join(', ') ?? ''}
        onBlur={(e) => {
          const list = e.target.value.split(',').map((v) => v.trim()).filter(Boolean)
          onChange(list.length ? list : undefined)
        }}
        className="h-8"
      />
    </Field>
  )
}

/** A saved workflow picked by name — the catalog the task composer offers. */
function WorkflowSelect({
  label,
  value,
  optional,
  onChange,
}: {
  label: string
  value: string | undefined
  optional?: boolean
  onChange: (name: string | undefined) => void
}) {
  const workflows = useWorkflows()
  const names = (workflows.data?.workflows ?? []).map((w) => w.name)
  return (
    <select
      aria-label={label}
      className="w-full rounded-md border border-input bg-card px-2 py-1 text-[12px] shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || undefined)}
    >
      {optional ? <option value="">one agent step</option> : null}
      {value && !names.includes(value) ? <option value={value}>{value} (not found)</option> : null}
      {names.map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </select>
  )
}

type ConditionValue = Extract<WorkflowGraphNode, { type: 'if' }>['condition']

/** An `if` node's condition: pick what to look at, then the fields that kind needs. */
function ConditionEditor({ condition, onChange }: { condition: ConditionValue; onChange: (c: ConditionValue) => void }) {
  const numericOps = ['>', '>=', '<', '<=', '=='] as const
  const outputOps = ['equals', 'not-equals', 'contains', '>', '>=', '<', '<='] as const
  const switchKind = (kind: ConditionValue['kind']) => {
    switch (kind) {
      case 'diff-lines':
      case 'diff-files':
        return onChange({ kind, op: '>', value: kind === 'diff-lines' ? 500 : 20 })
      case 'paths-changed':
        return onChange({ kind, glob: 'packages/web/**' })
      case 'output':
        return onChange({ kind, ref: 'review.verdict', op: 'equals', value: 'approve' })
      case 'branch':
        return onChange({ kind, op: 'equals', value: 'main' })
    }
  }
  return (
    <>
      <Field label="look at">
        <select className="w-full rounded-md border border-input bg-card px-2 py-1 text-[12px] shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" value={condition.kind} onChange={(e) => switchKind(e.target.value as ConditionValue['kind'])}>
          <option value="diff-lines">the task's diff — changed lines</option>
          <option value="diff-files">the task's diff — changed files</option>
          <option value="paths-changed">which paths changed (glob)</option>
          <option value="output">another node's output</option>
          <option value="branch">the base branch</option>
        </select>
      </Field>
      {(condition.kind === 'diff-lines' || condition.kind === 'diff-files') && (
        <div className="grid grid-cols-[5rem_1fr] gap-2">
          <select className="w-full rounded-md border border-input bg-card px-2 py-1 text-[12px] shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" aria-label="operator" value={condition.op} onChange={(e) => onChange({ ...condition, op: e.target.value as (typeof numericOps)[number] })}>
            {numericOps.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
          <Input type="number" min={0} aria-label="threshold" value={condition.value} onChange={(e) => onChange({ ...condition, value: Math.max(0, Number(e.target.value) || 0) })} className="h-8" />
        </div>
      )}
      {condition.kind === 'paths-changed' && (
        <Field label="glob — * within a folder, ** across folders">
          <Input value={condition.glob} onChange={(e) => onChange({ ...condition, glob: e.target.value })} className="h-8 font-mono text-[11px]" />
        </Field>
      )}
      {condition.kind === 'output' && (
        <>
          <Field label="output — <node>.<field>">
            <Input value={condition.ref} onChange={(e) => onChange({ ...condition, ref: e.target.value.trim() })} className="h-8 font-mono text-[11px]" />
          </Field>
          <div className="grid grid-cols-[7rem_1fr] gap-2">
            <select className="w-full rounded-md border border-input bg-card px-2 py-1 text-[12px] shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" aria-label="operator" value={condition.op} onChange={(e) => onChange({ ...condition, op: e.target.value as (typeof outputOps)[number] })}>
              {outputOps.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            <Input aria-label="value" value={String(condition.value)} onChange={(e) => onChange({ ...condition, value: e.target.value })} className="h-8" />
          </div>
        </>
      )}
      {condition.kind === 'branch' && (
        <div className="grid grid-cols-[7rem_1fr] gap-2">
          <select className="w-full rounded-md border border-input bg-card px-2 py-1 text-[12px] shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" aria-label="operator" value={condition.op} onChange={(e) => onChange({ ...condition, op: e.target.value as 'equals' | 'matches' })}>
            <option value="equals">equals</option>
            <option value="matches">matches glob</option>
          </select>
          <Input aria-label="branch" value={condition.value} onChange={(e) => onChange({ ...condition, value: e.target.value })} className="h-8 font-mono text-[11px]" />
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">Leaves by true or false. Diff and paths are this task's own changes vs its base.</p>
    </>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

/** A duration edited in minutes, stored in ms (min 1 minute — the server's floor). */
function MinutesField({
  label,
  value,
  optional,
  onChange,
}: {
  label: string
  value: number | undefined
  optional?: boolean
  onChange: (ms: number | undefined) => void
}) {
  return (
    <Field label={label}>
      <Input
        type="number"
        min={1}
        value={value ? Math.round(value / 60_000) : ''}
        placeholder={optional ? 'no timeout' : undefined}
        onChange={(e) => {
          const minutes = Math.floor(Number(e.target.value))
          onChange(minutes >= 1 ? minutes * 60_000 : undefined)
        }}
        className="h-8"
      />
    </Field>
  )
}

const OUTPUTS: Record<GraphNodeType, string[]> = {
  start: [],
  end: [],
  loop: ['iteration', 'max'],
  agent: ['summary', 'verdict', 'costUsd'],
  check: ['exitCode', 'output'],
  'gate.human': ['comment'],
  'ask-user': ['answer'],
  dispatch: ['runId', 'status', 'summary'],
  'git.commit': ['sha'],
  'github.draft-pr': ['url', 'number'],
  'github.wait-ci': ['status'],
  'github.pr-comment': [],
  fork: ['runIds'],
  join: ['succeeded', 'failed'],
  workflow: ['runId', 'status', 'summary'],
  if: ['result', 'value'],
  'git.push': [],
  'git.sync-base': ['conflicts'],
  'github.pr-update': [],
  'github.issue-comment': ['issue'],
  'notify.webhook': ['status'],
}

/** A node's template outputs — a fork's agent reports as a subtask (`runId`, `status`, `summary`). */
function outputsOf(node: WorkflowGraphNode, branches?: ReadonlySet<string>): string[] {
  if (node.type === 'agent' && branches?.has(node.id)) return ['runId', 'status', 'summary']
  return OUTPUTS[node.type]
}

function Inspector({
  node,
  graph,
  onChange,
  onGraphEdit,
  onDelete,
}: {
  node: WorkflowGraphNode
  graph: WorkflowGraph
  onChange: (next: WorkflowGraphNode) => void
  /** Edits that reach past this node (a fork's branch count adds or drops agents). */
  onGraphEdit: (fn: (g: WorkflowGraph) => WorkflowGraph) => void
  onDelete: () => void
}) {
  const branches = forkBranchIds(graph)
  const isBranch = node.type === 'agent' && branches.has(node.id)
  // The id is committed on blur so a half-typed rename never rewires the graph mid-word.
  const [draftId, setDraftId] = useState(node.id)
  const set = (patch: Record<string, unknown>) => {
    const next: Record<string, unknown> = { ...node, ...patch }
    for (const [k, v] of Object.entries(patch)) if (v === undefined || v === '') delete next[k]
    onChange(next as WorkflowGraphNode)
  }

  return (
    <div className="space-y-3 p-4 text-[12px]">
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase text-muted-foreground">{node.type} node</span>
        <Button size="sm" variant="danger-ghost" onClick={onDelete} aria-label="Delete node">
          <Trash2Icon />
        </Button>
      </div>
      <Field label="id">
        <Input
          value={draftId}
          onChange={(e) => setDraftId(e.target.value)}
          onBlur={() => {
            const id = draftId.trim()
            if (!id || id === node.id) return setDraftId(node.id)
            if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) || graph.nodes.some((n) => n.id === id)) {
              toast(`“${id}” is taken or not a valid id (letters, digits, - and _).`, { tone: 'danger' })
              return setDraftId(node.id)
            }
            onChange({ ...node, id })
          }}
          className="h-8"
        />
      </Field>
      <Field label="name">
        <Input value={node.name ?? ''} onChange={(e) => set({ name: e.target.value })} className="h-8" />
      </Field>

      {node.type === 'agent' && (
        <>
          <Field label="prompt — {{task}}, {{nodes.<id>.<field>}}">
            <Textarea value={node.prompt ?? ''} rows={5} className="font-mono text-[11px]" onChange={(e) => set({ prompt: e.target.value })} />
          </Field>
          <SkillField value={node.skill} onChange={(skill) => set({ skill })} />
          <div className="grid grid-cols-2 gap-2">
            <Field label="runner">
              <select className="w-full rounded-md border border-input bg-card px-2 py-1 text-[12px] shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" value={node.runner ?? ''} onChange={(e) => set({ runner: e.target.value || undefined })}>
                <option value="">task default</option>
                {RUNNERS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="model">
              <Input value={node.model ?? ''} onChange={(e) => set({ model: e.target.value })} className="h-8" />
            </Field>
          </div>
          {isBranch ? (
            <>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="size-3.5 accent-primary"
                  checked={node.review ?? false}
                  onChange={(e) => set({ review: e.target.checked || undefined })}
                />
                reviewer — judges the task branch, never implements
              </label>
              <Field label="budget USD — carved from this run">
                <Input
                  type="number"
                  min={0}
                  step={0.5}
                  value={node.budgetUsd ?? ''}
                  onChange={(e) => set({ budgetUsd: Number(e.target.value) > 0 ? Number(e.target.value) : undefined })}
                  className="h-8"
                />
              </Field>
              <p className="rounded-md bg-accent/50 p-2 text-[11px] text-muted-foreground">
                A fork branch: runs as its own subtask at the same time as the other branches — a fresh session in its
                own worktree, starting from the task's work so far.
              </p>
            </>
          ) : (
            <>
              <Field label="verdicts — comma-separated, each becomes a port">
                <Input
                  defaultValue={node.verdicts?.join(', ') ?? ''}
                  onBlur={(e) => {
                    const list = e.target.value.split(',').map((v) => v.trim()).filter(Boolean)
                    set({ verdicts: list.length ? list : undefined })
                  }}
                  className="h-8"
                  placeholder="approve, changes"
                />
              </Field>
              <Field label="session">
                <select
                  className="w-full rounded-md border border-input bg-card px-2 py-1 text-[12px] shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  value={node.session?.continue ?? ''}
                  onChange={(e) => set({ session: e.target.value ? { continue: e.target.value } : undefined })}
                >
                  <option value="">fresh session</option>
                  {graph.nodes
                    .filter((n) => n.type === 'agent' && n.id !== node.id)
                    .map((n) => (
                      <option key={n.id} value={n.id}>
                        continue {n.name ?? n.id}
                      </option>
                    ))}
                </select>
              </Field>
            </>
          )}
          {node.verdicts?.length ? (
            <p className="rounded-md bg-accent/50 p-2 text-[11px] text-muted-foreground">
              The agent ends its turn with {node.verdicts.map((v) => `CEZ:VERDICT ${v}`).join(' or ')}. No verdict → one
              reminder, then <span style={{ color: TONE.failure }}>failed</span>.
            </p>
          ) : null}
        </>
      )}

      {node.type === 'check' && (
        <Field label="command — runs in the worktree; exit 0 passes">
          <Textarea value={node.command} rows={3} className="font-mono text-[11px]" onChange={(e) => set({ command: e.target.value })} />
        </Field>
      )}

      {node.type === 'loop' && (
        <Field label="max iterations — repeat while within, then exhausted">
          <Input
            type="number"
            min={1}
            value={node.max}
            onChange={(e) => set({ max: Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
            className="h-8"
          />
        </Field>
      )}

      {node.type === 'gate.human' && (
        <>
          <Field label="message — shown on the approve / reject card">
            <Textarea value={node.message} rows={3} onChange={(e) => set({ message: e.target.value })} />
          </Field>
          <MinutesField label="timeout (minutes, optional) — adds a timeout port" value={node.timeoutMs} optional onChange={(ms) => set({ timeoutMs: ms })} />
          <p className="rounded-md bg-accent/50 p-2 text-[11px] text-muted-foreground">
            The run waits without holding a slot. A reply starting with “approve” takes approve; anything else takes
            reject and becomes <code>{`{{nodes.${node.id}.comment}}`}</code>.
          </p>
        </>
      )}

      {node.type === 'ask-user' && (
        <>
          <Field label="question">
            <Textarea value={node.question} rows={3} onChange={(e) => set({ question: e.target.value })} />
          </Field>
          <Field label="options — comma-separated, optional (free text always works)">
            <Input
              defaultValue={node.options?.join(', ') ?? ''}
              onBlur={(e) => {
                const list = e.target.value.split(',').map((v) => v.trim()).filter(Boolean)
                set({ options: list.length ? list : undefined })
              }}
              className="h-8"
            />
          </Field>
          <MinutesField label="timeout (minutes, optional) — adds a timeout port" value={node.timeoutMs} optional onChange={(ms) => set({ timeoutMs: ms })} />
        </>
      )}

      {node.type === 'dispatch' && (
        <>
          <Field label="objective — {{task}}, {{nodes.<id>.<field>}}">
            <Textarea value={node.prompt} rows={4} className="font-mono text-[11px]" onChange={(e) => set({ prompt: e.target.value })} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="runner">
              <select
                className="w-full rounded-md border border-input bg-card px-2 py-1 text-[12px] shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                value={node.runner ?? ''}
                onChange={(e) => set({ runner: e.target.value || undefined })}
              >
                <option value="">task default</option>
                {RUNNERS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="budget USD">
              <Input
                type="number"
                min={0}
                step={0.5}
                value={node.budgetUsd ?? ''}
                onChange={(e) => set({ budgetUsd: Number(e.target.value) > 0 ? Number(e.target.value) : undefined })}
                className="h-8"
              />
            </Field>
          </div>
        </>
      )}

      {node.type === 'git.commit' && (
        <Field label="commit message — commits everything in the worktree">
          <Input value={node.message} onChange={(e) => set({ message: e.target.value })} className="h-8" />
        </Field>
      )}

      {node.type === 'github.draft-pr' && (
        <Field label="title — optional, defaults to the task title">
          <Input value={node.title ?? ''} onChange={(e) => set({ title: e.target.value })} className="h-8" />
        </Field>
      )}

      {node.type === 'github.pr-comment' && (
        <Field label="comment body">
          <Textarea value={node.body} rows={3} onChange={(e) => set({ body: e.target.value })} />
        </Field>
      )}

      {node.type === 'github.wait-ci' && (
        <>
          <MinutesField label="timeout (minutes) — required" value={node.timeoutMs} onChange={(ms) => set({ timeoutMs: ms ?? 60 * 60_000 })} />
          <Field label="poll every (seconds)">
            <Input
              type="number"
              min={10}
              value={Math.round(node.pollMs / 1000)}
              onChange={(e) => set({ pollMs: Math.max(10, Math.floor(Number(e.target.value) || 60)) * 1000 })}
              className="h-8"
            />
          </Field>
        </>
      )}

      {node.type === 'fork' && (
        <>
          <Field label="branches — one agent each, all at once">
            <select
              className="w-full rounded-md border border-input bg-card px-2 py-1 text-[12px] shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              value={node.branches}
              onChange={(e) => onGraphEdit((g) => setForkBranches(g, node.id, Number(e.target.value)))}
            >
              {[2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n} agents
                </option>
              ))}
            </select>
          </Field>
          <p className="text-[11px] text-muted-foreground">
            Each branch is the agent it is wired to: set its prompt, runner and budget there. They run as subtasks in
            their own worktrees (at most 4 at once) and meet at the join.
          </p>
        </>
      )}

      {node.type === 'join' && (
        <Field label="wait for">
          <select
            className="w-full rounded-md border border-input bg-card px-2 py-1 text-[12px] shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            value={node.wait}
            onChange={(e) => set({ wait: e.target.value })}
          >
            <option value="all">every branch (done only if all succeed)</option>
            <option value="any">the first to succeed (the rest are cancelled)</option>
          </select>
        </Field>
      )}

      {node.type === 'workflow' && (
        <>
          <WorkflowSelect label="workflow to run" value={node.workflow} onChange={(workflow) => set({ workflow: workflow ?? 'quick-task' })} />
          <Field label="task for it — {{task}}, {{nodes.<id>.<field>}}">
            <Textarea value={node.prompt ?? ''} placeholder="{{task}}" rows={3} className="font-mono text-[11px]" onChange={(e) => set({ prompt: e.target.value })} />
          </Field>
          <p className="text-[11px] text-muted-foreground">Runs as a subtask in its own worktree; this node waits for it.</p>
        </>
      )}

      {node.type === 'git.push' && (
        <p className="text-[11px] text-muted-foreground">Commits anything pending, then pushes the task branch to origin.</p>
      )}

      {node.type === 'git.sync-base' && (
        <p className="text-[11px] text-muted-foreground">
          Merges the latest base branch into the task. On a conflict the merge is left in progress and the node leaves by{' '}
          <span style={{ color: TONE.failure }}>conflict</span> — wire it to an agent to resolve it;{' '}
          <code>{`{{nodes.${node.id}.conflicts}}`}</code> lists the files.
        </p>
      )}

      {node.type === 'github.pr-update' && (
        <>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={node.ready ?? false} onChange={(e) => set({ ready: e.target.checked || undefined })} />
            <span>mark ready for review</span>
          </label>
          <ListField label="add labels — comma-separated" value={node.addLabels} onChange={(addLabels) => set({ addLabels })} />
          <ListField label="request reviewers — comma-separated logins" value={node.reviewers} onChange={(reviewers) => set({ reviewers })} />
        </>
      )}

      {node.type === 'github.issue-comment' && (
        <>
          <Field label="issue number — empty = the task's own issue">
            <Input
              type="number"
              min={1}
              value={node.issue ?? ''}
              onChange={(e) => set({ issue: Number(e.target.value) > 0 ? Math.floor(Number(e.target.value)) : undefined })}
              className="h-8"
            />
          </Field>
          <Field label="comment">
            <Textarea value={node.body} rows={3} onChange={(e) => set({ body: e.target.value })} />
          </Field>
        </>
      )}

      {node.type === 'notify.webhook' && (
        <>
          <Field label="URL (http/https)">
            <Input value={node.url} onChange={(e) => set({ url: e.target.value })} className="h-8 font-mono text-[11px]" />
          </Field>
          <Field label="message — sent as JSON text">
            <Textarea value={node.body ?? ''} rows={3} onChange={(e) => set({ body: e.target.value })} />
          </Field>
          <p className="text-[11px] text-muted-foreground">
            Only runs when the server has <code>CEZ_WORKFLOW_WEBHOOKS=1</code>; otherwise it leaves by failed.
          </p>
        </>
      )}

      {node.type === 'if' && <ConditionEditor condition={node.condition} onChange={(condition) => set({ condition })} />}

      {node.type === 'end' && (
        <Field label="run status">
          <select className="w-full rounded-md border border-input bg-card px-2 py-1 text-[12px] shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" value={node.status} onChange={(e) => set({ status: e.target.value })}>
            <option value="success">success</option>
            <option value="failed">failed</option>
          </select>
        </Field>
      )}

      <div>
        <div className="mb-1 text-[11px] uppercase text-muted-foreground">Output ports</div>
        {portsOf(node).map((p) => (
          <div key={p} className="flex justify-between py-0.5">
            <span style={{ color: TONE[portTone(node, p)] }}>{p}</span>
            <span className="text-muted-foreground">{targetOf(graph, node.id, p) ?? 'ends run'}</span>
          </div>
        ))}
      </div>
      {outputsOf(node, branches).length > 0 && (
        <div>
          <div className="mb-1 text-[11px] uppercase text-muted-foreground">Outputs for templates</div>
          {outputsOf(node, branches).map((o) => (
            <code key={o} className="block text-[11px]">{`{{nodes.${node.id}.${o}}}`}</code>
          ))}
        </div>
      )}
    </div>
  )
}
