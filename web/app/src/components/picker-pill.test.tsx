import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { chipClass, PickerPill } from './picker-pill'

describe('chipClass', () => {
  it('is the unified interactive Chip with the focus grammar', () => {
    expect(chipClass).toContain('h-8')
    expect(chipClass).toContain('bg-card')
    expect(chipClass).toContain('outline-none')
    expect(chipClass).toContain('focus-visible:ring-[3px]')
    expect(chipClass).toContain('focus-visible:ring-ring/50')
  })
})

describe('PickerPill catalog status', () => {
  it('keeps radio options selectable and renders a disabled status row', async () => {
    render(
      <PickerPill
        slot="model-pill"
        ariaLabel="Model"
        label="auto"
        value=""
        onPick={() => {}}
        options={[{ value: '', label: 'auto' }, { value: 'gpt-future', label: 'Future' }]}
        status="Using cached Codex model list"
      />,
    )
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Model' }))
    expect(await screen.findAllByRole('menuitemradio')).toHaveLength(2)
    expect(screen.getByText('Using cached Codex model list').closest('[data-disabled]')).not.toBeNull()
  })
})
