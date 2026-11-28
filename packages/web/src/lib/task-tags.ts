import type { RunTag, TaskTag, TaskTagColor, TaskTagsList } from '@open-mercato/cezar-api-client'

/**
 * Task tags in the cockpit (spec 2026-11-23-task-tags). The server keeps each run's snapshot
 * verbatim; resolving it against the registry happens here, in one place (§ 4.3).
 */

/** The project task list's "No tag" filter value. A leading space keeps it out of the id space
 *  (`tt-…`). Not `UNTAGGED` from `global-tasks.ts`, which means "the PROJECT has no tags". */
export const NO_TASK_TAG = ' no-task-tag'

/** A chip as the cockpit paints it. `snapshot` = the registry does not know the id (D4): neutral
 *  color, removable and filterable, not editable. */
export interface ResolvedRunTag {
  id: string
  name: string
  color?: TaskTagColor
  snapshot: boolean
}

/** Registry wins when it has the id; a tombstoned id is hidden; an unknown id is its snapshot. */
export function resolveRunTags(
  tags: readonly RunTag[] | undefined,
  registry: Pick<TaskTagsList, 'tags' | 'deletedIds'> | undefined,
): ResolvedRunTag[] {
  if (!tags || tags.length === 0) return []
  const byId = new Map((registry?.tags ?? []).map((tag) => [tag.id, tag]))
  const deleted = new Set(registry?.deletedIds ?? [])
  const out: ResolvedRunTag[] = []
  for (const tag of tags) {
    if (deleted.has(tag.id)) continue
    const live = byId.get(tag.id)
    if (live) out.push({ id: live.id, name: live.name, ...(live.color ? { color: live.color } : {}), snapshot: false })
    else out.push({ id: tag.id, name: tag.name, snapshot: true })
  }
  return out
}

/** The tags a picker offers in `projectId`: its own, then global; each by `lastUsedAt`, then name.
 *  Orphaned tags are never offered (§ 9). */
export function pickerTags(registry: TaskTagsList | undefined, projectId: string | undefined): { project: TaskTag[]; global: TaskTag[] } {
  const live = (registry?.tags ?? []).filter((tag) => !tag.orphaned)
  const order = (a: TaskTag, b: TaskTag) =>
    (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '') || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  return {
    project: live.filter((tag) => tag.projectId !== undefined && tag.projectId === projectId).sort(order),
    global: live.filter((tag) => tag.projectId === undefined).sort(order),
  }
}

/** D6's comparison: trimmed, case-folded. */
export function tagNameKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Does `query` name no visible tag, so the picker should offer `Create "<query>"`? */
export function offersCreate(query: string, visible: readonly Pick<TaskTag, 'name'>[]): boolean {
  const key = tagNameKey(query)
  return key !== '' && !visible.some((tag) => tagNameKey(tag.name) === key)
}

/** The swatch class for a tag color (`--color-tag-*` in index.css); a snapshot chip is gray. */
export function tagSwatchClass(color: TaskTagColor | undefined): string {
  switch (color) {
    case 'red':
      return 'bg-tag-red'
    case 'orange':
      return 'bg-tag-orange'
    case 'amber':
      return 'bg-tag-amber'
    case 'green':
      return 'bg-tag-green'
    case 'teal':
      return 'bg-tag-teal'
    case 'blue':
      return 'bg-tag-blue'
    case 'violet':
      return 'bg-tag-violet'
    default:
      return 'bg-tag-gray'
  }
}

/** Apply a delta to a run's snapshot list the way the server does (D8), for optimistic updates. */
export function applyTagDelta(current: readonly RunTag[] | undefined, add: readonly RunTag[], remove: readonly string[]): RunTag[] {
  const removed = new Set(remove)
  const next = (current ?? []).filter((tag) => !removed.has(tag.id))
  for (const tag of add) {
    const at = next.findIndex((t) => t.id === tag.id)
    if (at === -1) next.push(tag)
    else next[at] = tag
  }
  return next
}

/** One chip per case-folded name across projects (the global page, § 7.5): picking it selects
 *  every id in the group; its color is the most recently used member's. */
export interface TagGroup {
  key: string
  name: string
  ids: string[]
  color?: TaskTagColor
}

export function groupTagsByName(tags: readonly (ResolvedRunTag & { lastUsedAt?: string })[]): TagGroup[] {
  const groups = new Map<string, TagGroup & { usedAt: string }>()
  for (const tag of tags) {
    const key = tagNameKey(tag.name)
    const used = tag.lastUsedAt ?? ''
    const group = groups.get(key)
    if (!group) {
      groups.set(key, { key, name: tag.name, ids: [tag.id], ...(tag.color ? { color: tag.color } : {}), usedAt: used })
      continue
    }
    if (!group.ids.includes(tag.id)) group.ids.push(tag.id)
    if (used > group.usedAt) {
      group.usedAt = used
      group.name = tag.name
      if (tag.color) group.color = tag.color
      else delete group.color
    }
  }
  return [...groups.values()]
    .map(({ usedAt: _usedAt, ...group }) => group)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}
