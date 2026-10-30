// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { VIEW_DRAG_TYPE } from './layout-cards'
import { ViewDropZones } from './view-drop-zones'

afterEach(cleanup)

const dataTransfer = { types: [VIEW_DRAG_TYPE], getData: () => 'terminal', dropEffect: '' }
const hot = (el: Element) => el.className.includes('bg-muted')

describe('ViewDropZones hover (#1556)', () => {
  it('keeps the highlight while the pointer crosses into the label, with no relatedTarget', () => {
    const { container } = render(
      <ViewDropZones view="terminal" columns={[{ view: 'changes', width: 100 }]} onDrop={vi.fn()} />,
    )
    const zone = container.querySelector('[data-drop-zone="replace"]')!
    const label = zone.firstChild!.parentElement!.appendChild(document.createElement('span'))
    fireEvent.dragEnter(zone, { dataTransfer })
    fireEvent.dragOver(zone, { dataTransfer })
    expect(hot(zone)).toBe(true)
    // Entering a child fires enter(child) then leave(zone); Safari/Firefox give no relatedTarget.
    fireEvent.dragEnter(label, { dataTransfer })
    fireEvent.dragLeave(zone, { dataTransfer })
    expect(hot(zone)).toBe(true)
    fireEvent.dragLeave(label, { dataTransfer })
    expect(hot(zone)).toBe(false)
  })

  it('still drops with the view and clears the highlight', () => {
    const onDrop = vi.fn()
    const { container } = render(
      <ViewDropZones view="terminal" columns={[{ view: 'changes', width: 100 }]} onDrop={onDrop} />,
    )
    const zone = container.querySelector('[data-drop-zone="replace"]')!
    fireEvent.dragEnter(zone, { dataTransfer })
    fireEvent.drop(zone, { dataTransfer })
    expect(onDrop).toHaveBeenCalledWith('terminal', 0, 'replace')
    expect(hot(zone)).toBe(false)
  })
})
