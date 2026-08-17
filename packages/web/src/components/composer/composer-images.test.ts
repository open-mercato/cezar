import { describe, expect, it } from 'vitest'

import { fileToPendingImage, MAX_IMAGE_BYTES, screenFiles, splitAttachments } from './composer-images'

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

  it('accepts a non-image file — it becomes an on-disk attachment (#file-attachments)', () => {
    const intake = screenFiles([fakeFile({ type: 'text/plain', name: 'notes.txt' })], 0)
    expect(intake.accepted.map((f) => f.name)).toEqual(['notes.txt'])
    expect(intake.rejected).toEqual([])
  })

  it('names an oversized file in the rejection', () => {
    const intake = screenFiles([fakeFile({ size: MAX_IMAGE_BYTES + 1, name: 'huge.png' })], 0)
    expect(intake.accepted).toEqual([])
    expect(intake.rejected).toEqual(['huge.png is too large (max 5 MB)'])
  })

  it('exactly 5 MB still passes (the cap is inclusive, like the legacy check)', () => {
    expect(screenFiles([fakeFile({ size: MAX_IMAGE_BYTES })], 0).accepted).toHaveLength(1)
  })

  it('enforces the 4-attachment cap against what is already attached', () => {
    const intake = screenFiles([fakeFile({ name: 'a.png' }), fakeFile({ name: 'b.png' })], 3)
    expect(intake.accepted).toHaveLength(1)
    expect(intake.rejected).toEqual(['b.png skipped — max 4 attachments per message'])
  })

  it('non-image files count against the same cap as images', () => {
    const intake = screenFiles(
      [fakeFile({ name: 'a.png' }), fakeFile({ name: 'data.csv', type: 'text/csv' })],
      3,
    )
    expect(intake.accepted.map((f) => f.name)).toEqual(['a.png'])
    expect(intake.rejected).toEqual(['data.csv skipped — max 4 attachments per message'])
  })

  it('a batch mixing every failure mode reports each file by name', () => {
    const intake = screenFiles(
      [
        fakeFile({ name: 'ok.png' }),
        fakeFile({ name: 'big.png', size: MAX_IMAGE_BYTES + 1 }),
        fakeFile({ name: 'doc.pdf', type: 'application/pdf' }),
      ],
      0,
    )
    expect(intake.accepted.map((f) => f.name)).toEqual(['ok.png', 'doc.pdf'])
    expect(intake.rejected).toEqual(['big.png is too large (max 5 MB)'])
  })

  it('an unnamed paste still reads humanly in the rejection', () => {
    const intake = screenFiles([fakeFile({ name: '', size: MAX_IMAGE_BYTES + 1 })], 0)
    expect(intake.rejected).toEqual(['attachment is too large (max 5 MB)'])
  })
})

describe('fileToPendingImage', () => {
  it('encodes to the wire shape plus a renderable data-URL preview', async () => {
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'tiny.png', { type: 'image/png' })
    const image = await fileToPendingImage(file)
    expect(image.mediaType).toBe('image/png')
    expect(image.name).toBe('tiny.png')
    expect(image.data).toBe(btoa(String.fromCharCode(137, 80, 78, 71)))
    expect(image.preview).toBe(`data:image/png;base64,${image.data}`)
  })

  it('a non-image file gets no preview — the row renders a chip from `name` instead', async () => {
    const file = new File(['a;b;c'], 'export.csv', { type: 'text/csv' })
    const pending = await fileToPendingImage(file)
    expect(pending.mediaType).toBe('text/csv')
    expect(pending.name).toBe('export.csv')
    expect(pending.preview).toBe('')
  })

  it('a file the browser cannot type still ships a truthy advisory mediaType', async () => {
    const file = new File(['{}'], 'events.ndjson', { type: '' })
    const pending = await fileToPendingImage(file)
    expect(pending.mediaType).toBe('application/octet-stream')
    expect(pending.preview).toBe('')
  })
})

describe('splitAttachments — one pending array, two wire fields', () => {
  it('routes images to `images` (name dropped) and the rest to `files` (name kept)', () => {
    const { images, files } = splitAttachments([
      { mediaType: 'image/png', data: 'AAA', preview: 'data:image/png;base64,AAA', name: 'shot.png' },
      { mediaType: 'text/csv', data: 'BBB', preview: '', name: 'export.csv' },
    ])
    expect(images).toEqual([{ mediaType: 'image/png', data: 'AAA' }])
    expect(files).toEqual([{ name: 'export.csv', mediaType: 'text/csv', data: 'BBB' }])
  })

  it('answers empty arrays for an empty pending list', () => {
    expect(splitAttachments([])).toEqual({ images: [], files: [] })
  })
})
