/**
 * Public surface of the diff facade — consumers import `Diff` and its prop types from here
 * and nothing else (`diff.tsx` header has the engine decision). The parser and word-diff
 * modules are internal; they are exported nowhere on purpose.
 */
export { Diff } from './diff'
export { canPreviewMarkdown, isMarkdownPath } from './markdown'
export { COMMENT_MAX } from './types'
export { describeLines } from './line-label'
export type {
  DiffFileChange,
  DiffHandle,
  DiffLineAnchor,
  DiffLineComment,
  DiffLineEnd,
  DiffMode,
  DiffNewLineComment,
  DiffProps,
  DiffRevealTarget,
} from './types'
