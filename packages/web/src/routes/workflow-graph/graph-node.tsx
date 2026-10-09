import { BaseEdge, getSmoothStepPath, Handle, Position, type EdgeProps } from '@xyflow/react'
import {
  BotIcon,
  ExternalLinkIcon,
  FlagIcon,
  GitForkIcon,
  GitMergeIcon,
  MergeIcon,
  GitCommitIcon,
  GitPullRequestIcon,
  HandIcon,
  MessageCircleQuestionIcon,
  MessageSquareIcon,
  PlayIcon,
  PlusIcon,
  RepeatIcon,
  SignpostIcon,
  TagIcon,
  SplitIcon,
  TerminalIcon,
  TimerIcon,
  UploadIcon,
  WebhookIcon,
  WorkflowIcon,
  type LucideIcon,
} from 'lucide-react'
import { memo } from 'react'
import type * as React from 'react'

import { Link } from '@/lib/project-router'
import { Button } from '@/components/ui/button'

import type { WorkflowGraph, WorkflowGraphNode, WorkflowNodeCatalogResponse } from '@open-mercato/cezar-api-client'
import { cn } from '@/lib/utils'
import {
  CAPTION_WIDTH,
  portsOf,
  roundedPath,
  routeLanes,
  targetOf,
  type Lane,
  type LaneRequest,
  portTone,
  TILE,
  WIDE_TYPES,
  WIDE_WIDTH,
  type GraphNodeType,
  type NodeRunState,
  type PortTone,
} from '@/lib/workflow-graph'

/**
 * How one workflow node looks on a canvas — shared by the editor and the task view's live graph
 * (spec 2026-09-30-workflow-node-editor). Deliberately quiet, n8n-style: a small tile with one
 * icon and a caption under it; agent-like nodes are a wider tile carrying title + subtitle.
 * Ports are dots on the right edge; they get a label only when a node has more than one, which is
 * exactly when the label says something (pass / fail, approve / reject).
 */

export type Category = WorkflowNodeCatalogResponse['nodes'][number]['category']

export const CATEGORY_ORDER: { id: Category; label: string; color: string }[] = [
  { id: 'agents', label: 'Agents', color: 'var(--violet)' },
  { id: 'flow', label: 'Flow control', color: 'var(--primary-strong)' },
  { id: 'scripts', label: 'Scripts & checks', color: 'var(--info)' },
  { id: 'git', label: 'Git & GitHub', color: 'var(--foreground)' },
]

export const TYPE_CATEGORY: Record<GraphNodeType, Category> = {
  start: 'flow',
  end: 'flow',
  loop: 'flow',
  'gate.human': 'flow',
  agent: 'agents',
  'ask-user': 'agents',
  dispatch: 'agents',
  check: 'scripts',
  'git.commit': 'git',
  'github.draft-pr': 'git',
  'github.wait-ci': 'git',
  'github.pr-comment': 'git',
  fork: 'flow',
  join: 'flow',
  if: 'flow',
  workflow: 'flow',
  'git.push': 'git',
  'git.sync-base': 'git',
  'github.pr-update': 'git',
  'github.issue-comment': 'git',
  'notify.webhook': 'scripts',
}

export const ICONS: Record<GraphNodeType, LucideIcon> = {
  start: PlayIcon,
  end: FlagIcon,
  loop: RepeatIcon,
  agent: BotIcon,
  check: TerminalIcon,
  'gate.human': HandIcon,
  'ask-user': MessageCircleQuestionIcon,
  dispatch: SplitIcon,
  'git.commit': GitCommitIcon,
  'github.draft-pr': GitPullRequestIcon,
  'github.wait-ci': TimerIcon,
  'github.pr-comment': MessageSquareIcon,
  fork: GitForkIcon,
  join: MergeIcon,
  if: SignpostIcon,
  workflow: WorkflowIcon,
  'git.push': UploadIcon,
  'git.sync-base': GitMergeIcon,
  'github.pr-update': TagIcon,
  'github.issue-comment': MessageSquareIcon,
  'notify.webhook': WebhookIcon,
}

export const TONE: Record<PortTone, string> = {
  success: 'var(--success)',
  failure: 'var(--danger)',
  verdict: 'var(--violet)',
  neutral: 'var(--muted-foreground)',
}

export const TYPE_LABEL: Record<GraphNodeType, string> = {
  start: 'Start',
  end: 'End',
  loop: 'Loop',
  agent: 'Agent',
  check: 'Check',
  'gate.human': 'Human gate',
  'ask-user': 'Ask user',
  dispatch: 'Subtask',
  'git.commit': 'Commit',
  'github.draft-pr': 'Draft PR',
  'github.wait-ci': 'Wait for CI',
  'github.pr-comment': 'PR comment',
  fork: 'Fork',
  join: 'Join',
  if: 'If',
  workflow: 'Sub-workflow',
  'git.push': 'Push',
  'git.sync-base': 'Sync with base',
  'github.pr-update': 'Update PR',
  'github.issue-comment': 'Issue comment',
  'notify.webhook': 'Webhook',
}

export const categoryColor = (type: GraphNodeType) =>
  CATEGORY_ORDER.find((c) => c.id === TYPE_CATEGORY[type])?.color ?? 'var(--muted-foreground)'

/** Geometry lives with the layout (`lib/workflow-graph.ts`) so both size a node the same way. */
export { TILE, WIDE_WIDTH }
const WIDE = WIDE_TYPES

/** One short detail line under (or inside) a node — never more than the eye needs at a glance. */
export function nodeDetail(node: WorkflowGraphNode, loopCount?: number): string {
  switch (node.type) {
    case 'agent':
      return [node.review ? 'reviewer' : '', node.runner ?? '', node.budgetUsd ? `$${node.budgetUsd}` : '', node.skill ? `/${node.skill}` : '', node.session ? `↺ ${node.session.continue}` : '']
        .filter(Boolean)
        .join(' · ') || 'agent'
    case 'dispatch':
      return [node.runner ?? 'subtask', node.budgetUsd ? `$${node.budgetUsd}` : ''].filter(Boolean).join(' · ')
    case 'check':
      return `$ ${node.command}`
    case 'loop':
      return loopCount ? `${loopCount} / ${node.max}` : `max ${node.max}`
    case 'end':
      return node.status === 'failed' ? 'fails the run' : 'succeeds'
    case 'gate.human':
      return node.message
    case 'ask-user':
      return node.question
    case 'git.commit':
      return node.message
    case 'github.draft-pr':
      return node.title ?? 'task title'
    case 'github.wait-ci':
      return `≤ ${Math.round(node.timeoutMs / 60_000)} min`
    case 'github.pr-comment':
      return node.body
    case 'fork':
      return `${node.branches} agents at once`
    case 'join':
      return node.wait === 'any' ? 'first to succeed' : 'wait for all'
    case 'workflow':
      return node.workflow
    case 'git.push':
      return 'task branch → origin'
    case 'git.sync-base':
      return 'merge latest base'
    case 'github.pr-update':
      return [node.ready ? 'ready' : '', node.addLabels?.length ? `+${node.addLabels.join(', ')}` : '', node.reviewers?.length ? `@${node.reviewers.join(', @')}` : '']
        .filter(Boolean)
        .join(' · ') || 'no changes'
    case 'github.issue-comment':
      return node.issue ? `#${node.issue}` : "task's issue"
    case 'notify.webhook':
      return node.url.replace(/^https?:\/\//, '')
    case 'if': {
      const c = node.condition
      switch (c.kind) {
        case 'diff-lines':
          return `lines ${c.op} ${c.value}`
        case 'diff-files':
          return `files ${c.op} ${c.value}`
        case 'paths-changed':
          return `changed ${c.glob}`
        case 'output':
          return `${c.ref} ${c.op} ${c.value}`
        case 'branch':
          return `base ${c.op} ${c.value}`
      }
      return ''
    }
    default:
      return ''
  }
}

/**
 * React Flow's own chrome, pointed at the cockpit's tokens so both canvases follow the APP theme
 * (React Flow's `colorMode` only knows the OS one): the canvas, its dots, the zoom controls.
 */
export const CANVAS_THEME = {
  '--xy-background-color': 'var(--background)',
  '--xy-background-pattern-color': 'color-mix(in oklab, var(--muted-foreground) 28%, transparent)',
  '--xy-controls-button-background-color': 'var(--card)',
  '--xy-controls-button-background-color-hover': 'var(--muted)',
  '--xy-controls-button-color': 'var(--muted-foreground)',
  '--xy-controls-button-color-hover': 'var(--foreground)',
  '--xy-controls-button-border-color': 'var(--border)',
  '--xy-controls-box-shadow': 'var(--shadow-xs)',
  '--xy-edge-stroke': 'var(--muted-foreground)',
  '--xy-connectionline-stroke': 'var(--muted-foreground)',
  '--xy-selection-background-color': 'color-mix(in oklab, var(--primary) 12%, transparent)',
  '--xy-selection-border': '1px solid var(--primary-strong)',
} as React.CSSProperties

const STATUS: Partial<Record<NodeRunState['status'], { ring: string; dot: string; label: string }>> = {
  running: { ring: 'ring-2 ring-primary shadow-md', dot: 'bg-primary motion-safe:animate-pulse', label: 'running' },
  waiting: { ring: 'ring-2 ring-info', dot: 'bg-info motion-safe:animate-pulse', label: 'needs you' },
  done: { ring: '', dot: 'bg-success', label: 'done' },
  failed: { ring: 'ring-2 ring-danger', dot: 'bg-danger', label: 'failed' },
  cancelled: { ring: '', dot: 'bg-muted-foreground', label: 'cancelled' },
}

export interface GraphNodeViewProps {
  node: WorkflowGraphNode
  selected?: boolean
  /** Server validation flagged this node. */
  issue?: boolean
  /** Live or simulated state; `pending` dims the node, `reached` is plain. */
  status?: NodeRunState['status']
  loopCount?: number
  iterations?: number
  costUsd?: number
  /** Ports with an edge — an unwired one is drawn hollow (it ends the run). */
  wired?: readonly string[]
  connectable?: boolean
  /** Editor only: an unwired port grows a `+` stub (n8n-style) that adds a node wired to it. */
  onAddFromPort?: (port: string) => void
  /** What runs inside a card — a sub-workflow's steps, a subtask's rail — drawn in place of the
   *  subtitle as one dot per step (coloured by status once it runs). */
  inner?: readonly InnerStep[]
  /** Live view: this node's child task, opened from the card. */
  subtaskTo?: string
}

export interface InnerStep {
  id: string
  name: string
  status?: string
}

const INNER_DOT: Record<string, string> = {
  running: 'bg-primary motion-safe:animate-pulse',
  waiting: 'bg-info motion-safe:animate-pulse',
  done: 'bg-success',
  failed: 'bg-danger',
}

function InnerSteps({ steps }: { steps: readonly InnerStep[] }) {
  return (
    <div className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground" aria-label="steps inside">
      {steps.slice(0, 6).map((st, i) => (
        <span key={st.id} className="flex min-w-0 items-center gap-1" title={`${st.name}${st.status ? ` — ${st.status}` : ''}`}>
          {i > 0 && <span aria-hidden="true">→</span>}
          <span className={cn('size-1.5 shrink-0 rounded-full', (st.status && INNER_DOT[st.status]) || 'bg-muted-foreground/40')} />
          <span className="truncate">{st.name}</span>
        </span>
      ))}
      {steps.length > 6 && <span>+{steps.length - 6}</span>}
    </div>
  )
}

export const GraphNodeView = memo(function GraphNodeView({
  node,
  selected,
  issue,
  status,
  loopCount,
  iterations,
  costUsd,
  wired,
  connectable = true,
  onAddFromPort,
  inner,
  subtaskTo,
}: GraphNodeViewProps) {
  const Icon = ICONS[node.type]
  const color = categoryColor(node.type)
  const ports = portsOf(node)
  const wide = WIDE.has(node.type)
  const title = node.name ?? (wide ? TYPE_LABEL[node.type] : node.id)
  const detail = nodeDetail(node, loopCount)
  const state = status ? STATUS[status] : undefined
  const extras = [iterations && iterations > 1 ? `×${iterations}` : '', costUsd ? `$${costUsd.toFixed(2)}` : '']
    .filter(Boolean)
    .join(' · ')

  const shape =
    node.type === 'start'
      ? 'rounded-l-[32px] rounded-r-xl'
      : node.type === 'end'
        ? 'rounded-full'
        : 'rounded-xl'

  return (
    <div
      data-node-type={node.type}
      data-node-status={status}
      className={cn('group relative', status === 'pending' && 'opacity-45')}
      title={wide ? undefined : `${title} — ${detail}`}
    >
      <div
        className={cn(
          'relative flex items-center border bg-card text-card-foreground shadow-sm transition-[border-color,box-shadow]',
          'border-border group-hover:border-muted-foreground/50 group-hover:shadow-md',
          shape,
          wide ? 'h-16 gap-3 px-3.5' : 'size-16 justify-center',
          selected && 'border-foreground/70 ring-3 ring-foreground/10',
          issue && 'ring-2 ring-danger',
          state?.ring,
        )}
        style={{ width: wide ? WIDE_WIDTH : TILE }}
      >
        {node.type !== 'start' && (
          <Handle
            type="target"
            position={Position.Left}
            isConnectable={connectable}
            className="!h-3.5 !w-1 !rounded-full !border-0 !bg-muted-foreground/50"
          />
        )}
        {wide ? (
          // The type's icon on a soft tile of its own colour — the card's one accent.
          <span
            className="flex size-9 shrink-0 items-center justify-center rounded-lg"
            style={{ background: `color-mix(in oklab, ${color} 12%, transparent)` }}
          >
            <Icon className="size-5" style={{ color }} strokeWidth={1.75} />
          </span>
        ) : (
          <Icon className="size-6 shrink-0" style={{ color }} strokeWidth={1.75} />
        )}
        {wide && (
          <div className="min-w-0">
            <div className="truncate text-[13px] leading-tight font-medium">{title}</div>
            {inner?.length ? <InnerSteps steps={inner} /> : <div className="mt-0.5 truncate text-xs text-muted-foreground">{detail}</div>}
          </div>
        )}
        {subtaskTo && (
          <Link
            to={subtaskTo}
            // `nodrag nopan`: following the link, not grabbing the canvas.
            className="nodrag nopan absolute right-1.5 bottom-1 rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            aria-label={`Open the subtask for ${title}`}
            title="Open the subtask"
            onClick={(e) => e.stopPropagation()}
          >
            <ExternalLinkIcon className="size-3" />
          </Link>
        )}
        {state && (
          <span
            className={cn('absolute -top-1 -right-1 size-2.5 rounded-full ring-2 ring-background', state.dot)}
            aria-label={state.label}
          />
        )}
        {node.type === 'loop' && loopCount ? (
          <span className="absolute -bottom-2 left-1/2 -translate-x-1/2 rounded-full border border-border bg-card px-1.5 text-[11px] leading-4 text-muted-foreground tabular-nums">
            {loopCount}/{node.max}
          </span>
        ) : null}

        {ports.map((port, i) => {
          const tone = TONE[portTone(node, port)]
          const top = `${((i + 1) / (ports.length + 1)) * 100}%`
          const open = wired !== undefined && !wired.includes(port)
          return (
            <div key={port}>
              <Handle
                id={port}
                type="source"
                position={Position.Right}
                isConnectable={connectable}
                className="!size-2.5 !border-[1.5px] !shadow-none"
                style={{ top, borderColor: tone, background: open ? 'var(--card)' : tone }}
              />
              {(ports.length > 1 || (open && onAddFromPort)) && (
                <div className="absolute left-[calc(100%+9px)] flex -translate-y-1/2 items-center" style={{ top }}>
                  {ports.length > 1 && (
                    <span
                      className="pointer-events-none rounded-sm bg-background px-1 text-[11px] leading-4 whitespace-nowrap"
                      style={{ color: tone }}
                    >
                      {port}
                    </span>
                  )}
                  {open && onAddFromPort && (
                    <>
                      <span aria-hidden="true" className="h-px w-6 bg-border" />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon-xs"
                        // `nodrag nopan`: a click here is a button press, not the start of a node drag.
                        className="nodrag nopan size-5 rounded-full border-border text-muted-foreground shadow-xs hover:border-muted-foreground/60 hover:bg-card hover:text-foreground active:translate-y-0"
                        aria-label={`Add a node after ${node.name ?? node.id} → ${port}`}
                        title={`Add a node on “${port}”`}
                        onClick={(e) => {
                          e.stopPropagation()
                          onAddFromPort(port)
                        }}
                      >
                        <PlusIcon className="size-3" />
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {!wide && (
        <div
          className="pointer-events-none absolute top-full left-1/2 mt-1.5 -translate-x-1/2 text-center"
          style={{ width: CAPTION_WIDTH }}
        >
          <div className="truncate text-xs leading-tight font-medium text-foreground">{title}</div>
          {detail ? <div className="truncate text-[11px] text-muted-foreground">{detail}</div> : null}
        </div>
      )}
      {extras ? (
        <div className={cn('pointer-events-none absolute left-1/2 -translate-x-1/2 text-[11px] text-muted-foreground tabular-nums', wide ? 'top-full mt-1' : 'top-full mt-9')}>
          {extras}
        </div>
      ) : null}
    </div>
  )
})

/** Neutral edge styling shared by both canvases: grey, dashed when it runs back (a loop). */
export function edgeStyle(opts: { tone: PortTone; back: boolean; emphasis?: 'taken' | 'dim' }) {
  const stroke =
    opts.tone === 'failure' ? 'color-mix(in oklab, var(--danger) 45%, transparent)' : 'color-mix(in oklab, var(--muted-foreground) 45%, transparent)'
  return {
    stroke: opts.emphasis === 'taken' ? (opts.tone === 'failure' ? 'var(--danger)' : 'var(--primary-strong)') : stroke,
    strokeWidth: opts.emphasis === 'taken' ? 2 : 1.25,
    strokeDasharray: opts.back ? '5 4' : undefined,
    opacity: opts.emphasis === 'dim' ? 0.35 : 1,
  }
}

/**
 * An edge that runs backwards — a loop, or the walk continuing on the next row — drawn around the
 * nodes instead of through them: out of the port, along its lane (`data.laneY`, from
 * `routeLanes`), and into the target from the left. Without a lane it falls back to smoothstep.
 */
export function LaneEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, style, markerEnd }: EdgeProps) {
  const route = (data as { lane?: Lane } | undefined)?.lane
  if (route === undefined) {
    const [path] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, offset: 28, borderRadius: 14 })
    return <BaseEdge path={path} style={style} markerEnd={markerEnd} />
  }
  // The legs stand where the router checked them, unless the node was dragged past them.
  const lane = route.y
  const out = Math.max(sourceX + 12, route.outX)
  const into = Math.min(targetX - 12, route.inX)
  const path = roundedPath([
    { x: sourceX, y: sourceY },
    { x: out, y: sourceY },
    { x: out, y: lane },
    { x: into, y: lane },
    { x: into, y: targetY },
    { x: targetX, y: targetY },
  ])
  return <BaseEdge path={path} style={style} markerEnd={markerEnd} />
}

export const edgeTypes = { lane: LaneEdge }

/**
 * Lanes for every edge that cannot run straight: a loop, a leftward edge across a wrapped row,
 * and a forward edge whose direct way would pass through another node (a long edge skipping a
 * column). Everything else keeps its plain curve.
 */
export function backLanes(graph: WorkflowGraph, loops: ReadonlySet<string>): Map<string, Lane> {
  const requests: LaneRequest[] = []
  for (const n of graph.nodes) {
    for (const port of portsOf(n)) {
      const to = targetOf(graph, n.id, port)
      if (!to) continue
      const key = `${n.id}.${port}->${to}`
      const leftward = (graph.layout?.[to]?.x ?? 0) <= (graph.layout?.[n.id]?.x ?? 0)
      if (loops.has(key) || leftward || blockedEdge(graph, n.id, port, to)) requests.push({ key, from: n.id, port, to })
    }
  }
  return routeLanes(graph, requests)
}

/** Would the direct way from `from.port` to `to` pass through a third node's tile or caption? */
export function blockedEdge(graph: WorkflowGraph, from: string, port: string, to: string): boolean {
  const layout = graph.layout ?? {}
  const src = graph.nodes.find((n) => n.id === from)
  const a = layout[from]
  const b = layout[to]
  if (!src || !a || !b) return false
  const ports = portsOf(src)
  const sx = a.x + (WIDE_TYPES.has(src.type) ? WIDE_WIDTH : TILE)
  const sy = a.y + ((Math.max(0, ports.indexOf(port)) + 1) / (ports.length + 1)) * TILE
  const tx = b.x
  const ty = b.y + TILE / 2
  const [x0, x1] = [Math.min(sx, tx), Math.max(sx, tx)]
  const [y0, y1] = [Math.min(sy, ty) - 6, Math.max(sy, ty) + 6]
  return graph.nodes.some((n) => {
    if (n.id === from || n.id === to) return false
    const p = layout[n.id]
    if (!p) return false
    const w = WIDE_TYPES.has(n.type) ? WIDE_WIDTH : TILE
    const below = WIDE_TYPES.has(n.type) ? 0 : 34 // a tile's caption
    return p.x < x1 && p.x + w > x0 && p.y < y1 && p.y + TILE + below > y0
  })
}
