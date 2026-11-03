import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { MAX_TREE_PANE_WIDTH, MIN_TREE_PANE_WIDTH, TREE_PANE_WIDTH_STORAGE_KEY } from '@/lib/tree-pane-width'

import { TreePaneResizeHandle, treePaneWidthProps, useTreePaneWidth } from './tree-pane-resize'

afterEach(() => {
  cleanup()
  localStorage.clear()
  // Reset the shared store's unsaved value through a storage notification.
  window.dispatchEvent(new StorageEvent('storage', { key: TREE_PANE_WIDTH_STORAGE_KEY }))
})

function Harness({ slot }: { slot: string }) {
  const paneRef = useRef<HTMLElement | null>(null)
  const [width, setWidth] = useTreePaneWidth()
  const props = treePaneWidthProps(width)
  return (
    <div>
      <aside ref={paneRef} data-testid={slot} style={props.style} className={props.className} />
      <TreePaneResizeHandle paneRef={paneRef} width={width} onWidthChange={setWidth} />
    </div>
  )
}

const handles = () => document.querySelectorAll<HTMLElement>('[data-slot="tree-pane-resize-handle"]')
const pane = (slot: string) => document.querySelector<HTMLElement>(`[data-testid="${slot}"]`)!

describe('tree pane resize', () => {
  it('keeps the responsive CSS widths until the user resizes', () => {
    render(<Harness slot="a" />)
    expect(pane('a').getAttribute('style')).toBeNull()
    expect(pane('a').className).toBe('')
    const handle = handles()[0]!
    expect(handle.getAttribute('role')).toBe('separator')
    expect(handle.hasAttribute('aria-valuenow')).toBe(false)
  })

  it('a drag widens the pane from md up, persists, and moves every mounted tree', () => {
    render(
      <>
        <Harness slot="a" />
        <Harness slot="b" />
      </>,
    )
    const handle = handles()[0]!
    handle.setPointerCapture = () => {}
    handle.hasPointerCapture = () => true
    handle.releasePointerCapture = () => {}
    // jsdom measures the pane at 0, so the drag starts from 0 and lands on +200.
    fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 300, pointerId: 1 })
    fireEvent.pointerUp(handle, { clientX: 300, pointerId: 1 })

    const expected = 200
    expect(localStorage.getItem(TREE_PANE_WIDTH_STORAGE_KEY)).toBe(String(expected))
    for (const slot of ['a', 'b']) {
      expect(pane(slot).style.getPropertyValue('--tree-pane-width')).toBe(`${expected}px`)
      expect(pane(slot).className).toBe('md:w-(--tree-pane-width)!')
    }
    expect(handle.getAttribute('aria-valuenow')).toBe(String(expected))
    // A move after the drag ended does nothing.
    fireEvent.pointerMove(handle, { clientX: 900, pointerId: 1 })
    expect(localStorage.getItem(TREE_PANE_WIDTH_STORAGE_KEY)).toBe(String(expected))
  })

  it('steps with the keyboard, jumps to the bounds, and a double-click resets', () => {
    render(<Harness slot="a" />)
    const handle = handles()[0]!
    fireEvent.keyDown(handle, { key: 'End' })
    expect(handle.getAttribute('aria-valuenow')).toBe(String(MAX_TREE_PANE_WIDTH))
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(handle.getAttribute('aria-valuenow')).toBe(String(MAX_TREE_PANE_WIDTH - 16))
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(handle.getAttribute('aria-valuenow')).toBe(String(MIN_TREE_PANE_WIDTH))
    // Unhandled keys stay the browser's.
    expect(fireEvent.keyDown(handle, { key: 'Tab' })).toBe(true)

    fireEvent.doubleClick(handle)
    expect(localStorage.getItem(TREE_PANE_WIDTH_STORAGE_KEY)).toBeNull()
    expect(pane('a').style.getPropertyValue('--tree-pane-width')).toBe('')
    expect(pane('a').className).toBe('')
  })

  it('picks up a width another tab stored', () => {
    render(<Harness slot="a" />)
    act(() => {
      localStorage.setItem(TREE_PANE_WIDTH_STORAGE_KEY, '400')
      window.dispatchEvent(new StorageEvent('storage', { key: TREE_PANE_WIDTH_STORAGE_KEY }))
    })
    expect(pane('a').style.getPropertyValue('--tree-pane-width')).toBe('400px')
  })
})
