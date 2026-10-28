import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  normalizeProjectFolders,
  PROJECT_FOLDERS_STORAGE_KEY,
  readProjectFolders,
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
