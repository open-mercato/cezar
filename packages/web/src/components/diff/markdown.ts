import type { DiffFileChange } from './types'

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx', 'mdown', 'mkd'])

/** A path the diff can render as a formatted document — decided by extension, like `image`. */
export function isMarkdownPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 && MARKDOWN_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

/** True when the file has a new side worth rendering: Markdown, text, and not deleted. */
export function canPreviewMarkdown(file: DiffFileChange): boolean {
  return isMarkdownPath(file.path) && file.status !== 'deleted' && !file.binary
}
