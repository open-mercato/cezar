import type { WorktreeEntry } from '@open-mercato/cezar-api-client'

/**
 * Pure decisions for the Files tab (R5 Step 1.6): what a worktree file entry previews as,
 * and the small formatting the tree/preview rows share. Kept out of the components so the
 * rules are unit-testable without rendering.
 */

/** Extensions the preview renders as an inline `<img>` — must match the server's raw-serving
 *  allowlist (IMAGE_MIME in src/server/git-changes.ts), or the `<img>` would 409. */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'])

export function isImagePath(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return false
  return IMAGE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

export type PreviewKind = 'image' | 'too-large' | 'binary' | 'text'

/**
 * What a file entry previews as. Order matters: an image past the size cap is "too large"
 * (the server refuses its raw bytes too), an image within it renders inline even though the
 * API flags it binary, and only non-image binaries land on the "binary file" state.
 */
export function previewKind(entry: Extract<WorktreeEntry, { type: 'file' }>): PreviewKind {
  if (entry.tooLarge) return 'too-large'
  if (isImagePath(entry.path)) return 'image'
  if (entry.binary) return 'binary'
  return 'text'
}

/** `312 B` / `4.6 kB` / `1.2 MB` — file sizes, where sub-kB honesty matters (formatMem in
 *  tasks-table.ts rounds to whole kB because RSS never needs bytes). */
export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} kB`
  return `${bytes} B`
}
