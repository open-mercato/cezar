import { CheckCircle2Icon, ChevronDownIcon, CircleXIcon, RotateCcwIcon, XIcon } from 'lucide-react'
import { useState } from 'react'

import type { WorkflowGraphNode } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Separator } from '@/components/ui/separator'
import { portsOf, portTone } from '@/lib/workflow-graph'
import { cn } from '@/lib/utils'

import { TONE } from './graph-node'

/**
 * The simulation's own bar, floating over the foot of the canvas: which node the walk stands on,
 * one button per way out of it, and — folded away until asked for — the path taken so far.
 */
export function SimBar({
  cursor,
  finished,
  taken,
  log,
  onStep,
  onRestart,
  onStop,
}: {
  /** The node the walk stands on; undefined once the run has ended. */
  cursor: WorkflowGraphNode | undefined
  finished: 'success' | 'failed' | undefined
  taken: number
  log: readonly string[]
  onStep: (port: string) => void
  onRestart: () => void
  onStop: () => void
}) {
  const [open, setOpen] = useState(false)
  const ended = finished !== undefined || !cursor
  const forked = cursor?.type === 'fork'

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      data-slot="sim-bar"
      className="absolute bottom-4 left-1/2 z-20 w-[min(560px,calc(100%-2rem))] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-card shadow-lg"
    >
      <CollapsibleContent>
        <ol className="max-h-44 overflow-y-auto border-b border-border/70 px-3.5 py-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {log.length === 0 ? <li>Nothing has happened yet.</li> : null}
          {log.map((line, index) => (
            <li key={index} className="flex gap-2">
              <span className="w-5 shrink-0 text-right text-soft-foreground tabular-nums">{index + 1}</span>
              <span className="min-w-0 break-words">{line}</span>
            </li>
          ))}
        </ol>
      </CollapsibleContent>
      <div className="flex flex-wrap items-center gap-2 p-2.5 pl-3.5">
        {ended ? (
          <span className="flex min-w-0 items-center gap-2 text-[13px]">
            {finished === 'failed' ? (
              <CircleXIcon className="size-4 shrink-0" style={{ color: TONE.failure }} />
            ) : (
              <CheckCircle2Icon className="size-4 shrink-0" style={{ color: TONE.success }} />
            )}
            <span>
              Run ends <b className="font-medium">{finished}</b> after {taken} steps.
            </span>
          </span>
        ) : (
          <>
            <span className="min-w-0 text-[13px] text-muted-foreground">
              <b className="font-medium text-foreground">{cursor.name ?? cursor.id}</b> ends with
            </span>
            {(forked ? ['done', 'failed'] : portsOf(cursor)).map((port) => (
              <Button
                key={port}
                size="sm"
                variant="outline"
                style={{ color: TONE[forked ? (port === 'failed' ? 'failure' : 'success') : portTone(cursor, port)] }}
                onClick={() => onStep(port)}
              >
                {forked ? (port === 'done' ? 'all branches done' : 'a branch failed') : port}
              </Button>
            ))}
          </>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <CollapsibleTrigger asChild>
            <Button size="sm" variant="ghost" className="gap-1 px-2 text-xs font-normal" aria-label="Path taken so far">
              <span className="tabular-nums">{log.length}</span> steps
              <ChevronDownIcon className={cn('size-3.5 transition-transform', !open && 'rotate-180')} />
            </Button>
          </CollapsibleTrigger>
          <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-4" />
          <Button size="icon-sm" variant="ghost" aria-label="Restart" title="Restart" onClick={onRestart}>
            <RotateCcwIcon />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Stop simulating" title="Stop simulating" onClick={onStop}>
            <XIcon />
          </Button>
        </div>
      </div>
    </Collapsible>
  )
}
