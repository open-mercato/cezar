import { QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Skill } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { SourcePill } from '@/components/source-pill'

const { previewLoaded } = vi.hoisted(() => ({ previewLoaded: vi.fn() }))

vi.mock('@/components/skill-detail', () => ({
  SkillPreviewDialog: ({ skill }: { skill: Skill | null }) => {
    previewLoaded()
    return skill ? <div role="dialog">{skill.name}</div> : null
  },
}))

const skill: Skill = {
  name: 'review',
  source: 'builtin',
  path: '/skills/review.md',
  body: '# Review',
  description: 'Review changes',
}

function renderPill() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <SourcePill source={null} ready skills={[skill]} skillUsage={undefined} workflows={[]} onPick={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('SourcePill skill preview', () => {
  beforeEach(() => {
    previewLoaded.mockClear()
    Element.prototype.scrollIntoView = vi.fn()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
  })

  it('does not load the preview module until View skill is clicked', async () => {
    renderPill()
    expect(previewLoaded).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Choose a skill or workflow' }))
    fireEvent.click(await screen.findByRole('button', { name: 'View skill review' }))

    await waitFor(() => expect(previewLoaded).toHaveBeenCalled())
    expect(screen.getByRole('dialog').textContent).toContain('review')
  })
})
