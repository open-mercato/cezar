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
      className="flex flex-col gap-3"
    >
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0 space-y-1">
          <Label htmlFor="automation-dispatch" className="text-sm font-medium text-foreground">
            <GitForkIcon aria-hidden="true" className={cn('size-4', enabled ? 'text-foreground' : 'text-muted-foreground')} />
            Dispatch
          </Label>
          <p className="text-sm text-muted-foreground">
            Let this run start its own subtasks with <code className="font-mono text-xs">cez task create</code> — each in a worktree forked off its branch, reporting back into the parent session.
          </p>
        </div>
        <Switch id="automation-dispatch" aria-label="Dispatch" checked={enabled} onCheckedChange={(next) => onChange({ dispatch: next })} />
      </div>
      {enabled ? (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-muted-foreground">
          <span className="inline-flex items-center gap-2">
            Up to
            <Select value={String(maxSubtasks)} onValueChange={(value) => onChange({ maxSubtasks: Number(value) })}>
              <SelectTrigger size="sm" aria-label="Max subtasks">
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
          <Label className="text-[13px] font-normal text-muted-foreground">
            <Switch size="sm" aria-label="Review child" checked={reviewChild} onCheckedChange={(next) => onChange({ reviewChild: next })} />
            Review child
          </Label>
          <span data-slot="editor-dispatch-hint" className="ml-auto text-xs whitespace-nowrap tabular-nums">
            ≤ {maxSubtasks + 1} agents
          </span>
        </div>
      ) : null}
    </div>
  )
}
