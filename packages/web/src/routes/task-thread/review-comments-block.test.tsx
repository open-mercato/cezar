import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { createQueryClient } from '@/api/query-client'

import { formatDiffComments, type DiffComment } from './diff-comments'
import { UserBubble } from './thread-items'

afterEach(cleanup)

const COMMENT: DiffComment = {
  id: 'c1',
  path: '.ai/specs/draft-persistence.md',
  side: 'new',
  line: 154,
  body: 'explain this line',
  excerpt: '| `diff-comments` | Changes-tab line comments |',
}

function renderBubble(text: string) {
  // The bubble hosts a (here inert) draft hook, which needs a query client.
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/tasks/r1']}>
        <Routes>
          <Route path="/tasks/:id" element={<UserBubble text={text} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('a sent review in the transcript', () => {
  it('renders each comment as a card: file link, the code, and the note — apart', () => {
    renderBubble(`please look\n\n${formatDiffComments([COMMENT])}`)

    expect(screen.getByText('please look')).not.toBeNull()
    const card = document.querySelector('[data-slot="review-comment"]')!
    const link = card.querySelector('a')!
    expect(link.textContent).toBe('.ai/specs/draft-persistence.md')
    // Straight to that line on the Changes tab.
    expect(link.getAttribute('href')).toBe('/tasks/r1/changes?file=.ai%2Fspecs%2Fdraft-persistence.md&side=new&line=154')
    expect(card.querySelector('[data-slot="review-comment-code"]')?.textContent).toBe(COMMENT.excerpt)
    // The note is its own element — not folded into the quoted code.
    expect(card.querySelector('[data-slot="review-comment-body"]')?.textContent).toBe('explain this line')
    expect(card.querySelector('[data-slot="review-comment-code"]')?.textContent).not.toContain('explain')
  })

  it('leaves an ordinary message as plain Markdown', () => {
    renderBubble('nothing to review here')
    expect(document.querySelector('[data-slot="review-comments"]')).toBeNull()
    expect(screen.getByText('nothing to review here')).not.toBeNull()
  })
})

describe('a sent asset comment in the transcript', () => {
  it('links to the asset on the Assets tab and shows the element markup apart from the note', () => {
    renderBubble(
      formatDiffComments([
        COMMENT,
        { kind: 'asset', id: 'e', asset: 'recipe.html', selector: 'main > h2', label: 'Ingredients', excerpt: '<h2>Ingredients</h2>', body: 'bigger' },
      ]),
    )
    expect(screen.getByText('2 comments on the diff and assets')).not.toBeNull()
    const cards = document.querySelectorAll('[data-slot="review-comment"]')
    const link = cards[1]!.querySelector('a')!
    expect(link.textContent).toBe('recipe.html')
    expect(link.getAttribute('href')).toBe('/tasks/r1/assets/recipe.html')
    expect(cards[1]!.querySelector('[data-slot="review-comment-code"]')?.textContent).toBe('<h2>Ingredients</h2>')
    expect(cards[1]!.querySelector('[data-slot="review-comment-body"]')?.textContent).toBe('bigger')
    expect(cards[1]!.querySelector('[data-slot="review-comment-element"]')?.textContent).toBe('· element main > h2')
  })
})
