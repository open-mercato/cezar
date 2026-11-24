import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SourcePill } from './source-pill'

afterEach(cleanup)

const renderPill = (source: { source: 'skill' | 'workflow'; ref: string } | null) =>
  render(<SourcePill source={source} ready skills={[]} skillUsage={undefined} workflows={[]} onPick={vi.fn()} />)

const hint = () => document.querySelector('[data-slot="source-pill-hint"]')

describe('SourcePill hover hint', () => {
  it('a chosen source says how to drop it: pick it again, or press ✕', async () => {
    renderPill({ source: 'skill', ref: 'om-review' })
    const pill = document.querySelector('[data-slot="source-pill"]') as HTMLElement
    fireEvent.pointerEnter(pill)
    await waitFor(() => expect(hint()?.textContent).toContain('Pick it again, or press ✕, to run without it'))
    fireEvent.pointerLeave(pill)
    await waitFor(() => expect(hint()).toBeNull())
  })

  it('hover only: focus alone opens no hint (the menu hands focus back to the pill)', () => {
    renderPill({ source: 'skill', ref: 'om-review' })
    fireEvent.focus(document.querySelector('[data-slot="source-pill"]') as HTMLElement)
    expect(hint()).toBeNull()
  })

  it('an empty pill has nothing to drop, so no hint', () => {
    renderPill(null)
    fireEvent.pointerEnter(document.querySelector('[data-slot="source-pill"]') as HTMLElement)
    expect(hint()).toBeNull()
  })
})
