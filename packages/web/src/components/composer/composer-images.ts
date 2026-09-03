import type { ImageInput } from '@open-mercato/cezar-api-client'

/**
 * The composer's image intake — paperclip, ⌘V paste, and drag-drop all funnel here, exactly
 * like the legacy message bar (web/app.js `addImage`/`readImageFile`). The caps mirror the
 * server's zod (`messageSchema.images`: max 4 entries, ~5 MB decoded each) so the client
 * rejects with a human sentence instead of shipping a request the server will bounce.
 */

export const MAX_IMAGES = 4
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/** The four formats every backend can actually render — the same set `persistImage`
 *  maps to a file extension server-side. Consulted ONLY when the browser reports no
 *  type at all: some Linux file managers and clipboard sources hand over a `File`
 *  with `type: ''`, and dropping that silently is, from the user's side, identical
 *  to the paste never happening. */
const EXTENSION_MEDIA_TYPES = new Map<string, string>([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
])

/** The media type to send for a file, or null when it is not an image we can send.
 *  A Map, not an object literal: the key is a user-supplied filename fragment, and
 *  an object would answer `constructor`/`toString` off the prototype. */
export function imageMediaType(file: File): string | null {
  if (file.type.startsWith('image/')) return file.type
  if (file.type) return null
  const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
  return EXTENSION_MEDIA_TYPES.get(extension) ?? null
}

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
  const mediaType = imageMediaType(file) ?? file.type
  return {
    mediaType,
    data,
    preview: `data:${mediaType};base64,${data}`,
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
 * Validate a batch against what is already attached: typed non-images are ignored outright (a
 * text file dropped on the composer is not an error, it is just not an attachment), oversized
 * files and over-cap files are named in the rejection so the user knows which ones never made
 * it. A file the browser could not type at ALL is the third case and it is not silent: the
 * user believes they attached something, so an unrecognized one has to say so.
 */
export function screenFiles(files: readonly File[], alreadyAttached: number): ImageIntake {
  const accepted: File[] = []
  const rejected: string[] = []
  let count = alreadyAttached
  for (const file of files) {
    if (!imageMediaType(file)) {
      if (!file.type) rejected.push(`${file.name || 'file'} skipped — not a recognized image`)
      continue
    }
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
