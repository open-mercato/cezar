import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { ChangedFile } from '@open-mercato/cezar-api-client'

import { ChangesTree } from './changes-tree'
import { buildFileTree } from './file-tree'

afterEach(cleanup)

const file = (path: string, extra: Partial<ChangedFile> = {}): ChangedFile => ({
  path,
  status: 'modified',
  adds: 1,
  dels: 0,
  binary: false,
  patch: '',
  ...extra,
})

const rows = () =>
  [...document.querySelectorAll<HTMLElement>('[data-slot="tree-file"]')].map((el) => [el.dataset.path, el.dataset.junk ?? ''])

describe('ChangesTree — untracked junk is de-emphasised, not hidden (redesign 2026-11)', () => {
  it('lists source first, then .DS_Store, images and binaries in the tertiary ink', () => {
    const root = buildFileTree([file('shot.png', { status: 'added', adds: 0, dels: 0, binary: true }), file('b.ts'), file('.DS_Store', { status: 'added' }), file('a.ts')])
    render(<ChangesTree root={root} selected={null} onSelect={() => {}} />)
    expect(rows()).toEqual([
      ['a.ts', ''],
      ['b.ts', ''],
      ['.DS_Store', 'true'],
      ['shot.png', 'true'],
    ])
    const junk = document.querySelector<HTMLElement>('[data-slot="tree-file"][data-junk="true"]')!
    expect(junk.className).toContain('text-soft-foreground')
    expect(document.querySelector<HTMLElement>('[data-slot="tree-file"][data-path="a.ts"]')!.className).not.toContain('text-soft-foreground')
    // Three or fewer stay inline — no fold row for a couple of screenshots.
    expect(document.querySelector('[data-slot="tree-junk-fold"]')).toBeNull()
  })

  it('folds many junk files under one row, closed by default, and the folder count stays honest', () => {
    const root = buildFileTree([
      file('src/x.ts', { adds: 4, dels: 2 }),
      ...['1', '2', '3', '4', '5'].map((n) => file(`src/frames/${n}.gif`, { status: 'added', adds: 0, dels: 0, binary: true })),
    ])
    render(<ChangesTree root={root} selected={null} onSelect={() => {}} />)
    // The frames folder holds nothing but junk: its rows are behind the fold, its ± still counts.
    const fold = document.querySelector<HTMLElement>('[data-slot="tree-junk-fold"]')!
    expect(fold.textContent).toContain('5 files')
    expect(fold.getAttribute('aria-expanded')).toBe('false')
    expect(rows().map(([path]) => path)).toEqual(['src/x.ts'])
    expect(document.querySelector('[data-slot="tree-dir"][data-path="src/frames"]')!.textContent).not.toContain('+')

    fireEvent.click(fold)
    expect(fold.getAttribute('aria-expanded')).toBe('true')
    expect(rows()).toHaveLength(6)
    expect(rows().filter(([, junk]) => junk === 'true')).toHaveLength(5)
  })

  it('opens the fold when the selected file is inside it, so a diff click-through always lands', () => {
    const root = buildFileTree(['1', '2', '3', '4'].map((n) => file(`${n}.png`, { binary: true })))
    render(<ChangesTree root={root} selected="3.png" onSelect={() => {}} />)
    expect(document.querySelector('[data-slot="tree-junk-fold"]')!.getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('[data-slot="tree-file"][data-path="3.png"]')!.getAttribute('aria-current')).toBe('true')
  })
})
