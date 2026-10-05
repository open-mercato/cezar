import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Diff } from './diff'
import type { DiffFileChange, DiffLineComment } from './types'

afterEach(cleanup)

const MODIFIED: DiffFileChange = {
  path: 'src/a.ts',
  status: 'modified',
  adds: 1,
  dels: 1,
  patch: [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -3,3 +3,3 @@',
    ' const one = 1',
    '-const two = 2',
    '+const two = 3',
    ' const three = 3',
    '',
  ].join('\n'),
}

async function renderDiff(ui: React.ReactElement, settleText = 'src/a.ts') {
  const view = render(ui)
  await screen.findByText(settleText)
  return view
}

describe('Diff line comments', () => {
  it('offers no "+" when the host takes no comments', async () => {
    await renderDiff(<Diff files={[MODIFIED]} />)
    expect(document.querySelector('[data-slot="diff-add-comment"]')).toBeNull()
  })

  it('opens an editor under the line and hands back anchor, excerpt and body', async () => {
    const onAddComment = vi.fn()
    await renderDiff(<Diff files={[MODIFIED]} onAddComment={onAddComment} />)

    // The added line is new-side line 4.
    fireEvent.click(screen.getByRole('button', { name: 'Comment on a.ts line 4' }))
    const editor = screen.getByPlaceholderText('Add a comment for the AI')
    expect(screen.getByRole('button', { name: 'Comment' })).toHaveProperty('disabled', true)

    fireEvent.change(editor, { target: { value: 'why 3?' } })
    fireEvent.keyDown(editor, { key: 'Enter' })

    expect(onAddComment).toHaveBeenCalledWith({
      path: 'src/a.ts',
      side: 'new',
      line: 4,
      excerpt: 'const two = 3',
      body: 'why 3?',
    })
    expect(screen.queryByPlaceholderText('Add a comment for the AI')).toBeNull()
  })

  it('anchors a deleted line on the old side and Escape cancels without calling back', async () => {
    const onAddComment = vi.fn()
    await renderDiff(<Diff files={[MODIFIED]} onAddComment={onAddComment} />)

    fireEvent.click(screen.getByRole('button', { name: 'Comment on a.ts removed line 4' }))
    const editor = screen.getByPlaceholderText('Add a comment for the AI')
    fireEvent.change(editor, { target: { value: 'x' } })
    fireEvent.keyDown(editor, { key: 'Escape' })

    expect(onAddComment).not.toHaveBeenCalled()
    expect(screen.queryByPlaceholderText('Add a comment for the AI')).toBeNull()
  })

  it('renders saved comments under their line in both layouts, and deletes one', async () => {
    const comments: DiffLineComment[] = [{ id: 'c1', path: 'src/a.ts', side: 'new', line: 5, body: 'nice' }]
    const onRemoveComment = vi.fn()
    const { rerender } = await renderDiff(
      <Diff files={[MODIFIED]} comments={comments} onRemoveComment={onRemoveComment} />,
    )

    const thread = document.querySelector('[data-slot="diff-line-comments"]')!
    expect(thread.textContent).toContain('nice')
    // Directly after the context line it anchors to (new-side 5 = `const three = 3`).
    expect(thread.previousElementSibling?.textContent).toContain('const three = 3')

    rerender(<Diff files={[MODIFIED]} mode="split" comments={comments} onRemoveComment={onRemoveComment} />)
    // A context row maps both cells to one anchor — the comment shows once, not twice.
    expect(document.querySelectorAll('[data-slot="diff-line-comment"]')).toHaveLength(1)

    // No `onEditComment` ⇒ no Edit; removal is still offered.
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Remove from chat' }))
    expect(onRemoveComment).toHaveBeenCalledWith('c1')
  })

  it('edits a saved comment in its place, and Cancel leaves it untouched', async () => {
    const comments: DiffLineComment[] = [{ id: 'c1', path: 'src/a.ts', side: 'new', line: 4, body: 'remove this' }]
    const onEditComment = vi.fn()
    const onAddComment = vi.fn()
    await renderDiff(
      <Diff files={[MODIFIED]} comments={comments} onEditComment={onEditComment} onAddComment={onAddComment} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    // The comment is swapped for its editor, prefilled.
    expect(document.querySelector('[data-slot="diff-line-comment"]')).toBeNull()
    expect(screen.getByDisplayValue('remove this')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(document.querySelector('[data-slot="diff-line-comment"]')?.textContent).toContain('remove this')
    expect(onEditComment).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const editor = screen.getByDisplayValue('remove this')
    fireEvent.change(editor, { target: { value: 'remove this import' } })
    fireEvent.keyDown(editor, { key: 'Enter' })

    expect(onEditComment).toHaveBeenCalledWith('c1', 'remove this import')
    expect(onAddComment).not.toHaveBeenCalled()
  })

  it('anchors a split context row to the new side from EITHER cell', async () => {
    const onAddComment = vi.fn()
    await renderDiff(<Diff files={[MODIFIED]} mode="split" onAddComment={onAddComment} />)

    // The first context line (`const one = 1`) is old 3 / new 3; click the LEFT (old) cell's "+".
    const pair = [...document.querySelectorAll('[data-slot="diff-pair"]')].find((row) =>
      row.textContent?.includes('const one = 1'),
    )!
    const [leftCell] = pair.querySelectorAll('[data-slot="diff-cell"]')
    fireEvent.click(leftCell!.querySelector('[data-slot="diff-add-comment"]')!)
    const editor = screen.getByPlaceholderText('Add a comment for the AI')
    fireEvent.change(editor, { target: { value: 'ctx' } })
    fireEvent.keyDown(editor, { key: 'Enter' })

    expect(onAddComment).toHaveBeenCalledWith(expect.objectContaining({ side: 'new', line: 3, excerpt: 'const one = 1' }))
  })

  it('keeps the editor and its text open when the host refuses the comment', async () => {
    const onAddComment = vi.fn(() => false)
    await renderDiff(<Diff files={[MODIFIED]} onAddComment={onAddComment} />)

    fireEvent.click(screen.getByRole('button', { name: 'Comment on a.ts line 4' }))
    const editor = screen.getByPlaceholderText('Add a comment for the AI')
    fireEvent.change(editor, { target: { value: 'too much' } })
    fireEvent.keyDown(editor, { key: 'Enter' })

    expect(onAddComment).toHaveBeenCalledTimes(1)
    expect((screen.getByPlaceholderText('Add a comment for the AI') as HTMLTextAreaElement).value).toBe('too much')
  })

  it('carries the pre-rename path with a removed line of a renamed file', async () => {
    const onAddComment = vi.fn()
    const renamed: DiffFileChange = { ...MODIFIED, path: 'src/b.ts', oldPath: 'src/a.ts', status: 'renamed' }
    render(<Diff files={[renamed]} onAddComment={onAddComment} />)
    await screen.findByText('src/b.ts')

    fireEvent.click(screen.getByRole('button', { name: 'Comment on b.ts removed line 4' }))
    const editor = screen.getByPlaceholderText('Add a comment for the AI')
    fireEvent.change(editor, { target: { value: 'why?' } })
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(onAddComment).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'src/b.ts', oldPath: 'src/a.ts', side: 'old', line: 4 }),
    )

    // An added line of the same file carries no oldPath — its number is the new file's.
    fireEvent.click(screen.getByRole('button', { name: 'Comment on b.ts line 4' }))
    const next = screen.getByPlaceholderText('Add a comment for the AI')
    fireEvent.change(next, { target: { value: 'ok' } })
    fireEvent.keyDown(next, { key: 'Enter' })
    expect(onAddComment.mock.calls[1]?.[0]).not.toHaveProperty('oldPath')
  })
})

/** jsdom ships no `matchMedia`; stub the one query the tap handler reads. */
function stubHover(canHover: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ media: query, matches: query === '(hover: none)' ? !canHover : false }))
}

describe('Diff line comments on touch screens', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('opens the editor when a line is tapped on a device that cannot hover', async () => {
    stubHover(false)
    const onAddComment = vi.fn()
    await renderDiff(<Diff files={[MODIFIED]} onAddComment={onAddComment} />)

    const added = document.querySelector('[data-slot="diff-line"][data-line="add"]')!
    fireEvent.click(added.querySelector('[data-word], span:last-child')!)
    const editor = screen.getByPlaceholderText('Add a comment for the AI')
    fireEvent.change(editor, { target: { value: 'tapped' } })
    fireEvent.keyDown(editor, { key: 'Enter' })

    expect(onAddComment).toHaveBeenCalledWith(expect.objectContaining({ side: 'new', line: 4, body: 'tapped' }))
  })

  it('works in split mode too', async () => {
    stubHover(false)
    await renderDiff(<Diff files={[MODIFIED]} mode="split" onAddComment={vi.fn()} />)

    fireEvent.click(document.querySelector('[data-slot="diff-cell"][data-line="del"]')!)
    expect(screen.getByPlaceholderText('Add a comment for the AI')).not.toBeNull()
  })

  it('leaves a click on a hover device alone — the "+" is there', async () => {
    stubHover(true)
    await renderDiff(<Diff files={[MODIFIED]} onAddComment={vi.fn()} />)

    fireEvent.click(document.querySelector('[data-slot="diff-line"][data-line="add"]')!)
    expect(screen.queryByPlaceholderText('Add a comment for the AI')).toBeNull()
  })

  it('does not open an editor when the tap ends a text selection, or when comments are off', async () => {
    stubHover(false)
    const { rerender } = await renderDiff(<Diff files={[MODIFIED]} onAddComment={vi.fn()} />)
    vi.stubGlobal('getSelection', () => ({ toString: () => 'const two' }))
    fireEvent.click(document.querySelector('[data-slot="diff-line"][data-line="add"]')!)
    expect(screen.queryByPlaceholderText('Add a comment for the AI')).toBeNull()

    vi.stubGlobal('getSelection', () => ({ toString: () => '' }))
    rerender(<Diff files={[MODIFIED]} />)
    fireEvent.click(document.querySelector('[data-slot="diff-line"][data-line="add"]')!)
    expect(screen.queryByPlaceholderText('Add a comment for the AI')).toBeNull()
  })
})

describe('Diff line comments on a range of lines', () => {
  /** The diff's displayed lines, in order: ctx 3, del 4, add 4, ctx 5. */
  const rows = () => [...document.querySelectorAll<HTMLElement>('[data-slot="diff-line"]')]
  const plusOf = (row: HTMLElement) => row.querySelector<HTMLButtonElement>('[data-slot="diff-add-comment"]')!

  it('drags the "+" across lines into one comment on the whole range', async () => {
    const onAddComment = vi.fn()
    await renderDiff(<Diff files={[MODIFIED]} onAddComment={onAddComment} />)

    const [first, , , last] = rows()
    fireEvent.mouseDown(plusOf(first!), { button: 0 })
    fireEvent.mouseEnter(rows()[2]!)
    fireEvent.mouseEnter(rows()[3]!)
    // While dragging, every covered row is marked.
    expect(rows().map((row) => row.dataset.mark)).toEqual(['selected', 'selected', 'selected', 'selected'])
    fireEvent.mouseUp(window)

    // The editor opens under the LAST line and names the span.
    expect(last!.nextElementSibling?.querySelector('[data-slot="diff-comment-editor"]')).not.toBeNull()
    expect(screen.getByLabelText('Comment on lines 3–5')).not.toBeNull()
    // No visible caption — the tinted rows already show the span.
    expect(screen.queryByText(/Commenting on/)).toBeNull()
    const editor = screen.getByPlaceholderText('Add a comment for the AI')
    fireEvent.change(editor, { target: { value: 'this whole block' } })
    fireEvent.keyDown(editor, { key: 'Enter' })

    expect(onAddComment).toHaveBeenCalledWith({
      path: 'src/a.ts',
      side: 'new',
      line: 5,
      start: { side: 'new', line: 3 },
      excerpt: 'const one = 1\nconst two = 2\nconst two = 3\nconst three = 3',
      body: 'this whole block',
    })
  })

  it('drags upwards just as well — the range is ordered, the comment hangs under its last line', async () => {
    const onAddComment = vi.fn()
    await renderDiff(<Diff files={[MODIFIED]} onAddComment={onAddComment} />)

    fireEvent.mouseDown(plusOf(rows()[3]!), { button: 0 })
    fireEvent.mouseEnter(rows()[2]!)
    fireEvent.mouseUp(window)
    const editor = screen.getByPlaceholderText('Add a comment for the AI')
    fireEvent.change(editor, { target: { value: 'up' } })
    fireEvent.keyDown(editor, { key: 'Enter' })

    expect(onAddComment).toHaveBeenCalledWith(
      expect.objectContaining({ side: 'new', line: 5, start: { side: 'new', line: 4 }, excerpt: 'const two = 3\nconst three = 3' }),
    )
  })

  it('press-and-release on one "+" is still a one-line comment', async () => {
    const onAddComment = vi.fn()
    await renderDiff(<Diff files={[MODIFIED]} onAddComment={onAddComment} />)

    fireEvent.mouseDown(plusOf(rows()[2]!), { button: 0 })
    fireEvent.mouseUp(window)
    const editor = screen.getByPlaceholderText('Add a comment for the AI')
    fireEvent.change(editor, { target: { value: 'one' } })
    fireEvent.keyDown(editor, { key: 'Enter' })

    expect(onAddComment.mock.calls[0]?.[0]).not.toHaveProperty('start')
    expect(onAddComment.mock.calls[0]?.[0]).toMatchObject({ side: 'new', line: 4 })
  })

  it('shift-click stretches the open editor to a range, keeping what was typed', async () => {
    const onAddComment = vi.fn()
    await renderDiff(<Diff files={[MODIFIED]} onAddComment={onAddComment} />)

    fireEvent.click(plusOf(rows()[0]!)) // keyboard-style activation: one line
    fireEvent.change(screen.getByPlaceholderText('Add a comment for the AI'), { target: { value: 'typed first' } })
    fireEvent.click(plusOf(rows()[3]!), { shiftKey: true })

    expect(screen.getByLabelText('Comment on lines 3–5')).not.toBeNull()
    const editor = screen.getByPlaceholderText('Add a comment for the AI') as HTMLTextAreaElement
    expect(editor.value).toBe('typed first')
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(onAddComment).toHaveBeenCalledWith(expect.objectContaining({ line: 5, start: { side: 'new', line: 3 }, body: 'typed first' }))
  })

  it('marks the lines a saved range comment covers, and names the span on the comment', async () => {
    const comments: DiffLineComment[] = [
      { id: 'r1', path: 'src/a.ts', side: 'new', line: 5, start: { side: 'old', line: 4 }, body: 'swap these' },
    ]
    await renderDiff(<Diff files={[MODIFIED]} comments={comments} />)

    // del 4 … ctx 5 are covered; ctx 3 above the range is not.
    expect(rows().map((row) => row.dataset.mark)).toEqual([undefined, 'commented', 'commented', 'commented'])
    // The span is named for screen readers; on screen the marked lines show it.
    expect(document.querySelector('[data-slot="diff-line-comment"]')?.getAttribute('aria-label')).toBe(
      'Comment on removed line 4 – line 5',
    )
    // The file header counts it.
    expect(document.querySelector('[data-slot="diff-file-header"] [data-slot="comment-count"]')?.textContent).toBe('1')
  })
})

describe('Diff line comments — editor focus, text and ranges', () => {
  const rows = () => [...document.querySelectorAll<HTMLElement>('[data-slot="diff-line"]')]
  const plusOf = (row: HTMLElement) => row.querySelector<HTMLButtonElement>('[data-slot="diff-add-comment"]')!

  it('names the file on every "+", so "line 4" is not ambiguous across files', async () => {
    await renderDiff(<Diff files={[MODIFIED]} onAddComment={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Comment on a.ts line 4' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Comment on a.ts removed line 4' })).not.toBeNull()
  })

  it('brings a freshly opened editor into view', async () => {
    const scrolled = vi.fn()
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scrolled
    try {
      await renderDiff(<Diff files={[MODIFIED]} onAddComment={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: 'Comment on a.ts line 4' }))
      expect(scrolled).toHaveBeenCalledWith({ block: 'nearest' })
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })

  it('returns focus to the "+" that opened the editor, on Comment and on Escape', async () => {
    await renderDiff(<Diff files={[MODIFIED]} onAddComment={vi.fn()} />)
    const plus = screen.getByRole('button', { name: 'Comment on a.ts line 4' })

    plus.focus()
    fireEvent.click(plus)
    fireEvent.keyDown(screen.getByPlaceholderText('Add a comment for the AI'), { key: 'Escape' })
    await waitFor(() => expect(document.activeElement).toBe(plus))

    fireEvent.click(plus)
    const editor = screen.getByPlaceholderText('Add a comment for the AI')
    fireEvent.change(editor, { target: { value: 'noted' } })
    fireEvent.keyDown(editor, { key: 'Enter' })
    await waitFor(() => expect(document.activeElement).toBe(plus))
  })

  it('returns focus to the comment after an edit is saved', async () => {
    const comments: DiffLineComment[] = [{ id: 'c1', path: 'src/a.ts', side: 'new', line: 4, body: 'remove this' }]
    await renderDiff(<Diff files={[MODIFIED]} comments={comments} onEditComment={vi.fn()} />)
    const edit = screen.getByRole('button', { name: 'Edit' })
    edit.focus()
    fireEvent.click(edit)
    fireEvent.keyDown(screen.getByDisplayValue('remove this'), { key: 'Escape' })
    // The Edit button was replaced by the editor and rendered anew — focus lands on the card's.
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Edit'))
  })

  it('does not carry a half-written note to another line — only a shift-click stretch does', async () => {
    await renderDiff(<Diff files={[MODIFIED]} onAddComment={vi.fn()} />)
    fireEvent.click(plusOf(rows()[0]!))
    fireEvent.change(screen.getByPlaceholderText('Add a comment for the AI'), { target: { value: 'about line 3' } })
    fireEvent.click(plusOf(rows()[3]!)) // a plain open elsewhere
    expect((screen.getByPlaceholderText('Add a comment for the AI') as HTMLTextAreaElement).value).toBe('')
  })

  it('a fast release still ends the drag on the last row entered', async () => {
    const onAddComment = vi.fn()
    await renderDiff(<Diff files={[MODIFIED]} onAddComment={onAddComment} />)
    fireEvent.mouseDown(plusOf(rows()[0]!), { button: 0 })
    // Entering the row and releasing in ONE batch — no render in between.
    act(() => {
      fireEvent.mouseEnter(rows()[3]!)
      fireEvent.mouseUp(window)
    })
    const editor = screen.getByPlaceholderText('Add a comment for the AI')
    fireEvent.change(editor, { target: { value: 'all of it' } })
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(onAddComment).toHaveBeenCalledWith(expect.objectContaining({ line: 5, start: { side: 'new', line: 3 } }))
  })

  it('says so in the excerpt when a range crosses collapsed unchanged lines', async () => {
    const twoHunks: DiffFileChange = {
      path: 'src/c.ts',
      status: 'modified',
      adds: 2,
      dels: 0,
      patch: [
        'diff --git a/src/c.ts b/src/c.ts',
        '--- a/src/c.ts',
        '+++ b/src/c.ts',
        '@@ -1,1 +1,2 @@',
        ' top',
        '+added near the top',
        '@@ -40,1 +41,2 @@',
        ' bottom',
        '+added near the bottom',
        '',
      ].join('\n'),
    }
    const onAddComment = vi.fn()
    await renderDiff(<Diff files={[twoHunks]} onAddComment={onAddComment} />, 'src/c.ts')
    const lines = rows()
    fireEvent.mouseDown(plusOf(lines[0]!), { button: 0 })
    fireEvent.mouseEnter(lines[3]!)
    fireEvent.mouseUp(window)
    const editor = screen.getByPlaceholderText('Add a comment for the AI')
    fireEvent.change(editor, { target: { value: 'span' } })
    fireEvent.keyDown(editor, { key: 'Enter' })

    expect(onAddComment.mock.calls[0]?.[0].excerpt).toBe(
      ['top', 'added near the top', '⋯ 38 unchanged lines not shown', 'bottom', 'added near the bottom'].join('\n'),
    )
  })
})

describe('Diff line comments after the agent changed the code', () => {
  it('marks a comment outdated, with the code it was left on, once its line reads differently', async () => {
    // Left on new-side line 4 when it read `const two = 99`; the diff now shows `const two = 3`.
    const stale: DiffLineComment[] = [
      { id: 's1', path: 'src/a.ts', side: 'new', line: 4, body: 'why 99?', excerpt: 'const two = 99' },
    ]
    await renderDiff(<Diff files={[MODIFIED]} comments={stale} />)
    const card = document.querySelector('[data-slot="diff-line-comment"]')!
    expect(card.querySelector('[data-slot="diff-line-comment-outdated"]')?.textContent).toContain('const two = 99')
  })

  it('leaves a comment whose line still reads the same unmarked', async () => {
    const current: DiffLineComment[] = [
      { id: 'c1', path: 'src/a.ts', side: 'new', line: 4, body: 'fine', excerpt: 'const two = 3' },
      // A range compares its LAST line — the anchor.
      { id: 'r1', path: 'src/a.ts', side: 'new', line: 5, start: { side: 'new', line: 3 }, body: 'block', excerpt: 'const one = 1\nconst two = 3\nconst three = 3' },
    ]
    await renderDiff(<Diff files={[MODIFIED]} comments={current} />)
    expect(document.querySelectorAll('[data-slot="diff-line-comment"]')).toHaveLength(2)
    expect(document.querySelector('[data-slot="diff-line-comment-outdated"]')).toBeNull()
  })
})
