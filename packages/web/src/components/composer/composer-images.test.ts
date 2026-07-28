import { describe, expect, it } from 'vitest'

import { fileToPendingImage, MAX_IMAGE_BYTES, screenFiles } from './composer-images'

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

  it('ignores non-images silently — a dropped text file is not an error', () => {
    const intake = screenFiles([fakeFile({ type: 'text/plain', name: 'notes.txt' })], 0)
    expect(intake.accepted).toEqual([])
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

  it('enforces the 4-image cap against what is already attached', () => {
    const intake = screenFiles([fakeFile({ name: 'a.png' }), fakeFile({ name: 'b.png' })], 3)
    expect(intake.accepted).toHaveLength(1)
    expect(intake.rejected).toEqual(['b.png skipped — max 4 images per message'])
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
    expect(intake.accepted.map((f) => f.name)).toEqual(['ok.png'])
    expect(intake.rejected).toEqual(['big.png is too large (max 5 MB)'])
  })

  it('an unnamed paste still reads humanly in the rejection', () => {
    const intake = screenFiles([fakeFile({ name: '', size: MAX_IMAGE_BYTES + 1 })], 0)
    expect(intake.rejected).toEqual(['image is too large (max 5 MB)'])
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
})
