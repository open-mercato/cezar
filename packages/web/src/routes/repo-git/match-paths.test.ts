import { describe, expect, it } from 'vitest'

import { matchPaths } from './match-paths'

const PATHS = [
  '.gitignore',
  'README.md',
  'docs/guide.md',
  'packages/web/src/app.tsx',
  'packages/web/src/routes/repo-git/repo-files.tsx',
  'packages/web/src/routes/repo-git/repo-git.tsx',
]

describe('matchPaths', () => {
  it('an empty or whitespace query is no filter, uncapped', () => {
    expect(matchPaths(PATHS, '', 2)).toEqual({ results: PATHS, total: PATHS.length })
    expect(matchPaths(PATHS, '   ', 2).results).toHaveLength(PATHS.length)
  })

  it('matches a subsequence across directory boundaries', () => {
    // The case that justifies subsequence matching at all.
    expect(matchPaths(PATHS, 'webrepofiles', 10).results).toEqual([
      'packages/web/src/routes/repo-git/repo-files.tsx',
    ])
  })

  it('is case-insensitive in both directions', () => {
    expect(matchPaths(PATHS, 'readme', 10).results).toContain('README.md')
    expect(matchPaths(['lowercase.ts'], 'LOWER', 10).results).toEqual(['lowercase.ts'])
  })

  it('ranks a basename match above a path-only one', () => {
    const paths = ['zzz/aaa/deep-nested-thing.ts', 'app.ts']
    // 'app' is in `app.ts`'s basename; in the other it only spans directories.
    expect(matchPaths(paths, 'app', 10).results[0]).toBe('app.ts')
  })

  it('ranks the shorter path first when both match the same way', () => {
    const paths = ['a/b/c/repo-git.tsx', 'repo-git.tsx']
    expect(matchPaths(paths, 'repogit', 10).results).toEqual(['repo-git.tsx', 'a/b/c/repo-git.tsx'])
  })

  it('orders equal-length matches alphabetically, never by index order', () => {
    const shuffled = ['src/b.ts', 'src/a.ts']
    expect(matchPaths(shuffled, 'srcts', 10).results).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('caps the results and reports the real total', () => {
    const many = Array.from({ length: 50 }, (_, i) => `src/file-${String(i).padStart(2, '0')}.ts`)
    const capped = matchPaths(many, 'src', 10)
    expect(capped.results).toHaveLength(10)
    expect(capped.total).toBe(50)
  })

  it('no match is an empty result with a zero total', () => {
    expect(matchPaths(PATHS, 'zzzzz', 10)).toEqual({ results: [], total: 0 })
  })

  it('handles spaces and unicode in both the query and the paths', () => {
    const paths = ['a dir/a file.txt', 'ünïcode.md']
    expect(matchPaths(paths, 'a file', 10).results).toEqual(['a dir/a file.txt'])
    expect(matchPaths(paths, 'ünï', 10).results).toEqual(['ünïcode.md'])
  })

  it('does not reuse half of an astral character (the surrogate-pair advance)', () => {
    // '🙂' is two code units. Advancing by one would leave its trailing surrogate matchable, so a
    // two-emoji needle would match a one-emoji path.
    expect(matchPaths(['a🙂.ts'], '🙂🙂', 10).results).toEqual([])
    expect(matchPaths(['a🙂b🙂.ts'], '🙂🙂', 10).results).toEqual(['a🙂b🙂.ts'])
  })

  it('an exhausted needle character is not reused — ordering is respected', () => {
    // 'aa' must NOT match a path with a single 'a'.
    expect(matchPaths(['bab.ts'], 'aa', 10).results).toEqual([])
    expect(matchPaths(['banana.ts'], 'aaa', 10).results).toEqual(['banana.ts'])
    // Order matters: 'ba' matches, 'ab' only via the later pair.
    expect(matchPaths(['ba.ts'], 'ab', 10).results).toEqual([])
  })
})
