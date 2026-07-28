import type { ImageInput } from '@open-mercato/cezar-api-client'

/**
 * The composer's image intake — paperclip, ⌘V paste, and drag-drop all funnel here, exactly
 * like the legacy message bar (web/app.js `addImage`/`readImageFile`). The caps mirror the
 * server's zod (`messageSchema.images`: max 4 entries, ~5 MB decoded each) so the client
 * rejects with a human sentence instead of shipping a request the server will bounce.
 */

export const MAX_IMAGES = 4
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/** A pending attachment: the wire shape plus the data-URL the thumbnail row renders. */
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
  return {
    mediaType: file.type,
    data,
    preview: `data:${file.type};base64,${data}`,
    name: file.name || 'pasted image',
  }
}

export interface ImageIntake {
  /** The files that passed — encode these and append. */
  accepted: File[]
  /** One human sentence per rejection, ready for a toast. */
  rejected: string[]
}

/**
 * Validate a batch against what is already attached: non-images are ignored outright (a text
 * file dropped on the composer is not an error, it is just not an attachment), oversized files
 * and over-cap files are named in the rejection so the user knows which ones never made it.
 */
export function screenFiles(files: readonly File[], alreadyAttached: number): ImageIntake {
  const accepted: File[] = []
  const rejected: string[] = []
  let count = alreadyAttached
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue
    if (file.size > MAX_IMAGE_BYTES) {
      rejected.push(`${file.name || 'image'} is too large (max 5 MB)`)
      continue
    }
    if (count >= MAX_IMAGES) {
      rejected.push(`${file.name || 'image'} skipped — max ${MAX_IMAGES} images per message`)
      continue
    }
    accepted.push(file)
    count += 1
  }
  return { accepted, rejected }
}
