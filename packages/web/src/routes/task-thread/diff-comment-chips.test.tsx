import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DiffCommentChips } from './diff-comment-chips'
import type { DiffComment } from './diff-comments'

afterEach(cleanup)

const base: DiffComment = { id: 'a', path: 'src/app/page.tsx', side: 'new', line: 11, body: 'note', excerpt: '' }

function renderChips(comments: DiffComment[]) {
  render(
    <MemoryRouter>
      <DiffCommentChips runId="r1" comments={comments} onRemove={vi.fn()} />
    </MemoryRouter>,
  )
}

describe('diff comment chips', () => {
  it('labels one line, a same-side range, and a range across removed and added lines', () => {
    renderChips([
      base,
      { ...base, id: 'b', line: 14, start: { side: 'new', line: 12 } },
      { ...base, id: 'c', line: 30, start: { side: 'old', line: 28 } },
    ])
    expect(screen.getByText('page.tsx +11')).not.toBeNull()
    expect(screen.getByText('page.tsx +12–14')).not.toBeNull()
    expect(screen.getByText('page.tsx −28–+30')).not.toBeNull()
  })

  it('speaks the span in words and never reads the body out', () => {
    renderChips([{ ...base, line: 14, start: { side: 'new', line: 12 }, body: 'x'.repeat(4000) }])
    const link = screen.getByRole('link')
    expect(link.getAttribute('aria-label')).toBe('Comment on src/app/page.tsx lines 12–14')
    // Straight to this comment on the Changes tab, not the top of its file.
    expect(link.getAttribute('href')).toBe('/tasks/r1/changes?file=src%2Fapp%2Fpage.tsx&side=new&line=14&comment=a')
    expect(screen.getByRole('button', { name: 'Remove comment on page.tsx lines 12–14' })).not.toBeNull()
  })

  it("explains the comment in the cockpit's tooltip, not the browser's title", async () => {
    // Radix positions the tooltip with floating-ui, which measures — jsdom has no observer.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
    renderChips([{ ...base, line: 14, start: { side: 'new', line: 12 }, body: 'collapse these\ninto one' }])
    const chip = document.querySelector<HTMLElement>('[data-slot="diff-comment-chip"]')!
    expect(chip.hasAttribute('title')).toBe(false)

    // Keyboard focus opens it as well as hover.
    fireEvent.focus(screen.getByRole('link'))
    const tooltip = await waitFor(() => {
      const found = document.querySelector('[data-slot="diff-comment-tooltip"]')
      expect(found).not.toBeNull()
      return found!
    })
    expect(tooltip.textContent).toContain('src/app/page.tsx · lines 12–14')
    expect(tooltip.textContent).toContain('collapse these')
    vi.unstubAllGlobals()
  })
})
