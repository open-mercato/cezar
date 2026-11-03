import { describe, expect, it } from 'vitest'

import type { ChangedFile } from '@open-mercato/cezar-api-client'

import { buildFileTree, buildPathTree } from './file-tree'

const file = (path: string, extra: Partial<ChangedFile> = {}): ChangedFile => ({
  path,
  status: 'modified',
  adds: 1,
  dels: 0,
  binary: false,
  patch: '',
  ...extra,
})

describe('buildFileTree', () => {
  it('an empty change set is an empty root', () => {
    expect(buildFileTree([])).toEqual({
      kind: 'dir',
      name: '',
      path: '',
      dirs: [],
      files: [],
      adds: 0,
      dels: 0,
      fileCount: 0,
    })
  })

  it('nests by folder and keeps root files at the root', () => {
    const root = buildFileTree([file('README.md'), file('src/a.ts'), file('src/util/b.ts')])
    expect(root.files.map((f) => f.name)).toEqual(['README.md'])
    expect(root.dirs).toHaveLength(1)
    const src = root.dirs[0]!
    expect(src.name).toBe('src')
    expect(src.files.map((f) => f.name)).toEqual(['a.ts'])
    expect(src.dirs[0]!.name).toBe('util')
    expect(src.dirs[0]!.files[0]).toMatchObject({ name: 'b.ts', path: 'src/util/b.ts' })
  })

  it('aggregates ± and file counts per folder, bottom-up', () => {
    const root = buildFileTree([
      file('src/a.ts', { adds: 10, dels: 2 }),
      file('src/util/b.ts', { adds: 5, dels: 1 }),
      file('docs/c.md', { adds: 1, dels: 0 }),
    ])
    expect(root).toMatchObject({ adds: 16, dels: 3, fileCount: 3 })
    const src = root.dirs.find((d) => d.name === 'src')!
    expect(src).toMatchObject({ adds: 15, dels: 3, fileCount: 2 })
    expect(src.dirs[0]).toMatchObject({ name: 'util', adds: 5, dels: 1, fileCount: 1 })
  })

  it('compacts single-child folder chains into one joined row — but never the root', () => {
    const root = buildFileTree([file('packages/web/src/main.tsx'), file('packages/web/src/lib/x.ts')])
    // web → app → src is a pure chain (no files on the way): one "packages/web/src" row.
    expect(root.dirs).toHaveLength(1)
    const chain = root.dirs[0]!
    expect(chain.name).toBe('packages/web/src')
    expect(chain.path).toBe('packages/web/src')
    expect(chain.files.map((f) => f.name)).toEqual(['main.tsx'])
    expect(chain.dirs.map((d) => d.name)).toEqual(['lib'])
  })

  it('does not compact through a folder that has its own files', () => {
    const root = buildFileTree([file('a/keep.ts'), file('a/b/deep.ts')])
    const a = root.dirs[0]!
    expect(a.name).toBe('a')
    expect(a.files.map((f) => f.name)).toEqual(['keep.ts'])
    expect(a.dirs[0]!.name).toBe('b')
  })

  it('sorts dirs and files alphabetically, dirs listed separately from files', () => {
    const root = buildFileTree([file('z.ts'), file('a.ts'), file('m/x.ts'), file('b/y.ts')])
    expect(root.dirs.map((d) => d.name)).toEqual(['b', 'm'])
    expect(root.files.map((f) => f.name)).toEqual(['a.ts', 'z.ts'])
  })

  it('carries status/binary through to the leaves', () => {
    const root = buildFileTree([
      file('img/logo.png', { status: 'added', binary: true, adds: 0, dels: 0 }),
    ])
    expect(root.dirs[0]!.files[0]).toMatchObject({ status: 'added', binary: true })
  })
})

/** The generic half the repo Files sub-tab (#1279) builds its tree from: same nesting, same
 *  compaction, same ordering, no counts. */
describe('buildPathTree', () => {
  const plain = (paths: string[]) =>
    buildPathTree(paths, (path, name) => ({ kind: 'file' as const, name, path }))

  it('an empty path list is an empty root', () => {
    expect(plain([])).toEqual({ kind: 'dir', name: '', path: '', dirs: [], files: [] })
  })

  it('nests plain paths and keeps root files at the root', () => {
    const root = plain(['README.md', 'src/a.ts', 'src/util/b.ts'])
    expect(root.files.map((f) => f.name)).toEqual(['README.md'])
    const src = root.dirs[0]!
    expect(src.name).toBe('src')
    expect(src.path).toBe('src')
    expect(src.files.map((f) => f.path)).toEqual(['src/a.ts'])
    expect(src.dirs[0]!.files[0]).toEqual({ kind: 'file', name: 'b.ts', path: 'src/util/b.ts' })
  })

  it('compacts single-child chains and stops at a folder with its own files', () => {
    expect(plain(['packages/web/src/main.tsx']).dirs[0]!.name).toBe('packages/web/src')
    const kept = plain(['a/keep.ts', 'a/b/deep.ts'])
    expect(kept.dirs[0]!.name).toBe('a')
    expect(kept.dirs[0]!.dirs[0]!.name).toBe('b')
  })

  it('sorts dirs and files alphabetically, in separate lists so dirs render first', () => {
    const root = plain(['z.ts', 'a.ts', 'm/x.ts', 'b/y.ts'])
    expect(root.dirs.map((d) => d.name)).toEqual(['b', 'm'])
    expect(root.files.map((f) => f.name)).toEqual(['a.ts', 'z.ts'])
  })

  it('handles a dotfile at the root and a path with spaces and unicode', () => {
    const root = plain(['.env', 'a dir/a file.txt', 'ünïcode.md'])
    expect(root.files.map((f) => f.name)).toEqual(['.env', 'ünïcode.md'])
    expect(root.dirs[0]!.name).toBe('a dir')
    expect(root.dirs[0]!.files[0]!.path).toBe('a dir/a file.txt')
  })
})
