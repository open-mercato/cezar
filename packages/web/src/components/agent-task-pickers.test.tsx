import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Skill } from '@open-mercato/cezar-api-client'
import { SkillsPicker } from '@/components/agent-task-pickers'

const { moduleLoaded, previewRendered } = vi.hoisted(() => ({ moduleLoaded: vi.fn(), previewRendered: vi.fn() }))

vi.mock('@/components/skill-detail', () => ({
  SkillPreviewDialog: ({ skill, onClose }: { skill: Skill | null; onClose: () => void }) => {
    moduleLoaded()
    previewRendered(skill)
    return skill ? <div data-testid="skill-preview-mock" role="dialog">{skill.name}<button type="button" onClick={onClose}>Close preview</button></div> : null
  },
}))

const skill: Skill = { name: 'review', source: 'builtin', path: '/skills/review.md', body: '# Review' }

describe('SkillsPicker skill preview', () => {
  beforeEach(() => {
    moduleLoaded.mockClear()
    previewRendered.mockClear()
    Element.prototype.scrollIntoView = vi.fn()
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  })

  it('lazy-loads the preview on first use and preserves close/reopen without toggling', async () => {
    const onToggle = vi.fn()
    render(<SkillsPicker skills={[skill]} skillUsage={undefined} selected={[]} onToggle={onToggle} slotPrefix="test" />)
    expect(moduleLoaded).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Choose skills' }))
    fireEvent.click(await screen.findByRole('button', { name: 'View skill review' }))
    await waitFor(() => expect(screen.getByTestId('skill-preview-mock').textContent).toContain('review'))
    expect(onToggle).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }))
    expect(previewRendered).toHaveBeenLastCalledWith(null)
    fireEvent.click(await screen.findByRole('button', { name: 'View skill review' }))
    await waitFor(() => expect(screen.getByTestId('skill-preview-mock').textContent).toContain('review'))
    expect(previewRendered).toHaveBeenLastCalledWith(skill)
    expect(onToggle).not.toHaveBeenCalled()
  })
})
