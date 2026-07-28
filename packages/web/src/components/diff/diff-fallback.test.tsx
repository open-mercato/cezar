import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Diff } from './diff'
import type { DiffFileChange } from './types'

/**
 * The facade's degradation contract: when the engine chunk cannot load (stale deploy,
 * partial `web/dist`, offline cache), `<Diff>` must render the same props through the
 * inline fallback — degraded, never blank. Separate file because `vi.mock` is hoisted and
 * would poison the happy-path suite.
 */
vi.mock('./diff-view', () => {
  throw new Error('chunk load failed')
})

afterEach(cleanup)

const FILE: DiffFileChange = {
  path: 'src/a.ts',
  status: 'modified',
  adds: 1,
  dels: 1,
  patch: ['diff --git a/src/a.ts b/src/a.ts', '@@ -1,2 +1,2 @@', ' const one = 1', '-const two = 2', '+const two = 3', ''].join(
    '\n',
  ),
}

describe('Diff fallback path', () => {
  it('renders the fallback with the same props when the engine import fails', async () => {
    render(<Diff files={[FILE]} mode="split" wrap />)

    // The lazy import rejects on a microtask — the fallback replaces the loading row.
    const root = await screen.findByText('src/a.ts').then(() => document.querySelector('[data-slot="diff"]')!)
    expect(root.getAttribute('data-fallback')).toBe('true')

    // Same contract: aggregate stat, per-file section, tinted +/- lines from the raw patch.
    expect(document.querySelector('[data-slot="diff-totals"]')?.textContent).toContain('1 file changed')
    expect(document.querySelector('[data-slot="diff-file"]')?.getAttribute('data-path')).toBe('src/a.ts')
    expect(screen.getByText('+const two = 3').className).toContain('bg-diff-add')
    expect(screen.getByText('-const two = 2').className).toContain('bg-diff-del')
  })

  it('still renders the empty state without an engine', () => {
    render(<Diff files={[]} />)

    expect(document.querySelector('[data-slot="diff-empty"]')?.textContent).toBe('No changes.')
  })
})
