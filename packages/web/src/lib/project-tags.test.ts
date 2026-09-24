import { describe, expect, it } from 'vitest'

import type { ProjectListEntry } from '@open-mercato/cezar-api-client'

import { TAG_SUGGESTION_LIMIT, allProjectTags, suggestTags } from './project-tags'

/**
 * The workspace's tag vocabulary. This exists because tags only group anything if two projects
 * spell one the same way, and the server can only deduplicate within a single project's list —
 * so the suggestions are what keep the SECOND repo landing on the first one's word.
 */

function project(overrides: Partial<ProjectListEntry> & { id: string }): ProjectListEntry {
  return {
    name: overrides.id,
    root: `/repos/${overrides.id}`,
    addedAt: '2026-07-01T10:00:00Z',
    lastOpenedAt: '2026-07-01T10:00:00Z',
    source: 'local',
    status: 'ok',
    ...overrides,
  }
}

describe('allProjectTags', () => {
  it('collects, dedupes case-insensitively and sorts', () => {
    expect(
      allProjectTags([
        project({ id: 'a', tags: ['storefront', 'backend'] }),
        project({ id: 'b', tags: ['Storefront'] }),
        project({ id: 'c' }),
      ]),
    ).toEqual(['backend', 'storefront'])
  })

  it('is empty for a workspace nobody has tagged', () => {
    expect(allProjectTags([project({ id: 'a' })])).toEqual([])
  })
})

describe('suggestTags', () => {
  const ALL = ['backend', 'client-acme', 'infra', 'storefront', 'testing']

  it('offers the whole vocabulary before a keystroke', () => {
    // "Which tags exist here?" is the first question someone tagging a second repo has.
    expect(suggestTags(ALL, [], '')).toEqual(ALL)
  })

  it('drops tags the project already carries', () => {
    // Re-adding one is a no-op the server answers 200 to, which looks like it worked.
    expect(suggestTags(ALL, ['infra', 'STOREFRONT'], '')).toEqual([
      'backend',
      'client-acme',
      'testing',
    ])
  })

  it('matches as a case-insensitive substring', () => {
    expect(suggestTags(ALL, [], 'FRONT')).toEqual(['storefront'])
    expect(suggestTags(ALL, [], 'acme')).toEqual(['client-acme'])
  })

  it('leads with prefix matches', () => {
    // Typing `st` should lead with `storefront`, not with the mid-word hit in `testing` —
    // alphabetical order alone would put `testing` first.
    expect(suggestTags(['testing', 'storefront'], [], 'st')).toEqual(['storefront', 'testing'])
  })

  it('drops an exact match — Enter already commits it', () => {
    // A row that says exactly what the field says is a second way to do one thing.
    expect(suggestTags(ALL, [], 'infra')).toEqual([])
    expect(suggestTags(ALL, [], 'INFRA')).toEqual([])
  })

  it('answers nothing for a query no tag contains, so a new tag is simply typed', () => {
    expect(suggestTags(ALL, [], 'brand-new')).toEqual([])
  })

  it('caps the list', () => {
    const many = Array.from({ length: TAG_SUGGESTION_LIMIT + 5 }, (_, i) => `tag-${i}`)
    expect(suggestTags(many, [], '')).toHaveLength(TAG_SUGGESTION_LIMIT)
    expect(suggestTags(many, [], 'tag', 3)).toHaveLength(3)
  })
})
