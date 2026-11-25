import '@xyflow/react/dist/style.css'

import type { WorkflowGraph, WorkflowGraphNode } from '@open-mercato/cezar-api-client'
import { Background, BackgroundVariant, Controls, MarkerType, ReactFlow, ReactFlowProvider, type Edge, type Node, type NodeProps } from '@xyflow/react'
import { useMemo } from 'react'

import { graphForWorkflow, loopEdges, portsOf, portTone, targetOf } from '@/lib/workflow-graph'
import { backLanes, edgeStyle, edgeTypes, GraphNodeView } from '../workflow-graph/graph-node'

/**
 * A framework's compiled graph, read-only (spec 2026-11-15-framework-board D3: "Open compiled
 * graph"). The task view's live graph without a run: same node cards, same lanes, no overlay.
 */

type StaticNodeData = { node: WorkflowGraphNode }

function StaticNode({ data }: NodeProps<Node<StaticNodeData>>) {
  return <GraphNodeView node={data.node} connectable={false} />
}

const nodeTypes = { static: StaticNode }

export function CompiledGraph({ graph: raw }: { graph: WorkflowGraph }) {
  const graph = useMemo(() => graphForWorkflow({ steps: [], graph: raw }), [raw])
  const loops = useMemo(() => loopEdges(graph), [graph])
  const lanes = useMemo(() => backLanes(graph, loops), [graph, loops])
  const nodes: Node<StaticNodeData>[] = useMemo(
    () =>
      graph.nodes.map((n) => ({
        id: n.id,
        type: 'static',
        position: graph.layout?.[n.id] ?? { x: 0, y: 0 },
        draggable: false,
        connectable: false,
        data: { node: n },
      })),
    [graph],
  )
  const edges: Edge[] = useMemo(
    () =>
      graph.nodes.flatMap((n) =>
        portsOf(n).flatMap((port) => {
          const to = targetOf(graph, n.id, port)
          if (!to) return []
          const key = `${n.id}.${port}->${to}`
          const back = loops.has(key)
          const leftward = (graph.layout?.[to]?.x ?? 0) <= (graph.layout?.[n.id]?.x ?? 0)
          const style = edgeStyle({ tone: portTone(n, port), back })
          return [
            {
              id: key,
              source: n.id,
              sourceHandle: port,
              target: to,
              type: back || leftward || lanes.has(key) ? 'lane' : 'default',
              ...(lanes.has(key) ? { data: { lane: lanes.get(key) } } : {}),
              style,
              markerEnd: { type: MarkerType.ArrowClosed, color: style.stroke, width: 14, height: 14 },
            },
          ]
        }),
      ),
    [graph, loops, lanes],
  )
  return (
    <div data-slot="compiled-graph" className="relative h-full min-h-[360px] w-full">
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
          minZoom={0.2}
          colorMode="system"
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  )
}
