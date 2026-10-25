export const PROJECT_FOLDERS_STORAGE_KEY = 'cez-project-folders'

export type ProjectFolder = { id: string; name: string; projectIds: string[] }

export function normalizeProjectFolders(value: unknown): ProjectFolder[] {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  const assigned = new Set<string>()
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const folder = entry as Record<string, unknown>
    if (typeof folder.id !== 'string' || !folder.id.trim() || ids.has(folder.id)) return []
    if (typeof folder.name !== 'string' || !folder.name.trim()) return []
    ids.add(folder.id)
    const projectIds = Array.isArray(folder.projectIds)
      ? [...new Set(folder.projectIds.filter((id): id is string => typeof id === 'string' && !assigned.has(id)))]
      : []
    projectIds.forEach((id) => assigned.add(id))
    return [{ id: folder.id, name: folder.name.trim(), projectIds }]
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
