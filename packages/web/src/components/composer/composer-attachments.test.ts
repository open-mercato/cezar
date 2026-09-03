import { describe, expect, it } from 'vitest'

import {
  attachmentMediaType,
  fileToPendingAttachment,
  MAX_ATTACHMENT_BYTES,
  screenFiles,
} from './composer-attachments'

/** screenFiles reads only `type`, `size`, `name` — a structural stand-in keeps the 5MB cases
 *  from allocating 5MB buffers. */
const fakeFile = (over: { type?: string; size?: number; name?: string } = {}): File =>
  ({ type: 'image/png', size: 1024, name: 'shot.png', ...over }) as File

describe('screenFiles — the legacy 4×5MB caps, mirrored from the server zod', () => {
  it('accepts images within the caps', () => {
    const intake = screenFiles([fakeFile(), fakeFile({ name: 'b.png' })], 0)
    expect(intake.accepted).toHaveLength(2)
    expect(intake.rejected).toEqual([])
  })

  /** #950 — the three formats this widening is for. */
  it('accepts a PDF, a .txt and a .md alongside images', () => {
    const intake = screenFiles(
      [
        fakeFile({ type: 'application/pdf', name: 'report.pdf' }),
        fakeFile({ type: 'text/plain', name: 'notes.txt' }),
        fakeFile({ type: 'text/markdown', name: 'brief.md' }),
      ],
      0,
    )
    expect(intake.accepted.map((f) => f.name)).toEqual(['report.pdf', 'notes.txt', 'brief.md'])
    expect(intake.rejected).toEqual([])
  })

  /**
   * The browser's own `type` is not a good enough reason to refuse a file: Windows reports `''`
   * for a `.md` on plenty of setups, and a user cannot fix their machine's MIME database. Before
   * #950 this was also silent, which reads as a broken composer rather than a rejected file.
   */
  it('falls back to the extension when the browser reports no type', () => {
    const intake = screenFiles(
      [fakeFile({ type: '', name: 'brief.md' }), fakeFile({ type: '', name: 'notes.txt' })],
      0,
    )
    expect(intake.accepted).toHaveLength(2)
    expect(intake.rejected).toEqual([])
  })

  it('refuses an unsupported file out loud, naming it', () => {
    const intake = screenFiles([fakeFile({ type: 'application/zip', name: 'payload.zip' })], 0)
    expect(intake.accepted).toEqual([])
    expect(intake.rejected).toEqual([
      'payload.zip is not a supported attachment (images, PDF and plain-text files such as TXT or MD)',
    ])
  })

  it('names an oversized file in the rejection', () => {
    const intake = screenFiles([fakeFile({ size: MAX_ATTACHMENT_BYTES + 1, name: 'huge.png' })], 0)
    expect(intake.accepted).toEqual([])
    expect(intake.rejected).toEqual(['huge.png is too large (max 5 MB)'])
  })

  it('exactly 5 MB still passes (the cap is inclusive, like the legacy check)', () => {
    expect(screenFiles([fakeFile({ size: MAX_ATTACHMENT_BYTES })], 0).accepted).toHaveLength(1)
  })

  it('enforces the 4-attachment cap against what is already attached', () => {
    const intake = screenFiles([fakeFile({ name: 'a.png' }), fakeFile({ name: 'b.png' })], 3)
    expect(intake.accepted).toHaveLength(1)
    expect(intake.rejected).toEqual(['b.png skipped — max 4 attachments per message'])
  })

  it('a batch mixing every failure mode reports each file by name', () => {
    const intake = screenFiles(
      [
        fakeFile({ name: 'ok.png' }),
        fakeFile({ name: 'big.png', size: MAX_ATTACHMENT_BYTES + 1 }),
        fakeFile({ name: 'brief.md', type: 'text/markdown' }),
        fakeFile({ name: 'payload.zip', type: 'application/zip' }),
      ],
      0,
    )
    expect(intake.accepted.map((f: File) => f.name)).toEqual(['ok.png', 'brief.md'])
    expect(intake.rejected).toEqual([
      'big.png is too large (max 5 MB)',
      'payload.zip is not a supported attachment (images, PDF and plain-text files such as TXT or MD)',
    ])
  })

  it('an unnamed paste still reads humanly in the rejection', () => {
    const intake = screenFiles([fakeFile({ name: '', size: MAX_ATTACHMENT_BYTES + 1 })], 0)
    expect(intake.rejected).toEqual(['attachment is too large (max 5 MB)'])
  })
})

describe('attachmentMediaType', () => {
  it('keeps a media type the contract already knows', () => {
    expect(attachmentMediaType(fakeFile({ type: 'image/png', name: 'a.png' }))).toBe('image/png')
    expect(attachmentMediaType(fakeFile({ type: 'application/pdf', name: 'a.pdf' }))).toBe('application/pdf')
    expect(attachmentMediaType(fakeFile({ type: 'text/markdown', name: 'a.md' }))).toBe('text/markdown')
  })

  it('reads the extension when the type is empty or unknown', () => {
    expect(attachmentMediaType(fakeFile({ type: '', name: 'a.md' }))).toBe('text/markdown')
    expect(attachmentMediaType(fakeFile({ type: '', name: 'server.log' }))).toBe('text/plain')
    expect(attachmentMediaType(fakeFile({ type: 'application/octet-stream', name: 'a.pdf' }))).toBe('application/pdf')
  })

  it('answers null for a file cezar will not take, whatever it is called', () => {
    expect(attachmentMediaType(fakeFile({ type: 'application/zip', name: 'a.zip' }))).toBeNull()
    expect(attachmentMediaType(fakeFile({ type: 'text/html', name: 'a.html' }))).toBeNull()
  })
})

describe('fileToPendingAttachment', () => {
  it('encodes an image to the wire shape plus a renderable data-URL preview', async () => {
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'tiny.png', { type: 'image/png' })
    const image = await fileToPendingAttachment(file)
    expect(image.mediaType).toBe('image/png')
    expect(image.name).toBe('tiny.png')
    expect(image.isImage).toBe(true)
    expect(image.data).toBe(btoa(String.fromCharCode(137, 80, 78, 71)))
    expect(image.preview).toBe(`data:image/png;base64,${image.data}`)
  })

  /** A file has nothing to preview, and the chip shows its name instead — which is why the name
   *  is kept locally and never sent: the server names the file from its media type. */
  it('encodes a markdown file with no preview and keeps its name for the chip', async () => {
    const file = new File(['# hi'], 'brief.md', { type: 'text/markdown' })
    const attachment = await fileToPendingAttachment(file)
    expect(attachment.mediaType).toBe('text/markdown')
    expect(attachment.name).toBe('brief.md')
    expect(attachment.isImage).toBe(false)
    expect(attachment.preview).toBeUndefined()
    expect(attachment.data).toBe(btoa('# hi'))
  })

  it('takes a typeless .md on its extension, exactly as the screening did', async () => {
    const file = new File(['# hi'], 'brief.md', { type: '' })
    expect((await fileToPendingAttachment(file)).mediaType).toBe('text/markdown')
  })
})
