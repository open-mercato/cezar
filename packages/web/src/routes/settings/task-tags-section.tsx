import { TagIcon } from 'lucide-react'
import { useRef, useState } from 'react'

import { useDeleteTaskTag, useTaskTags, useUpdateTaskTag } from '@/api/task-tags'
import { useProjects } from '@/api/queries'
import {
  TASK_TAG_COLORS,
  TASK_TAG_DESCRIPTION_MAX,
  TASK_TAG_NAME_MAX,
  type PatchTaskTagInput,
  type TaskTag,
} from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { LoadingState, SettingsSkeleton } from '@/components/loading-state'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button, buttonVariants } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { tagSwatchClass } from '@/lib/task-tags'
import { cn } from '@/lib/utils'
import { CardNote, SettingsCard, isCommitKey } from './form-row'

/**
 * Settings → Task tags (spec 2026-11-23-task-tags § 7.4): the registry grouped by scope. No usage
 * counts — the global /tasks filter answers "what is tagged X".
 */

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : 'Could not save')

export function TaskTagsSection() {
  const tags = useTaskTags()
  const projects = useProjects()
  const [deleting, setDeleting] = useState<TaskTag | null>(null)
  const remove = useDeleteTaskTag()

  if (tags.isPending) {
    return <LoadingState label="Loading tags…" data-slot="task-tags-loading"><SettingsSkeleton /></LoadingState>
  }
  if (tags.isError) {
    return <CenteredState icon={<TagIcon />} tone="danger" title="Task tags did not load" subtitle={tags.error.message} heading="h2" />
  }

  const names = new Map((projects.data?.projects ?? []).map((p) => [p.id, p.name]))
  const byName = (a: TaskTag, b: TaskTag) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  const all = [...tags.data.tags].sort(byName)
  const projectIds = [...new Set(all.filter((t) => t.projectId !== undefined && !t.orphaned).map((t) => t.projectId!))]
  const groups: Array<{ key: string; title: string; tags: TaskTag[] }> = [
    { key: 'global', title: 'Global', tags: all.filter((t) => t.projectId === undefined) },
    ...projectIds.map((id) => ({
      key: id,
      title: names.get(id) ?? id,
      tags: all.filter((t) => t.projectId === id && !t.orphaned),
    })),
    { key: 'orphaned', title: 'Unregistered project', tags: all.filter((t) => t.projectId !== undefined && t.orphaned === true) },
  ].filter((g) => g.tags.length > 0)

  if (groups.length === 0) {
    return (
      <div data-slot="task-tags-section" className="flex w-full flex-col gap-5">
        <CenteredState
          icon={<TagIcon />}
          title="No task tags yet"
          subtitle="Create one from the “+ Tag” chip in the new-task composer, or from a task’s tag menu."
          heading="h2"
        />
      </div>
    )
  }

  return (
    <div data-slot="task-tags-section" className="flex w-full flex-col gap-5">
      {groups.map((group) => (
        <SettingsCard key={group.key} slot={`task-tags-${group.key}`} title={group.title}>
          {group.tags.map((tag) => (
            <TagRow key={tag.id} tag={tag} onDelete={() => setDeleting(tag)} />
          ))}
        </SettingsCard>
      ))}
      <CardNote>Stored in ~/.cezar/task-tags.json.</CardNote>
      <AlertDialog open={deleting !== null} onOpenChange={(open) => { if (!open) setDeleting(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>The tag disappears from every task that carries it. The tasks themselves are untouched.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              data-action="task-tags-confirm-delete"
              className={buttonVariants({ variant: 'destructive' })}
              onClick={() => { if (deleting) remove.mutate(deleting.id) }}
            >
              Delete tag
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function TagRow({ tag, onDelete }: { tag: TaskTag; onDelete: () => void }) {
  const update = useUpdateTaskTag()
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState(tag.name)
  const [description, setDescription] = useState(tag.description ?? '')

  const patch = (body: PatchTaskTagInput, onFail?: () => void) => {
    setError(null)
    update.mutate({ tagId: tag.id, ...body }, {
      onError: (e) => { setError(errorMessage(e)); onFail?.() },
    })
  }
  const cancelled = useRef(false)
  const commitName = () => {
    if (cancelled.current) { cancelled.current = false; return }
    const next = name.trim()
    if (next === '' || next === tag.name) { setName(tag.name); return }
    patch({ name: next }, () => setName(tag.name))
  }
  const commitDescription = () => {
    const next = description.trim()
    if (next === (tag.description ?? '')) return
    patch({ description: next === '' ? null : next })
  }

  return (
    <div data-slot="task-tag-row" className="flex flex-col gap-1.5 px-4 py-3 text-ui">
      <div className="flex flex-wrap items-center gap-2.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Color of ${tag.name}: ${tag.color ?? 'gray'}`}
              className="flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-accent"
            >
              <span className={cn('size-3 rounded-full', tagSwatchClass(tag.color))} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {TASK_TAG_COLORS.map((color) => (
              <DropdownMenuItem key={color} onSelect={() => patch({ color: color === 'gray' ? null : color })}>
                <span className={cn('size-3 rounded-full', tagSwatchClass(color))} />
                {color}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Input
          aria-label={`Name of ${tag.name}`}
          className="w-48"
          value={name}
          maxLength={TASK_TAG_NAME_MAX}
          onChange={(e) => { cancelled.current = false; setName(e.target.value) }}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (isCommitKey(e)) { e.preventDefault(); commitName(); cancelled.current = true }
            else if (e.key === 'Escape') { cancelled.current = true; setName(tag.name); setError(null); e.currentTarget.blur() }
          }}
        />
        <Input
          aria-label={`Description of ${tag.name}`}
          className="min-w-48 flex-1"
          placeholder="Description"
          value={description}
          maxLength={TASK_TAG_DESCRIPTION_MAX}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={commitDescription}
          onKeyDown={(e) => { if (isCommitKey(e)) { e.preventDefault(); commitDescription() } }}
        />
        {tag.projectId !== undefined ? (
          <Button type="button" variant="outline" size="sm" onClick={() => patch({ global: true })}>
            Make global
          </Button>
        ) : null}
        <Button type="button" variant="outline" size="sm" onClick={onDelete}>
          Delete
        </Button>
      </div>
      {error ? <p role="alert" className="text-meta text-danger">{error}</p> : null}
    </div>
  )
}
