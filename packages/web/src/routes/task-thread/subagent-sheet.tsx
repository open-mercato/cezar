import { useEffect, useRef } from 'react'

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'

import type { SubagentSummary } from './subagent-dock'
import type { ThreadEntry } from './thread-state'
import { NestedEntry } from './thread-items'

/**
 * The sub-agent drill-down (spec `.ai/specs/2026-07-20-grouped-subagent-display.md`
 * §"Drill-down sheet", issue #474; mockup `mockup-02-subagent-sheet.png`): one agent's full
 * child stream in a focused right-side panel, entered from an Agents-dock row.
 *
 * It reads the same reducer state the thread does and renders it with the same `NestedEntry`
 * components, so it live-updates for free and a replayed (finished) run shows byte-identical
 * content. No new persistence, no route, no deep link — the selection is one id in component
 * state (spec Q2/Q5).
 */
export function SubagentSheet({
  agent,
  entries,
  onClose,
}: {
  /** The selected agent, or `undefined` when the sheet is closed. */
  agent: SubagentSummary | undefined
  /** That agent's child entries, in stream order (`subagentChildren`). */
  entries: ThreadEntry[]
  onClose: () => void
}) {
  return (
    <Sheet open={agent !== undefined} onOpenChange={(open) => { if (!open) onClose() }}>
      <SheetContent
        data-slot="subagent-sheet"
        side="right"
        // Wider than the default `sm:max-w-sm`: this panel carries tool cards and diffs,
        // not a settings form.
        className="w-full gap-0 p-0 sm:max-w-xl"
      >
        {agent !== undefined ? <SheetBody agent={agent} entries={entries} /> : null}
      </SheetContent>
    </Sheet>
  )
}

function SheetBody({ agent, entries }: { agent: SubagentSummary; entries: ThreadEntry[] }) {
  return (
    <>
      <SheetHeader className="gap-1.5 border-b border-border px-5 py-4">
        <SheetTitle className="flex min-w-0 items-center gap-2 pr-8 text-[15px]">
          <span className="min-w-0 truncate">{agent.title}</span>
          {agent.agentType !== undefined ? (
            <span
              data-slot="agent-type"
              className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10.5px] font-semibold tracking-[0.05em] text-muted-foreground uppercase"
            >
              {agent.agentType}
            </span>
          ) : null}
        </SheetTitle>
        <SheetDescription data-slot="subagent-meta" className="flex items-center gap-2 text-xs">
          <StatusPill status={agent.status} />
          <span className="tabular-nums">
            {agent.toolCalls} {agent.toolCalls === 1 ? 'tool call' : 'tool calls'}
          </span>
        </SheetDescription>
      </SheetHeader>
      <SubagentStream entries={entries} scope={agent.id} />
    </>
  )
}

/**
 * The agent's children, tailing live output the way the thread does: pinned to the bottom
 * unless the reader scrolled up, so a long-running agent does not yank the panel out from
 * under someone reading an earlier tool call.
 */
function SubagentStream({ entries, scope }: { entries: ThreadEntry[]; scope: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)

  // Keyed on CONTENT, not entry count: `item.delta` grows the existing last entry in place,
  // so a length-only dep would never fire during the streaming this affordance exists for.
  // `thread-state` applies deltas TWO ways — `item.text += delta` for message/reasoning and
  // `item.output += delta` for tools — so both have to be in the signature. Counting only text
  // would leave the panel pinned to a stale offset while a sub-agent streams command output,
  // which is exactly the long-running case this affordance exists for.
  const signature = entries.reduce(
    (sum, entry) =>
      sum +
      (entry.kind === 'message' || entry.kind === 'reasoning'
        ? entry.text.length
        : entry.kind === 'tool'
          ? (entry.output?.length ?? 0) + (entry.error?.length ?? 0)
          : 0),
    entries.length,
  )
  useEffect(() => {
    const node = ref.current
    if (node === null || !stuck.current) return
    node.scrollTop = node.scrollHeight
  }, [signature])

  if (entries.length === 0) {
    return (
      <div data-slot="subagent-empty" className="px-5 py-6 text-[13px] text-muted-foreground">
        No attributed output — see the thread card for this agent&apos;s result.
      </div>
    )
  }

  return (
    <div
      ref={ref}
      data-slot="subagent-stream"
      onScroll={(event) => {
        const node = event.currentTarget
        // 24px of slack: "close enough to the bottom" survives sub-pixel scroll heights.
        stuck.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24
      }}
      className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-5 py-4"
    >
      {entries.map((entry) => (
        <NestedEntry key={entry.id} entry={entry} scope={`subagent:${scope}`} />
      ))}
    </div>
  )
}

/** Status as a word, not only a hue — the dock's glyphs do not survive being read aloud. */
function StatusPill({ status }: { status: SubagentSummary['status'] }) {
  const label =
    status === 'completed'
      ? 'Completed'
      : status === 'failed'
        ? 'Failed'
        : status === 'declined'
          ? 'Declined'
          : status === 'pending'
            ? 'Pending'
            : 'Running'
  return (
    <span
      data-slot="subagent-status"
      data-status={status}
      className={cn(
        'rounded-full px-2 py-0.5 text-[10.5px] font-semibold tracking-[0.05em] uppercase',
        status === 'completed' && 'bg-success/15 text-success',
        (status === 'failed' || status === 'declined') && 'bg-danger/15 text-danger',
        (status === 'running' || status === 'pending') && 'bg-muted text-muted-foreground',
      )}
    >
      {label}
    </span>
  )
}
