import {
  BotIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  FileTextIcon,
  GlobeIcon,
  SearchIcon,
  SparklesIcon,
  SquarePenIcon,
  SquareTerminalIcon,
  WrenchIcon,
  type LucideIcon,
} from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'

import type { ToolKind, UiToolItem } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'

import type { ThreadBlock } from './thread-groups'
import { ToolCard } from './thread-items'
import { useThreadCardCache } from './thread-open-cards'
import type { ThreadEntry } from './thread-state'

/**
 * A finished turn's work, folded behind one line — "Worked for 28s · 3 files read · 2 commands ·
 * 1 edit" — and, once opened, laid out to be scanned rather than replayed:
 *
 *  - a row of buckets (read / searched / ran / edited / …) that doubles as a filter;
 *  - the calls themselves as tidy rows in one bordered list — icon, verb, the target in mono,
 *    status — each expandable to its output, its error, or (for an edit) its diff;
 *  - the agent's reasoning and interim remarks in between, in the order they streamed.
 *
 * Nothing the flat thread shows is dropped: the streak and "Explored N files" folds are flattened
 * here (one disclosure is enough — a fold inside a fold was most of the clicking), so every call
 * is one click from the header instead of three.
 */

/** The buckets the summary counts, derived from the protocol's own `ToolKind`. */
export type WorkBucket = 'read' | 'search' | 'execute' | 'edit' | 'fetch' | 'task' | 'skill' | 'other'

const BUCKET_OF: Record<ToolKind, WorkBucket | undefined> = {
  read: 'read',
  search: 'search',
  execute: 'execute',
  // Every way of changing a file is one bucket: the reader asks "what did it change?".
  edit: 'edit',
  delete: 'edit',
  move: 'edit',
  fetch: 'fetch',
  task: 'task',
  skill: 'skill',
  think: 'other',
  other: 'other',
  // Plan tools never reach the thread (`groupThreadItems` pass 0) — the plan dock owns them.
  plan: undefined,
}

const BUCKETS: ReadonlyArray<{
  id: WorkBucket
  icon: LucideIcon
  /** The filter chip's word. */
  chip: string
  /** The header summary's noun, singular and plural. */
  one: string
  many: string
}> = [
  { id: 'read', icon: FileTextIcon, chip: 'Read', one: 'file read', many: 'files read' },
  { id: 'search', icon: SearchIcon, chip: 'Searched', one: 'search', many: 'searches' },
  { id: 'execute', icon: SquareTerminalIcon, chip: 'Ran', one: 'command', many: 'commands' },
  { id: 'edit', icon: SquarePenIcon, chip: 'Edited', one: 'edit', many: 'edits' },
  { id: 'fetch', icon: GlobeIcon, chip: 'Fetched', one: 'fetch', many: 'fetches' },
  { id: 'task', icon: BotIcon, chip: 'Agents', one: 'sub-agent', many: 'sub-agents' },
  { id: 'skill', icon: SparklesIcon, chip: 'Skills', one: 'skill', many: 'skills' },
  { id: 'other', icon: WrenchIcon, chip: 'Other', one: 'other call', many: 'other calls' },
]

interface ToolStep {
  kind: 'tool'
  id: string
  item: UiToolItem
  children: readonly ThreadEntry[]
}
interface EntryStep {
  kind: 'entry'
  id: string
  entry: ThreadEntry
}
type WorkStep = ToolStep | EntryStep

/** The folded blocks, flattened back to stream order: one step per tool call or thread entry. */
function workSteps(blocks: readonly ThreadBlock[]): WorkStep[] {
  const steps: WorkStep[] = []
  const visit = (block: ThreadBlock) => {
    switch (block.kind) {
      case 'entry':
        steps.push({ kind: 'entry', id: block.id, entry: block.entry })
        break
      case 'tool-card':
        steps.push({ kind: 'tool', id: block.id, item: block.item, children: block.children })
        break
      case 'context-group':
        for (const item of block.tools) steps.push({ kind: 'tool', id: item.id, item, children: [] })
        break
      case 'streak':
        block.blocks.forEach(visit)
        break
    }
  }
  blocks.forEach(visit)
  return steps
}

export interface WorkStats {
  total: number
  failed: number
  buckets: Record<WorkBucket, number>
}

/** Counts over the turn's TOP-LEVEL calls — a sub-agent's own calls belong to the sub-agent. */
export function workStats(blocks: readonly ThreadBlock[]): WorkStats {
  const buckets: Record<WorkBucket, number> = { read: 0, search: 0, execute: 0, edit: 0, fetch: 0, task: 0, skill: 0, other: 0 }
  let total = 0
  let failed = 0
  for (const step of workSteps(blocks)) {
    if (step.kind !== 'tool') continue
    const bucket = BUCKET_OF[step.item.toolKind]
    if (bucket === undefined) continue
    buckets[bucket] += 1
    total += 1
    if (step.item.status === 'failed') failed += 1
  }
  return { total, failed, buckets }
}

/** "3 files read · 2 commands · 1 edit" — empty when the turn made no tool calls. */
export function workSummaryLabel(stats: WorkStats): string {
  const parts = BUCKETS.filter(({ id }) => stats.buckets[id] > 0).map(
    ({ id, one, many }) => `${stats.buckets[id]} ${stats.buckets[id] === 1 ? one : many}`,
  )
  if (stats.failed > 0) parts.push(`${stats.failed} failed`)
  return parts.join(' · ')
}

/** Beyond this many rows a list of calls shows the first ones and a "Show N more". */
const LIST_CLAMP = 12

type Filter = 'all' | 'failed' | WorkBucket

export function WorkGroup({
  label,
  blocks,
  scope,
  renderEntry,
  renderNested,
}: {
  /** "Worked for 28s", or a plain fallback when the turn carries no usable clock. */
  label: string
  blocks: readonly ThreadBlock[]
  /** The turn's render key — scopes the open-card cache (item ids repeat across sessions). */
  scope: string
  renderEntry: (entry: ThreadEntry, scope: string) => ReactNode
  renderNested: (entries: readonly ThreadEntry[], scope: string) => ReactNode
}) {
  const cache = useThreadCardCache()
  const cacheKey = `${scope}:work`
  const [open, setOpenState] = useState(() => cache?.get(cacheKey) ?? false)
  const setOpen = (next: boolean) => {
    cache?.set(cacheKey, next)
    setOpenState(next)
  }
  const stats = useMemo(() => workStats(blocks), [blocks])
  const summary = workSummaryLabel(stats)
  return (
    <Collapsible data-slot="work-group" open={open} onOpenChange={setOpen} className="group/work min-w-0">
      <CollapsibleTrigger
        title={`${blocks.length} ${blocks.length === 1 ? 'step' : 'steps'}`}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-sm border-b border-border pb-2.5 text-left text-[13.5px] text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
      >
        <span className="shrink-0">{label}</span>
        {summary !== '' ? (
          <span data-slot="work-summary" className="min-w-0 truncate text-soft-foreground">
            · {summary}
          </span>
        ) : null}
        <ChevronRightIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 transition-transform group-data-[state=open]/work:rotate-90"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <WorkBody blocks={blocks} stats={stats} scope={scope} renderEntry={renderEntry} renderNested={renderNested} />
      </CollapsibleContent>
    </Collapsible>
  )
}

function WorkBody({
  blocks,
  stats,
  scope,
  renderEntry,
  renderNested,
}: {
  blocks: readonly ThreadBlock[]
  stats: WorkStats
  scope: string
  renderEntry: (entry: ThreadEntry, scope: string) => ReactNode
  renderNested: (entries: readonly ThreadEntry[], scope: string) => ReactNode
}) {
  const steps = useMemo(() => workSteps(blocks), [blocks])
  const [filter, setFilter] = useState<Filter>('all')
  const present = BUCKETS.filter(({ id }) => stats.buckets[id] > 0)
  // A filter is only worth its row when there is something to tell apart.
  const filterable = present.length > 1 || (present.length === 1 && stats.failed > 0)
  const active: Filter = filterable ? filter : 'all'

  // `all` keeps the stream's order and everything in it; a bucket is just its calls.
  const segments = useMemo(() => {
    const out: Array<
      { kind: 'tools'; id: string; tools: ToolStep[] } | { kind: 'notes'; id: string; notes: EntryStep[] } | EntryStep
    > = []
    for (const step of steps) {
      if (step.kind === 'entry') {
        if (active !== 'all') continue
        // System notes arrive in runs ("run started", "worktree ready", …): one tight block
        // reads as the aside it is, where a full row gap per line read as four events.
        const last = out.at(-1)
        if (step.entry.kind !== 'note') out.push(step)
        else if (last !== undefined && last.kind === 'notes') last.notes.push(step)
        else out.push({ kind: 'notes', id: `notes:${step.id}`, notes: [step] })
        continue
      }
      const bucket = BUCKET_OF[step.item.toolKind]
      if (bucket === undefined) continue
      if (active === 'failed' ? step.item.status !== 'failed' : active !== 'all' && bucket !== active) continue
      const last = out.at(-1)
      if (last !== undefined && last.kind === 'tools') last.tools.push(step)
      else out.push({ kind: 'tools', id: `tools:${step.id}`, tools: [step] })
    }
    return out
  }, [steps, active])

  return (
    <div data-slot="work-body" className="flex flex-col gap-3 border-b border-border py-3.5">
      {filterable ? (
        <ToggleGroup
          type="single"
          size="sm"
          spacing={1}
          value={active}
          onValueChange={(value) => setFilter(value === '' ? 'all' : (value as Filter))}
          aria-label="Filter the work by kind"
          data-slot="work-filter"
          className="flex-wrap"
        >
          <FilterChip value="all" label="All" count={stats.total} />
          {present.map(({ id, icon, chip }) => (
            <FilterChip key={id} value={id} icon={icon} label={chip} count={stats.buckets[id]} />
          ))}
          {stats.failed > 0 ? (
            <FilterChip value="failed" icon={CircleAlertIcon} label="Failed" count={stats.failed} danger />
          ) : null}
        </ToggleGroup>
      ) : null}
      {segments.map((segment) =>
        segment.kind === 'tools' ? (
          <ToolList key={`${active}:${segment.id}`} tools={segment.tools} scope={scope} renderNested={renderNested} />
        ) : segment.kind === 'notes' ? (
          <div key={segment.id} data-slot="work-notes" className="flex min-w-0 flex-col gap-0.5 px-0.5">
            {segment.notes.map((note) => (
              <div key={note.id} className="min-w-0">
                {renderEntry(note.entry, scope)}
              </div>
            ))}
          </div>
        ) : (
          <div key={segment.id} data-slot="work-entry" className="min-w-0 px-0.5">
            {renderEntry(segment.entry, scope)}
          </div>
        ),
      )}
    </div>
  )
}

function FilterChip({
  value,
  icon: Icon,
  label,
  count,
  danger = false,
}: {
  value: Filter
  icon?: LucideIcon
  label: string
  count: number
  danger?: boolean
}) {
  return (
    <ToggleGroupItem
      value={value}
      data-bucket={value}
      className="h-7 gap-1.5 rounded-full border border-transparent px-2.5 text-xs font-normal text-muted-foreground hover:bg-muted hover:text-foreground data-[state=on]:border-border data-[state=on]:bg-muted data-[state=on]:text-foreground"
    >
      {Icon ? <Icon aria-hidden="true" className={cn('size-3.5', danger && 'text-danger')} /> : null}
      {label}
      <span className="font-mono text-[11px] tabular-nums text-soft-foreground">{count}</span>
    </ToggleGroupItem>
  )
}

/** Consecutive calls as ONE bordered list of rows — the card is the list, not each call. */
function ToolList({
  tools,
  scope,
  renderNested,
}: {
  tools: readonly ToolStep[]
  scope: string
  renderNested: (entries: readonly ThreadEntry[], scope: string) => ReactNode
}) {
  const [showAll, setShowAll] = useState(false)
  const clamped = !showAll && tools.length > LIST_CLAMP
  const visible = clamped ? tools.slice(0, LIST_CLAMP) : tools
  return (
    <div
      data-slot="tool-list"
      className="min-w-0 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card"
    >
      {visible.map((step) => (
        <ToolCard
          key={step.id}
          variant="row"
          item={step.item}
          nested={step.children}
          cacheKey={`${scope}:${step.id}`}
          renderNested={renderNested}
        />
      ))}
      {clamped ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-slot="tool-list-more"
          onClick={() => setShowAll(true)}
          className="h-9 w-full justify-start rounded-none px-3 text-xs font-normal text-muted-foreground"
        >
          Show {tools.length - LIST_CLAMP} more
        </Button>
      ) : null}
    </div>
  )
}
