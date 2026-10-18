import {
  attachmentExtension,
  BINARY_ATTACHMENT_MEDIA_TYPE,
  isAttachmentMediaType,
  isImageMediaType,
  MAX_ATTACHMENTS_PER_MESSAGE,
  type AttachmentInput,
} from '@open-mercato/cezar-api-client'

/**
 * The composer's attachment intake — paperclip, ⌘V paste, and drag-drop all funnel here, exactly
 * like the legacy message bar (web/app.js `addImage`/`readImageFile`). The caps mirror the
 * server's zod (`attachmentListSchema`: count, ~5 MB decoded each, 20 MB of images) so the client rejects with a human sentence
 * instead of shipping a request the server will bounce.
 *
 * Since #950 an attachment is not necessarily an image: any file is taken, and only the size and
 * count caps refuse one. The browser's own answer for `file.type` decides how it travels, with
 * the extension consulted when that answer is empty — Windows reports `''` for a `.md`.
 */

export const MAX_ATTACHMENTS = MAX_ATTACHMENTS_PER_MESSAGE
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024

/** Decoded image bytes per message — images reach the provider inline in one turn, staged or not,
 *  so the server holds them to `MAX_ATTACHMENTS_TOTAL_BASE64`; files travel as paths and are exempt. */
export const MAX_IMAGE_BYTES_PER_MESSAGE = 4 * MAX_ATTACHMENT_BYTES

/** Decoded size of the images already attached, from their base64 length. */
export function attachedImageBytes(attachments: readonly Pick<AttachmentInput, 'mediaType' | 'data'>[]): number {
  return attachments.reduce(
    (n, a) => (isImageMediaType(a.mediaType) ? n + Math.floor((a.data.length * 3) / 4) : n),
    0,
  )
}

/** The async append's re-check: `screenFiles` ran against a snapshot, and encodes still in flight
 *  from an earlier drop are not in it — so both caps are re-applied to the list as it now is. */
export function appendAttachment<T extends Pick<AttachmentInput, 'mediaType' | 'data'>>(
  prev: readonly T[],
  next: T,
): T[] | null {
  if (prev.length >= MAX_ATTACHMENTS) return null
  if (attachedImageBytes(prev) + attachedImageBytes([next]) > MAX_IMAGE_BYTES_PER_MESSAGE) return null
  return [...prev, next]
}

/** Extension → media type for a file whose own `type` is empty or unrecognised. `.log` is here
 *  because `text/plain` is what the allowlist takes, and a log the browser typed as `text/plain`
 *  is accepted either way — the fallback only decides the TYPELESS case. */
const EXTENSION_MEDIA_TYPES: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  log: 'text/plain',
  pdf: 'application/pdf',
}

/** Text formats sent as `text/plain` (telemetry 6c4b3066: an `.html` was refused). The contract
 *  never widens to `text/html` — cezar serves attachments from the cockpit's origin — so the bytes
 *  travel as plain text and the server pins the stored name to `.txt` (`sanitizeAttachmentName`). */
const PLAIN_TEXT_EXTENSIONS = new Set([
  'html', 'htm', 'xml', 'css', 'scss', 'less', 'csv', 'tsv', 'json', 'jsonl', 'ndjson',
  'yaml', 'yml', 'toml', 'ini', 'env', 'conf', 'cfg', 'sql', 'graphql', 'gql', 'diff', 'patch',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'vue', 'svelte', 'astro', 'php', 'py',
  'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'sh', 'bash',
  'zsh', 'ps1', 'bat', 'lua', 'pl', 'r', 'dart', 'scala', 'ex', 'exs', 'erl', 'hs', 'twig',
  'rst', 'adoc', 'tex', 'srt', 'vtt',
])

/** Browser-reported types that are text whatever their subtype says. */
const PLAIN_TEXT_MEDIA_TYPES = new Set([
  'application/json', 'application/xml', 'application/javascript', 'application/x-yaml',
  'application/yaml', 'application/sql', 'application/x-sh',
])

/**
 * What cezar will call this file on the wire.
 *
 * The browser's `type` wins when it is one the contract knows. When it is empty — a `.md` on
 * Windows, a file dragged out of some archive tools — the extension decides instead, because
 * refusing a supported file over a MIME database the user does not control would be a defect they
 * could do nothing about. Other text formats (HTML, CSV, JSON, source code) go as `text/plain`,
 * and anything else — a `.zip`, a `.xlsx` (telemetry 48850f4a) — as a binary file the agent gets
 * by path.
 */
export function attachmentMediaType(file: File): string {
  // `application/octet-stream` is the browser saying it does not know — the extension may.
  if (isAttachmentMediaType(file.type) && file.type !== BINARY_ATTACHMENT_MEDIA_TYPE) return file.type
  const ext = file.name.includes('.') ? (file.name.split('.').pop()?.toLowerCase() ?? '') : ''
  const known = EXTENSION_MEDIA_TYPES[ext]
  if (known) return known
  if (PLAIN_TEXT_EXTENSIONS.has(ext)) return 'text/plain'
  if (file.type.startsWith('text/') || PLAIN_TEXT_MEDIA_TYPES.has(file.type)) return 'text/plain'
  return BINARY_ATTACHMENT_MEDIA_TYPE
}

/** A pending attachment: the wire shape, plus what the composer's row needs to show it. */
export interface PendingAttachment extends AttachmentInput {
  /** Server-minted id when this attachment is backed by the in-task draft store. */
  id?: string
  /** Data-URL for the thumbnail — images only; a file has nothing to preview. */
  preview?: string
  /** What the chip shows. Always present, because a chip with no label is worse than a generic
   *  one — so for an upload that carried no name of its own this is a FALLBACK (`pasted image`,
   *  `pasted.md`), not something the user chose. Never sent; `originalName` is. */
  name: string
  /** The name the upload itself carried, absent when it had none — a clipboard paste, typically.
   *  This is the only one that goes on the wire (#929), because it is the only one the attachment
   *  library should file a copy under: a library of `pasted.md`, `pasted-2.md`, `pasted-3.md` is
   *  the numbered clutter the library exists to replace. The run folder names its own copy either
   *  way. */
  originalName?: string
  isImage: boolean
}

/** Distinguishes a user's removal from the composer's optimistic clear before submit. */
export type AttachmentsChangeReason = 'edit' | 'submit'

/**
 * The chip label for an upload that carried no name of its own — `pasted image`, `pasted.md`.
 *
 * Exported because it is also the only way to tell, later, whether a name IS one: an attachment
 * that comes back from the draft store (#939) is rebuilt from a stored label with no record of
 * where that label came from, and a generated one must not be mistaken for a name the user chose
 * and filed in the library under (`toAttachmentInput`). One function so the two cannot drift.
 */
export function fallbackAttachmentName(mediaType: string, isImage: boolean): string {
  return isImage ? 'pasted image' : `pasted.${attachmentExtension(mediaType)}`
}

/** File → base64 (chunked — `String.fromCharCode(...5MB)` would blow the arg limit). */
export async function fileToPendingAttachment(file: File, source: 'file' | 'clipboard' = 'file'): Promise<PendingAttachment> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  const data = btoa(binary)
  const mediaType = attachmentMediaType(file)
  const isImage = isImageMediaType(mediaType)
  // Clipboard image names may be synthesized by the browser (for example image.png).
  const originalName = source === 'clipboard' && isImage ? undefined : file.name
  return {
    mediaType,
    data,
    ...(isImage ? { preview: `data:${mediaType};base64,${data}` } : {}),
    name: originalName || fallbackAttachmentName(mediaType, isImage),
    ...(originalName ? { originalName } : {}),
    isImage,
  }
}

/**
 * Strip a pending attachment down to what goes on the wire — the single place that decides it, so
 * a second composer surface cannot start sending `preview` (a whole second copy of the bytes).
 *
 * Picked and dropped files carry their original filename, including images (#960).
 * Clipboard images carry only a fallback display label, even when the browser supplied a
 * filename. Sending that label would clutter the library with numbered pasted images.
 */
export function toAttachmentInput({ mediaType, data, originalName }: PendingAttachment): AttachmentInput {
  return { mediaType, data, ...(originalName ? { name: originalName } : {}) }
}

export interface AttachmentIntake {
  /** The files that passed — encode these and append. */
  accepted: File[]
  /** One human sentence per rejection, ready for a toast. */
  rejected: string[]
}

/**
 * Validate a batch against what is already attached. Every rejection names the file, because the
 * failure this screening exists to prevent is the silent one: before #950 a `.md` dropped on the
 * composer simply vanished, which reads as a broken composer rather than as an unsupported file.
 */
export function screenFiles(
  files: readonly File[],
  alreadyAttached: number,
  alreadyAttachedImageBytes = 0,
): AttachmentIntake {
  const accepted: File[] = []
  const rejected: string[] = []
  let count = alreadyAttached
  let imageBytes = alreadyAttachedImageBytes
  for (const file of files) {
    // Quoted, so telemetry's toast scrub masks the whole name — spaces and all — and every
    // refusal of one kind lands in one error group (telemetry 0f1255b6).
    const label = file.name ? `“${file.name}”` : 'attachment'
    if (file.size > MAX_ATTACHMENT_BYTES) {
      rejected.push(`${label} is too large (max 5 MB)`)
      continue
    }
    if (count >= MAX_ATTACHMENTS) {
      rejected.push(`${label} skipped — max ${MAX_ATTACHMENTS} attachments per message`)
      continue
    }
    const isImage = isImageMediaType(attachmentMediaType(file))
    if (isImage && imageBytes + file.size > MAX_IMAGE_BYTES_PER_MESSAGE) {
      rejected.push(`${label} skipped — max 20 MB of images per message`)
      continue
    }
    accepted.push(file)
    count += 1
    if (isImage) imageBytes += file.size
  }
  return { accepted, rejected }
}
