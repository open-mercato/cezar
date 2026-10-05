import { act, cleanup, render, waitFor } from '@testing-library/react'
import { useImperativeHandle, type ReactNode, type Ref } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DiffView } from './diff-view'
import type { DiffHandle } from './types'

const virtual = vi.hoisted(() => ({ scrollToIndex: vi.fn(), scrollTo: vi.fn() }))
// Keep the real diff and reveal lifecycle. Model only the virtualizer's scroll ownership;
// jsdom has no layout, so viewport and comment geometry are supplied explicitly below.
vi.mock('virtua', () => ({
  Virtualizer: ({ children, ref }: { children: ReactNode; ref: Ref<unknown> }) => {
    useImperativeHandle(ref, () => virtual)
    return <div>{children}</div>
  },
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  window.history.replaceState({}, '', '/')
})

const file = {
  path: 'review.ts', status: 'added' as const, adds: 3, dels: 0,
  patch: 'diff --git a/review.ts b/review.ts\n--- /dev/null\n+++ b/review.ts\n@@ -0,0 +1,3 @@\n+one\n+two\n+three\n',
}
const comment = { id: 'deep', path: file.path, side: 'new' as const, line: 3, body: 'Check this line', excerpt: 'three' }

function mount(mode: 'flat' | 'virtual') {
  window.history.replaceState({}, '', `/?diff=${mode}`)
  const ref: { current: DiffHandle | null } = { current: null }
  const view = render(
    <main data-slot="main">
      <DiffView files={[file]} comments={[comment]} onAddComment={() => true} viewRef={ref} />
    </main>,
  )
  return { ref, main: view.container.querySelector('main')! }
}

describe('revealing a comment', () => {
  it('positions a selected file below the sticky chrome through the virtualizer', () => {
    const { ref } = mount('virtual')
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ scrollMarginTop: '160px' } as CSSStyleDeclaration)

    act(() => ref.current!.scrollToPath(file.path))

    expect(virtual.scrollToIndex).toHaveBeenCalledWith(0, { align: 'start', offset: -160 })
  })

  it('uses the virtualizer for the exact jump, replacing its pending file jump', async () => {
    const { ref, main } = mount('virtual')
    const card = document.querySelector<HTMLElement>('[data-comment-id="deep"]')!
    main.scrollTop = 400
    Object.defineProperty(main, 'clientHeight', { value: 800 })
    vi.spyOn(main, 'getBoundingClientRect').mockReturnValue({ top: 50 } as DOMRect)
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({ top: 3000, height: 40 } as DOMRect)
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ scrollMarginBottom: '100px' } as CSSStyleDeclaration)
    const domScroll = vi.fn()
    card.scrollIntoView = domScroll

    act(() => ref.current!.reveal!({ path: file.path, side: 'new', line: 3, commentId: comment.id }))

    await waitFor(() => expect(virtual.scrollTo).toHaveBeenCalledWith(3020))
    expect(virtual.scrollToIndex).toHaveBeenCalledWith(0, { align: 'start', offset: -0 })
    expect(domScroll).not.toHaveBeenCalled()
    expect(card.dataset.flash).toBe('true')
  })

  it('jumps immediately in flat mode so lazy layout cannot invalidate a smooth destination', async () => {
    const { ref } = mount('flat')
    const card = document.querySelector<HTMLElement>('[data-comment-id="deep"]')!
    const domScroll = vi.fn()
    card.scrollIntoView = domScroll

    act(() => ref.current!.reveal!({ path: file.path, side: 'new', line: 3, commentId: comment.id }))

    await waitFor(() => expect(domScroll).toHaveBeenCalledWith({ block: 'center', behavior: 'instant' }))
    expect(card.dataset.flash).toBe('true')
  })
})
