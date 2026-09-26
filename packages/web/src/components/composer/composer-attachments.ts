import {
  attachmentExtension,
  isAttachmentMediaType,
  isImageMediaType,
  type AttachmentInput,
} from '@open-mercato/cezar-api-client'

/**
 * The composer's attachment intake — paperclip, ⌘V paste, and drag-drop all funnel here, exactly
 * like the legacy message bar (web/app.js `addImage`/`readImageFile`). The caps mirror the
 * server's zod (max 4 entries, ~5 MB decoded each) so the client rejects with a human sentence
 * instead of shipping a request the server will bounce.
 *
 * Since #950 an attachment is not necessarily an image: a `.pdf`, `.txt` or `.md` is taken too.
 * The screening rules for those are the same, with one addition — the browser's own answer for
 * `file.type` is not trustworthy enough to refuse on. Windows in particular reports `''` for a
 * `.md`, so the extension is consulted before a file is turned away.
 */

export const MAX_ATTACHMENTS = 4
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024

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

/**
 * What cezar will call this file on the wire, or `null` when it will not take it at all.
 *
 * The browser's `type` wins when it is one the contract knows. When it is empty — a `.md` on
 * Windows, a file dragged out of some archive tools — the extension decides instead, because
 * refusing a supported file over a MIME database the user does not control would be a defect they
 * could do nothing about.
 */
export function attachmentMediaType(file: File): string | null {
  if (isAttachmentMediaType(file.type)) return file.type
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  return EXTENSION_MEDIA_TYPES[ext] ?? null
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
  const mediaType = attachmentMediaType(file) ?? 'application/octet-stream'
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
export function screenFiles(files: readonly File[], alreadyAttached: number): AttachmentIntake {
  const accepted: File[] = []
  const rejected: string[] = []
  let count = alreadyAttached
  for (const file of files) {
    const label = file.name || 'attachment'
    if (attachmentMediaType(file) === null) {
      rejected.push(
        `${label} is not a supported attachment (images, PDF and plain-text files such as TXT or MD)`,
      )
      continue
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      rejected.push(`${label} is too large (max 5 MB)`)
      continue
    }
    if (count >= MAX_ATTACHMENTS) {
      rejected.push(`${label} skipped — max ${MAX_ATTACHMENTS} attachments per message`)
      continue
    }
    accepted.push(file)
    count += 1
  }
  return { accepted, rejected }
}
