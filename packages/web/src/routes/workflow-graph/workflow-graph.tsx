import '@xyflow/react/dist/style.css'

import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
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
  MoreHorizontalIcon,
  PlayIcon,
  PlusIcon,
  SaveIcon,
  Settings2Icon,
  SquareIcon,
  Trash2Icon,
  WorkflowIcon,
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
import { Page } from '@/components/page'
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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { Spinner } from '@/components/ui/spinner'
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
  skillStackOfGraph,
  stepsFromPlan,
  parseFrom,
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
import { WorkflowsSidebar } from '../workflows/workflows-sidebar'
import { CanvasControls } from './canvas-controls'
import { backLanes, CANVAS_THEME, categoryColor, TYPE_LABEL, edgeStyle, edgeTypes, GraphNodeView, ICONS, type InnerStep, TILE, TONE, WIDE_WIDTH } from './graph-node'
import { Inspector } from './inspector'
import { DRAG_MIME, NodePalette } from './node-palette'
import { SimBar } from './sim-bar'
import { WorkflowPanel } from './workflow-panel'

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
  subtitle,
  icon,
  onClose,
  children,
  label,
}: {
  side: 'left' | 'right'
  title: ReactNode
  /** One quiet line under the title — what kind of thing the panel is about. */
  subtitle?: ReactNode
  /** Leads the header: the node's own icon tile. */
  icon?: ReactNode
  onClose: () => void
  children: ReactNode
  label: string
}) {
  return (
    <aside
      aria-label={label}
      className={cn(
        'absolute top-3 bottom-3 z-10 flex max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-lg',
        side === 'left' ? 'left-3 w-80' : 'right-3 w-[23rem]',
      )}
    >
      <div className="flex min-h-12 shrink-0 items-center gap-2.5 border-b border-border/70 py-2 pr-1.5 pl-3.5">
        {icon}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] leading-tight font-semibold text-foreground">{title}</div>
          {subtitle ? <div className="truncate text-xs leading-tight text-muted-foreground">{subtitle}</div> : null}
        </div>
        <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label={`Close ${label.toLowerCase()}`}>
          <XIcon />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
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
  /** The right panel: the selected node, the workflow's own settings, or nothing. */
  const [workflowPanel, setWorkflowPanel] = useState(false)
  const [sim, setSim] = useState<SimState | null>(null)
  const [issues, setIssues] = useState<string[]>([])
  // True whenever `issues` does not yet reflect the current graph — the debounce below hasn't
  // fired yet, or its request is still in flight. Gates Save so it can't fire against a graph
  // that hasn't actually been validated.
  const [validating, setValidating] = useState(false)
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
    // Stale issues from the PREVIOUS workflow must not leave Save wrongly enabled or disabled
    // for the ~350ms before the debounced validation below re-runs against the new graph.
    setIssues([])
    setValidating(true)
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
    setValidating(true)
    const t = setTimeout(() => {
      validateWorkflowGraph({ nodes: graphNodes, edges: graphEdges })
        .then((r) => setIssues(r.issues))
        .catch((err: unknown) => setIssues([err instanceof Error ? err.message : String(err)]))
        .finally(() => setValidating(false))
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
        edit((g) => {
          const parsed = parseFrom(from, g.nodes)
          return parsed ? disconnect(g, parsed.node, parsed.port) : g
        })
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

  // The list of workflows lives in the contextual sidebar; opening another one from a canvas
  // with unsaved edits asks first, exactly as the toolbar's picker did.
  const sidebar = (
    <WorkflowsSidebar
      activeName={routeName}
      onOpen={(to) => {
        if (!dirty) return true
        setConfirm({ kind: 'discard', to })
        return false
      }}
    />
  )

  if (catalog.isPending || (routeName && workflows.isPending)) {
    return (
      <>
        {sidebar}
        <WorkflowsLoading />
      </>
    )
  }
  if (catalog.isError) {
    return (
      <>
      {sidebar}
      <Empty data-slot="centered-state" className="min-h-full flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon"><AlertTriangleIcon /></EmptyMedia>
          <EmptyTitle>The node catalog did not load</EmptyTitle>
          <EmptyDescription>{catalog.error instanceof Error ? catalog.error.message : 'Try again in a moment.'}</EmptyDescription>
        </EmptyHeader>
      </Empty>
      </>
    )
  }

  const selected = graph.nodes.find((n) => n.id === selectedId) ?? null
  const cursorNode = sim?.cursor ? graph.nodes.find((n) => n.id === sim.cursor) : undefined
  const unwired = unwiredPorts(graph)
  const canSave = name.trim().length > 0 && issues.length === 0 && !validating && !save.isPending
  // Re-saving the file this canvas was opened from overwrites silently; the confirm is only for
  // a name that collides with ANOTHER file (or a built-in-shadowing new one).
  const opened = routeName ? workflows.data?.workflows.find((w) => w.name === routeName) : undefined
  const savingOwnFile = opened?.source === 'file' && name.trim() === routeName
  // A file named like a built-in (`quick-task`) REPLACES it for every task in the repo.
  const shadowsBuiltIn = Boolean(workflows.data?.workflows.some((w) => w.name === name.trim() && w.source === 'built-in'))

  const yaml = graphYaml(name, description, graph)
  // Show a node: select it and bring it to the middle of the canvas.
  const reveal = (id: string) => {
    const at = graph.layout?.[id]
    setWorkflowPanel(false)
    setSelectedId(id)
    if (at) void flow.setCenter(at.x + TILE, at.y + TILE / 2, { zoom: flow.getZoom(), duration: 250 })
  }
  // An issue names its node in quotes; the first one that is a node on this canvas is the one shown.
  const revealIssue = (issue: string) => {
    for (const match of issue.matchAll(/"([A-Za-z0-9_-]+)"/g)) {
      const id = match[1] as string
      if (graph.nodes.some((n) => n.id === id)) return reveal(id)
    }
  }
  const openWorkflowPanel = () => {
    setSelectedId(null)
    setWorkflowPanel(true)
  }
  const tidy = () => {
    edit((g) => ({ ...g, layout: autoLayout(g) }))
    pendingFit.current = true
  }
  const SelectedIcon = selected ? ICONS[selected.type] : null
  const selectedColor = selected ? categoryColor(selected.type) : undefined

  return (
    <Page width="full" data-route="workflows" className="h-full min-h-0">
      {sidebar}
      {/* The toolbar: what this workflow is and what state it is in on the left; what you do to it
          on the right, ending in the one primary — Save. */}
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border bg-background px-3 py-1.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <WorkflowIcon aria-hidden="true" className="size-4" />
        </span>
        <Input
          aria-label="Workflow name"
          placeholder="Name this workflow"
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            setDirty(true)
          }}
          className="h-8 w-56 max-w-full border-transparent bg-transparent px-2 text-sm font-semibold shadow-none hover:bg-muted focus-visible:bg-card"
        />
        {opened?.source === 'built-in' ? (
          <Badge
            variant="secondary"
            className="font-normal"
            title="A built-in is a template: saving writes your own copy under the name on the left."
          >
            Template
          </Badge>
        ) : null}
        {dirty && (
          <Badge variant="outline" className="gap-1.5 font-normal text-muted-foreground" title="Unsaved changes" aria-label="Unsaved changes">
            <span className="size-1.5 rounded-full bg-pending" />
            Unsaved
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-slot="validation-chip"
                className={cn('px-2 text-xs', issues.length ? 'text-danger hover:text-danger' : 'font-normal')}
                title={issues.length ? 'What the server says is wrong' : 'The server validated this workflow'}
              >
                {validating ? (
                  <Spinner className="size-3.5" />
                ) : issues.length ? (
                  <AlertTriangleIcon className="size-3.5" />
                ) : (
                  <CheckCircle2Icon className="size-3.5 text-success" />
                )}
                {issues.length ? `${issues.length} issue${issues.length > 1 ? 's' : ''}` : 'Valid'}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 p-0">
              <div className="border-b border-border/70 px-3.5 py-2.5">
                <p className="text-[13px] font-semibold text-foreground">
                  {issues.length ? `${issues.length} issue${issues.length > 1 ? 's' : ''} to fix before saving` : 'This workflow is valid'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {issues.length ? 'Pick one to see its node.' : 'The server checked every node and edge.'}
                </p>
              </div>
              {issues.length > 0 ? (
                <ul className="max-h-64 overflow-y-auto p-1">
                  {issues.map((issue) => (
                    <li key={issue}>
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-auto w-full items-start justify-start gap-2 px-2.5 py-2 text-left text-xs font-normal whitespace-normal text-foreground"
                        onClick={() => revealIssue(issue)}
                      >
                        <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" style={{ color: TONE.failure }} />
                        <span className="min-w-0 break-words">{issue}</span>
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {unwired.length > 0 ? (
                <p className="border-t border-border/70 px-3.5 py-2.5 text-xs text-pretty text-muted-foreground">
                  Unwired ports end the run: <span className="font-mono text-[11px]">{unwired.join(', ')}</span>
                </p>
              ) : null}
            </PopoverContent>
          </Popover>
          <Separator orientation="vertical" className="mx-0.5 data-[orientation=vertical]:h-5" />
          <Button
            size="sm"
            variant={paletteOpen ? 'secondary' : 'outline'}
            aria-pressed={paletteOpen}
            disabled={Boolean(sim)}
            onClick={() => {
              setAttach(null)
              setPaletteOpen((o) => !o)
            }}
          >
            <PlusIcon /> Add node
          </Button>
          <Button size="sm" variant={sim ? 'secondary' : 'outline'} aria-pressed={Boolean(sim)} onClick={() => setSim((s) => (s ? null : startSim(graph)))}>
            {sim ? <SquareIcon /> : <PlayIcon />} {sim ? 'Stop' : 'Simulate'}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant={workflowPanel ? 'secondary' : 'ghost'} aria-label="More workflow actions" title="More">
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuItem
                aria-label="Workflow settings"
                title="Workflow settings, YAML and import"
                onSelect={() => (workflowPanel ? setWorkflowPanel(false) : openWorkflowPanel())}
              >
                <Settings2Icon />
                {workflowPanel ? 'Hide workflow details' : 'Details, YAML and import'}
              </DropdownMenuItem>
              <DropdownMenuItem aria-label="Tidy up" onSelect={tidy}>
                <LayoutGridIcon />
                Tidy up the layout
              </DropdownMenuItem>
              <DropdownMenuItem aria-label="Export YAML" onSelect={exportYaml}>
                <DownloadIcon />
                Export as a .yaml file
              </DropdownMenuItem>
              {opened?.source === 'file' ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={del.isPending}
                    onSelect={() => setConfirm({ kind: 'delete', name: opened.name })}
                  >
                    <Trash2Icon />
                    Delete workflow
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            size="sm"
            variant="primary"
            disabled={!canSave}
            title={!name.trim() ? 'Name the workflow to save it' : issues.length ? 'Fix the issues to save' : undefined}
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
          style={CANVAS_THEME}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.25} />
          <CanvasControls onTidy={sim ? undefined : tidy} />
        </ReactFlow>

        {paletteOpen && (
          <FloatingPanel
            side="left"
            label="Node palette"
            title="Add a node"
            subtitle="Click to add, or drag onto the canvas"
            onClose={() => {
              setPaletteOpen(false)
              setAttach(null)
            }}
          >
            <NodePalette
              nodes={catalog.data.nodes}
              skills={skills.data ?? []}
              skillsLoading={skills.isPending}
              attach={attach}
              onClearAttach={() => setAttach(null)}
              onAdd={(type, skill) => addNode(type, undefined, skill)}
            />
          </FloatingPanel>
        )}

        {selected ? (
          <FloatingPanel
            side="right"
            label="Inspector"
            title={selected.name ?? selected.id}
            subtitle={`${TYPE_LABEL[selected.type]} node`}
            icon={
              SelectedIcon ? (
                <span
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg"
                  style={{ background: `color-mix(in oklab, ${selectedColor} 12%, transparent)` }}
                >
                  <SelectedIcon className="size-4" style={{ color: selectedColor }} strokeWidth={1.75} />
                </span>
              ) : undefined
            }
            onClose={() => setSelectedId(null)}
          >
            <Inspector
              key={selected.id}
              node={selected}
              graph={graph}
              onGraphEdit={edit}
              onSelectNode={reveal}
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
          <FloatingPanel
            side="right"
            label="Workflow settings"
            title={name.trim() || 'Untitled workflow'}
            subtitle="Workflow"
            icon={
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <WorkflowIcon className="size-4" strokeWidth={1.75} />
              </span>
            }
            onClose={() => setWorkflowPanel(false)}
          >
            <WorkflowPanel
              description={description}
              onDescription={(value) => {
                setDescription(value)
                setDirty(true)
              }}
              issues={issues}
              unwired={unwired}
              onIssue={revealIssue}
              yaml={yaml}
              onExport={exportYaml}
              importText={importText}
              onImportText={setImportText}
              onImport={() => importYaml.mutate()}
              importing={importYaml.isPending}
              planText={planText}
              onPlanText={setPlanText}
              onPlan={() => autoPlan.mutate()}
              planning={autoPlan.isPending}
              onDelete={opened?.source === 'file' ? () => setConfirm({ kind: 'delete', name: opened.name }) : undefined}
              deleting={del.isPending}
            />
          </FloatingPanel>
        ) : null}

        {sim && (
          <SimBar
            cursor={sim.finished ? undefined : cursorNode}
            finished={sim.finished ?? (cursorNode ? undefined : 'success')}
            taken={sim.taken.length}
            log={sim.log}
            onStep={(port) => setSim((s) => (s && cursorNode ? simStep(graph, s, cursorNode.id, port) : s))}
            onRestart={() => setSim(startSim(graph))}
            onStop={() => setSim(null)}
          />
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
    </Page>
  )
}
