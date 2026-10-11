import { QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Skill } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { SourcePill } from '@/components/source-pill'

const { moduleLoaded, previewRendered } = vi.hoisted(() => ({ moduleLoaded: vi.fn(), previewRendered: vi.fn() }))

vi.mock('@/components/skill-detail', () => ({
  SkillPreviewDialog: ({ skill, onClose }: { skill: Skill | null; onClose: () => void }) => {
    moduleLoaded()
    previewRendered(skill)
    return skill ? <div data-testid="skill-preview-mock" role="dialog">{skill.name}<button type="button" onClick={onClose}>Close preview</button></div> : null
  },
}))

const skill: Skill = { name: 'review', source: 'builtin', path: '/skills/review.md', body: '# Review' }

describe('SourcePill skill preview', () => {
  beforeEach(() => {
    moduleLoaded.mockClear()
    previewRendered.mockClear()
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

  it('lazy-loads the preview on first use and preserves close/reopen without picking it', async () => {
    const onPick = vi.fn()
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <SourcePill source={null} ready skills={[skill]} skillUsage={undefined} workflows={[]} onPick={onPick} />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(moduleLoaded).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Choose a skill or workflow' }))
    fireEvent.click(await screen.findByRole('button', { name: 'View skill review' }))
    await waitFor(() => expect(screen.getByTestId('skill-preview-mock').textContent).toContain('review'))
    expect(onPick).not.toHaveBeenCalled()
    expect(moduleLoaded).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }))
    expect(previewRendered).toHaveBeenLastCalledWith(null)
    fireEvent.click(await screen.findByRole('button', { name: 'View skill review' }))
    await waitFor(() => expect(screen.getByTestId('skill-preview-mock').textContent).toContain('review'))
    expect(previewRendered).toHaveBeenLastCalledWith(skill)
    expect(onPick).not.toHaveBeenCalled()
  })
})
