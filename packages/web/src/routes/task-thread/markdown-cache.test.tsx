import { cleanup, render } from '@testing-library/react'
import { Lexer } from 'marked'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Markdown } from './markdown'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** Streamdown splits a message into blocks with marked's lexer; count those passes per text. */
function lexCalls(text: string, spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.filter((call) => call[0] === text).length
}

describe('Markdown block cache', () => {
  it('re-mounting settled text does not split it again, and renders the same DOM', () => {
    const text = '# Cached heading\n\nSome *settled* text.\n\n- one\n- two\n'
    const spy = vi.spyOn(Lexer, 'lex')

    const first = render(<Markdown>{text}</Markdown>)
    const html = first.container.innerHTML
    first.unmount()
    expect(lexCalls(text, spy)).toBe(1)

    const second = render(<Markdown>{text}</Markdown>)
    expect(lexCalls(text, spy)).toBe(1)
    expect(second.container.innerHTML).toBe(html)
  })
})
