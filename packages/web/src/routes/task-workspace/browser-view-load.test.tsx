import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BrowserView } from './browser-view'
import type { BrowserState } from './layout-state'

/**
 * The Browser column's SUCCESS path (spec `.ai/specs/2026-10-07-task-workspace.md` §7).
 *
 * The regression this pins: a successful load persists its address into the column, because §7
 * keeps only addresses that actually loaded. That write comes straight back as a new `current`,
 * and the effect that re-points the frame on a tab switch could not tell it from one — so it
 * reset a FINISHED load back to `loading`. No second `load` event can follow, the iframe being
 * already parked on that exact address, so `LOAD_TIMEOUT_MS` later the view declared a page the
 * user was looking at "Nie udało się otworzyć", with the page itself still rendered underneath.
 *
 * Verified against the unguarded effect: the first case below fails with the failure notice
 * present twelve seconds after a load that worked.
 */

// A local cockpit: `capabilities.preview` true, so a loopback address is framed rather than
// refused — which is the path these cases are about.
vi.mock('@/api/queries', () => ({
  useHealth: () => ({ data: { capabilities: { preview: true } } }),
}))

/** Drive the one load event an iframe gets, the way the browser would. */
function fireFrameLoad() {
  const frame = document.querySelector('iframe')
  if (!frame) throw new Error('no iframe rendered')
  act(() => {
    frame.dispatchEvent(new Event('load'))
  })
}

/** A controlled `BrowserView`, so a persisted address really does come back as a new prop — the
 *  round trip the bug lived in. A stub that swallowed `onChange` could not reproduce it. */
function Harness({ initial, onPersist }: { initial: BrowserState; onPersist?: (next: BrowserState) => void }) {
  const [state, setState] = useState(initial)
  return (
    <BrowserView
      state={state}
      onChange={(next) => {
        onPersist?.(next)
        setState(next)
      }}
    />
  )
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

const FAILURE = /Nie udało się otworzyć/

/** Type an address into the bar and submit it, the way a user reaches a new page. The tab must
 *  start BLANK: the bug only exists when the loaded address differs from the one the column had,
 *  because that is the only case that persists — and the persistence is what echoed back. */
function navigateTo(url: string) {
  const input = screen.getByPlaceholderText(/Wpisz adres/)
  fireEvent.change(input, { target: { value: url } })
  fireEvent.submit(input.closest('form')!)
}

describe('BrowserView — a load that worked stays worked', () => {
  it('does not report failure after a successful load, however long the user waits', async () => {
    render(<Harness initial={{ tabs: [''], active: 0 }} />)

    navigateTo('http://localhost:3000/')
    fireFrameLoad()
    // Well past LOAD_TIMEOUT_MS (12s), which is where the false failure used to appear.
    await act(async () => {
      vi.advanceTimersByTime(30_000)
    })

    expect(screen.queryByText(FAILURE)).toBeNull()
  })

  it('keeps the address it loaded', async () => {
    // The other half of §7: a loaded address is the only kind worth persisting, and the guard
    // must not have cost that write.
    const seen: BrowserState[] = []
    render(
      <Harness initial={{ tabs: [''], active: 0 }} onPersist={(next) => seen.push(next)} />,
    )

    navigateTo('http://localhost:3000/')
    fireFrameLoad()
    await act(async () => {
      vi.advanceTimersByTime(30_000)
    })

    expect(seen.at(-1)?.tabs).toEqual(['http://localhost:3000/'])
  })

  it('still reports failure for a page that never loads', async () => {
    // The guard must not cost the only failure an embedder can actually detect.
    render(<Harness initial={{ tabs: [''], active: 0 }} />)

    navigateTo('http://localhost:3000/')
    await act(async () => {
      vi.advanceTimersByTime(30_000)
    })

    expect(screen.queryByText(FAILURE)).not.toBeNull()
  })
})
