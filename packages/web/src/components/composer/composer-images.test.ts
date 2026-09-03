import { describe, expect, it } from 'vitest'

import { fileToPendingImage, imageMediaType, MAX_IMAGE_BYTES, screenFiles } from './composer-images'

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

  /** A file the browser could not type at all is NOT the "dropped text file" case: the
   *  user deliberately attached it and expects a thumbnail. Silently skipping it is
   *  indistinguishable from the paste never registering. */
  it('accepts a typeless file whose extension names a supported image', () => {
    const intake = screenFiles([fakeFile({ type: '', name: 'Screenshot 2026-08-23.png' })], 0)
    expect(intake.accepted).toHaveLength(1)
    expect(intake.rejected).toEqual([])
  })

  it('names a typeless file it cannot recognize instead of dropping it silently', () => {
    const intake = screenFiles([fakeFile({ type: '', name: 'archive.tar.gz' })], 0)
    expect(intake.accepted).toEqual([])
    expect(intake.rejected).toEqual(['archive.tar.gz skipped — not a recognized image'])
  })

  it('a typed non-image stays silent — the drop-a-text-file case is unchanged', () => {
    expect(screenFiles([fakeFile({ type: 'text/plain', name: 'notes.txt' })], 0).rejected).toEqual([])
  })
})

describe('imageMediaType', () => {
  it('trusts the browser when it typed the file', () => {
    expect(imageMediaType(fakeFile({ type: 'image/webp', name: 'x.png' }))).toBe('image/webp')
  })

  it('infers from the extension only when there is no type at all', () => {
    expect(imageMediaType(fakeFile({ type: '', name: 'shot.JPG' }))).toBe('image/jpeg')
    expect(imageMediaType(fakeFile({ type: '', name: 'anim.gif' }))).toBe('image/gif')
    expect(imageMediaType(fakeFile({ type: '', name: 'noextension' }))).toBeNull()
  })

  /** SVG and friends are image types the model cannot decode; a wrong guess would be
   *  a rejected API request rather than a rendered attachment. */
  it('does not invent a type for image extensions the backends cannot render', () => {
    expect(imageMediaType(fakeFile({ type: '', name: 'diagram.svg' }))).toBeNull()
  })

  it('rejects a typed non-image outright', () => {
    expect(imageMediaType(fakeFile({ type: 'application/pdf', name: 'doc.pdf' }))).toBeNull()
  })

  /** The extension is user-supplied, so the lookup must not answer off a prototype. */
  it('does not resolve an extension that only exists on Object.prototype', () => {
    expect(imageMediaType(fakeFile({ type: '', name: 'payload.constructor' }))).toBeNull()
    expect(imageMediaType(fakeFile({ type: '', name: 'payload.toString' }))).toBeNull()
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

  it('sends the inferred type for a file the browser left untyped', async () => {
    const file = new File([new Uint8Array([137, 80])], 'shot.png', { type: '' })
    const image = await fileToPendingImage(file)
    expect(image.mediaType).toBe('image/png')
    expect(image.preview).toBe(`data:image/png;base64,${image.data}`)
  })
})
