import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  moveProjectBetweenFolders,
  normalizeProjectFolders,
  PROJECT_FOLDERS_STORAGE_KEY,
  readProjectFolders,
  saveProjectFolder,
  writeProjectFolders,
  type ProjectFolder,
} from './project-folders'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  localStorage.clear()
})

describe('normalizeProjectFolders', () => {
  it('returns an empty array for non-array inputs', () => {
    expect(normalizeProjectFolders(null)).toEqual([])
    expect(normalizeProjectFolders(undefined)).toEqual([])
    expect(normalizeProjectFolders('folders')).toEqual([])
    expect(normalizeProjectFolders(123)).toEqual([])
    expect(normalizeProjectFolders({})).toEqual([])
  })

  it('normalizes valid folders and trims whitespace', () => {
    const raw = [
      { id: ' f1 ', name: ' Client Work ', projectIds: ['p1', 'p2'] },
      { id: 'f2', name: 'Internal', projectIds: ['p3'] },
    ]
    expect(normalizeProjectFolders(raw)).toEqual([
      { id: 'f1', name: 'Client Work', projectIds: ['p1', 'p2'] },
      { id: 'f2', name: 'Internal', projectIds: ['p3'] },
    ])
  })

  it('drops invalid or duplicate folder IDs', () => {
    const raw = [
      { id: '', name: 'Empty ID', projectIds: ['p1'] },
      { id: '   ', name: 'Whitespace ID', projectIds: ['p1'] },
      { id: 123, name: 'Number ID', projectIds: ['p1'] },
      { name: 'Missing ID', projectIds: ['p1'] },
      { id: 'f1', name: 'First', projectIds: ['p1'] },
      { id: 'f1', name: 'Duplicate ID', projectIds: ['p2'] },
    ]
    expect(normalizeProjectFolders(raw)).toEqual([
      { id: 'f1', name: 'First', projectIds: ['p1'] },
    ])
  })

  it('drops folders with empty or whitespace-only names', () => {
    const raw = [
      { id: 'f1', name: '', projectIds: ['p1'] },
      { id: 'f2', name: '   ', projectIds: ['p1'] },
      { id: 'f3', name: 42, projectIds: ['p1'] },
      { id: 'f4', projectIds: ['p1'] },
      { id: 'f5', name: 'Valid', projectIds: [] },
    ]
    expect(normalizeProjectFolders(raw)).toEqual([
      { id: 'f5', name: 'Valid', projectIds: [] },
    ])
  })

  it('deduplicates project assignments across and within folders', () => {
    const raw = [
      { id: 'f1', name: 'Folder 1', projectIds: ['p1', 'p1', 'p2', 123, null] },
      { id: 'f2', name: 'Folder 2', projectIds: ['p2', 'p3'] },
    ]
    expect(normalizeProjectFolders(raw)).toEqual([
      { id: 'f1', name: 'Folder 1', projectIds: ['p1', 'p2'] },
      { id: 'f2', name: 'Folder 2', projectIds: ['p3'] },
    ])
  })

  it('handles non-array or missing projectIds gracefully', () => {
    const raw = [
      { id: 'f1', name: 'No Projects' },
      { id: 'f2', name: 'Null Projects', projectIds: null },
    ]
    expect(normalizeProjectFolders(raw)).toEqual([
      { id: 'f1', name: 'No Projects', projectIds: [] },
      { id: 'f2', name: 'Null Projects', projectIds: [] },
    ])
  })
})

describe('readProjectFolders and writeProjectFolders', () => {
  it('round-trips folders through localStorage', () => {
    const folders: ProjectFolder[] = [
      { id: 'f1', name: 'Folder A', projectIds: ['p1'] },
      { id: 'f2', name: 'Folder B', projectIds: ['p2', 'p3'] },
    ]
    writeProjectFolders(folders)
    expect(readProjectFolders()).toEqual(folders)
  })

  it('returns empty array when storage is empty or contains invalid JSON', () => {
    expect(readProjectFolders()).toEqual([])
    localStorage.setItem(PROJECT_FOLDERS_STORAGE_KEY, 'invalid json {')
    expect(readProjectFolders()).toEqual([])
  })
})

describe('saveProjectFolder', () => {
  it('adds a new folder to the list', () => {
    const initial: ProjectFolder[] = [{ id: 'f1', name: 'Folder 1', projectIds: ['p1'] }]
    const result = saveProjectFolder(initial, { id: 'f2', name: 'Folder 2', projectIds: ['p2'] })
    expect(result).toEqual([
      { id: 'f1', name: 'Folder 1', projectIds: ['p1'] },
      { id: 'f2', name: 'Folder 2', projectIds: ['p2'] },
    ])
  })

  it('removes assigned projects from their previous folders', () => {
    const initial: ProjectFolder[] = [
      { id: 'f1', name: 'Folder 1', projectIds: ['p1', 'p2'] },
      { id: 'f2', name: 'Folder 2', projectIds: ['p3'] },
    ]
    // Move p1 from f1 into f2
    const result = saveProjectFolder(
      initial,
      { id: 'f2', name: 'Folder 2', projectIds: ['p3', 'p1'] },
      'f2',
    )
    expect(result).toEqual([
      { id: 'f1', name: 'Folder 1', projectIds: ['p2'] },
      { id: 'f2', name: 'Folder 2', projectIds: ['p3', 'p1'] },
    ])
  })

  it('deletes a folder when passed null', () => {
    const initial: ProjectFolder[] = [
      { id: 'f1', name: 'Folder 1', projectIds: ['p1'] },
      { id: 'f2', name: 'Folder 2', projectIds: ['p2'] },
    ]
    const result = saveProjectFolder(initial, null, 'f1')
    expect(result).toEqual([{ id: 'f2', name: 'Folder 2', projectIds: ['p2'] }])
  })

  it('replaces a folder when id changes', () => {
    const initial: ProjectFolder[] = [
      { id: 'f1', name: 'Old Folder', projectIds: ['p1'] },
    ]
    const result = saveProjectFolder(
      initial,
      { id: 'f1-new', name: 'Renamed', projectIds: ['p1'] },
      'f1',
    )
    expect(result).toEqual([
      { id: 'f1-new', name: 'Renamed', projectIds: ['p1'] },
    ])
  })
})

describe('moveProjectBetweenFolders', () => {
  it('moves a project from one folder to another', () => {
    const initial: ProjectFolder[] = [
      { id: 'f1', name: 'Folder 1', projectIds: ['p1', 'p2'] },
      { id: 'f2', name: 'Folder 2', projectIds: ['p3'] },
    ]
    const result = moveProjectBetweenFolders(initial, 'p1', 'f2')
    expect(result).toEqual([
      { id: 'f1', name: 'Folder 1', projectIds: ['p2'] },
      { id: 'f2', name: 'Folder 2', projectIds: ['p3', 'p1'] },
    ])
  })

  it('moves a project from a folder to ungrouped (null target)', () => {
    const initial: ProjectFolder[] = [
      { id: 'f1', name: 'Folder 1', projectIds: ['p1', 'p2'] },
    ]
    const result = moveProjectBetweenFolders(initial, 'p1', null)
    expect(result).toEqual([{ id: 'f1', name: 'Folder 1', projectIds: ['p2'] }])
  })

  it('moves an ungrouped project into a folder', () => {
    const initial: ProjectFolder[] = [
      { id: 'f1', name: 'Folder 1', projectIds: ['p1'] },
    ]
    const result = moveProjectBetweenFolders(initial, 'ungrouped-p', 'f1')
    expect(result).toEqual([{ id: 'f1', name: 'Folder 1', projectIds: ['p1', 'ungrouped-p'] }])
  })

  it('is a no-op when project is already in target folder', () => {
    const initial: ProjectFolder[] = [
      { id: 'f1', name: 'Folder 1', projectIds: ['p1'] },
    ]
    const result = moveProjectBetweenFolders(initial, 'p1', 'f1')
    expect(result).toEqual(initial)
  })
})
