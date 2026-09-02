import type { FileInput, ImageInput } from '@open-mercato/cezar-api-client'

/**
 * The composer's attachment intake — paperclip, ⌘V paste, and drag-drop all funnel here.
 *
 * Two kinds travel side by side, because the server does two different things with them: an
 * IMAGE is inlined into the message so the model can look at it, and a TEXT FILE is written to
 * the run's attachment folder and named to the agent by path. The caps mirror the server's zod
 * (4 each; ~5 MB per image, ~1 MB per file) so the client rejects with a human sentence instead
 * of shipping a request the route will bounce.
 *
 * Anything else is refused OUT LOUD. Dropping a `.zip` used to be silent, which read as a
 * broken composer rather than an unsupported file — the same silence that made `.md` look
 * broken before it was supported at all.
 */

export const MAX_IMAGES = 4
export const MAX_FILES = 4
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_FILE_BYTES = 1024 * 1024

/** The media types the server's `fileInputSchema` accepts. */
const FILE_MEDIA_TYPE = /^(text\/|application\/(json|x-ndjson|xml|yaml|x-yaml|toml|x-toml|markdown|sql|csv)$)/

/**
 * Extensions we call text when the browser will not. `file.type` is empty for plenty of
 * ordinary files (`.md` on several OS/browser pairs, `.log`, `.toml`), and refusing those
 * because the platform has no MIME entry for them would refuse exactly the file this feature
 * exists for.
 */
const TEXT_EXTENSIONS = new Set([
  'md', 'markdown', 'txt', 'text', 'log', 'csv', 'tsv', 'json', 'jsonl', 'ndjson',
  'yaml', 'yml', 'toml', 'ini', 'xml', 'sql', 'diff', 'patch',
])

/**
 * The file picker's `accept`. Extensions as well as types, because the dialog filters with the
 * PLATFORM's MIME table: where `.md` has no entry there, a type-only `accept` greys the file out
 * and the user cannot pick it at all — which is how attaching a `.md` came to look impossible.
 */
export const ATTACH_ACCEPT = [
  'image/*',
  'text/*',
  ...[...TEXT_EXTENSIONS].map((ext) => `.${ext}`),
].join(',')

/** A pending image: the wire shape plus the data-URL the thumbnail row renders. */
export interface PendingImage extends ImageInput {
  preview: string
  name: string
}

/** A pending text file: the wire shape plus the size its chip shows. */
export interface PendingFile extends FileInput {
  size: number
}

/** How many of each are already attached — the caps are per kind. */
export interface AttachedCounts {
  images: number
  files: number
}

/** What a batch of dropped/pasted/picked files resolved to. */
export interface AttachmentIntake {
  /** Images that passed — encode these and append. */
  images: File[]
  /** Text files that passed. */
  files: File[]
  /** One human sentence per rejection, ready for a toast. */
  rejected: string[]
}

/** The media type to send for a file, or null when it is neither an image nor text. */
export function attachmentMediaType(file: File): string | null {
  if (file.type.startsWith('image/')) return file.type
  if (FILE_MEDIA_TYPE.test(file.type)) return file.type
  // No type, or one the allowlist does not know: the extension decides, and `text/plain` is
  // what a `.md` the browser had no entry for is sent as.
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  return file.type === '' && TEXT_EXTENSIONS.has(ext) ? 'text/plain' : null
}

/** Base64 for a File (chunked — `String.fromCharCode(...5MB)` would blow the arg limit). */
async function encode(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

export async function fileToPendingImage(file: File): Promise<PendingImage> {
  const data = await encode(file)
  const mediaType = attachmentMediaType(file) ?? file.type
  return {
    mediaType,
    data,
    preview: `data:${mediaType};base64,${data}`,
    name: file.name || 'pasted image',
  }
}

export async function fileToPendingFile(file: File): Promise<PendingFile> {
  return {
    name: file.name,
    mediaType: attachmentMediaType(file) ?? 'text/plain',
    data: await encode(file),
    size: file.size,
  }
}

/**
 * Validate a batch against what is already attached. Every refusal is named: too big, over the
 * per-kind cap, or not a kind cezar takes at all.
 */
export function screenFiles(files: readonly File[], attached: AttachedCounts): AttachmentIntake {
  const intake: AttachmentIntake = { images: [], files: [], rejected: [] }
  let images = attached.images
  let count = attached.files
  for (const file of files) {
    const label = file.name || 'attachment'
    const mediaType = attachmentMediaType(file)
    if (mediaType === null) {
      intake.rejected.push(`${label} is not an image or a text file`)
      continue
    }
    if (mediaType.startsWith('image/')) {
      if (file.size > MAX_IMAGE_BYTES) {
        intake.rejected.push(`${label} is too large (max 5 MB)`)
        continue
      }
      if (images >= MAX_IMAGES) {
        intake.rejected.push(`${label} skipped — max ${MAX_IMAGES} images per message`)
        continue
      }
      intake.images.push(file)
      images += 1
      continue
    }
    if (file.size > MAX_FILE_BYTES) {
      intake.rejected.push(`${label} is too large (max 1 MB)`)
      continue
    }
    if (count >= MAX_FILES) {
      intake.rejected.push(`${label} skipped — max ${MAX_FILES} files per message`)
      continue
    }
    intake.files.push(file)
    count += 1
  }
  return intake
}
