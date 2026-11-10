import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const publicDir = resolve(webRoot, 'public')

interface ManifestIcon {
  src: string
  type: string
  sizes: string
  purpose: string
}

function readManifest(): Record<string, unknown> & { icons: ManifestIcon[] } {
  return JSON.parse(readFileSync(resolve(publicDir, 'manifest.webmanifest'), 'utf8'))
}

/** Width, height and colour type from a PNG's IHDR chunk. */
function pngHeader(file: string): { width: number; height: number; colorType: number } {
  const bytes = readFileSync(resolve(publicDir, file.replace(/^\//, '')))
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colorType: bytes[25] ?? -1 }
}

/**
 * The installable cockpit (#1762). The PNGs are exported by hand from `public/icon.svg` — nothing
 * rasterizes at build time, so re-export them when the mark changes. No service worker on purpose:
 * live data must never come from a cache.
 */
describe('install manifest', () => {
  it('describes a standalone app that starts at the bare root', () => {
    const manifest = readManifest()
    expect(manifest).toMatchObject({
      id: '/',
      name: 'cezar',
      short_name: 'cezar',
      // The bare root restores this browser's last location (lib/last-location.ts).
      start_url: '/',
      scope: '/',
      display: 'standalone',
      theme_color: '#0d0d0d',
      background_color: '#0d0d0d',
    })
  })

  it('lists 192 and 512 `any` icons plus a maskable one, each a shipped file', () => {
    const { icons } = readManifest()
    const any = icons.filter((icon) => icon.purpose === 'any').map((icon) => icon.sizes)
    expect(any).toEqual(expect.arrayContaining(['192x192', '512x512']))
    expect(icons.filter((icon) => icon.purpose === 'maskable')).toHaveLength(1)
    for (const icon of icons) {
      expect(existsSync(resolve(publicDir, icon.src.replace(/^\//, '')))).toBe(true)
    }
  })

  it.each([
    { file: '/icons/icon-192.png', size: 192, colorTypes: [6] },
    { file: '/icons/icon-512.png', size: 512, colorTypes: [6] },
    // Full-bleed: Android's mask and Apple's squircle must find no transparent corners.
    { file: '/icons/icon-maskable-512.png', size: 512, colorTypes: [2, 6] },
    { file: '/icons/apple-touch-icon.png', size: 180, colorTypes: [2, 6] },
  ])('$file is a $size px PNG', ({ file, size, colorTypes }) => {
    const header = pngHeader(file)
    expect(header.width).toBe(size)
    expect(header.height).toBe(size)
    expect(colorTypes).toContain(header.colorType)
  })

  it('declared sizes match the files', () => {
    for (const icon of readManifest().icons.filter((entry) => entry.type === 'image/png')) {
      const { width, height } = pngHeader(icon.src)
      expect(icon.sizes).toBe(`${width}x${height}`)
    }
  })

  it('is linked from index.html with credentials, beside the Apple tags', () => {
    const html = readFileSync(resolve(webRoot, 'index.html'), 'utf8')
    // use-credentials: behind an authenticated reverse proxy an anonymous manifest fetch gets a 401.
    expect(html).toMatch(/<link rel="manifest" href="\/manifest\.webmanifest" crossorigin="use-credentials" \/>/)
    expect(html).toMatch(/<link rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png" \/>/)
    expect(html).toMatch(/<meta name="apple-mobile-web-app-title" content="cezar" \/>/)
    expect(html).toMatch(/<meta name="theme-color" content="#0d0d0d" \/>/)
  })

  it('registers no service worker', () => {
    const main = readFileSync(resolve(webRoot, 'src/main.tsx'), 'utf8')
    expect(main).not.toMatch(/serviceWorker/)
    expect(existsSync(resolve(publicDir, 'sw.js'))).toBe(false)
  })
})
