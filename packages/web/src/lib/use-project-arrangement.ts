import { KeyboardSensor, PointerSensor, useSensor, useSensors, type Announcements, type DragEndEvent } from '@dnd-kit/core'
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import * as React from 'react'

import type { ProjectListEntry } from '@open-mercato/cezar-api-client'

import { moveProjectBetweenFolders, readProjectFolders, saveProjectFolder, writeProjectFolders, type ProjectFolder } from './project-folders'
import { moveProjectId, orderProjects } from './project-order'
import { useProjectOrder } from './use-project-order'

/** dnd-kit ids: a folder header sorts under this prefix, a project under its own id. */
export const FOLDER_DND_PREFIX = 'folder:'

export interface ProjectSection {
  /** `null` is the trailing "No folder" group. */
  folder: ProjectFolder | null
  projects: ProjectListEntry[]
}

/**
 * How the project switcher arranges the registry (moved out of the retired per-project sidebar
 * tree, #952 / folders): the user's hand-picked order over `lastOpenedAt`, the per-browser
 * folders, and the one dnd-kit context that reorders projects, moves them between folders and
 * reorders the folders themselves.
 */
export function useProjectArrangement(projects: readonly ProjectListEntry[]) {
  const [folders, setFolders] = React.useState(readProjectFolders)
  const [editingFolder, setEditingFolder] = React.useState<ProjectFolder | null | undefined>(undefined)
  const saveFolder = React.useCallback(
    (folder: ProjectFolder | null, previousId?: string) => {
      const next = saveProjectFolder(folders, folder, previousId)
      setFolders(next)
      writeProjectFolders(next)
      setEditingFolder(undefined)
    },
    [folders],
  )

  const { order, canReorder, setOrder } = useProjectOrder()
  const ordered = React.useMemo(() => {
    const placed = orderProjects(projects, order)
    // An UNREGISTERED boot folder leads: it has no `lastOpenedAt` and no registry entry to be
    // placed by hand. A stable partition, so the result is still a permutation of the input.
    const lead = placed.filter((project) => project.unregistered)
    if (lead.length === 0) return placed
    return [...lead, ...placed.filter((project) => !project.unregistered)]
  }, [projects, order])
  const orderedIds = React.useMemo(() => ordered.map((project) => project.id), [ordered])

  const sections = React.useMemo<ProjectSection[]>(() => {
    const grouped = folders.map((folder) => ({
      folder,
      projects: ordered.filter((project) => folder.projectIds.includes(project.id)),
    }))
    const loose = ordered.filter((project) => !folders.some((folder) => folder.projectIds.includes(project.id)))
    // "No folder" only earns a heading beside other folders; alone it is just the list.
    return loose.length > 0 || folders.length === 0 ? [...grouped, { folder: null, projects: loose }] : grouped
  }, [folders, ordered])

  // The small pointer distance keeps a plain click a click; the coordinate getter is what makes
  // Space/arrows/Space work.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  // One project cannot be reordered, and neither can any number before the authoritative
  // ui-state GET lands — a write composed from an empty cache would drop the file's other keys.
  const sortable = canReorder && ordered.length > 1

  const folderOf = React.useCallback(
    (id: string): ProjectFolder | undefined =>
      id.startsWith(FOLDER_DND_PREFIX)
        ? folders.find((folder) => folder.id === id.slice(FOLDER_DND_PREFIX.length))
        : folders.find((folder) => folder.projectIds.includes(id)),
    [folders],
  )

  const handleDragEnd = React.useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      if (over === null || over.id === active.id) return
      const activeId = String(active.id)
      const overId = String(over.id)

      if (activeId.startsWith(FOLDER_DND_PREFIX)) {
        // A folder lands where the folder under the pointer (or the one holding that project) is.
        const from = folders.findIndex((folder) => folder.id === activeId.slice(FOLDER_DND_PREFIX.length))
        const target = folderOf(overId)
        const to = target === undefined ? -1 : folders.findIndex((folder) => folder.id === target.id)
        if (from === -1 || to === -1 || from === to) return
        const next = arrayMove(folders, from, to)
        setFolders(next)
        writeProjectFolders(next)
        return
      }

      const overFolder = folderOf(overId)
      if (folderOf(activeId)?.id !== overFolder?.id) {
        const nextFolders = moveProjectBetweenFolders(folders, activeId, overFolder?.id ?? null)
        setFolders(nextFolders)
        writeProjectFolders(nextFolders)
      }
      if (overId.startsWith(FOLDER_DND_PREFIX)) return
      const from = orderedIds.indexOf(activeId)
      const to = orderedIds.indexOf(overId)
      if (from === -1 || to === -1) return
      // The WHOLE visible order is persisted, not just the moved id, so nothing re-sorts itself
      // back to the top on the next read.
      setOrder(moveProjectId(orderedIds, from, to))
    },
    [folders, folderOf, orderedIds, setOrder],
  )

  // dnd-kit's defaults would read out slugs and coordinates; a person needs names and positions.
  const announcements = React.useMemo<Announcements>(() => {
    const describe = (id: string | number) => {
      const key = String(id)
      if (key.startsWith(FOLDER_DND_PREFIX)) {
        const index = folders.findIndex((folder) => folder.id === key.slice(FOLDER_DND_PREFIX.length))
        return { name: folders[index]?.name ?? key, position: `folder ${index + 1} of ${folders.length}` }
      }
      const index = orderedIds.indexOf(key)
      return { name: ordered[index]?.name ?? key, position: `position ${index + 1} of ${orderedIds.length}` }
    }
    return {
      onDragStart: ({ active }) => {
        const { name, position } = describe(active.id)
        return `Picked up ${name}, ${position}.`
      },
      onDragOver: ({ active, over }) =>
        over
          ? `${describe(active.id).name} moved to ${describe(over.id).position}.`
          : `${describe(active.id).name} is not over a drop position.`,
      onDragEnd: ({ active, over }) =>
        over
          ? `${describe(active.id).name} dropped at ${describe(over.id).position}.`
          : `${describe(active.id).name} dropped. The order is unchanged.`,
      onDragCancel: ({ active }) =>
        `Reordering cancelled. ${describe(active.id).name} returned to ${describe(active.id).position}.`,
    }
  }, [folders, ordered, orderedIds])

  return {
    ordered,
    orderedIds,
    folders,
    sections,
    sortable,
    sensors,
    announcements,
    handleDragEnd,
    editingFolder,
    setEditingFolder,
    saveFolder,
  }
}
