import { EditorView } from '@codemirror/view'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import CodeMirrorEditor from './code-mirror-editor'

afterEach(cleanup)

const view = () => EditorView.findFromDOM(document.querySelector('[data-slot="code-mirror"]') as HTMLElement)!
/** Insert at the start, the way a keystroke would — through a transaction the editor reports. */
const insert = (text: string) => act(() => view().dispatch({ changes: { from: 0, insert: text } }))

describe('CodeMirrorEditor', () => {
  it('reports what was typed', () => {
    const onChange = vi.fn()
    render(<CodeMirrorEditor value={'a\nb\n'} onChange={onChange} path="notes.txt" />)
    insert('x')
    expect(onChange).toHaveBeenLastCalledWith('xa\nb\n')
  })

  // The server writes bytes verbatim, so the editor must not normalize them on the way through:
  // CodeMirror's default joins lines with `\n`, which would rewrite every line of a CRLF file.
  it('hands a CRLF file back as CRLF', () => {
    const onChange = vi.fn()
    render(<CodeMirrorEditor value={'one\r\ntwo\r\n'} onChange={onChange} path="win.txt" />)
    expect(view().state.doc.lines).toBe(3)
    insert('zero\r\n')
    expect(onChange).toHaveBeenLastCalledWith('zero\r\none\r\ntwo\r\n')
  })

  it('leaves a file with mixed line endings exactly as it found it', () => {
    const onChange = vi.fn()
    const mixed = 'unix\nwindows\r\nlast'
    render(<CodeMirrorEditor value={mixed} onChange={onChange} path="mixed.txt" />)
    insert('x')
    expect(onChange).toHaveBeenLastCalledWith(`x${mixed}`)
  })

  it('takes a value changed from outside without reporting it back as an edit', () => {
    const onChange = vi.fn()
    const { rerender } = render(<CodeMirrorEditor value="old" onChange={onChange} path="a.txt" />)
    rerender(<CodeMirrorEditor value="reloaded from disk" onChange={onChange} path="a.txt" />)
    expect(view().state.sliceDoc()).toBe('reloaded from disk')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('calls the handler from the latest render, not the one it mounted with', () => {
    const first = vi.fn()
    const latest = vi.fn()
    const { rerender } = render(<CodeMirrorEditor value="a" onChange={first} path="a.txt" />)
    rerender(<CodeMirrorEditor value="a" onChange={latest} path="a.txt" />)
    insert('x')
    expect(first).not.toHaveBeenCalled()
    expect(latest).toHaveBeenCalledWith('xa')
  })

  it('opens the find panel when asked to, and not on mount', () => {
    const { rerender } = render(<CodeMirrorEditor value="a" path="a.txt" />)
    expect(document.querySelector('.cm-search')).toBeNull()
    rerender(<CodeMirrorEditor value="a" path="a.txt" findRequest={1} />)
    expect(document.querySelector('.cm-search')).not.toBeNull()
  })

  it('follows readOnly and wrap after mounting', () => {
    const { rerender } = render(<CodeMirrorEditor value="a" path="a.txt" />)
    expect(view().state.readOnly).toBe(false)
    expect(view().contentDOM.classList.contains('cm-lineWrapping')).toBe(false)
    rerender(<CodeMirrorEditor value="a" path="a.txt" readOnly wrap />)
    expect(view().state.readOnly).toBe(true)
    expect(view().contentDOM.classList.contains('cm-lineWrapping')).toBe(true)
  })
})
