import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './sheet'

afterEach(cleanup)

/**
 * The close button is absolutely positioned, so only these classes keep header text out from
 * under it — jsdom computes no layout, so the reserve is pinned at the class level. `pr-16`
 * (64px) has to stay past `right-4` (16px) + the button's `size-11` (44px) target.
 */
const HEADER_RESERVE = '[&_[data-slot=sheet-header]]:pr-16'

function renderSheet(props: { showCloseButton?: boolean; headerClassName?: string } = {}) {
  render(
    <Sheet open>
      <SheetContent showCloseButton={props.showCloseButton}>
        <SheetHeader className={props.headerClassName}>
          <SheetTitle>Failed outcomes</SheetTitle>
          <SheetDescription>Tasks behind the selected metric.</SheetDescription>
        </SheetHeader>
      </SheetContent>
    </Sheet>,
  )
  const content = document.querySelector('[data-slot="sheet-content"]')
  const header = document.querySelector('[data-slot="sheet-header"]')
  return { content, header }
}

describe('SheetContent', () => {
  it('reserves the close button footprint in the header so title and description clear it', () => {
    const { content } = renderSheet()

    expect(content?.className).toContain(HEADER_RESERVE)
  })

  it('gives the close button a 44px centred touch target', () => {
    renderSheet()
    const close = screen.getByRole('button', { name: 'Close' })

    expect(close.className).toContain('size-11')
    expect(close.className).toContain('place-items-center')
  })

  it('reserves nothing when there is no close button to clear', () => {
    const { content } = renderSheet({ showCloseButton: false })

    expect(content?.className).not.toContain(HEADER_RESERVE)
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
  })

  it('keeps the reserve when a header brings its own horizontal padding', () => {
    // The reserve lives on SheetContent rather than SheetHeader precisely because
    // tailwind-merge would drop a base `pr-*` for a caller's `px-*`.
    const { content, header } = renderSheet({ headerClassName: 'px-5 py-4' })

    expect(content?.className).toContain(HEADER_RESERVE)
    expect(header?.className).toContain('px-5')
  })
})
