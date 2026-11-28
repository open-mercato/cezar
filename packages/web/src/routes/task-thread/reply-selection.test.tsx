import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { ReplySelection, replySelectionText, selectedExtent, SETTLE_MS } from './reply-selection'

afterEach(cleanup)

beforeAll(() => {
  // jsdom lays nothing out: give ranges a box so the toolbar has somewhere to sit.
  Range.prototype.getBoundingClientRect = () =>
    ({ top: 300, bottom: 320, left: 100, width: 200, height: 20, right: 300, x: 100, y: 300, toJSON: () => ({}) }) as DOMRect
})

function thread(runId = 'r1') {
  render(
    <div data-route="task-thread" data-run-id={runId}>
      <div data-slot="user-message"><p>my own words</p></div>
      <div data-slot="assistant-message"><p id="reply">Pill.tsx works out which state applies.</p></div>
    </div>,
  )
}

function select(id: string) {
  const node = document.getElementById(id)!
  const range = document.createRange()
  range.selectNodeContents(node)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

describe('replySelectionText', () => {
  it("answers only for a selection inside this run's assistant replies", () => {
    thread()
    select('reply')
    expect(replySelectionText(window.getSelection(), 'r1')).toBe('Pill.tsx works out which state applies.')
    expect(replySelectionText(window.getSelection(), 'other')).toBeUndefined()
  })
  it('answers for a triple-click on the last paragraph, whose range ends at the next block outside the reply', () => {
    render(
      <div data-route="task-thread" data-run-id="r1">
        <div data-slot="assistant-message">
          <p id="first">First paragraph.</p>
          <p id="last">Last paragraph.</p>
        </div>
        <div id="after"><span>2:31 PM</span></div>
      </div>,
    )
    // Chrome's triple-click shape: from the paragraph's text to offset 0 of the following block.
    const range = document.createRange()
    range.setStart(document.getElementById('last')!.firstChild!, 0)
    range.setEnd(document.getElementById('after')!, 0)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    expect(replySelectionText(window.getSelection(), 'r1')).toBe('Last paragraph.')
    const extent = selectedExtent(range)
    expect(extent.endContainer).toBe(document.getElementById('last')!.firstChild)
    expect(extent.endOffset).toBe('Last paragraph.'.length)
  })

  it('answers for a triple-click that ends at offset 0 of an EMPTY element after the reply', () => {
    render(
      <div data-route="task-thread" data-run-id="r1">
        <div data-slot="assistant-message"><p id="last">Last paragraph.</p></div>
        <span id="empty" />
        <p>2:31 PM</p>
      </div>,
    )
    const range = document.createRange()
    range.setStart(document.getElementById('last')!.firstChild!, 0)
    range.setEnd(document.getElementById('empty')!, 0)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    expect(replySelectionText(window.getSelection(), 'r1')).toBe('Last paragraph.')
  })

  it('leaves a range that already ends inside its text alone', () => {
    thread()
    const text = document.getElementById('reply')!.firstChild!
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 8)
    expect(selectedExtent(range)).toBe(range)
  })

  it('ignores a selection outside the replies', () => {
    thread()
    const range = document.createRange()
    range.selectNodeContents(document.querySelector('[data-slot="user-message"] p')!)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    expect(replySelectionText(window.getSelection(), 'r1')).toBeUndefined()
  })
})

describe('ReplySelection', () => {
  async function selectReply(props: Partial<Parameters<typeof ReplySelection>[0]> = {}) {
    const onAddToChat = vi.fn()
    const onComment = vi.fn(() => true)
    render(
      <div data-route="task-thread" data-run-id="r1">
        <ReplySelection runId="r1" onAddToChat={onAddToChat} onComment={onComment} canComment {...props} />
        <div data-slot="assistant-message"><p id="reply">Pill.tsx works out which state applies.</p></div>
      </div>,
    )
    select('reply')
    await act(async () => {
      fireEvent.pointerUp(document.getElementById('reply')!)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    return { onAddToChat, onComment }
  }

  it('offers Add to chat on a selected passage and hands it over', async () => {
    const { onAddToChat } = await selectReply()
    fireEvent.click(screen.getByRole('button', { name: /Add to chat/ }))
    expect(onAddToChat).toHaveBeenCalledWith('Pill.tsx works out which state applies.')
    expect(screen.queryByRole('toolbar')).toBeNull()
  })

  it('Reply opens a comment box under the quote, and Enter keeps the comment', async () => {
    const { onComment } = await selectReply()
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
    const box = screen.getByRole('dialog', { name: 'Reply to the selected text' })
    expect(box.textContent).toContain('Pill.tsx works out which state applies.')
    const input = screen.getByRole('textbox', { name: 'Your comment' })
    fireEvent.change(input, { target: { value: '  why?  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onComment).toHaveBeenCalledWith({ excerpt: 'Pill.tsx works out which state applies.', body: 'why?' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps the box open when the comment could not be kept', async () => {
    const refused = vi.fn(() => false)
    await selectReply({ onComment: refused })
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Your comment' }), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }))
    expect(refused).toHaveBeenCalledOnce()
    expect(screen.getByRole('dialog')).not.toBeNull()
  })

  it('turns both actions off until the comment list has loaded', async () => {
    await selectReply({ canComment: false })
    expect((screen.getByRole('button', { name: 'Reply' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: /Add to chat/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps an open Reply box, and what was typed, when the passage leaves the page', async () => {
    await selectReply()
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Your comment' }), { target: { value: 'half a thought' } })
    const box = Range.prototype.getBoundingClientRect
    // A long thread unmounts far rows: the kept range no longer has a box.
    Range.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, width: 0, height: 0 }) as DOMRect
    try {
      act(() => void window.dispatchEvent(new Event('scroll')))
      expect((screen.getByRole('textbox', { name: 'Your comment' }) as HTMLTextAreaElement).value).toBe('half a thought')
    } finally {
      Range.prototype.getBoundingClientRect = box
    }
  })

  it('drops the toolbar (nothing typed there) when the passage leaves the page', async () => {
    await selectReply()
    const box = Range.prototype.getBoundingClientRect
    Range.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, width: 0, height: 0 }) as DOMRect
    try {
      act(() => void window.dispatchEvent(new Event('scroll')))
      expect(screen.queryByRole('toolbar')).toBeNull()
    } finally {
      Range.prototype.getBoundingClientRect = box
    }
  })

  it('follows a touch selection once it settles — the OS handles fire no pointer events', async () => {
    render(
      <div data-route="task-thread" data-run-id="r1">
        <ReplySelection runId="r1" onAddToChat={vi.fn()} onComment={vi.fn(() => true)} canComment />
        <div data-slot="assistant-message"><p id="reply">Pill.tsx works out which state applies.</p></div>
      </div>,
    )
    fireEvent.pointerDown(document.getElementById('reply')!, { pointerType: 'touch' })
    select('reply')
    act(() => void document.dispatchEvent(new Event('selectionchange')))
    expect(screen.queryByRole('toolbar')).toBeNull()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS + 50))
    })
    expect(screen.getByRole('toolbar', { name: 'Selected text' })).not.toBeNull()
  })

  it('does not open the toolbar mid-drag for a mouse selection', async () => {
    render(
      <div data-route="task-thread" data-run-id="r1">
        <ReplySelection runId="r1" onAddToChat={vi.fn()} onComment={vi.fn(() => true)} canComment />
        <div data-slot="assistant-message"><p id="reply">Pill.tsx works out which state applies.</p></div>
      </div>,
    )
    fireEvent.pointerDown(document.getElementById('reply')!, { pointerType: 'mouse' })
    select('reply')
    act(() => void document.dispatchEvent(new Event('selectionchange')))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS + 50))
    })
    expect(screen.queryByRole('toolbar')).toBeNull()
  })
})
