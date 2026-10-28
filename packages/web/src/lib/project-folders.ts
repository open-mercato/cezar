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
