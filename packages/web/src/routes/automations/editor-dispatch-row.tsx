import { GitForkIcon } from 'lucide-react'

import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

import { DISPATCH_SUBTASK_OPTIONS } from './editor-draft'

/**
 * The automation's own dispatch setting (spec 2026-09-14-automations-redesign Q4, § UI/UX 4.4):
 * on/off, a subtask ceiling, and whether the run is asked to dispatch a review child. Rendered
 * only on a cockpit whose `capabilities.dispatch` is on — off, the row is absent rather than
 * disabled, because a saved `task.dispatch` is ignored at fire time there, never refused.
 */
export function EditorDispatchRow({
  available,
  enabled,
  maxSubtasks,
  reviewChild,
  onChange,
}: {
  available: boolean
  enabled: boolean
  maxSubtasks: number
  reviewChild: boolean
  onChange: (patch: { dispatch?: boolean; maxSubtasks?: number; reviewChild?: boolean }) => void
}) {
  if (!available) return null
  const options = DISPATCH_SUBTASK_OPTIONS.includes(maxSubtasks as (typeof DISPATCH_SUBTASK_OPTIONS)[number])
    ? DISPATCH_SUBTASK_OPTIONS
    : [...DISPATCH_SUBTASK_OPTIONS, maxSubtasks].sort((a, b) => a - b)
  return (
    <div
      data-slot="editor-dispatch"
      data-enabled={enabled ? 'true' : undefined}
      title="Let this run start its own subtasks with cez task create — each in a worktree forked off its branch, reporting back into the parent session."
      className="flex flex-wrap items-center gap-2.5 border-t border-border pt-3 text-[13px] text-muted-foreground"
    >
      <Label className="text-[13px] font-medium text-foreground">
        <GitForkIcon aria-hidden="true" className={cn('size-3.5', enabled ? 'text-violet' : 'text-soft-foreground')} />
        Dispatch
        <Switch aria-label="Dispatch" checked={enabled} onCheckedChange={(next) => onChange({ dispatch: next })} />
      </Label>
      {enabled ? (
        <>
          <span className="text-soft-foreground">·</span>
          <span className="inline-flex items-center gap-1.5">
            up to
            <Select value={String(maxSubtasks)} onValueChange={(value) => onChange({ maxSubtasks: Number(value) })}>
              <SelectTrigger size="sm" aria-label="Max subtasks" className="h-7 px-2 text-[12.5px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map((count) => (
                  <SelectItem key={count} value={String(count)}>{count}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            subtasks
          </span>
          <span className="text-soft-foreground">·</span>
          <Label className="text-[13px] font-normal text-muted-foreground">
            <Switch size="sm" aria-label="Review child" checked={reviewChild} onCheckedChange={(next) => onChange({ reviewChild: next })} />
            review child
          </Label>
          <span data-slot="editor-dispatch-hint" className="ml-auto text-[11.5px] whitespace-nowrap text-soft-foreground">
            ≤ {maxSubtasks + 1} agents
          </span>
        </>
      ) : null}
    </div>
  )
}
