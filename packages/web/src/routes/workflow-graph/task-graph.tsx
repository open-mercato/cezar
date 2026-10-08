import '@xyflow/react/dist/style.css'

import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import { ExternalLinkIcon, WorkflowIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useParams } from 'react-router'

import { Link } from '@/lib/project-router'

import { useRun } from '@/api/queries'
import type { ApiRun, WorkflowGraphNode } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import {
  graphForWorkflow,
  loopEdges,
  type Lane,
  portsOf,
  portTone,
  runOverlay,
  targetOf,
  type NodeRunState,
} from '@/lib/workflow-graph'

import { GitTabLoadError, GitTabLoading } from '../task-git/git-tab-loading'
import { RunHeader } from '../task-thread/run-header'
import { backLanes, edgeStyle, edgeTypes, GraphNodeView } from './graph-node'
import { FloatingPanel } from './workflow-graph'

/**
 * The task view's live graph (spec 2026-09-30-workflow-node-editor, phase 3): the run's own
 * graph, read-only, with the walk folded on — each node's status, iterations and cost, loop
 * counters, and every edge the run took (thicker, with a ×N count when taken more than once).
 * Live for free: it reads the run record, which the global SSE stream already patches in place.
 */

type LiveNodeData = { node: WorkflowGraphNode; state: NodeRunState; childRunId?: string }

function LiveNodeCard({ data }: NodeProps<Node<LiveNodeData>>) {
  const { node, state, childRunId } = data
  return childRunId ? (
    <SubtaskNodeCard node={node} state={state} childRunId={childRunId} />
  ) : (
    <GraphNodeView
      node={node}
      connectable={false}
      status={state.status}
      loopCount={state.loopCount}
      iterations={state.iterations}
      costUsd={state.costUsd}
    />
  )
}

/**
 * A node that ran as a child task — a fork's agent, a subtask, a sub-workflow: its card reads the
 * child's own record (already live through the SSE cache), so it shows the child's steps as they
 * run and its real cost, and links through to it.
 */
function SubtaskNodeCard({ node, state, childRunId }: { node: WorkflowGraphNode; state: NodeRunState; childRunId: string }) {
  const child = useRun(childRunId).data
  // A multi-step child (a sub-workflow) shows its steps; a single-step one is the node itself.
  const inner = child && child.steps.length > 1 ? child.steps.map((s) => ({ id: s.id, name: s.name ?? s.id, status: s.status })) : undefined
  return (
    <GraphNodeView
      node={node}
      connectable={false}
      status={state.status}
      costUsd={child?.costUsd ?? state.costUsd}
      inner={inner}
      subtaskTo={`/tasks/${childRunId}/graph`}
    />
  )
}

const nodeTypes = { live: LiveNodeCard }

export function TaskGraphRoute() {
  const { id } = useParams<{ id: string }>()
  const run = useRun(id)
  if (run.isPending) return <GitTabLoading tab="changes" />
  if (run.isError) return <GitTabLoadError tab="changes" error={run.error} />
  return (
    <ReactFlowProvider>
      <TaskGraphView run={run.data} />
    </ReactFlowProvider>
  )
}

/**
 * The graph as a WORKSPACE COLUMN (spec `2026-10-07-task-workspace` §5.1).
 *
 * The same one-prop embedding the other four views take: `embedded` drops this component's own
 * `RunHeader` and changes nothing else. `ReactFlowProvider` comes along because it is per-graph
 * state, not per-route — two Graph columns in one layout each need their own.
 */
export function GraphView({ run, embedded = false }: { run: ApiRun; embedded?: boolean }) {
  return (
    <ReactFlowProvider>
      <TaskGraphView run={run} embedded={embedded} />
    </ReactFlowProvider>
  )
}

function TaskGraphView({ run, embedded = false }: { run: ApiRun; embedded?: boolean }) {
  const def = run.workflowDef
  const graph = useMemo(() => (def ? graphForWorkflow(def) : null), [def])
  const overlay = useMemo(() => (graph ? runOverlay(graph, run) : null), [graph, run])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = graph?.nodes.find((n) => n.id === selectedId)

  const nodes: Node<LiveNodeData>[] = useMemo(
    () =>
      graph && overlay
        ? graph.nodes.map((n) => ({
            id: n.id,
            type: 'live',
            position: graph.layout?.[n.id] ?? { x: 0, y: 0 },
            draggable: false,
            connectable: false,
            data: {
              node: n,
              state: overlay.nodes.get(n.id) ?? { status: 'pending' },
              ...childOf(run, n.id),
            },
          }))
        : [],
    [graph, overlay],
  )

  const loops = useMemo(() => (graph ? loopEdges(graph) : new Set<string>()), [graph])
  const lanes = useMemo(() => (graph ? backLanes(graph, loops) : new Map<string, Lane>()), [graph, loops])
  const edges: Edge[] = useMemo(() => {
    if (!graph || !overlay) return []
    return graph.nodes.flatMap((n) =>
      portsOf(n).flatMap((port) => {
        const to = targetOf(graph, n.id, port)
        if (!to) return []
        const key = `${n.id}.${port}->${to}`
        const count = overlay.edges.get(key) ?? 0
        // Dashed = a real way back (a loop), from the graph; a leftward edge in a wrapped layout is
          // just the walk continuing on the next row, drawn solid with right angles.
          const back = loops.has(`${n.id}.${port}->${to}`)
          const leftward = (graph.layout?.[to]?.x ?? 0) <= (graph.layout?.[n.id]?.x ?? 0)
        const style = edgeStyle({ tone: portTone(n, port), back, emphasis: count ? 'taken' : 'dim' })
        return [
          {
            id: key,
            source: n.id,
            sourceHandle: port,
            target: to,
            type: back || leftward || lanes.has(key) ? 'lane' : 'default',
              // A way back, or an edge that would cross a node, runs in its own lane around them.
              ...(lanes.has(key) ? { data: { lane: lanes.get(key) } } : {}),
            label: count > 1 ? `×${count}` : undefined,
            style,
            markerEnd: { type: MarkerType.ArrowClosed, color: style.stroke, width: 14, height: 14 },
            labelStyle: { fill: 'var(--muted-foreground)', fontSize: 10, fontWeight: 600 },
            labelBgStyle: { fill: 'var(--background)' },
          },
        ]
      }),
    )
  }, [graph, overlay, loops, lanes])

  return (
    <div data-route="task-graph" className="flex h-full min-h-0 flex-col">
      {embedded ? null : <RunHeader run={run} tab="graph" />}
      {!graph ? (
        <CenteredState
          icon={<WorkflowIcon />}
          tone="neutral"
          title="No workflow graph"
          subtitle="This task has no stored workflow definition to draw."
        />
      ) : (
        <div className="relative min-h-[420px] flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            onNodeClick={(_, n) => setSelectedId(n.id)}
            onPaneClick={() => setSelectedId(null)}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
            minZoom={0.2}
            colorMode="system"
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
          {selected && overlay ? (
            <FloatingPanel side="right" label="Node details" title={selected.name ?? selected.id} onClose={() => setSelectedId(null)}>
              <NodeDetails
                state={overlay.nodes.get(selected.id) ?? { status: 'pending' }}
                outputs={run.graphState?.outputs?.[selected.id]}
                childRunId={childOf(run, selected.id).childRunId}
                loopMax={selected.type === 'loop' ? selected.max : undefined}
              />
            </FloatingPanel>
          ) : null}
        </div>
      )}
    </div>
  )
}

/** The child task a node started, when it runs as one (fork agents, subtasks, sub-workflows). */
function childOf(run: ApiRun, nodeId: string): { childRunId?: string } {
  const id = run.graphState?.outputs?.[nodeId]?.runId
  return typeof id === 'string' && id ? { childRunId: id } : {}
}

/** What one node did in this run: its state, and every `{{nodes.<id>.<field>}}` it produced. */
function NodeDetails({
  state,
  outputs,
  loopMax,
  childRunId,
}: {
  state: NodeRunState
  outputs: Record<string, string | number> | undefined
  loopMax?: number
  childRunId?: string
}) {
  const rows: [string, string][] = [['status', state.status === 'reached' ? 'passed through' : state.status]]
  if (state.iterations) rows.push(['runs', String(state.iterations)])
  if (state.costUsd) rows.push(['cost', `$${state.costUsd.toFixed(2)}`])
  if (state.loopCount !== undefined) rows.push(['iterations', `${state.loopCount}${loopMax ? ` / ${loopMax}` : ''}`])
  const fields = Object.entries(outputs ?? {}).filter(([, v]) => v !== '')
  return (
    <div className="space-y-4 p-4 text-[12px]">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {childRunId ? (
        <Link to={`/tasks/${childRunId}`} className="inline-flex items-center gap-1 text-primary hover:underline">
          Open the subtask <ExternalLinkIcon className="size-3" />
        </Link>
      ) : null}
      <div>
        <div className="mb-1 text-[11px] text-muted-foreground uppercase">Outputs</div>
        {fields.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">Nothing yet — outputs appear once the node has run.</p>
        ) : (
          fields.map(([k, v]) => (
            <div key={k} className="mb-2">
              <code className="text-[11px] text-muted-foreground">{k}</code>
              <pre className="mt-0.5 max-h-48 overflow-auto rounded-md bg-muted/40 p-2 text-[11px] whitespace-pre-wrap">{String(v)}</pre>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
