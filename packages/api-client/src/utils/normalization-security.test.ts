import { describe, expect, it, vi } from 'vitest'
import { sanitizeAttachmentName } from '@open-mercato/cezar-contract'
import { getApiBaseUrl, setApiBaseUrl } from './project-scope.ts'

// Reject the vulnerable operations deterministically: wall-clock thresholds are load-sensitive,
// and attachment stems are already bounded before suffix trimming.
function rejectPolynomialSuffix(pattern: string, run: () => void): void {
  const replace = String.prototype.replace
  const spy = vi.spyOn(String.prototype, 'replace').mockImplementation(function (
    this: string, ...args: Parameters<typeof replace>
  ) {
    const [search] = args
    if (search instanceof RegExp && search.source === pattern) {
      throw new Error('polynomial suffix regex executed')
    }
    return Reflect.apply(replace, this, args)
  })
  try {
    run()
  } finally {
    spy.mockRestore()
    setApiBaseUrl('')
  }
}

describe('linear suffix normalization', () => {
  it('normalizes adversarial URL suffixes without the polynomial regex', () => {
    rejectPolynomialSuffix('\\/+$', () => {
      const embedded = `https://host/${'/'.repeat(100_000)}x`
      setApiBaseUrl(`${embedded}///`)
      expect(getApiBaseUrl()).toBe(embedded)
      setApiBaseUrl('/'.repeat(100_000))
      expect(getApiBaseUrl()).toBe('')
    })
  })

  it.each(['', '/', '///', 'https://host///', 'https://host/a//b', 'a/\n', 'a/\r\n', 'a/\u2028', 'a/\u2029', 'a/ ', 'a/?x=/'])('preserves URL normalization for %j', (input) => {
    try {
      setApiBaseUrl(input)
      expect(getApiBaseUrl()).toBe(input.replace(/\/+$/, ''))
    } finally {
      setApiBaseUrl('')
    }
  })

  it('normalizes bounded adversarial attachment stems without the polynomial regex', () => {
    rejectPolynomialSuffix('[. ]+$', () => {
      expect(sanitizeAttachmentName(`a${'.'.repeat(98)}x.txt`, 'text/plain')).toBe(`a${'.'.repeat(98)}x.txt`)
      expect(sanitizeAttachmentName(`a${'.'.repeat(200)}x.txt`, 'text/plain')).toBe('a.txt')
    })
  })

  it.each([
    ['notes. .txt', 'notes.txt'], ['notes. ', 'notes.txt'], [' . . ', null],
    ['C:\\tmp\\CON.txt', 'CON-.txt'], ['../notes.markdown', 'notes.markdown'],
    ['a\u00a0.\t.txt', 'a.txt'], ['photo.jpeg', 'photo.jpeg'],
    ['install.sh', 'install.sh.txt'], ['a'.repeat(99) + '.x', 'a'.repeat(99) + '.txt'],
  ])('preserves attachment normalization for %j', (input, expected) => {
    const mediaType = input.endsWith('.jpeg') ? 'image/jpeg'
      : input.endsWith('.markdown') ? 'text/markdown' : 'text/plain'
    expect(sanitizeAttachmentName(input, mediaType)).toBe(expected)
  })
})
