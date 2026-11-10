import { describe, expect, it } from 'vitest'
// Streamdown's own dependency, imported here only to prove the port matches it — and to fail
// the day a Streamdown upgrade changes the handler underneath it.
import remend from 'remend'

import { completeIncompleteLink } from './remend-links'

const LINKS_ONLY = {
  singleTilde: false,
  comparisonOperators: false,
  htmlTags: false,
  setextHeadings: false,
  boldItalic: false,
  bold: false,
  italic: false,
  inlineCode: false,
  strikethrough: false,
  katex: false,
}

// remend drops one trailing space before any handler runs.
const reference = (text: string) => remend(text, LINKS_ONLY)
const port = (text: string) =>
  completeIncompleteLink(text.endsWith(' ') && !text.endsWith('  ') ? text.slice(0, -1) : text)

const REPLY = [
  'See [the log](https://example.com/log) and ![shot](https://example.com/a.png).',
  'Nested [a [b] c](https://example.com/n) and `code [x]` and \\`[y`.',
  '```',
  'const a = [1, 2](3)',
  '```',
  '- [ ] task',
  '- [x] done [ref][1]',
  '',
  '[1]: https://example.com/ref',
  'Trailing [half](https://exa',
].join('\n')

describe('completeIncompleteLink', () => {
  it.each([
    ['plain text', 'plain text'],
    ['a [half', 'a [half](streamdown:incomplete-link)'],
    ['a [text](https://exa', 'a [text](streamdown:incomplete-link)'],
    ['an ![image](https://exa', 'an '],
    ['an ![image', 'an '],
    ['`[in code`', '`[in code`'],
  ])('completes %j like remend', (input, expected) => {
    expect(port(input)).toBe(expected)
    expect(reference(input)).toBe(expected)
  })

  it('matches remend on every prefix of a link-dense reply', () => {
    for (let at = 0; at <= REPLY.length; at += 1) {
      const text = REPLY.slice(0, at)
      expect(port(text), JSON.stringify(text)).toBe(reference(text))
    }
  })

  it('matches remend on random bracket soup', () => {
    let seed = 7
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
    const alphabet = ['[', ']', '(', ')', '!', '`', '```', '\\', ' ', 'a', '\n', 'http://x']
    for (let run = 0; run < 3000; run += 1) {
      const text = Array.from({ length: 1 + Math.floor(random() * 30) }, () => alphabet[Math.floor(random() * alphabet.length)]).join('')
      expect(port(text), JSON.stringify(text)).toBe(reference(text))
    }
  })
})
