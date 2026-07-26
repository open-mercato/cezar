import { XIcon } from 'lucide-react'

import type { PendingImage } from './composer-images'

/** The attached-image thumbnail row. Each thumb IS its own remove button — one target, no
 *  separate ✕ to hit — with the hover/focus veil advertising the action. */
export function ComposerThumbs({
  images,
  onRemove,
}: {
  images: PendingImage[]
  onRemove: (index: number) => void
}) {
  if (images.length === 0) return null
  return (
    <div data-slot="composer-thumbs" className="flex flex-wrap gap-2 px-4 pt-3">
      {images.map((image, index) => (
        <button
          key={`${image.name}-${index}`}
          type="button"
          aria-label={`Remove ${image.name}`}
          title={`${image.name} — click to remove`}
          className="group relative size-12 overflow-hidden rounded-md border border-border"
          onClick={() => onRemove(index)}
        >
          <img src={image.preview} alt="" className="size-full object-cover" />
          <span className="absolute inset-0 hidden items-center justify-center bg-background/70 group-hover:flex group-focus-visible:flex">
            <XIcon aria-hidden="true" className="size-4" />
          </span>
        </button>
      ))}
    </div>
  )
}
