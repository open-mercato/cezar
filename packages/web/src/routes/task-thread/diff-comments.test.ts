import { describe, expect, it } from 'vitest'

import {
  capExcerpt,
  commentsRideWith,
  EXCERPT_MAX,
  formatDiffComments,
  MESSAGE_TEXT_MAX,
  messageWithReview,
  parseDiffComments,
  parseReviewMessage,
  RANGE_EXCERPT_MAX,
  REVIEW_HEADING,
  slashCommandOf,
  withDiffComments,
  type DiffComment,
} from './diff-comments'

const A: DiffComment = { id: 'a', path: 'src/b.ts', side: 'new', line: 12, body: 'rename this', excerpt: '  const x = 1' }
const B: DiffComment = { id: 'b', path: 'src/a.ts', side: 'old', line: 3, body: 'why remove?\nit was used', excerpt: '' }

describe('diff comments', () => {
  it('round-trips through the stored JSON and drops anything malformed', () => {
    const stored = JSON.stringify([A, { id: 'x', path: 'p', side: 'left', line: 1, body: 'b' }, null, 'junk', B])
    expect(parseDiffComments(stored)).toEqual([A, B])
  })

  it('reads an empty, non-JSON or non-array text as no comments', () => {
    expect(parseDiffComments('')).toEqual([])
    expect(parseDiffComments('not json')).toEqual([])
    expect(parseDiffComments('{"id":"a"}')).toEqual([])
  })

  it('formats one review block, ordered by path then line, code fenced and the note its own paragraph', () => {
    expect(formatDiffComments([A, B])).toBe(
      [
        'Review comments on the diff:',
        '',
        '- `src/a.ts` line 3 (removed line):',
        '',
        // Fenced even when empty, so a note can never be mistaken for the code.
        '  ```',
        '  ',
        '  ```',
        '',
        '  why remove?',
        '  it was used',
        '',
        '- `src/b.ts` line 12:',
        '',
        '  ```',
        // The commented line's own indentation survives.
        '    const x = 1',
        '  ```',
        '',
        '  rename this',
      ].join('\n'),
    )
  })

  it('fences code that itself contains a fence with a longer one', () => {
    const tricky: DiffComment = { ...A, excerpt: 'const s = ```nested```' }
    expect(formatDiffComments([tricky])).toContain('  ````\n  const s = ```nested```\n  ````')
  })

  it('appends the review after the typed message, and leaves a message without comments alone', () => {
    expect(withDiffComments('also run the tests', [A])).toBe(`also run the tests\n\n${formatDiffComments([A])}`)
    expect(withDiffComments('', [A])).toBe(formatDiffComments([A]))
    expect(withDiffComments('just this', [])).toBe('just this')
    // Typed text leads because its first character is load-bearing: a registry `/skill` is only
    // expanded when the message STARTS with its slash (`expandRegistrySlashSkillText`).
    expect(withDiffComments('/fix-review please', [A])).toBe(`/fix-review please\n\n${formatDiffComments([A])}`)
  })

  it('lets comments ride plain text and registry skills, never a backend slash command', () => {
    expect(commentsRideWith('please fix', ['fix-review'])).toBe(true)
    expect(commentsRideWith('/fix-review please', ['fix-review'])).toBe(true)
    expect(commentsRideWith('/compact', ['fix-review'])).toBe(false)
    expect(commentsRideWith('  /compact focus on tests', ['fix-review'])).toBe(false)
    // The catalog has not arrived: a slash message keeps its comments rather than risk losing them.
    expect(commentsRideWith('/fix-review', undefined)).toBe(false)
    // Not a command at all: a path, or a slash mid-sentence.
    expect(commentsRideWith('/ is the root', [])).toBe(true)
    expect(commentsRideWith('see a/b', [])).toBe(true)
    expect(slashCommandOf('/compact now')).toBe('compact')
  })

  it('caps the excerpt, so a minified line cannot push the draft past its size cap', () => {
    // Indentation is structure: only blank lines and trailing space go.
    expect(capExcerpt('  short  ')).toBe('  short')
    const long = capExcerpt('x'.repeat(50_000))
    expect(long).toHaveLength(EXCERPT_MAX + 1)
    expect(long.endsWith('…')).toBe(true)
  })

  it('orders old-file line numbers before new-file ones within a path', () => {
    const newSide: DiffComment = { ...B, id: 'n', side: 'new', line: 1 }
    const oldSide: DiffComment = { ...B, id: 'o', side: 'old', line: 9 }
    const review = formatDiffComments([newSide, oldSide])
    expect(review.indexOf('line 9 (removed line)')).toBeLessThan(review.indexOf('line 1:'))
  })

  it('names the old path for a removed line of a renamed file, and keeps it across storage', () => {
    const renamed: DiffComment = { ...B, path: 'src/new-name.ts', oldPath: 'src/old-name.ts' }
    expect(parseDiffComments(JSON.stringify([renamed]))).toEqual([renamed])
    expect(formatDiffComments([renamed])).toContain(
      '`src/old-name.ts` line 3 (removed line, renamed to `src/new-name.ts`):',
    )
  })

  it('formats a range comment with its span and every covered line quoted', () => {
    const range: DiffComment = {
      id: 'r',
      path: 'src/a.ts',
      side: 'new',
      line: 14,
      start: { side: 'new', line: 12 },
      body: 'collapse these',
      excerpt: 'const a = 1\nconst b = 2\nconst c = 3',
    }
    expect(formatDiffComments([range])).toBe(
      [
        'Review comments on the diff:',
        '',
        '- `src/a.ts` lines 12–14:',
        '',
        '  ```',
        '  const a = 1',
        '  const b = 2',
        '  const c = 3',
        '  ```',
        '',
        '  collapse these',
      ].join('\n'),
    )
    // A range across removed and added lines names both ends.
    expect(formatDiffComments([{ ...range, start: { side: 'old', line: 11 } }])).toContain(
      '`src/a.ts` removed line 11 – line 14:',
    )
  })

  it('keeps a range across storage, and drops a malformed start rather than the comment', () => {
    const range: DiffComment = { ...A, start: { side: 'new', line: 10 } }
    expect(parseDiffComments(JSON.stringify([range]))).toEqual([range])
    expect(parseDiffComments(JSON.stringify([{ ...A, start: { side: 'left', line: 'x' } }]))).toEqual([A])
  })

  it('sorts a range by where it starts', () => {
    const late: DiffComment = { ...A, id: 'late', line: 5 }
    const range: DiffComment = { ...A, id: 'range', line: 20, start: { side: 'new', line: 2 } }
    expect(formatDiffComments([late, range]).indexOf('lines 2–20')).toBeLessThan(
      formatDiffComments([late, range]).indexOf('line 5:'),
    )
  })

  it('gives a range a longer excerpt cap than a single line', () => {
    expect(capExcerpt('x'.repeat(5000), RANGE_EXCERPT_MAX)).toHaveLength(RANGE_EXCERPT_MAX + 1)
    expect(RANGE_EXCERPT_MAX).toBeGreaterThan(EXCERPT_MAX)
  })

  it('reads a sent review back: lead text, then one item per comment with its code and note apart', () => {
    const range: DiffComment = { ...A, id: 'r', line: 14, start: { side: 'new', line: 12 }, excerpt: 'a\nb', body: 'merge these' }
    const sent = withDiffComments('please fix', [B, range])
    expect(parseReviewMessage(sent)).toEqual({
      lead: 'please fix',
      items: [
        { path: 'src/a.ts', label: 'line 3 (removed line)', line: 3, side: 'old', excerpt: '', body: 'why remove?\nit was used' },
        { path: 'src/b.ts', label: 'lines 12–14', line: 12, side: 'new', excerpt: 'a\nb', body: 'merge these' },
      ],
    })
  })

  it('links a removed line of a renamed file to the file as the diff lists it now', () => {
    const renamed: DiffComment = { ...B, path: 'src/new-name.ts', oldPath: 'src/old-name.ts' }
    expect(parseReviewMessage(formatDiffComments([renamed]))?.items[0]).toMatchObject({
      path: 'src/new-name.ts',
      side: 'old',
      line: 3,
    })
  })

  it('still reads reviews sent in the earlier `> quote` form', () => {
    const old = ['Review comments on the diff:', '', '- `src/b.ts` line 12:', '> const x = 1', '  rename this'].join('\n')
    expect(parseReviewMessage(old)?.items).toEqual([
      { path: 'src/b.ts', label: 'line 12', line: 12, side: 'new', excerpt: 'const x = 1', body: 'rename this' },
    ])
  })

  it('reads a Send back with no notes, and leaves anything that is not a review alone', () => {
    expect(parseReviewMessage(`Review feedback:\n${formatDiffComments([A])}`)?.lead).toBe('Review feedback:')
    expect(parseReviewMessage('just a message')).toBeUndefined()
    expect(parseReviewMessage('quoting Review comments on the diff:\n\nmid-sentence')).toBeUndefined()
    expect(parseReviewMessage(`${REVIEW_HEADING}\n\nnot an item`)).toBeUndefined()
  })

  it('reads a note that itself opens with a code block as the note, not as the commented code', () => {
    const suggestion: DiffComment = { ...B, side: 'new', excerpt: '', body: '```\nfoo()\n```\nuse this instead' }
    expect(parseReviewMessage(formatDiffComments([suggestion]))?.items[0]).toMatchObject({
      excerpt: '',
      body: '```\nfoo()\n```\nuse this instead',
    })
  })

  it('keeps every line of a range in place, the first included', () => {
    const range: DiffComment = {
      ...A,
      line: 3,
      start: { side: 'new', line: 1 },
      excerpt: capExcerpt('\n    if x:\n        y()\n    z()\n', RANGE_EXCERPT_MAX),
    }
    expect(formatDiffComments([range])).toContain('  ```\n      if x:\n          y()\n      z()\n  ```')
    expect(parseReviewMessage(formatDiffComments([range]))?.items[0]?.excerpt).toBe('    if x:\n        y()\n    z()')
  })

  it('refuses, with a reason, a message the review would push past the server cap', () => {
    const huge: DiffComment = { ...A, body: 'x'.repeat(4000) }
    expect(() => messageWithReview('y'.repeat(MESSAGE_TEXT_MAX - 100), [huge])).toThrow(/Too long with the diff comment attached/)
    expect(messageWithReview('fits', [A])).toBe(withDiffComments('fits', [A]))
  })
})
