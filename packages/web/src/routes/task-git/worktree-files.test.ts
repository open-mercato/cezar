import { describe, expect, it } from 'vitest'

import { formatFileSize, isImagePath, previewKind } from './worktree-files'

describe('isImagePath', () => {
  it('matches the server allowlist, case-insensitively, by last extension', () => {
    expect(isImagePath('logo.png')).toBe(true)
    expect(isImagePath('deep/dir/Photo.JPEG')).toBe(true)
    expect(isImagePath('icon.svg')).toBe(true)
    expect(isImagePath('a.webp')).toBe(true)
    expect(isImagePath('notes.md')).toBe(false)
    expect(isImagePath('README')).toBe(false)
    expect(isImagePath('.png')).toBe(false) // dotfile named ".png", not an image
    expect(isImagePath('archive.png.zip')).toBe(false)
  })
})

describe('previewKind — the preview decision, in order', () => {
  const file = (over: Partial<Parameters<typeof previewKind>[0]>) => ({
    type: 'file' as const,
    path: 'a.txt',
    size: 10,
    binary: false,
    tooLarge: false,
    ...over,
  })

  it('too-large wins over everything — the server withholds those bytes anyway', () => {
    expect(previewKind(file({ path: 'huge.png', binary: true, tooLarge: true }))).toBe('too-large')
    expect(previewKind(file({ path: 'huge.txt', tooLarge: true }))).toBe('too-large')
  })

  it('images render inline even though the API flags them binary (and SVG though it does not)', () => {
    expect(previewKind(file({ path: 'logo.png', binary: true }))).toBe('image')
    expect(previewKind(file({ path: 'icon.svg', binary: false }))).toBe('image')
  })

  it('binary non-images get the binary state; everything else is text', () => {
    expect(previewKind(file({ path: 'blob.dat', binary: true }))).toBe('binary')
    expect(previewKind(file({ path: 'main.ts' }))).toBe('text')
  })
})

describe('formatFileSize', () => {
  it('keeps byte-level honesty below 1 kB and one decimal above', () => {
    expect(formatFileSize(0)).toBe('0 B')
    expect(formatFileSize(312)).toBe('312 B')
    expect(formatFileSize(4700)).toBe('4.6 kB')
    expect(formatFileSize(1024 ** 2 + 200_000)).toBe('1.2 MB')
  })
})
