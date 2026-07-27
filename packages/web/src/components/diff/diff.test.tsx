import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Diff, DiffFallback } from './diff'
import type { DiffFileChange } from './types'

// Explicit rather than relying on RTL's auto-cleanup, which only runs when vitest `globals` is on.
afterEach(cleanup)

/** The server's `/api/runs/:id/changes` file shape — the facade's input contract. */
const MODIFIED: DiffFileChange = {
  path: 'src/a.ts',
  status: 'modified',
  adds: 1,
  dels: 1,
  patch: [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -3,3 +3,3 @@',
    ' const one = 1',
    '-const two = 2',
    '+const two = 3',
    ' const three = 3',
    '',
  ].join('\n'),
}

const ADDED: DiffFileChange = {
  path: 'README.md',
  status: 'added',
  adds: 2,
  dels: 0,
  patch: ['diff --git a/README.md b/README.md', '@@ -0,0 +1,2 @@', '+# Title', '+Body', ''].join('\n'),
}

/** The engine chunk loads lazily — settle on a rendered file header before asserting. */
async function renderDiff(ui: React.ReactElement, settleText = 'src/a.ts') {
  const view = render(ui)
  await screen.findByText(settleText)
  return view
}

describe('Diff facade', () => {
  it('renders every file with its path, per-file ± and status badge', async () => {
    await renderDiff(<Diff files={[MODIFIED, ADDED]} />)

    expect(screen.getByText('src/a.ts')).not.toBeNull()
    expect(screen.getByText('README.md')).not.toBeNull()
    expect(screen.getByText('added')).not.toBeNull()
    const files = document.querySelectorAll('[data-slot="diff-file"]')
    expect(files).toHaveLength(2)
  })

  it('shows the aggregate ± stat across files', async () => {
    await renderDiff(<Diff files={[MODIFIED, ADDED]} />)

    const totals = document.querySelector('[data-slot="diff-totals"]')!
    expect(totals.textContent).toContain('2 files changed')
    expect(totals.textContent).toContain('+3')
    expect(totals.textContent).toContain('−1')
  })

  it('defaults to unified mode and flips to split on the mode prop', async () => {
    const { rerender } = await renderDiff(<Diff files={[MODIFIED]} />)

    expect(document.querySelector('[data-slot="diff"]')?.getAttribute('data-mode')).toBe('unified')
    expect(document.querySelector('[data-slot="diff-line"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="diff-pair"]')).toBeNull()

    rerender(<Diff files={[MODIFIED]} mode="split" />)
    expect(document.querySelector('[data-slot="diff"]')?.getAttribute('data-mode')).toBe('split')
    expect(document.querySelector('[data-slot="diff-pair"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="diff-line"]')).toBeNull()
    // The del/add pair shares one row: left cell del, right cell add.
    const pair = Array.from(document.querySelectorAll('[data-slot="diff-pair"]')).find((row) =>
      row.querySelector('[data-line="del"]'),
    )!
    expect(pair.querySelector('[data-line="add"]')).not.toBeNull()
  })

  it('marks the word-level change on both sides of a paired edit', async () => {
    await renderDiff(<Diff files={[MODIFIED]} />)

    const delMarks = Array.from(document.querySelectorAll('[data-word="del"]'))
    const addMarks = Array.from(document.querySelectorAll('[data-word="add"]'))
    expect(delMarks.map((mark) => mark.textContent)).toEqual(['2'])
    expect(addMarks.map((mark) => mark.textContent)).toEqual(['3'])
    expect(addMarks[0]!.className).toContain('bg-diff-add-strong')
  })

  it('renders the empty state synchronously for an empty file list', () => {
    render(<Diff files={[]} />)

    expect(document.querySelector('[data-slot="diff-empty"]')?.textContent).toBe('No changes.')
    expect(document.querySelector('[data-slot="diff-loading"]')).toBeNull()
  })

  it('soft-wraps line content when wrap is set', async () => {
    await renderDiff(<Diff files={[MODIFIED]} wrap />)

    const body = document.querySelector('[data-slot="diff-file-body"]')!
    expect(body.getAttribute('data-wrap')).toBe('true')
    expect(body.innerHTML).toContain('whitespace-pre-wrap')
  })

  it('collapses a file body from its sticky header', async () => {
    await renderDiff(<Diff files={[MODIFIED]} />)

    fireEvent.click(screen.getByRole('button', { name: /src\/a\.ts/ }))
    expect(document.querySelector('[data-slot="diff-file-body"]')).toBeNull()
  })

  it('expands a context gap through the loadFileText seam', async () => {
    const fileText = Array.from({ length: 6 }, (_, i) => `line ${i + 1}`).join('\n')
    const loadFileText = vi.fn().mockResolvedValue(fileText)
    await renderDiff(<Diff files={[MODIFIED]} loadFileText={loadFileText} />)

    // The hunk starts at line 3 — a 2-line leading gap renders as an expander.
    const gap = screen.getByRole('button', { name: /2 unchanged lines/ })
    fireEvent.click(gap)
    // Expanded lines render as syntax-token spans — assert on whole-row text, not one node.
    const contextRows = () => Array.from(document.querySelectorAll('[data-line="context"]'))
    await waitFor(() => expect(contextRows().some((row) => row.textContent?.includes('line 1'))).toBe(true))
    expect(loadFileText).toHaveBeenCalledWith('src/a.ts')
    expect(contextRows().some((row) => row.textContent?.includes('line 2'))).toBe(true)
    expect(screen.queryByRole('button', { name: /2 unchanged lines/ })).toBeNull()
  })

  it('renders static gap separators when no loader is wired', async () => {
    await renderDiff(<Diff files={[MODIFIED]} />)

    const gap = document.querySelector('[data-slot="diff-gap"]')!
    expect(gap.tagName).toBe('DIV')
    expect(gap.textContent).toContain('2 unchanged lines')
  })

  it('explains binary and metadata-only files instead of rendering rows', async () => {
    const binary: DiffFileChange = { path: 'logo.png', status: 'modified', adds: 0, dels: 0, binary: true, patch: '' }
    const metaOnly: DiffFileChange = { path: 'src/a.ts', status: 'modified', adds: 0, dels: 0, patch: '' }
    await renderDiff(<Diff files={[metaOnly, binary]} />)

    expect(screen.getByText('Binary file — no text diff.')).not.toBeNull()
    expect(screen.getByText('No content changes (metadata only).')).not.toBeNull()
  })
})

describe('Diff facade — image previews (#365)', () => {
  const IMAGE: DiffFileChange = {
    path: 'assets/logo.png',
    status: 'modified',
    adds: 0,
    dels: 0,
    binary: true,
    image: true,
    patch: '',
  }
  const DELETED_IMAGE: DiffFileChange = { ...IMAGE, path: 'assets/gone.png', status: 'deleted' }

  it('renders an inline <img> from imageSrc instead of the binary note, tagged "image" not "binary"', async () => {
    const imageSrc = vi.fn((path: string) => `/api/runs/r1/files?path=${path}&raw=1`)
    await renderDiff(<Diff files={[IMAGE]} imageSrc={imageSrc} />, 'assets/logo.png')

    const img = document.querySelector('[data-slot="diff-image-preview"] img')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toBe('/api/runs/r1/files?path=assets/logo.png&raw=1')
    expect(imageSrc).toHaveBeenCalledWith('assets/logo.png')
    expect(screen.queryByText('Binary file — no text diff.')).toBeNull()
    // Status badge reads "image", not "binary".
    expect(screen.getByText('image')).not.toBeNull()
    expect(screen.queryByText('binary')).toBeNull()
  })

  it('falls back to the plain binary note when no imageSrc resolver is wired', async () => {
    await renderDiff(<Diff files={[IMAGE]} />, 'assets/logo.png')

    expect(screen.getByText('Binary file — no text diff.')).not.toBeNull()
    expect(document.querySelector('[data-slot="diff-image-preview"]')).toBeNull()
  })

  it('shows "Open in default app" only when onOpenInApp is provided, and calls it with the path', async () => {
    const imageSrc = (path: string) => `/raw/${path}`
    const onOpenInApp = vi.fn()
    const { rerender } = await renderDiff(<Diff files={[IMAGE]} imageSrc={imageSrc} />, 'assets/logo.png')
    expect(screen.queryByText('Open in default app')).toBeNull()

    rerender(<Diff files={[IMAGE]} imageSrc={imageSrc} onOpenInApp={onOpenInApp} />)
    const button = screen.getByText('Open in default app')
    fireEvent.click(button)
    expect(onOpenInApp).toHaveBeenCalledWith('assets/logo.png')
  })

  it('never renders a preview for a deleted image — only the new side is ever servable', async () => {
    const imageSrc = vi.fn((path: string) => `/raw/${path}`)
    await renderDiff(<Diff files={[DELETED_IMAGE]} imageSrc={imageSrc} />, 'assets/gone.png')

    expect(document.querySelector('[data-slot="diff-image-preview"]')).toBeNull()
    expect(imageSrc).not.toHaveBeenCalled()
    expect(screen.getByText(/only the new side can be previewed/)).not.toBeNull()
  })
})

/**
 * The regression this file's PNG-only fixtures let through: `image` is set from the path's
 * EXTENSION, so an SVG git diffs as TEXT (`binary: false`, real +N/−M) arrives flagged
 * `image: true`. Swapping its rows for a picture — or worse, for the "Binary file" note when
 * no `imageSrc` is wired (Repo → Changes, repo commits, task commits) — destroys the diff.
 */
describe('Diff facade — an SVG is text, not a picture (#365 regression)', () => {
  const SVG: DiffFileChange = {
    path: 'assets/icon.svg',
    status: 'modified',
    adds: 1,
    dels: 1,
    binary: false,
    image: true,
    patch: [
      'diff --git a/assets/icon.svg b/assets/icon.svg',
      'index 1111111..2222222 100644',
      '--- a/assets/icon.svg',
      '+++ b/assets/icon.svg',
      '@@ -1,3 +1,3 @@',
      ' <svg viewBox="0 0 16 16">',
      '-  <path d="M1 1h14v14H1z" />',
      '+  <path d="M2 2h12v12H2z" />',
      ' </svg>',
      '',
    ].join('\n'),
  }

  it('renders the text diff for a modified SVG when no imageSrc is wired (repo/commit views)', async () => {
    await renderDiff(<Diff files={[SVG]} />, 'assets/icon.svg')

    expect(screen.queryByText('Binary file — no text diff.')).toBeNull()
    expect(document.querySelector('[data-slot="diff-image-preview"]')).toBeNull()
    const rows = Array.from(document.querySelectorAll('[data-slot="diff-line"]'))
    expect(rows.some((row) => row.textContent?.includes('M1 1h14v14H1z'))).toBe(true)
    expect(rows.some((row) => row.textContent?.includes('M2 2h12v12H2z'))).toBe(true)
  })

  it('still renders the text diff for a modified SVG when imageSrc IS wired (Changes tab)', async () => {
    const imageSrc = vi.fn((path: string) => `/raw/${path}`)
    await renderDiff(<Diff files={[SVG]} imageSrc={imageSrc} onOpenInApp={vi.fn()} />, 'assets/icon.svg')

    // The text diff is the review surface — a lone new-side picture would lose the change.
    expect(document.querySelector('[data-slot="diff-image-preview"]')).toBeNull()
    expect(imageSrc).not.toHaveBeenCalled()
    expect(document.querySelectorAll('[data-slot="diff-line"]').length).toBeGreaterThan(0)
  })

  it('previews an SVG that carries no text patch at all (nothing to lose)', async () => {
    const noPatch: DiffFileChange = { ...SVG, adds: 0, dels: 0, patch: '' }
    const imageSrc = vi.fn((path: string) => `/raw/${path}`)
    await renderDiff(<Diff files={[noPatch]} imageSrc={imageSrc} />, 'assets/icon.svg')

    expect(document.querySelector('[data-slot="diff-image-preview"] img')?.getAttribute('src')).toBe(
      '/raw/assets/icon.svg',
    )
  })

  it('agrees with the zero-dependency fallback renderer on the same SVG', () => {
    render(<DiffFallback files={[SVG]} imageSrc={(path) => `/raw/${path}`} />)

    expect(document.querySelector('[data-slot="diff-image-preview"]')).toBeNull()
    expect(screen.queryByText('Binary file — no text diff.')).toBeNull()
    expect(document.querySelector('pre')?.textContent).toContain('M2 2h12v12H2z')
  })
})
