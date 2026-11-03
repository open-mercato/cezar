import { useEffect, useMemo, useRef, useState } from 'react'
import { defaultUrlTransform, type UrlTransform } from 'streamdown'

import { Markdown } from '@/routes/task-thread/markdown'

import { parsePatch } from './parse-patch'
import type { DiffFileChange } from './types'

/**
 * A Markdown file's new side rendered as a document — the `preview` branch of a diff card.
 * The full text comes from `loadFileText` when the consumer wires one (the Changes tab reads
 * the worktree); otherwise, or when the loader answers `null`, the new-side lines of the patch
 * stand in. For an added file that IS the whole document; for an edit it is only the changed
 * sections, and the note says so rather than passing excerpts off as the file.
 *
 * Relative URLs resolve against the file's own directory (see `repoUrlTransform`).
 */
export function MarkdownPreview({
  file,
  loadFileText,
  imageSrc,
}: {
  file: DiffFileChange
  loadFileText?: (path: string) => Promise<string | null>
  imageSrc?: (path: string) => string
}) {
  const fromPatch = useMemo(() => newSideFromPatch(file), [file])
  // The loader is usually an inline arrow — a ref keeps it out of the effect's deps, so a
  // parent re-render never re-fetches; a changed patch (the 4s poll saw a write) does.
  const loaderRef = useRef(loadFileText)
  loaderRef.current = loadFileText
  const canLoad = loadFileText !== undefined
  const [loaded, setLoaded] = useState<{ path: string; text: string | null } | null>(null)

  useEffect(() => {
    const load = loaderRef.current
    if (!load) return
    let cancelled = false
    void load(file.path).then(
      (text) => !cancelled && setLoaded({ path: file.path, text }),
      () => !cancelled && setLoaded({ path: file.path, text: null }),
    )
    return () => {
      cancelled = true
    }
  }, [file.path, file.patch, canLoad])

  // Same ref trick for `imageSrc`: a fresh transform per render would defeat `Markdown`'s memo.
  const imageSrcRef = useRef(imageSrc)
  imageSrcRef.current = imageSrc
  const urlTransform = useMemo(
    () => repoUrlTransform(file.path, (path) => imageSrcRef.current?.(path)),
    [file.path],
  )

  // Keyed on the PATH, not the patch: while an agent edits the file, the previous text stays
  // up until the new one lands — swapping in "Loading…" on every poll would jump the page.
  const current = loaded?.path === file.path ? loaded : null
  if (canLoad && current === null) {
    return <p className="px-4 py-2.5 text-xs text-soft-foreground">Loading preview…</p>
  }
  const full = current?.text ?? null
  const partial = full === null && !fromPatch.complete
  return (
    <div data-slot="diff-markdown-preview" className="px-6 py-6">
      {partial ? (
        <p className="mx-auto mb-4 max-w-[72ch] text-xs text-soft-foreground">Showing the changed sections only.</p>
      ) : null}
      <Markdown variant="document" urlTransform={urlTransform}>
        {full ?? fromPatch.text}
      </Markdown>
    </div>
  )
}

/** The new-side text the patch carries, hunks joined by a rule; `complete` when it is the
 *  whole file (an untruncated add). */
function newSideFromPatch(file: DiffFileChange): { text: string; complete: boolean } {
  const parsed = parsePatch(file.patch)
  const sections = parsed.hunks.map((hunk) =>
    hunk.lines
      .filter((line) => line.kind !== 'del')
      .map((line) => line.text)
      .join('\n'),
  )
  return {
    text: sections.join('\n\n---\n\n'),
    complete: file.status === 'added' && !parsed.truncated,
  }
}

/** A URL with a scheme (`https:`, `mailto:`) or protocol-relative (`//host`) — not a repo path. */
const ABSOLUTE_URL = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i

/**
 * Left alone, a relative URL in a previewed file resolves against the COCKPIT page — a dead
 * route for a link, a stray request for an image. Resolve it against the file's directory the
 * way a forge does (a leading `/` is the repo root): images load through `imageSrc` (the raw
 * route only serves image extensions, so that is the one kind it can serve), other relative
 * links lose their href rather than navigate somewhere wrong. Without an `imageSrc` (the repo
 * view serves no file bytes) a relative image is dropped too — no src beats a broken icon.
 * In-page `#anchors` and absolute URLs keep Streamdown's sanitizing default.
 */
export function repoUrlTransform(filePath: string, imageSrc: (path: string) => string | undefined): UrlTransform {
  return (url, key, node) => {
    if (url.startsWith('#') || ABSOLUTE_URL.test(url)) return defaultUrlTransform(url, key, node)
    const target = resolveRepoPath(filePath, url)
    if (target === null || key !== 'src') return null
    return imageSrc(target) ?? null
  }
}

/** `url` relative to `filePath`'s directory, query/hash dropped; `null` past the repo root. */
export function resolveRepoPath(filePath: string, url: string): string | null {
  const bare = url.split(/[?#]/, 1)[0] ?? ''
  if (bare === '') return null
  const parts = bare.startsWith('/') ? [] : filePath.split('/').slice(0, -1)
  for (const segment of bare.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (parts.pop() === undefined) return null
    } else {
      parts.push(decodeSegment(segment))
    }
  }
  return parts.length > 0 ? parts.join('/') : null
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}
