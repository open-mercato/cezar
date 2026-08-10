import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

import type { SubagentSummary } from './subagent-dock'
import type { ThreadAsk, ThreadEntry } from './thread-state'
import { SessionTranscript, agentTranscriptSections } from './session-transcript'

/**
 * The sub-agent drill-down (spec `.ai/specs/2026-07-20-grouped-subagent-display.md`
 * §"Drill-down sheet", issue #474; mockup `mockup-02-subagent-sheet.png`): one agent's full
 * child stream in a focused right-side panel, entered from an Agents-dock row.
 *
 * It reads the same reducer state the thread does and hands it to `SessionTranscript`, so
 * grouping, cards, attachments, virtualization, and follow-tail behavior cannot drift from
 * the main session. No new persistence, route, or deep link — the selection is one id in
 * component state (spec Q2/Q5).
 */
export function SubagentSheet({
  runId,
  renderAsk,
  agent,
  entries,
  onClose,
}: {
  runId: string
  renderAsk?: (ask: ThreadAsk) => ReactNode
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
        className="flex min-h-0 w-full gap-0 p-0 sm:max-w-xl"
      >
        {agent !== undefined ? (
          <SheetBody runId={runId} renderAsk={renderAsk} agent={agent} entries={entries} />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function SheetBody({
  runId,
  renderAsk,
  agent,
  entries,
}: {
  runId: string
  renderAsk?: (ask: ThreadAsk) => ReactNode
  agent: SubagentSummary
  entries: ThreadEntry[]
}) {
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
      <SessionTranscript
        runId={runId}
        viewId={`agent:${agent.id}`}
        sections={agentTranscriptSections(agent.id, entries)}
        mode="panel"
        renderAsk={renderAsk}
        empty={
          <div data-slot="subagent-empty" className="py-2 text-[13px] text-muted-foreground">
            No attributed output — see the thread card for this agent&apos;s result.
          </div>
        }
      />
    </>
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
