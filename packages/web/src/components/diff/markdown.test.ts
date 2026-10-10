import { defaultUrlTransform, type UrlTransform } from 'streamdown'
import { describe, expect, it } from 'vitest'

import { canPreviewMarkdown, isMarkdownPath } from './markdown'
import { repoUrlTransform, resolveRepoPath } from './markdown-preview'

describe('isMarkdownPath', () => {
  it('matches Markdown extensions case-insensitively', () => {
    expect(isMarkdownPath('README.md')).toBe(true)
    expect(isMarkdownPath('docs/Guide.MARKDOWN')).toBe(true)
    expect(isMarkdownPath('pages/intro.mdx')).toBe(true)
  })

  it('rejects other files, dotfiles and directories named like Markdown', () => {
    expect(isMarkdownPath('src/a.ts')).toBe(false)
    expect(isMarkdownPath('.md')).toBe(false)
    expect(isMarkdownPath('notes.md/readme')).toBe(false)
  })
})

describe('canPreviewMarkdown', () => {
  const base = { path: 'README.md', adds: 1, dels: 0, patch: '' }

  it('needs a new side to render', () => {
    expect(canPreviewMarkdown({ ...base, status: 'modified' })).toBe(true)
    expect(canPreviewMarkdown({ ...base, status: 'deleted' })).toBe(false)
    expect(canPreviewMarkdown({ ...base, status: 'modified', binary: true })).toBe(false)
  })
})

describe('resolveRepoPath', () => {
  it('resolves against the file directory, a leading slash against the repo root', () => {
    expect(resolveRepoPath('docs/guide.md', 'img/a.png')).toBe('docs/img/a.png')
    expect(resolveRepoPath('docs/guide.md', './a.png?raw=1#x')).toBe('docs/a.png')
    expect(resolveRepoPath('docs/guide.md', '../README.md')).toBe('README.md')
    expect(resolveRepoPath('docs/guide.md', '/assets/my%20logo.png')).toBe('assets/my logo.png')
  })

  it('refuses paths that climb past the repo root', () => {
    expect(resolveRepoPath('docs/guide.md', '../../etc/passwd')).toBeNull()
    expect(resolveRepoPath('README.md', '..')).toBeNull()
    expect(resolveRepoPath('README.md', '?q')).toBeNull()
  })
})

describe('repoUrlTransform', () => {
  const node: Parameters<UrlTransform>[2] = { type: 'element', tagName: 'a', properties: {}, children: [] }
  const transform = repoUrlTransform('docs/guide.md', (path) => `/raw?path=${path}`)

  it('routes relative images through imageSrc and drops relative links', () => {
    expect(transform('logo.png', 'src', node)).toBe('/raw?path=docs/logo.png')
    expect(transform('../README.md', 'href', node)).toBeNull()
  })

  it('leaves anchors and absolute URLs to the default sanitizer', () => {
    expect(transform('#install', 'href', node)).toBe('#install')
    expect(transform('https://example.com/x', 'href', node)).toBe('https://example.com/x')
    // Absolute URLs get exactly the default — protocol hardening happens downstream of it.
    expect(transform('javascript:void(0)', 'href', node)).toBe(defaultUrlTransform('javascript:void(0)', 'href', node))
  })
})
