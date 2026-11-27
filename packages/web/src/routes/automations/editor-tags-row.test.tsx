import { cleanup, fireEvent, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { EditorTagsRow } from './editor-tags-row'

vi.mock('@/api/task-tags', () => ({
  useActiveProjectId: () => 'proj',
  useTaskTags: () => ({
    data: {
      tags: [{ id: 'tt-live00001', name: 'Release', color: 'green', createdAt: '2026-11-01T00:00:00.000Z' }],
      deletedIds: [],
    },
  }),
  useCreateTaskTag: () => ({ mutate: vi.fn(), isPending: false }),
}))

// The picker's popover is not under test; the row's chips and the missing-tag line are.
vi.mock('@/components/task-tag-picker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/task-tag-picker')>()),
  TaskTagPicker: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

afterEach(cleanup)

const swatch = (chip: Element) => chip.querySelector('span[aria-hidden="true"]')?.className ?? ''

describe('EditorTagsRow (spec 2026-11-23-automation-task-tags)', () => {
  it('paints a live tag in its color and a gone tag gray, with the "no longer exist" line', () => {
    const { container } = render(
      <EditorTagsRow
        tags={[{ id: 'tt-live00001', name: 'Release' }, { id: 'tt-gone00001', name: 'Old sprint' }]}
        onChange={() => undefined}
      />,
    )
    const chips = [...container.querySelectorAll('[data-slot="task-tag-chip"]')]
    expect(chips.map((chip) => chip.textContent)).toEqual(['Release', 'Old sprint'])
    expect(swatch(chips[0]!)).toContain('bg-tag-green')
    expect(swatch(chips[1]!)).toContain('bg-tag-gray')
    expect(container.querySelector('[data-slot="editor-tags-missing"]')?.textContent).toBe(
      'A gray tag no longer exists; runs start without it.',
    )
  })

  it('falls back to a live tag of the same name, and shows no missing line', () => {
    const { container } = render(<EditorTagsRow tags={[{ id: 'tt-other0001', name: 'release' }]} onChange={() => undefined} />)
    const chip = container.querySelector('[data-slot="task-tag-chip"]')!
    expect(chip.getAttribute('data-tag-id')).toBe('tt-live00001')
    expect(swatch(chip)).toContain('bg-tag-green')
    expect(container.querySelector('[data-slot="editor-tags-missing"]')).toBeNull()
  })

  it('removes a gray tag by position', () => {
    const onChange = vi.fn()
    const { getByRole } = render(
      <EditorTagsRow tags={[{ id: 'tt-live00001', name: 'Release' }, { name: 'Gone' }]} onChange={onChange} />,
    )
    fireEvent.click(getByRole('button', { name: 'Remove tag Gone' }))
    expect(onChange).toHaveBeenCalledWith([{ id: 'tt-live00001', name: 'Release' }])
  })
})
