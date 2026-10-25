import { useState } from 'react'

import { ZoomableImage } from '@/components/zoomable-image'

import type { DiffFileChange } from './types'

/**
 * The image-diff preview (#365), shared by BOTH renderers — `diff-view.tsx` (the real engine)
 * and `diff.tsx`'s `DiffFallback`. It lives here because the two used to carry this JSX
 * duplicated verbatim and promptly drifted: the fallback required `imageSrc` before taking the
 * image branch, the engine did not, so the same file rendered a text diff in one and "Binary
 * file — no text diff." in the other. One component, one predicate — they cannot disagree again.
 */

/**
 * Does this file get a picture instead of a text diff?
 *
 * `image` is set from the path's EXTENSION alone (`assemblePayload` in `src/server/git-changes.ts`),
 * so it is true for SVGs — which git treats as text and diffs line by line with real +N/−M counts.
 * Previewing those as a lone new-side picture would DESTROY the diff on the cockpit's primary
 * review surface (edit one `d=` attribute and you'd see a logo, not the change). So the preview
 * only wins when there is no text diff to lose: git called the file binary, or there is no patch
 * at all. Everything else — SVG and friends — falls through to the normal rows.
 */
export function shouldPreviewImage(file: DiffFileChange): boolean {
  return file.image === true && (file.binary === true || file.patch === '')
}

/**
 * `imageSrc` serves the file's CURRENT (worktree) bytes; `oldImageSrc` serves its bytes at the
 * diff's base commit. A deleted image shows the old side only, a modified or renamed one shows
 * before | after, an added one the new side. Either loader absent (repo/commit diffs never wire
 * byte access) degrades to an honest note.
 */
export function ImagePreview({
  file,
  imageSrc,
  oldImageSrc,
  onOpenInApp,
}: {
  file: DiffFileChange
  imageSrc?: (path: string) => string
  oldImageSrc?: (path: string) => string
  onOpenInApp?: (path: string) => void
}) {
  const oldPath = file.oldPath ?? file.path
  if (file.status === 'deleted') {
    if (!oldImageSrc) return <ImageNote>Image deleted — only the new side can be previewed.</ImageNote>
    return (
      <div data-slot="diff-image-preview" className="flex flex-col items-center gap-2 p-4">
        <ImageSide src={oldImageSrc(oldPath)} alt={oldPath} side="old" />
      </div>
    )
  }
  if (!imageSrc) {
    return <ImageNote>Binary file — no text diff.</ImageNote>
  }
  const showBefore = oldImageSrc !== undefined && file.status !== 'added'
  return (
    <div data-slot="diff-image-preview" className="flex flex-col items-center gap-2 p-4">
      {showBefore ? (
        <div className="grid w-full grid-cols-1 items-start gap-4 sm:grid-cols-2">
          <ImageSide label="Before" src={oldImageSrc(oldPath)} alt={oldPath} side="old" />
          <ImageSide label="After" src={imageSrc(file.path)} alt={file.path} side="new" />
        </div>
      ) : (
        <ImageSide src={imageSrc(file.path)} alt={file.path} side="new" />
      )}
      {onOpenInApp ? (
        <button
          type="button"
          data-slot="diff-image-open"
          onClick={() => onOpenInApp(file.path)}
          className="text-[11px] font-medium text-soft-foreground hover:text-foreground hover:underline"
        >
          Open in default app
        </button>
      ) : null}
    </div>
  )
}

// No caption for a deleted image: the header's `deleted` badge already says it. A side the
// server refuses (past `FILE_CONTENT_CAP`, absent at the base) gets a note, not a broken icon.
function ImageSide({ label, src, alt, side }: { label?: string; src: string; alt: string; side: 'old' | 'new' }) {
  const [failed, setFailed] = useState<string | null>(null)
  return (
    <figure data-slot="diff-image-side" data-side={side} className="flex min-w-0 flex-col items-center gap-1.5">
      {label ? <figcaption className="text-[11px] font-medium text-soft-foreground">{label}</figcaption> : null}
      {failed === src ? (
        <ImageNote>Image can’t be previewed (too large or unavailable).</ImageNote>
      ) : (
        <ZoomableImage
          src={src}
          alt={alt}
          onError={() => setFailed(src)}
          className="max-h-[60vh] max-w-full rounded-sm"
        />
      )}
    </figure>
  )
}

function ImageNote({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-2.5 text-xs text-soft-foreground">{children}</p>
}
