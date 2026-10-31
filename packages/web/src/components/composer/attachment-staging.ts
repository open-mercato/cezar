import { deleteStagedUpload, stageUpload } from '@/api/client'
import { reportAttachmentStagingFailed, trackAttachmentsRestaged } from '@/lib/telemetry'
import { ATTACHMENT_UPLOAD_MISSING, type AttachmentEntry } from '@open-mercato/cezar-api-client'

import { toAttachmentInput, type PendingAttachment } from './composer-attachments'

/**
 * Staged attachments (telemetry 7054e5f2): each attachment is uploaded once, when it is attached,
 * and a message names it by id — so how much a message can carry is no longer one request body.
 *
 * Keyed by the base64 itself rather than the object: hosts re-create attachments freely (the draft
 * store files its id with a spread), and the same bytes are the same upload anyway. Staging is
 * best-effort — an attachment whose upload failed still rides the message inline.
 */

const staged = new Map<string, Promise<string | null>>()
/** Uploads a size limit refused (#1735): sending the same bytes inline would meet the same wall. */
const tooLarge = new Map<string, Error>()

function isPayloadTooLarge(error: unknown): error is Error {
  return error instanceof Error && (error as { status?: unknown }).status === 413
}

/** Start uploading now; idempotent per content. */
export function stageAttachment(attachment: PendingAttachment): Promise<string | null> {
  let pending = staged.get(attachment.data)
  if (!pending) {
    pending = stageUpload(toAttachmentInput(attachment)).then(
      (upload) => (typeof upload?.uploadId === 'string' ? upload.uploadId : null),
      (error: unknown) => {
        if (isPayloadTooLarge(error)) tooLarge.set(attachment.data, error)
        reportAttachmentStagingFailed(error)
        return null
      },
    )
    staged.set(attachment.data, pending)
    // A failed upload is not remembered, so the next send tries again.
    void pending.then((id) => {
      if (id === null && staged.get(attachment.data) === pending) staged.delete(attachment.data)
    })
  }
  return pending
}

/** What goes on the wire: a reference once staged, the bytes inline when staging failed. */
export async function toWireAttachment(attachment: PendingAttachment): Promise<AttachmentEntry> {
  const uploadId = await stageAttachment(attachment)
  // #1735: a 413 on the upload (a proxy's body limit) cannot be dodged by sending the bytes inline.
  const refused = tooLarge.get(attachment.data)
  if (uploadId === null && refused) throw refused
  if (uploadId === null) return toAttachmentInput(attachment)
  return { uploadId, ...(attachment.originalName ? { name: attachment.originalName } : {}) }
}

/** Drop the staged copies — the message landed, or the user removed the attachment. */
export function releaseStaged(attachments: readonly PendingAttachment[]): void {
  for (const attachment of attachments) {
    const pending = staged.get(attachment.data)
    if (!pending) continue
    staged.delete(attachment.data)
    tooLarge.delete(attachment.data)
    void pending.then((id) => (id === null ? undefined : deleteStagedUpload(id))).catch(() => {})
  }
}

/** Forget the staged copies WITHOUT deleting them — the server no longer has them. */
export function forgetStaged(attachments: readonly PendingAttachment[]): void {
  for (const attachment of attachments) {
    staged.delete(attachment.data)
    tooLarge.delete(attachment.data)
  }
}

export function isUploadMissing(error: unknown): boolean {
  return error instanceof Error && error.message.includes(ATTACHMENT_UPLOAD_MISSING)
}

/**
 * Send with staged references; when the server has lost one (pruned, restarted on another home),
 * stage everything again and send once more, so the user never sees the expiry.
 */
export async function sendWithStaged<T>(
  attachments: readonly PendingAttachment[],
  send: (wire: AttachmentEntry[]) => Promise<T>,
): Promise<T> {
  // Nothing to stage: call through in the same tick, as the composer always has.
  if (attachments.length === 0) return send([])
  try {
    return await send(await Promise.all(attachments.map(toWireAttachment)))
  } catch (error) {
    if (!isUploadMissing(error)) throw error
    forgetStaged(attachments)
    try {
      const result = await send(await Promise.all(attachments.map(toWireAttachment)))
      trackAttachmentsRestaged('recovered')
      return result
    } catch (retryError) {
      trackAttachmentsRestaged('failed')
      throw retryError
    }
  }
}

/** Test seam. */
export function resetStaging(): void {
  staged.clear()
  tooLarge.clear()
}
