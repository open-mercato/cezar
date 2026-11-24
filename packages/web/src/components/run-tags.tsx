import { TagIcon } from 'lucide-react'

import { RUN_TAGS_MAX, type RunTag } from '@open-mercato/cezar-api-client'
import { useActiveProjectId, useEditRunTags, useHasQueryClient, useOptionalTaskTags } from '@/api/task-tags'
import { AddTagButton, TaskTagChip, TaskTagPicker, type TagRowState } from '@/components/task-tag-picker'
import { Button } from '@/components/ui/button'
import { resolveRunTags, type ResolvedRunTag } from '@/lib/task-tags'
import { cn } from '@/lib/utils'

/** One run's resolved chips (spec 2026-11-23-task-tags § 7.3). */
export function useRunTags(tags: readonly RunTag[] | undefined): ResolvedRunTag[] {
  return resolveRunTags(tags, useOptionalTaskTags())
}

/** Read-only chips, collapsing to `+N` past `max` (the task list row). */
export function RunTagChips({ tags, max = 2, className }: { tags: readonly RunTag[] | undefined; max?: number; className?: string }) {
  const resolved = useRunTags(tags)
  if (resolved.length === 0) return null
  const shown = resolved.slice(0, max)
  const rest = resolved.length - shown.length
  return (
    <span data-slot="run-tag-chips" className={cn('inline-flex min-w-0 items-center gap-1', className)}>
      {shown.map((tag) => (
        <TaskTagChip key={tag.id} tag={tag} />
      ))}
      {rest > 0 ? (
        <span className="text-label text-muted-foreground" title={resolved.slice(max).map((t) => t.name).join(', ')}>
          +{rest}
        </span>
      ) : null}
    </span>
  )
}

/** The edit half: toggling a tag on one run is one delta through the optimistic mutation. */
export function useRunTagToggle(runId: string, tags: readonly RunTag[] | undefined) {
  const edit = useEditRunTags()
  const ids = new Set((tags ?? []).map((t) => t.id))
  const stateOf = (id: string): TagRowState => (ids.has(id) ? 'checked' : 'empty')
  const toggle = (tag: RunTag, add: boolean) => {
    if (add && !ids.has(tag.id) && ids.size >= RUN_TAGS_MAX) return
    edit.mutate(add ? { runId, add: [tag] } : { runId, remove: [tag.id] })
  }
  return { stateOf, toggle, error: edit.error }
}

/** The task header's tags: chips with ×, plus a `+` that opens the picker. `open`/`onOpenChange`
 *  let the ⋯ menu's `Tags…` open the same picker. */
export function RunTagsEditor({
  run,
  open,
  onOpenChange,
}: {
  run: { id: string; tags?: RunTag[] }
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const projectId = useActiveProjectId()
  const resolved = useRunTags(run.tags)
  const { stateOf, toggle } = useRunTagToggle(run.id, run.tags)
  return (
    <span data-slot="run-tags" className="inline-flex min-w-0 flex-wrap items-center gap-1">
      {resolved.map((tag) => (
        <TaskTagChip key={tag.id} tag={tag} onRemove={() => toggle(tag, false)} />
      ))}
      <TaskTagPicker projectId={projectId} stateOf={stateOf} onToggle={toggle} open={open} onOpenChange={onOpenChange}>
        <AddTagButton compact={resolved.length > 0} aria-label="Add a tag" />
      </TaskTagPicker>
    </span>
  )
}

/** The task-row quick action: a tag icon that opens the picker anchored to the row button. */
export function RunTagQuickAction(props: Parameters<typeof RunTagQuickActionInner>[0]) {
  return useHasQueryClient() ? <RunTagQuickActionInner {...props} /> : null
}

function RunTagQuickActionInner({ run, title, disabled }: { run: { id: string; tags?: RunTag[] }; title: string; disabled?: boolean }) {
  const projectId = useActiveProjectId()
  const { stateOf, toggle } = useRunTagToggle(run.id, run.tags)
  const label = `Tag: ${title}`
  return (
    // The row navigates on click; the picker must not.
    <span className="inline-flex" onClick={(event) => event.stopPropagation()}>
      <TaskTagPicker projectId={projectId} stateOf={stateOf} onToggle={toggle} align="end" disabled={disabled}>
        <Button type="button" variant="ghost" size="icon-sm" data-action="tag" title={label} aria-label={label} disabled={disabled}>
          <TagIcon className="size-3.5" aria-hidden="true" />
        </Button>
      </TaskTagPicker>
    </span>
  )
}

/** Bulk tri-state across a selection (spec § 7.3): checked = every task has it, mixed = some. */
export function bulkTagState(runs: ReadonlyArray<{ tags?: RunTag[] }>, tagId: string): TagRowState {
  const count = runs.filter((run) => run.tags?.some((t) => t.id === tagId)).length
  return count === 0 ? 'empty' : count === runs.length ? 'checked' : 'mixed'
}

export interface BulkTagOutcome {
  changed: number
  skippedCap: number
  failed: number
}

/** One delta per task, at most 4 in flight; a failure skips only that task (spec § 7.3). */
export async function applyBulkTag(
  runs: ReadonlyArray<{ id: string; tags?: RunTag[] }>,
  tag: RunTag,
  add: boolean,
  send: (edit: { runId: string; add?: RunTag[]; remove?: string[] }) => Promise<unknown>,
): Promise<BulkTagOutcome> {
  const outcome: BulkTagOutcome = { changed: 0, skippedCap: 0, failed: 0 }
  const targets = runs.filter((run) => {
    const has = run.tags?.some((t) => t.id === tag.id) ?? false
    if (add && !has && (run.tags?.length ?? 0) >= RUN_TAGS_MAX) {
      outcome.skippedCap += 1
      return false
    }
    return add ? !has : has
  })
  let next = 0
  const worker = async () => {
    while (next < targets.length) {
      const run = targets[next++]!
      try {
        await send(add ? { runId: run.id, add: [tag] } : { runId: run.id, remove: [tag.id] })
        outcome.changed += 1
      } catch {
        outcome.failed += 1
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, targets.length) }, worker))
  return outcome
}

export function bulkTagMessage(tag: RunTag, add: boolean, outcome: BulkTagOutcome): string {
  const verb = add ? 'Tagged' : 'Untagged'
  const parts = [`${verb} ${outcome.changed} ${outcome.changed === 1 ? 'task' : 'tasks'} ${add ? 'with' : 'from'} “${tag.name}”`]
  if (outcome.skippedCap > 0) parts.push(`${outcome.skippedCap} skipped (${RUN_TAGS_MAX}-tag limit)`)
  if (outcome.failed > 0) parts.push(`${outcome.failed} failed`)
  return parts.join(' · ')
}

/** The selection bar's `Tag… (N)`. */
export function BulkTagButton(props: Parameters<typeof BulkTagButtonInner>[0]) {
  return useHasQueryClient() ? <BulkTagButtonInner {...props} /> : null
}

function BulkTagButtonInner({
  runs,
  disabled,
  onMessage,
}: {
  runs: ReadonlyArray<{ id: string; tags?: RunTag[] }>
  disabled?: boolean
  onMessage: (message: string) => void
}) {
  const projectId = useActiveProjectId()
  const edit = useEditRunTags()
  const toggle = (tag: RunTag, add: boolean) => {
    onMessage(`${add ? 'Tagging' : 'Untagging'}…`)
    void applyBulkTag(runs, tag, add, (variables) => edit.mutateAsync(variables)).then((outcome) =>
      onMessage(bulkTagMessage(tag, add, outcome)),
    )
  }
  return (
    <TaskTagPicker projectId={projectId} stateOf={(id) => bulkTagState(runs, id)} onToggle={toggle} disabled={disabled}>
      <Button type="button" size="sm" variant="outline" data-action="bulk-tag" disabled={disabled}>
        <TagIcon className="size-3.5" aria-hidden="true" />
        Tag… ({runs.length})
      </Button>
    </TaskTagPicker>
  )
}
