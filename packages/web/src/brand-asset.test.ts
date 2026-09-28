import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function readBrandSvg(): string {
  return readFileSync(resolve(webRoot, 'public/icon.svg'), 'utf8')
}

/** The `<image href="data:image/png;base64,…">` the SVG wraps. */
function embeddedPng(svg: string): Buffer {
  const base64 = svg.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/)?.[1]
  if (!base64) throw new Error('icon.svg no longer embeds a base64 PNG')
  return Buffer.from(base64, 'base64')
}

/**
 * Enough of a PNG reader to inspect the mark's actual pixels — the colours live in compressed
 * raster bytes, so no amount of grepping the SVG text can see them. Deliberately narrow: it
 * only handles the 8-bit greyscale+alpha, non-interlaced form the asset ships in, and throws
 * on anything else rather than silently decoding it wrong.
 */
function decodeGrayAlphaPng(png: Buffer): { width: number; height: number; pixels: Buffer } {
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  const [depth, colorType, interlace] = [png[24], png[25], png[28]]
  if (depth !== 8 || colorType !== 4 || interlace !== 0) {
    throw new Error(`expected 8-bit greyscale+alpha non-interlaced PNG, got ${depth}/${colorType}/${interlace}`)
  }

  const idat: Buffer[] = []
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset)
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
      idat.push(png.subarray(offset + 8, offset + 8 + length))
    }
    offset += 12 + length
  }

  // Undo the per-scanline filters (PNG spec §9); bpp is 2 for greyscale+alpha.
  const raw = inflateSync(Buffer.concat(idat))
  const bpp = 2
  const stride = width * bpp
  const pixels = Buffer.alloc(height * stride)
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c
    const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)]
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    for (let i = 0; i < stride; i++) {
      // Left, above and above-left neighbours; out of bounds reads as 0, per the spec.
      const a = (i >= bpp ? pixels[y * stride + i - bpp] : 0) ?? 0
      const b = (y ? pixels[(y - 1) * stride + i] : 0) ?? 0
      const c = (y && i >= bpp ? pixels[(y - 1) * stride + i - bpp] : 0) ?? 0
      const x = line[i] ?? 0
      const value =
        filter === 0 ? x
        : filter === 1 ? x + a
        : filter === 2 ? x + b
        : filter === 3 ? x + ((a + b) >> 1)
        : x + paeth(a, b, c)
      pixels[y * stride + i] = value & 0xff
    }
  }
  return { width, height, pixels }
}

/**
 * The brand mark is one public file shared by the favicon (`index.html`) and the sidebar
 * BrandTile (`/icon.svg`). The canonical public URL is `/icon.svg`; `/open-mercato.svg`
 * remains as a compatibility alias on the server.
 */
describe('cockpit brand asset', () => {
  it('ships a valid SVG at packages/web/public/icon.svg', () => {
    const svg = readBrandSvg()
    expect(svg.trimStart().startsWith('<svg')).toBe(true)
    // The mark is a raster tile (PNG embedded); the retired lime→yellow→violet gradient
    // must not sneak back in.
    expect(svg).not.toContain('paint0_linear')
    expect(svg).not.toContain('B4F372')
    expect(svg).toMatch(/data:image\/png;base64,/)
  })

  // The mark is a black tile carrying a white "C". Storing it greyscale is what makes that
  // structural rather than a convention: a greyscale PNG has no channels to hold the retired
  // purple tile, so the old colourway cannot come back without this assertion failing first.
  it('embeds the mark as a greyscale PNG, so no tile colour can return', () => {
    const png = embeddedPng(readBrandSvg())
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(png[25]).toBe(4) // colour type 4 — greyscale + alpha
  })

  // Greyscale alone would equally admit the inverse (a white tile with a black mark), which is
  // the mark on the wrong background, so pin which of the two tones is the tile.
  it('paints a black tile behind a white mark', () => {
    const { width, height, pixels } = decodeGrayAlphaPng(embeddedPng(readBrandSvg()))

    const opaque = new Map<number, number>()
    for (let i = 0; i < width * height; i++) {
      // Partially transparent pixels are the rounded corners' antialiasing, not tile or mark.
      if (pixels[i * 2 + 1] !== 0xff) continue
      const luma = pixels[i * 2] ?? 0
      opaque.set(luma, (opaque.get(luma) ?? 0) + 1)
    }

    const byArea = [...opaque].sort(([, a], [, b]) => b - a)
    const [tile, mark] = [byArea[0], byArea[1]]
    if (!tile || !mark) throw new Error('the mark should have a tile tone and a mark tone')
    expect(tile[0]).toBe(0x00) // the dominant tone is the tile, and it is black
    expect(mark[0]).toBe(0xff) // the mark sitting on it is white
    // Everything else is edge antialiasing between the two — a couple of thousand pixels at most.
    const antialiasing = byArea.reduce((n, [, count]) => n + count, 0) - tile[1] - mark[1]
    expect(antialiasing).toBeLessThan(0.01 * width * height)
  })

  it('points the favicon at /icon.svg', () => {
    const html = readFileSync(resolve(webRoot, 'index.html'), 'utf8')
    expect(html).toMatch(/rel=["']icon["'][^>]*href=["']\/icon\.svg["']/)
  })
})
