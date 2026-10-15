import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ATTACHMENT_UPLOAD_MISSING } from '@open-mercato/cezar-api-client'

const api = vi.hoisted(() => ({
  stageUpload: vi.fn(),
  deleteStagedUpload: vi.fn(),
}))
vi.mock('@/api/client', () => api)
const telemetry = vi.hoisted(() => ({ reportAttachmentStagingFailed: vi.fn(), trackAttachmentsRestaged: vi.fn() }))
vi.mock('@/lib/telemetry', () => telemetry)

import { releaseStaged, resetStaging, sendWithStaged, stageAttachment, toWireAttachment } from './attachment-staging'
import type { PendingAttachment } from './composer-attachments'

const attachment = (data: string, originalName?: string): PendingAttachment => ({
  mediaType: 'image/png',
  data,
  name: originalName ?? 'pasted image',
  ...(originalName ? { originalName } : {}),
  isImage: true,
})

describe('attachment staging (telemetry 7054e5f2)', () => {
  let next = 0
  beforeEach(() => {
    resetStaging()
    next = 0
    api.stageUpload.mockReset().mockImplementation(async () => ({
      uploadId: `id${(next += 1)}`,
      mediaType: 'image/png',
      bytes: 3,
    }))
    api.deleteStagedUpload.mockReset().mockResolvedValue({ deleted: true })
    telemetry.reportAttachmentStagingFailed.mockReset()
    telemetry.trackAttachmentsRestaged.mockReset()
  })
  afterEach(() => resetStaging())

  it('uploads each content once and sends a reference carrying the user filename', async () => {
    const a = attachment('AAAA', 'shot.png')
    void stageAttachment(a)
    expect(await toWireAttachment({ ...a })).toEqual({ uploadId: 'id1', name: 'shot.png' })
    expect(api.stageUpload).toHaveBeenCalledTimes(1)
  })

  it('falls back to inline bytes when staging fails, and retries on the next send', async () => {
    const failure = new Error('offline')
    api.stageUpload.mockRejectedValueOnce(failure)
    const a = attachment('BBBB')
    expect(await toWireAttachment(a)).toEqual({ mediaType: 'image/png', data: 'BBBB' })
    // The fallback hides the failure from the user, so it must not hide it from telemetry.
    expect(telemetry.reportAttachmentStagingFailed).toHaveBeenCalledWith(failure)
    await Promise.resolve()
    expect(await toWireAttachment(a)).toEqual({ uploadId: 'id1' })
  })

  it('re-stages and resends once when the server lost an upload', async () => {
    const a = attachment('CCCC')
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error(ATTACHMENT_UPLOAD_MISSING))
      .mockResolvedValueOnce('sent')
    await expect(sendWithStaged([a], send)).resolves.toBe('sent')
    expect(send.mock.calls.map(([wire]) => wire)).toEqual([[{ uploadId: 'id1' }], [{ uploadId: 'id2' }]])
    expect(telemetry.trackAttachmentsRestaged).toHaveBeenCalledWith('recovered')
  })

  it('counts a re-stage whose resend still fails', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error(ATTACHMENT_UPLOAD_MISSING)).mockRejectedValueOnce(new Error('session closed'))
    await expect(sendWithStaged([attachment('FFFF')], send)).rejects.toThrow('session closed')
    expect(telemetry.trackAttachmentsRestaged).toHaveBeenCalledWith('failed')
  })

  it('does not retry any other failure', async () => {
    const send = vi.fn().mockRejectedValue(new Error('session closed'))
    await expect(sendWithStaged([attachment('DDDD')], send)).rejects.toThrow('session closed')
    expect(send).toHaveBeenCalledTimes(1)
    expect(telemetry.trackAttachmentsRestaged).not.toHaveBeenCalled()
  })

  it('deletes the server copy on release', async () => {
    const a = attachment('EEEE')
    await stageAttachment(a)
    releaseStaged([a])
    await vi.waitFor(() => expect(api.deleteStagedUpload).toHaveBeenCalledWith('id1'))
  })
})
