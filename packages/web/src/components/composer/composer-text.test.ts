import { describe, expect, it } from 'vitest'

import { applyCompletion, detectTrigger } from './composer-text'

describe('detectTrigger — when does typing open the menu (#380)', () => {
  const table: Array<{
    name: string
    text: string
    caret: number
    expected: ReturnType<typeof detectTrigger>
  }> = [
    { name: 'a lone / at the start opens with an empty query', text: '/', caret: 1, expected: { trigger: '/', start: 0, query: '' } },
    { name: 'typing after the / becomes the query', text: '/om-f', caret: 5, expected: { trigger: '/', start: 0, query: 'om-f' } },
    { name: '/ after a space is a word boundary', text: 'use /rev', caret: 8, expected: { trigger: '/', start: 4, query: 'rev' } },
    { name: '/ after a newline is a word boundary', text: 'line\n/x', caret: 7, expected: { trigger: '/', start: 5, query: 'x' } },
    { name: '@ works the same', text: 'see @src', caret: 8, expected: { trigger: '@', start: 4, query: 'src' } },
    { name: 'mid-word / stays inert (URLs)', text: 'https://x', caret: 9, expected: null },
    { name: 'mid-word @ stays inert (e-mails)', text: 'a user@host', caret: 11, expected: null },
    { name: 'a space commits the token — menu closed', text: '/skill done', caret: 11, expected: null },
    { name: 'caret before the trigger sees nothing', text: 'hi /x', caret: 2, expected: null },
    { name: 'caret INSIDE the token still counts, query up to the caret', text: '/abcd', caret: 3, expected: { trigger: '/', start: 0, query: 'ab' } },
    { name: 'plain text — nothing', text: 'hello', caret: 5, expected: null },
    { name: 'empty text — nothing', text: '', caret: 0, expected: null },
  ]

  for (const { name, text, caret, expected } of table) {
    it(name, () => {
      expect(detectTrigger(text, caret)).toEqual(expected)
    })
  }
})

describe('applyCompletion — inserts at the token, not at the end', () => {
  it('replaces the open token with the completion + one space', () => {
    const result = applyCompletion('use /rev', { trigger: '/', start: 4, query: 'rev' }, 8, 'om-review')
    expect(result).toEqual({ text: 'use /om-review ', caret: 15 })
  })

  it('keeps everything after the caret (mid-draft completion)', () => {
    const result = applyCompletion('run /f then stop', { trigger: '/', start: 4, query: 'f' }, 6, 'fix')
    expect(result.text).toBe('run /fix  then stop')
    expect(result.caret).toBe('run /fix '.length)
  })

  it('@ mentions keep their trigger char', () => {
    const result = applyCompletion('see @re', { trigger: '@', start: 4, query: 're' }, 7, 'README.md')
    expect(result.text).toBe('see @README.md ')
  })
})
