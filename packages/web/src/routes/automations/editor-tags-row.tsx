import { RUN_TAGS_MAX, type AutomationTaskTag, type RunTag } from '@open-mercato/cezar-api-client'
import { useActiveProjectId, useTaskTags } from '@/api/task-tags'
import { AddTagButton, TaskTagChip, TaskTagPicker, type TagRowState } from '@/components/task-tag-picker'
import { resolveAutomationTags } from '@/lib/task-tags'

/** The task tags every launched run gets (spec 2026-11-23-task-tags § 5a). */
export function EditorTagsRow({ tags, onChange }: { tags: AutomationTaskTag[]; onChange: (tags: AutomationTaskTag[]) => void }) {
  const projectId = useActiveProjectId()
  const registry = useTaskTags()
  const shown = resolveAutomationTags(tags, registry.data, projectId)
  const missing = shown.filter((tag) => tag.snapshot).length
  const stateOf = (id: string): TagRowState => (shown.some((tag) => tag.id === id && !tag.snapshot) ? 'checked' : 'empty')
  const removeAt = (index: number) => onChange(tags.filter((_, i) => i !== index))
  const toggle = (tag: RunTag, add: boolean) => {
    if (!add) {
      onChange(tags.filter((_, i) => shown[i]?.id !== tag.id))
      return
    }
    if (shown.some((t) => t.id === tag.id && !t.snapshot)) return
    onChange([...tags, { id: tag.id, name: tag.name }])
  }
  return (
    <div data-slot="editor-tags" className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-label text-muted-foreground">Tag each run</span>
        {shown.map((tag, index) => (
          <TaskTagChip key={`${tag.id}-${index}`} tag={tag} onRemove={() => removeAt(index)} />
        ))}
        <TaskTagPicker projectId={projectId} stateOf={stateOf} onToggle={toggle}>
          <AddTagButton compact={shown.length > 0} disabled={tags.length >= RUN_TAGS_MAX} />
        </TaskTagPicker>
      </div>
      {missing > 0 ? (
        <p data-slot="editor-tags-missing" className="m-0 text-label text-muted-foreground">
          {missing === 1 ? 'A gray tag no longer exists' : 'Gray tags no longer exist'}; runs start without {missing === 1 ? 'it' : 'them'}.
        </p>
      ) : null}
    </div>
  )
}
