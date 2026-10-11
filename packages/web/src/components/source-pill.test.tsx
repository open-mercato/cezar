import { QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Skill } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { SourcePill } from '@/components/source-pill'

const { previewRendered } = vi.hoisted(() => ({ previewRendered: vi.fn() }))

vi.mock('@/components/skill-detail', () => ({
  SkillPreviewDialog: ({ skill }: { skill: Skill | null }) => {
    previewRendered(skill)
    return skill ? <div role="dialog">{skill.name}</div> : null
  },
}))

const skill: Skill = { name: 'review', source: 'builtin', path: '/skills/review.md', body: '# Review' }

describe('SourcePill skill preview', () => {
  beforeEach(() => previewRendered.mockClear())

  it('keeps the preview wrapper mounted and opens the selected skill without picking it', async () => {
    const onPick = vi.fn()
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <SourcePill source={null} ready skills={[skill]} skillUsage={undefined} workflows={[]} onPick={onPick} />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(previewRendered).toHaveBeenCalledWith(null)
    fireEvent.click(screen.getByRole('button', { name: 'Choose a skill or workflow' }))
    fireEvent.click(await screen.findByRole('button', { name: 'View skill review' }))
    await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain('review'))
    expect(onPick).not.toHaveBeenCalled()
  })
})
