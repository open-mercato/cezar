import type { FileInput, ImageInput } from '@open-mercato/cezar-api-client'

/**
 * The composer's attachment intake — paperclip, ⌘V paste, and drag-drop all funnel here,
 * exactly like the legacy message bar (web/app.js `addImage`/`readImageFile`). The caps
 * mirror the server's zod (`messageSchema.images`/`files`: max 4 entries, ~5 MB decoded
 * each) so the client rejects with a human sentence instead of shipping a request the
 * server will bounce. Images and non-image files (#file-attachments) share ONE pending
 * array and one cap; `splitAttachments` separates them into their wire fields at submit.
 */

export const MAX_IMAGES = 4
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/** A pending attachment: the wire shape plus the data-URL the thumbnail row renders.
 *  A non-image file has `preview: ''` — the row renders a named chip instead. */
export interface PendingImage extends ImageInput {
  preview: string
  name: string
}

/** File → base64 (chunked — `String.fromCharCode(...5MB)` would blow the arg limit). */
export async function fileToPendingImage(file: File): Promise<PendingImage> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  const data = btoa(binary)
  const isImage = file.type.startsWith('image/')
  return {
    // A file with no browser-known MIME (e.g. `.ndjson`) still needs a truthy value
    // for the wire's advisory field.
    mediaType: file.type || 'application/octet-stream',
    data,
    preview: isImage ? `data:${file.type};base64,${data}` : '',
    name: file.name || (isImage ? 'pasted image' : 'attachment'),
  }
}

/** Split the shared pending array into its wire fields: inline `images` vs on-disk `files`. */
export function splitAttachments(pending: readonly PendingImage[]): {
  images: ImageInput[]
  files: FileInput[]
} {
  const images: ImageInput[] = []
  const files: FileInput[] = []
  for (const { mediaType, data, name } of pending) {
    if (mediaType.startsWith('image/')) images.push({ mediaType, data })
    else files.push({ name, mediaType, data })
  }
  return { images, files }
}

export interface ImageIntake {
  /** The files that passed — encode these and append. */
  accepted: File[]
  /** One human sentence per rejection, ready for a toast. */
  rejected: string[]
}

/**
 * Validate a batch against what is already attached. Any file type is welcome
 * (#file-attachments) — images are inlined for the model to view, everything else is
 * materialized to disk server-side; oversized and over-cap files are named in the
 * rejection so the user knows which ones never made it.
 */
export function screenFiles(files: readonly File[], alreadyAttached: number): ImageIntake {
  const accepted: File[] = []
  const rejected: string[] = []
  let count = alreadyAttached
  for (const file of files) {
    if (file.size > MAX_IMAGE_BYTES) {
      rejected.push(`${file.name || 'attachment'} is too large (max 5 MB)`)
      continue
    }
    // Only the upper bound was checked, because before non-image attachments a 0-byte file
    // could not arrive: browsers do not paste empty images. An empty file encodes to `data: ''`,
    // which the server's `fileInputSchema` rejects with `min(1)` — bouncing the WHOLE message
    // with a raw zod error instead of one human line about one file.
    if (file.size === 0) {
      rejected.push(`${file.name || 'attachment'} is empty`)
      continue
    }
    if (count >= MAX_IMAGES) {
      rejected.push(`${file.name || 'attachment'} skipped — max ${MAX_IMAGES} attachments per message`)
      continue
    }
    accepted.push(file)
    count += 1
  }
  return { accepted, rejected }
}
