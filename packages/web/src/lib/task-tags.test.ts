import { describe, expect, it } from 'vitest'

import { applyTagDelta, groupTagsByName, offersCreate, pickerTags, resolveAutomationTags, resolveRunTags } from './task-tags'

/** spec 2026-11-23-task-tags § 4.3 / § 7.1. */
describe('resolveRunTags', () => {
  const registry = {
    tags: [{ id: 'tt-renamed0001', name: 'New name', color: 'green' as const, createdAt: '' }],
    deletedIds: ['tt-deleted0001'],
  }

  it('the registry wins, a tombstone hides, an unknown id shows its snapshot', () => {
    expect(
      resolveRunTags(
        [
          { id: 'tt-renamed0001', name: 'Old name' },
          { id: 'tt-deleted0001', name: 'Gone' },
          { id: 'tt-unknown0001', name: 'From elsewhere', color: 'red' },
        ],
        registry,
      ),
    ).toEqual([
      { id: 'tt-renamed0001', name: 'New name', color: 'green', snapshot: false },
      { id: 'tt-unknown0001', name: 'From elsewhere', snapshot: true },
    ])
  })

  it('an empty or absent registry still shows every snapshot (zero config)', () => {
    expect(resolveRunTags([{ id: 'tt-renamed0001', name: 'Old name' }], undefined)).toEqual([
      { id: 'tt-renamed0001', name: 'Old name', snapshot: true },
    ])
    expect(resolveRunTags(undefined, registry)).toEqual([])
  })
})

describe('the picker', () => {
  const registry = {
    tags: [
      { id: 'tt-projold0001', name: 'b-old', projectId: 'p', createdAt: '', lastUsedAt: '2026-01-01' },
      { id: 'tt-projnew0001', name: 'a-new', projectId: 'p', createdAt: '', lastUsedAt: '2026-11-01' },
      { id: 'tt-global00001', name: 'global', createdAt: '' },
      { id: 'tt-other000001', name: 'other project', projectId: 'q', createdAt: '' },
      { id: 'tt-orphan00001', name: 'orphan', projectId: 'gone', orphaned: true as const, createdAt: '' },
    ],
    deletedIds: [],
  }

  it('offers this project first by recency, then global; never another project or an orphan', () => {
    const { project, global } = pickerTags(registry, 'p')
    expect(project.map((t) => t.name)).toEqual(['a-new', 'b-old'])
    expect(global.map((t) => t.name)).toEqual(['global'])
  })

  it('offers Create only for a name no visible tag has, case-insensitively', () => {
    expect(offersCreate('GLOBAL', registry.tags)).toBe(false)
    expect(offersCreate('  fresh ', registry.tags)).toBe(true)
    expect(offersCreate('   ', registry.tags)).toBe(false)
  })
})

describe('helpers', () => {
  it('applyTagDelta adds, refreshes and removes', () => {
    const a = { id: 'tt-aaaaaaaa01', name: 'a' }
    expect(applyTagDelta([a], [{ ...a, name: 'A' }, { id: 'tt-bbbbbbbb01', name: 'b' }], [])).toEqual([
      { ...a, name: 'A' },
      { id: 'tt-bbbbbbbb01', name: 'b' },
    ])
    expect(applyTagDelta([a], [], [a.id])).toEqual([])
  })

  it('groupTagsByName folds case and takes the most recently used member’s look', () => {
    const groups = groupTagsByName([
      { id: 'tt-one0000001', name: 'Batch', snapshot: false, lastUsedAt: '2026-01-01', color: 'red' },
      { id: 'tt-two0000001', name: 'batch', snapshot: false, lastUsedAt: '2026-11-01', color: 'blue' },
      { id: 'tt-three00001', name: 'other', snapshot: true },
    ])
    expect(groups).toEqual([
      { key: 'batch', name: 'batch', ids: ['tt-one0000001', 'tt-two0000001'], color: 'blue' },
      { key: 'other', name: 'other', ids: ['tt-three00001'] },
    ])
  })
})

describe('resolveAutomationTags (spec 2026-11-23-automation-task-tags)', () => {
  const registry = {
    tags: [
      { id: 'tt-live00000001', name: 'nightly', color: 'blue' as const, createdAt: '' },
      { id: 'tt-other0000001', name: 'mine', projectId: 'other', createdAt: '' },
    ],
  }
  it('matches by id, then by name, and marks the rest as a snapshot the launch will skip', () => {
    const shown = resolveAutomationTags(
      [{ id: 'tt-live00000001', name: 'old name' }, { id: 'tt-gone00000001', name: 'NIGHTLY' }, { name: 'mine' }, { name: 'missing' }],
      registry,
      'p1',
    )
    expect(shown.map((t) => [t.name, t.snapshot])).toEqual([['nightly', false], ['nightly', false], ['mine', true], ['missing', true]])
  })
})
