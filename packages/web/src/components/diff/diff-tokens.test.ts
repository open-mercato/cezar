import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { ensureLang, highlightSync, type SynToken } from '@/lib/highlighter'

import {
  cachedDiffTokens,
  diffTokensKey,
  resetDiffTokenCache,
  scheduleTokenize,
  storeDiffTokens,
  tokenizeDiffLines,
} from './diff-tokens'
import { contextLinesForGap, parsePatch } from './parse-patch'

// Full tokenization of known-small input: no wall-clock budget (see highlighter.test.ts).
const ts = (text: string) => highlightSync(text, 'typescript', { tokenizeTimeLimit: 0 })

function tokensOf(patch: string) {
  const lines = parsePatch(patch).hunks.flatMap((hunk) => hunk.lines)
  return { lines, tokens: tokenizeDiffLines(lines, ts)! }
}

const colorOf = (line: SynToken[] | undefined, word: string) => line?.find((t) => t.content.includes(word))?.color

describe('tokenizeDiffLines', () => {
  beforeAll(() => ensureLang('typescript'))

  it('does not carry a comment opened at the end of one hunk into the next', () => {
    const { lines, tokens } = tokensOf(
      [
        '@@ -1,2 +1,2 @@',
        ' const a = 1',
        ' /**',
        '@@ -40,1 +40,1 @@',
        '-const b = 2',
        '+const b = 3',
      ].join('\n'),
    )
    expect(colorOf(tokens[1], '/**')).toBe('var(--syn-com)')
    for (const index of [2, 3]) {
      expect(lines[index]!.text).toContain('const b')
      expect(colorOf(tokens[index], 'const')).toBe('var(--syn-key)')
    }
  })

  it('does not carry state from a removed line into its added replacement', () => {
    const { tokens } = tokensOf(['@@ -1,1 +1,1 @@', '-const s = `open', '+const s = 1'].join('\n'))
    expect(colorOf(tokens[1], 'const')).toBe('var(--syn-key)')
  })

  it('keeps state within one contiguous run, so a multi-line comment still reads as one', () => {
    const { tokens } = tokensOf(['@@ -1,3 +1,3 @@', ' /**', '  * doc', ' */'].join('\n'))
    expect(colorOf(tokens[1], 'doc')).toBe('var(--syn-com)')
  })

  it('joins hunks bridged by expanded context into one run', () => {
    const [first, second] = parsePatch(
      ['@@ -1,1 +1,1 @@', ' /**', '@@ -4,1 +4,1 @@', ' const c = 4'].join('\n'),
    ).hunks
    const gap = contextLinesForGap({ beforeHunk: 1, oldStart: 2, newStart: 2, count: 2 }, ['/**', ' * doc', ' */', 'const c = 4'])
    const lines = [...first!.lines, ...gap, ...second!.lines]
    const tokens = tokenizeDiffLines(lines, ts)!
    expect(colorOf(tokens[1], 'doc')).toBe('var(--syn-com)')
    expect(colorOf(tokens[3], 'const')).toBe('var(--syn-key)')
  })

  it('returns null while the grammar is not loaded', () => {
    const lines = parsePatch('@@ -1,1 +1,1 @@\n x').hunks[0]!.lines
    expect(tokenizeDiffLines(lines, () => null)).toBeNull()
  })
})

describe('the diff token cache', () => {
  const lines = (patch: string) => parsePatch(patch).hunks.flatMap((hunk) => hunk.lines)
  const tokens: SynToken[][] = [[{ content: 'x' }]]
  afterEach(() => resetDiffTokenCache())

  it('keys on everything the tokens depend on — grammar, side, line numbers and text', () => {
    const base = diffTokensKey('typescript', lines(['@@ -1,1 +1,1 @@', '-a', '+b'].join('\n')))
    expect(diffTokensKey('typescript', lines(['@@ -1,1 +1,1 @@', '-a', '+b'].join('\n')))).toBe(base)
    expect(diffTokensKey('javascript', lines(['@@ -1,1 +1,1 @@', '-a', '+b'].join('\n')))).not.toBe(base)
    expect(diffTokensKey('typescript', lines(['@@ -9,1 +9,1 @@', '-a', '+b'].join('\n')))).not.toBe(base)
    expect(diffTokensKey('typescript', lines(['@@ -1,1 +1,1 @@', '+a', '-b'].join('\n')))).not.toBe(base)
  })

  it('serves a stored file back to a later mount', () => {
    storeDiffTokens('k', tokens)
    expect(cachedDiffTokens('k')).toBe(tokens)
    expect(cachedDiffTokens('other')).toBeUndefined()
  })

  it('stays bounded, evicting the least recently used first', () => {
    const big = (tag: string) => tag + 'x'.repeat(300_000)
    storeDiffTokens(big('a'), tokens)
    for (const tag of ['b', 'c', 'd', 'e']) storeDiffTokens(big(tag), tokens)
    // Touching `a` makes `b` the oldest.
    expect(cachedDiffTokens(big('a'))).toBe(tokens)
    storeDiffTokens(big('f'), tokens)
    storeDiffTokens(big('g'), tokens)
    expect(cachedDiffTokens(big('a'))).toBe(tokens)
    expect(cachedDiffTokens(big('b'))).toBeUndefined()
  })
})

describe('scheduleTokenize', () => {
  it('runs queued work after the current task, and skips a cancelled job', async () => {
    const ran: string[] = []
    scheduleTokenize(() => ran.push('a'))
    const cancel = scheduleTokenize(() => ran.push('b'))
    scheduleTokenize(() => ran.push('c'))
    cancel()
    expect(ran).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(ran).toEqual(['a', 'c'])
  })
})
