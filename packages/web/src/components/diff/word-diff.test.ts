import { describe, expect, it } from 'vitest'

import { diffWords, overlaySegments, type WordSpan } from './word-diff'

describe('diffWords', () => {
  it('marks exactly the replaced token on both sides', () => {
    const result = diffWords('const count = useState(0)', 'const total = useState(0)')!
    expect(result.del.filter((s) => s.changed).map((s) => s.text)).toEqual(['count'])
    expect(result.add.filter((s) => s.changed).map((s) => s.text)).toEqual(['total'])
    // Round trip: spans concatenate back to the exact line text.
    expect(result.del.map((s) => s.text).join('')).toBe('const count = useState(0)')
    expect(result.add.map((s) => s.text).join('')).toBe('const total = useState(0)')
  })

  it('merges adjacent changed tokens into one span', () => {
    const result = diffWords('return a + b', 'return a * c')!
    // `+ b` → `* c`: operator and word are adjacent changed tokens (whitespace between is
    // unchanged, so runs stay split by the kept space).
    expect(result.add.some((s) => s.changed && s.text.includes('*'))).toBe(true)
    expect(result.add.map((s) => s.text).join('')).toBe('return a * c')
  })

  it('returns null for identical lines', () => {
    expect(diffWords('same text', 'same text')).toBeNull()
  })

  it('returns null for rewrites (similarity below the guard)', () => {
    expect(diffWords('const alpha = compute(input)', 'return void render[]')).toBeNull()
  })

  it('returns null for empty and oversized sides', () => {
    expect(diffWords('', 'anything')).toBeNull()
    const huge = Array.from({ length: 400 }, (_, i) => `tok${i}`).join(' ')
    expect(diffWords(huge, `${huge} extra`)).toBeNull()
  })
})

describe('overlaySegments', () => {
  const spans: WordSpan[] = [
    { text: 'const two = ', changed: false },
    { text: '3', changed: true },
  ]

  it('splits syntax tokens at word-span boundaries, keeping colors', () => {
    const tokens = [
      { content: 'const', color: 'var(--syn-key)' },
      { content: ' two = 3', color: 'var(--syn-var)' },
    ]
    const segments = overlaySegments(tokens, spans, 'const two = 3')
    expect(segments).toEqual([
      { text: 'const', color: 'var(--syn-key)', changed: false },
      { text: ' two = ', color: 'var(--syn-var)', changed: false },
      { text: '3', color: 'var(--syn-var)', changed: true },
    ])
  })

  it('renders spans alone when tokens are not resident yet', () => {
    expect(overlaySegments(null, spans, 'const two = 3')).toEqual([
      { text: 'const two = ', changed: false },
      { text: '3', changed: true },
    ])
  })

  it('renders tokens alone when the line has no word marks', () => {
    const tokens = [{ content: 'plain', color: undefined }]
    expect(overlaySegments(tokens, undefined, 'plain')).toEqual([{ text: 'plain', color: undefined, changed: false }])
  })

  it('falls back to the raw text with neither tokens nor spans', () => {
    expect(overlaySegments(null, null, 'raw')).toEqual([{ text: 'raw', changed: false }])
    expect(overlaySegments(null, null, '')).toEqual([])
  })
})
