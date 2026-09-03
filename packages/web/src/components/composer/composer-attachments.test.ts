import { describe, expect, it } from 'vitest'

import {
  attachmentMediaType,
  fileToPendingFile,
  fileToPendingImage,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  screenFiles,
} from './composer-attachments'

/** screenFiles reads only `type`, `size`, `name` — a structural stand-in keeps the 5MB cases
 *  from allocating 5MB buffers. */
const fakeFile = (over: { type?: string; size?: number; name?: string } = {}): File =>
  ({ type: 'image/png', size: 1024, name: 'shot.png', ...over }) as File

const none = { images: 0, files: 0 }

describe('screenFiles — the 4×5MB image caps and the 4×1MB file caps, mirrored from the server zod', () => {
  it('accepts images within the caps', () => {
    const intake = screenFiles([fakeFile(), fakeFile({ name: 'b.png' })], none)
    expect(intake.images).toHaveLength(2)
    expect(intake.files).toEqual([])
    expect(intake.rejected).toEqual([])
  })

  it('accepts a text file as a FILE, not an image', () => {
    const intake = screenFiles([fakeFile({ type: 'text/markdown', name: 'brief.md' })], none)
    expect(intake.files.map((f) => f.name)).toEqual(['brief.md'])
    expect(intake.images).toEqual([])
    expect(intake.rejected).toEqual([])
  })

  /** The bug this feature exists for: on several OS/browser pairs a `.md` arrives with an EMPTY
   *  `type`, and a MIME-only rule refuses the one file the user meant to attach. */
  it('takes a typeless .md on its extension', () => {
    const intake = screenFiles([fakeFile({ type: '', name: 'spec.md' })], none)
    expect(intake.files.map((f) => f.name)).toEqual(['spec.md'])
    expect(intake.rejected).toEqual([])
  })

  /** …and the other half of it: what cezar cannot take is now SAID, not silently dropped. */
  /** A mistyped `.csv` reaches the intake as a file, not as a refusal (the regression behind
   *  the fallback rule above). */
  it('takes a mistyped .csv on its extension', () => {
    const intake = screenFiles(
      [fakeFile({ type: 'application/vnd.ms-excel', name: 'data.csv' })],
      none,
    )
    expect(intake.files.map((f) => f.name)).toEqual(['data.csv'])
    expect(intake.rejected).toEqual([])
  })

  it('names an unsupported file instead of ignoring it', () => {
    const intake = screenFiles([fakeFile({ type: 'application/pdf', name: 'doc.pdf' })], none)
    expect(intake.images).toEqual([])
    expect(intake.files).toEqual([])
    expect(intake.rejected).toEqual(['doc.pdf is not an image or a text file'])
  })

  it('names an oversized image in the rejection', () => {
    const intake = screenFiles([fakeFile({ size: MAX_IMAGE_BYTES + 1, name: 'huge.png' })], none)
    expect(intake.images).toEqual([])
    expect(intake.rejected).toEqual(['huge.png is too large (max 5 MB)'])
  })

  it('holds text files to their own, tighter cap', () => {
    const intake = screenFiles(
      [fakeFile({ type: 'text/plain', name: 'huge.log', size: MAX_FILE_BYTES + 1 })],
      none,
    )
    expect(intake.files).toEqual([])
    expect(intake.rejected).toEqual(['huge.log is too large (max 1 MB)'])
  })

  it('exactly at the cap still passes (inclusive, like the legacy check)', () => {
    expect(screenFiles([fakeFile({ size: MAX_IMAGE_BYTES })], none).images).toHaveLength(1)
    expect(
      screenFiles([fakeFile({ type: 'text/plain', name: 'a.txt', size: MAX_FILE_BYTES })], none)
        .files,
    ).toHaveLength(1)
  })

  it('enforces the 4-image cap against what is already attached', () => {
    const intake = screenFiles([fakeFile({ name: 'a.png' }), fakeFile({ name: 'b.png' })], {
      images: 3,
      files: 0,
    })
    expect(intake.images).toHaveLength(1)
    expect(intake.rejected).toEqual(['b.png skipped — max 4 images per message'])
  })

  /** The two caps are separate: four images do not spend the file budget. */
  it('counts each kind against its own cap', () => {
    const intake = screenFiles([fakeFile({ type: 'text/plain', name: 'notes.txt' })], {
      images: 4,
      files: 0,
    })
    expect(intake.files).toHaveLength(1)
    expect(intake.rejected).toEqual([])
  })

  it('enforces the 4-file cap', () => {
    const intake = screenFiles([fakeFile({ type: 'text/plain', name: 'e.txt' })], {
      images: 0,
      files: 4,
    })
    expect(intake.files).toEqual([])
    expect(intake.rejected).toEqual(['e.txt skipped — max 4 files per message'])
  })

  it('a batch mixing every failure mode reports each file by name', () => {
    const intake = screenFiles(
      [
        fakeFile({ name: 'ok.png' }),
        fakeFile({ name: 'big.png', size: MAX_IMAGE_BYTES + 1 }),
        fakeFile({ name: 'doc.pdf', type: 'application/pdf' }),
        fakeFile({ name: 'brief.md', type: 'text/markdown' }),
      ],
      none,
    )
    expect(intake.images.map((f) => f.name)).toEqual(['ok.png'])
    expect(intake.files.map((f) => f.name)).toEqual(['brief.md'])
    expect(intake.rejected).toEqual([
      'big.png is too large (max 5 MB)',
      'doc.pdf is not an image or a text file',
    ])
  })

  it('an unnamed paste still reads humanly in the rejection', () => {
    const intake = screenFiles([fakeFile({ name: '', size: MAX_IMAGE_BYTES + 1 })], none)
    expect(intake.rejected).toEqual(['attachment is too large (max 5 MB)'])
  })
})

describe('attachmentMediaType', () => {
  it('keeps a type the server accepts', () => {
    expect(attachmentMediaType(fakeFile({ type: 'text/markdown', name: 'a.md' }))).toBe('text/markdown')
    expect(attachmentMediaType(fakeFile({ type: 'image/jpeg', name: 'a.jpg' }))).toBe('image/jpeg')
  })

  it('keeps a parameterized type — a browser really does say `text/plain; charset=utf-8`', () => {
    expect(attachmentMediaType(fakeFile({ type: 'text/plain; charset=utf-8', name: 'a.txt' })))
      .toBe('text/plain; charset=utf-8')
  })

  it('falls back to the extension when the browser gave no type at all', () => {
    expect(attachmentMediaType(fakeFile({ type: '', name: 'a.md' }))).toBe('text/plain')
    expect(attachmentMediaType(fakeFile({ type: '', name: 'a.bin' }))).toBeNull()
  })

  /**
   * The type a browser reports is wrong as often as it is missing: a `.csv` comes back as
   * `application/vnd.ms-excel` wherever Excel registered it, a `.md` as
   * `application/octet-stream` where an editor did. Both are files the picker offers and the
   * server would have taken — refusing them was the same "you picked the file you meant and
   * cezar says no" failure this feature exists to end.
   */
  it('falls back to the extension when the browser gave a type the server would not take', () => {
    expect(attachmentMediaType(fakeFile({ type: 'application/vnd.ms-excel', name: 'data.csv' })))
      .toBe('text/plain')
    expect(attachmentMediaType(fakeFile({ type: 'application/octet-stream', name: 'brief.md' })))
      .toBe('text/plain')
  })

  /** The extension is what decides a refusal too — it describes the bytes, and it is the only
   *  half of the pair the server keeps. */
  it('refuses a file whose extension is not text, whatever it claims to be', () => {
    expect(attachmentMediaType(fakeFile({ type: 'application/zip', name: 'a.zip' }))).toBeNull()
    expect(attachmentMediaType(fakeFile({ type: '', name: 'a.pdf' }))).toBeNull()
  })
})

describe('fileToPendingImage / fileToPendingFile', () => {
  it('encodes an image to the wire shape plus a renderable data-URL preview', async () => {
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'tiny.png', { type: 'image/png' })
    const image = await fileToPendingImage(file)
    expect(image.mediaType).toBe('image/png')
    expect(image.name).toBe('tiny.png')
    expect(image.data).toBe(btoa(String.fromCharCode(137, 80, 78, 71)))
    expect(image.preview).toBe(`data:image/png;base64,${image.data}`)
  })

  it('gives an unnamed file a name — `fileInputSchema.name` is min(1), so `` would 400', async () => {
    const file = new File(['hi'], '', { type: 'text/plain' })
    expect((await fileToPendingFile(file)).name).toBe('attachment.txt')
  })

  it('encodes a text file with its own name — the server derives the on-disk extension from it', async () => {
    const file = new File(['# hi'], 'brief.md', { type: 'text/markdown' })
    const attachment = await fileToPendingFile(file)
    expect(attachment).toEqual({
      name: 'brief.md',
      mediaType: 'text/markdown',
      data: btoa('# hi'),
      size: file.size,
    })
  })
})
