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
 * `raw=1` only ever serves the file's CURRENT (new-side) bytes, so a deleted image has nothing
 * to fetch; `imageSrc` absent (a consumer that never wired byte access, e.g. repo/commit diffs)
 * degrades to the same honest note every other binary gets.
 */
export function ImagePreview({
  file,
  imageSrc,
  onOpenInApp,
}: {
  file: DiffFileChange
  imageSrc?: (path: string) => string
  onOpenInApp?: (path: string) => void
}) {
  if (file.status === 'deleted') {
    return <ImageNote>Image deleted — only the new side can be previewed.</ImageNote>
  }
  if (!imageSrc) {
    return <ImageNote>Binary file — no text diff.</ImageNote>
  }
  return (
    <div data-slot="diff-image-preview" className="flex flex-col items-center gap-2 p-4">
      <ZoomableImage src={imageSrc(file.path)} alt={file.path} className="max-h-[60vh] max-w-full rounded-sm" />
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

function ImageNote({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-2.5 text-xs text-soft-foreground">{children}</p>
}
