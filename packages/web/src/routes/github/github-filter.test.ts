import { describe, expect, it } from 'vitest'

import type { GithubItem } from '@open-mercato/cezar-api-client'

import {
  allLabels,
  filterGithubItems,
  labelChipStyle,
  shouldSearchForge,
  sortGithubItems,
} from './github-filter'

const item = (over: Partial<GithubItem> & Pick<GithubItem, 'number' | 'title'>): GithubItem => ({
  kind: 'issue',
  author: 'octocat',
  createdAt: '2026-07-01T00:00:00Z',
  labels: [],
  body: '',
  url: `https://github.com/o/r/issues/${over.number}`,
  comments: 0,
  ...over,
})

const items = [
  item({ number: 142, title: 'Login drops session', labels: ['bug', 'auth'], author: 'alice' }),
  item({ number: 139, title: 'Add --json flag', labels: ['enhancement', 'cli'], body: 'machine-readable' }),
  item({ number: 135, title: 'Flaky e2e cleanup', labels: ['bug', 'flaky-test'] }),
]

describe('filterGithubItems', () => {
  it('matches a bare number or #id against the item number', () => {
    expect(filterGithubItems(items, { query: '142' }).map((i) => i.number)).toEqual([142])
    expect(filterGithubItems(items, { query: '#139' }).map((i) => i.number)).toEqual([139])
    // Partial numeric match is allowed (13 → 139 and 135).
    expect(filterGithubItems(items, { query: '13' }).map((i) => i.number)).toEqual([139, 135])
  })

  it('matches free text across title, author and body (case-insensitive)', () => {
    expect(filterGithubItems(items, { query: 'login' }).map((i) => i.number)).toEqual([142])
    expect(filterGithubItems(items, { query: 'ALICE' }).map((i) => i.number)).toEqual([142])
    expect(filterGithubItems(items, { query: 'machine-readable' }).map((i) => i.number)).toEqual([139])
  })

  it('ANDs multiple selected labels, like GitHub', () => {
    expect(filterGithubItems(items, { labels: ['bug'] }).map((i) => i.number)).toEqual([142, 135])
    expect(filterGithubItems(items, { labels: ['bug', 'auth'] }).map((i) => i.number)).toEqual([142])
    expect(filterGithubItems(items, { labels: ['bug', 'cli'] })).toEqual([])
  })

  it('combines search and labels', () => {
    expect(filterGithubItems(items, { query: 'flaky', labels: ['bug'] }).map((i) => i.number)).toEqual([135])
  })

  it('empty filter returns everything', () => {
    expect(filterGithubItems(items, {})).toHaveLength(3)
  })
})

describe('sortGithubItems', () => {
  const aged = [
    item({ number: 10, title: 'oldest', createdAt: '2026-01-05T00:00:00Z' }),
    item({ number: 30, title: 'newest', createdAt: '2026-03-05T00:00:00Z' }),
    item({ number: 20, title: 'middle', createdAt: '2026-02-05T00:00:00Z' }),
  ]

  it('puts the most recent first for `newest`', () => {
    expect(sortGithubItems(aged, 'newest').map((i) => i.number)).toEqual([30, 20, 10])
  })

  it('puts the longest-waiting first for `oldest` — the whole point of the toggle', () => {
    expect(sortGithubItems(aged, 'oldest').map((i) => i.number)).toEqual([10, 20, 30])
  })

  // Sorting, not reversing: the cross-state search hits arrive in GitHub's best-match order, so
  // `newest` has to be an active sort there rather than a no-op that leaves relevance order alone.
  it('sorts by age even when the input order is unrelated to age', () => {
    const byRelevance = [aged[2], aged[0], aged[1]]
    expect(sortGithubItems(byRelevance, 'newest').map((i) => i.number)).toEqual([30, 20, 10])
    expect(sortGithubItems(byRelevance, 'oldest').map((i) => i.number)).toEqual([10, 20, 30])
  })

  it('breaks `createdAt` ties on the number, so the order never depends on the input order', () => {
    const sameSecond = [
      item({ number: 7, title: 'a', createdAt: '2026-04-01T09:00:00Z' }),
      item({ number: 9, title: 'b', createdAt: '2026-04-01T09:00:00Z' }),
      item({ number: 8, title: 'c', createdAt: '2026-04-01T09:00:00Z' }),
    ]
    expect(sortGithubItems(sameSecond, 'newest').map((i) => i.number)).toEqual([9, 8, 7])
    expect(sortGithubItems(sameSecond, 'oldest').map((i) => i.number)).toEqual([7, 8, 9])
    // …and shuffling the input cannot change either answer.
    const shuffled = [sameSecond[1], sameSecond[2], sameSecond[0]]
    expect(sortGithubItems(shuffled, 'newest').map((i) => i.number)).toEqual([9, 8, 7])
  })

  it('never mutates the caller — the input is the query cache’s own array', () => {
    const source = [...aged]
    sortGithubItems(source, 'oldest')
    expect(source.map((i) => i.number)).toEqual([10, 30, 20])
  })

  it('keeps an empty or unparseable createdAt deterministic instead of NaN-comparing it', () => {
    const ragged = [
      item({ number: 2, title: 'dated', createdAt: '2026-01-01T00:00:00Z' }),
      item({ number: 1, title: 'blank', createdAt: '' }),
      item({ number: 3, title: 'junk', createdAt: 'not-a-date' }),
    ]
    // Plain string order: '' < '2026-…' < 'not-a-date'. The only promise is that it is total and
    // repeatable — a missing timestamp must not scramble the rows around it.
    expect(sortGithubItems(ragged, 'oldest').map((i) => i.number)).toEqual([1, 2, 3])
    expect(sortGithubItems(ragged, 'newest').map((i) => i.number)).toEqual([3, 2, 1])
  })

  it('returns an empty array for an empty list', () => {
    expect(sortGithubItems([], 'oldest')).toEqual([])
  })
})

describe('allLabels', () => {
  it('returns the sorted distinct label set', () => {
    expect(allLabels(items)).toEqual(['auth', 'bug', 'cli', 'enhancement', 'flaky-test'])
  })
})

describe('labelChipStyle', () => {
  it('tints from a 6-hex color', () => {
    const style = labelChipStyle('d73a4a')
    expect(style.backgroundColor).toBe('#d73a4a22')
    expect(style.borderColor).toBe('#d73a4a66')
  })

  it('falls back to neutral tokens when the color is missing or malformed', () => {
    expect(labelChipStyle(undefined).color).toBe('var(--muted-foreground)')
    expect(labelChipStyle('nothex').color).toBe('var(--muted-foreground)')
  })

  it('blends the ink toward the theme foreground so it reads in both light and dark', () => {
    // No fixed hex: the color mixes toward `--foreground`, which flips per theme.
    expect(labelChipStyle('000000').color).toBe('color-mix(in srgb, #000000 50%, var(--foreground))')
  })
})

/**
 * The fallback trigger (#730). `filterGithubItems` can only ever match the OPEN set the list
 * fetched, so "non-empty query, zero local matches" is precisely the state where the answer may
 * still exist on GitHub — closed, merged, or past the fetched window. Getting this predicate wrong
 * is either a search that never fires (the bug) or a `gh` subprocess on every keystroke.
 */
describe('shouldSearchForge', () => {
  it('fires when a real query matches nothing locally — the #730 case', () => {
    expect(filterGithubItems(items, { query: '4507' })).toHaveLength(0)
    expect(shouldSearchForge('4507', 0)).toBe(true)
  })

  it('does not fire on a blank query — that is the unfiltered list, not a search', () => {
    expect(shouldSearchForge('', 0)).toBe(false)
    expect(shouldSearchForge('   ', 0)).toBe(false)
  })

  it('does not fire when the local filter already found something', () => {
    expect(filterGithubItems(items, { query: '142' }).length).toBeGreaterThan(0)
    expect(shouldSearchForge('142', filterGithubItems(items, { query: '142' }).length)).toBe(false)
  })

  // Locks what the JSDoc promises about the caller (#837): `github.tsx` counts local matches WITH
  // the label filter applied, so a label filter that empties an otherwise-matching query does reach
  // for the forge. Documented as intentional — the hits are re-narrowed by the same labels before
  // rendering — so this asserts the contract rather than guarding against it.
  it('a label filter that empties the local matches does trigger the fallback', () => {
    const countWith = (labels: readonly string[]) =>
      filterGithubItems(items, { query: '142', labels }).length
    expect(shouldSearchForge('142', countWith([]))).toBe(false)
    expect(countWith(['cli'])).toBe(0)
    expect(shouldSearchForge('142', countWith(['cli']))).toBe(true)
  })
})
