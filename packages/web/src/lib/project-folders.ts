export const PROJECT_FOLDERS_STORAGE_KEY = 'cez-project-folders'

export type ProjectFolder = { id: string; name: string; projectIds: string[] }

export function normalizeProjectFolders(value: unknown): ProjectFolder[] {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  const assigned = new Set<string>()
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const folder = entry as Record<string, unknown>
    const id = typeof folder.id === 'string' ? folder.id.trim() : ''
    if (!id || ids.has(id)) return []
    if (typeof folder.name !== 'string' || !folder.name.trim()) return []
    ids.add(id)
    const projectIds = Array.isArray(folder.projectIds)
      ? [...new Set(folder.projectIds.filter((pid): pid is string => typeof pid === 'string' && !assigned.has(pid)))]
      : []
    projectIds.forEach((pid) => assigned.add(pid))
    return [{ id, name: folder.name.trim(), projectIds }]
  })
}

export function readProjectFolders(): ProjectFolder[] {
  try {
    const raw = localStorage.getItem(PROJECT_FOLDERS_STORAGE_KEY)
    return raw === null ? [] : normalizeProjectFolders(JSON.parse(raw))
  } catch {
    return []
  }
}

export function writeProjectFolders(folders: ProjectFolder[]): void {
  try {
    localStorage.setItem(PROJECT_FOLDERS_STORAGE_KEY, JSON.stringify(folders))
  } catch {
    // Private mode or full storage: folders still apply until the page reloads.
  }
}

/**
 * Upsert or remove a folder, enforcing that projects assigned to the saved folder
 * are removed from any other folder (the move-removes-from-previous-folder invariant).
 */
export function saveProjectFolder(
  folders: ProjectFolder[],
  folder: ProjectFolder | null,
  previousId?: string,
): ProjectFolder[] {
  let next = folders.filter((item) => item.id !== previousId && item.id !== folder?.id)
  if (folder) {
    next = next.map((item) => ({
      ...item,
      projectIds: item.projectIds.filter((id) => !folder.projectIds.includes(id)),
    }))
    next.push(folder)
  }
  return next
}

/**
 * Move a project across folder boundaries (or to ungrouped when targetFolderId is null).
 */
export function moveProjectBetweenFolders(
  folders: ProjectFolder[],
  projectId: string,
  targetFolderId: string | null,
): ProjectFolder[] {
  return folders.map((folder) => {
    if (folder.id === targetFolderId) {
      if (folder.projectIds.includes(projectId)) return folder
      return { ...folder, projectIds: [...folder.projectIds, projectId] }
    }
    if (folder.projectIds.includes(projectId)) {
      return { ...folder, projectIds: folder.projectIds.filter((id) => id !== projectId) }
    }
    return folder
  })
}
