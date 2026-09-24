import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { CodeEditor } from './code-editor'

afterEach(cleanup)

// jsdom cannot assert the overlay's pixel alignment — that is covered by the
// e2e suite (spec #404 §Editor). These cover the DOM contract.

describe('CodeEditor', () => {
  it('renders the value in the textarea', () => {
    render(<CodeEditor value={'{"a":1}'} language="json" aria-label="editor" />)
    expect((screen.getByLabelText('editor') as HTMLTextAreaElement).value).toBe('{"a":1}')
  })

  it('fires onChange with the new text', () => {
    let seen = ''
    render(<CodeEditor value="" language="json" onChange={(v) => (seen = v)} aria-label="editor" />)
    fireEvent.change(screen.getByLabelText('editor'), { target: { value: '{"b":2}' } })
    expect(seen).toBe('{"b":2}')
  })

  it('does not soft-wrap (wrap=off)', () => {
    render(<CodeEditor value="x" language="json" aria-label="editor" />)
    expect(screen.getByLabelText('editor').getAttribute('wrap')).toBe('off')
  })

  it('honours readOnly', () => {
    render(<CodeEditor value="x" language="json" readOnly aria-label="editor" />)
    expect((screen.getByLabelText('editor') as HTMLTextAreaElement).readOnly).toBe(true)
  })

  it('degrades to plaintext for an unknown language without throwing', () => {
    expect(() =>
      render(<CodeEditor value={'hello'} language="not-a-language" aria-label="editor" />),
    ).not.toThrow()
    expect((screen.getByLabelText('editor') as HTMLTextAreaElement).value).toBe('hello')
  })

  it('does not trap Tab — the textarea stays keyboard-navigable', () => {
    // No onKeyDown handler that would preventDefault Tab: the component installs none.
    render(<CodeEditor value="x" language="json" aria-label="editor" />)
    const ta = screen.getByLabelText('editor')
    const ev = fireEvent.keyDown(ta, { key: 'Tab' })
    // fireEvent returns false only when a handler called preventDefault.
    expect(ev).toBe(true)
  })

  it('disables spellcheck/autocorrect for config text', () => {
    render(<CodeEditor value="x" language="toml" aria-label="editor" />)
    const ta = screen.getByLabelText('editor')
    expect(ta.getAttribute('spellcheck')).toBe('false')
    expect(ta.getAttribute('autocorrect')).toBe('off')
  })
})
