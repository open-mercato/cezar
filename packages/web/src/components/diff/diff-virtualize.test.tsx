import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Diff } from './diff'
import type { DiffFileChange, DiffHandle } from './types'

/**
 * What each rendering tier actually puts in the DOM (the threshold rule itself is pinned in
 * diff-scroll.test.ts). The real-browser half of "the DOM stays bounded" — measured element
 * counts against the same changeset forced both ways — is `packages/web/e2e/diff-scroll.e2e.ts`;
 * jsdom lays nothing out, so virtua can only be observed mounting, not windowing.
 */

beforeEach(() => {
  // virtua measures with a ResizeObserver; jsdom has none and never lays anything out.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  // jsdom implements no scrolling at all — the flat tier's reveal path calls this.
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.history.replaceState({}, '', '/')
})

/** A file rendering `rows` diff rows. */
function file(path: string, rows: number): DiffFileChange {
  return {
    path,
    status: 'modified',
    adds: rows,
    dels: 0,
    patch: [
      `diff --git a/${path} b/${path}`,
      'index 1111111..2222222 100644',
      `--- a/${path}`,
      `+++ b/${path}`,
      `@@ -1,${rows} +1,${rows} @@`,
      ...Array.from({ length: rows - 1 }, (_, index) => `+const value${index} = ${index}`),
    ].join('\n'),
  }
}

/** The engine chunk loads lazily — settle on a rendered file header before asserting. */
async function renderDiff(ui: React.ReactElement, settleText: string) {
  const view = render(ui)
  await screen.findByText(settleText)
  return view
}

/**
 * The virtualized tier's settle: virtua mounts NO items under jsdom (a zero-height viewport
 * windows down to nothing), so there is no file header to wait for — the engine chunk having
 * landed is the honest signal.
 */
async function renderVirtualDiff(ui: React.ReactElement) {
  const view = render(ui)
  await waitFor(() => expect(document.querySelector('[data-slot="diff-files"]')).not.toBeNull())
  return view
}

describe('the flat tier (small changesets)', () => {
  it('renders every file, each hinted for content-visibility skipping', async () => {
    await renderDiff(<Diff files={[file('a.ts', 3), file('b.ts', 3)]} />, 'a.ts')

    const region = document.querySelector('[data-slot="diff-files"]')!
    expect(region.getAttribute('data-virtualized')).toBe('false')
    expect(document.querySelectorAll('[data-slot="diff-file"]')).toHaveLength(2)

    const slot = document.querySelector<HTMLElement>('[data-slot="diff-file-slot"]')!
    expect(slot.className).toContain('[content-visibility:auto]')
    // The placeholder keeps the scrollbar honest before a skipped card is ever measured.
    expect(slot.style.containIntrinsicBlockSize).toMatch(/^auto \d+px$/)
  })

  it('gives no-wrap unified rows a width floor, so a size-contained row cannot shrink the horizontal scroll', async () => {
    await renderDiff(<Diff files={[file('a.ts', 3)]} />, 'a.ts')

    const rows = document.querySelector<HTMLElement>('[data-slot="diff-rows"]')!
    expect(rows.style.minInlineSize).toMatch(/^calc\(\d+ch \+ 7rem\)$/)
    expect(rows.className).toContain('[content-visibility:auto]')
  })

  it('drops the width floor when wrapping, where rows never exceed the box', async () => {
    await renderDiff(<Diff files={[file('a.ts', 3)]} wrap />, 'a.ts')

    expect(document.querySelector<HTMLElement>('[data-slot="diff-rows"]')!.style.minInlineSize).toBe('')
  })
})

describe('the virtualized tier (large changesets)', () => {
  it('switches to virtua past the row threshold', async () => {
    // 2 × 900 rows = 1,800 > DIFF_VIRTUALIZE_THRESHOLD, without forcing the override.
    await renderVirtualDiff(<Diff files={[file('a.ts', 900), file('b.ts', 900)]} />)

    expect(document.querySelector('[data-slot="diff-files"]')!.getAttribute('data-virtualized')).toBe('true')
    // The point of the tier: 1,800 rows of patch, and not one of them in the DOM off-screen.
    expect(document.querySelectorAll('[data-slot="diff-line"]')).toHaveLength(0)
  })

  it('honors ?diff=virtual on a changeset that would otherwise render flat', async () => {
    window.history.replaceState({}, '', '/?diff=virtual')
    await renderVirtualDiff(<Diff files={[file('a.ts', 3), file('b.ts', 3)]} />)

    expect(document.querySelector('[data-slot="diff-files"]')!.getAttribute('data-virtualized')).toBe('true')
  })
})

describe('per-file state survives the unmount virtualization performs', () => {
  it('collapses one file without touching its neighbours', async () => {
    await renderDiff(<Diff files={[file('a.ts', 3), file('b.ts', 3)]} />, 'a.ts')

    const headers = document.querySelectorAll<HTMLButtonElement>('[data-slot="diff-file-header"]')
    expect(headers[0]!.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(headers[0]!)

    expect(headers[0]!.getAttribute('aria-expanded')).toBe('false')
    expect(headers[1]!.getAttribute('aria-expanded')).toBe('true')
    // The collapsed file's rows are gone; the untouched one still has its body.
    expect(document.querySelectorAll('[data-slot="diff-file-body"]')).toHaveLength(1)
  })

  it('keeps that collapse across a re-render with a fresh files array (the 4s poll)', async () => {
    const files = [file('a.ts', 3), file('b.ts', 3)]
    const { rerender } = await renderDiff(<Diff files={files} />, 'a.ts')

    fireEvent.click(document.querySelectorAll<HTMLButtonElement>('[data-slot="diff-file-header"]')[0]!)
    // A refetch returns equal-but-not-identical file objects — state is keyed by path, so the
    // reader's collapse must not silently spring back open.
    rerender(<Diff files={[file('a.ts', 3), file('b.ts', 3)]} />)

    expect(
      document.querySelectorAll('[data-slot="diff-file-header"]')[0]!.getAttribute('aria-expanded'),
    ).toBe('false')
  })
})

describe('the reveal handle (the Changes tab file tree)', () => {
  it('scrolls to the file element while flat', async () => {
    const ref: { current: DiffHandle | null } = { current: null }
    await renderDiff(<Diff files={[file('a.ts', 3), file('b.ts', 3)]} viewRef={ref} />, 'a.ts')

    ref.current!.scrollToPath('b.ts')

    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' })
  })

  it('is a no-op for a path the changeset no longer carries', async () => {
    const ref: { current: DiffHandle | null } = { current: null }
    await renderDiff(<Diff files={[file('a.ts', 3)]} viewRef={ref} />, 'a.ts')

    expect(() => ref.current!.scrollToPath('gone.ts')).not.toThrow()
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled()
  })
})
