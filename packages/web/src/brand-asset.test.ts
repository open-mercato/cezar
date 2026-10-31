import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { BRAND_MARK_POLYGONS } from './components/brand-mark'
import { THEME_COLORS } from './lib/theme'

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function readBrandSvg(): string {
  return readFileSync(resolve(webRoot, 'public/icon.svg'), 'utf8')
}

/** Every `fill="…"` in the file, lowercased — the whole palette of a flat vector mark. */
function fills(svg: string): string[] {
  return [...svg.matchAll(/fill="([^"]+)"/g)].map((match) => (match[1] ?? '').toLowerCase())
}

/**
 * The brand mark is one public file shared by the favicon (`index.html`), the sidebar
 * BrandTile (`/icon.svg`) and — through `packages/desktop`'s `npm run icon` — the desktop app's
 * icon set and splash. The canonical public URL is `/icon.svg`; `/open-mercato.svg` remains as
 * a compatibility alias on the server.
 *
 * It is a flat VECTOR: a black rounded tile and a white geometric C drawn as polygons. It was a
 * 704px raster embedded in an SVG until the vector artwork arrived (2026-09-28); the raster
 * upscaled softly into the 1024px app icon, the vector renders sharp at every size.
 */
describe('cockpit brand asset', () => {
  it('ships a valid SVG at packages/web/public/icon.svg', () => {
    const svg = readBrandSvg()
    expect(svg.trimStart().startsWith('<svg')).toBe(true)
    // Square, so the favicon, the 26px brand tile and the app icon all frame it the same way.
    const viewBox = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(svg)
    expect(viewBox).not.toBeNull()
    expect(viewBox?.[1]).toBe(viewBox?.[2])
    // The retired lime→yellow→violet gradient must not sneak back in.
    expect(svg).not.toContain('paint0_linear')
    expect(svg).not.toContain('B4F372')
    expect(svg).not.toMatch(/<(linear|radial)Gradient/)
  })

  // A vector, not a picture of one: no embedded raster, so it stays sharp when the desktop icon
  // pipeline scales it to 1024px and when a high-density display paints the brand tile.
  it('is drawn as vector shapes, with no embedded raster', () => {
    const svg = readBrandSvg()
    expect(svg).not.toMatch(/<image\b/)
    expect(svg).not.toMatch(/data:image\//)
    expect(svg).toMatch(/<(polygon|path)\b/)
  })

  // Two tones and nothing else, and which of them is the tile is pinned: the inverse (a white
  // tile with a black mark) is the mark on the wrong background.
  it('paints a black tile behind a white mark', () => {
    const svg = readBrandSvg()
    const tile = /<rect\b[^>]*>/.exec(svg)?.[0] ?? ''
    expect(tile).toMatch(/fill="#000000"/i)
    // The tile covers the whole canvas and carries its own rounded corners.
    expect(tile).toMatch(/\brx="\d+/)
    expect(new Set(fills(svg))).toEqual(new Set(['#000000', '#ffffff']))
    // The mark is the white group drawn after the tile.
    expect(svg.indexOf('#ffffff')).toBeGreaterThan(svg.indexOf('<rect'))
  })

  // The sidebar draws the mark itself (tile-less, in the text colour) instead of showing the
  // tiled file, so the artwork exists twice. This is what keeps the two from drifting: the
  // component's polygons must be the file's, in order.
  it('is the same artwork the sidebar lockup draws', () => {
    const inFile = [...readBrandSvg().matchAll(/<polygon\b[^>]*\bpoints="([^"]+)"/g)].map((match) => match[1])
    expect(inFile).toEqual([...BRAND_MARK_POLYGONS])
  })

  // Self-hosted like every other face (the cockpit must work offline) and licensed beside it.
  it('ships the wordmark face, Chakra Petch SemiBold, with its licence', () => {
    const fonts = resolve(webRoot, 'src/assets/fonts')
    expect(readFileSync(resolve(fonts, 'chakra-petch-latin-600-normal.woff2')).subarray(0, 4).toString('latin1')).toBe('wOF2')
    expect(readFileSync(resolve(fonts, 'chakra-petch-LICENSE.txt'), 'utf8')).toContain('SIL Open Font License')
    const css = readFileSync(resolve(webRoot, 'src/styles/index.css'), 'utf8')
    expect(css).toMatch(/font-family: 'Chakra Petch';[\s\S]*?font-weight: 600;[\s\S]*?chakra-petch-latin-600-normal\.woff2/)
    expect(css).toMatch(/--brand: 'Chakra Petch', var\(--sans\);/)
  })

  it('points the favicon at /icon.svg', () => {
    const html = readFileSync(resolve(webRoot, 'index.html'), 'utf8')
    expect(html).toMatch(/rel=["']icon["'][^>]*href=["']\/icon\.svg["']/)
  })
})

/** Width and height from a PNG's IHDR, the first chunk after the 8-byte signature. */
function pngSize(file: string): [number, number] {
  const png = readFileSync(file)
  expect(png.subarray(1, 4).toString('latin1')).toBe('PNG')
  return [png.readUInt32BE(16), png.readUInt32BE(20)]
}

// Installable cockpit (#1762). Regenerate the PNGs with `npm run icons -w packages/web`.
describe('web app manifest', () => {
  const manifest = JSON.parse(readFileSync(resolve(webRoot, 'public/manifest.webmanifest'), 'utf8')) as {
    start_url: string
    scope: string
    display: string
    theme_color: string
    background_color: string
    icons: { src: string; sizes: string; type: string; purpose: string }[]
  }
  const html = readFileSync(resolve(webRoot, 'index.html'), 'utf8')

  it('opens standalone at the root, which restores the last project', () => {
    expect(manifest.display).toBe('standalone')
    expect(manifest.start_url).toBe('/')
    expect(manifest.scope).toBe('/')
  })

  // Without the attribute the fetch is anonymous, and a Basic gate answers it with a 401.
  it('is linked with credentials', () => {
    expect(html).toMatch(/<link rel="manifest" href="\/manifest\.webmanifest" crossorigin="use-credentials" \/>/)
  })

  it('splashes in the default theme', () => {
    expect(manifest.theme_color).toBe(THEME_COLORS.dark)
    expect(manifest.background_color).toBe(THEME_COLORS.dark)
  })

  it('names icons that exist at their declared size, with both install purposes', () => {
    for (const icon of manifest.icons) {
      const [width, height] = pngSize(resolve(webRoot, 'public', icon.src.slice(1)))
      expect(`${width}x${height}`).toBe(icon.sizes)
      expect(icon.type).toBe('image/png')
    }
    expect(manifest.icons.map((icon) => `${icon.sizes} ${icon.purpose}`)).toEqual(
      expect.arrayContaining(['192x192 any', '512x512 any', '512x512 maskable']),
    )
  })

  it('gives iOS a touch icon at its home-screen size', () => {
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />')
    expect(pngSize(resolve(webRoot, 'public/apple-touch-icon.png'))).toEqual([180, 180])
  })

  // The pre-paint script cannot import THEME_COLORS, and the palette lives in the stylesheet.
  it('keeps the theme colors in step with the shell and the palette', () => {
    const css = readFileSync(resolve(webRoot, 'src/styles/index.css'), 'utf8')
    const backgrounds = [...css.matchAll(/--background: (#[0-9a-f]{6});/g)].map((match) => match[1])
    expect(backgrounds).toEqual([THEME_COLORS.dark, THEME_COLORS.light])
    expect(html).toContain(`<meta name="theme-color" content="${THEME_COLORS.dark}" />`)
    expect(html).toContain(`light ? '${THEME_COLORS.light}' : '${THEME_COLORS.dark}'`)
  })
})
