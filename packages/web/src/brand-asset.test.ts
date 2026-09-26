import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The brand mark is one public file shared by the favicon (`index.html`) and the sidebar
 * BrandTile (`/open-mercato.svg`). Keep the path stable — pack-check, static-ui, and
 * BACKWARD_COMPATIBILITY.md all name it.
 */
describe('cockpit brand asset', () => {
  it('ships a valid SVG at packages/web/public/open-mercato.svg', () => {
    const svg = readFileSync(resolve(webRoot, 'public/open-mercato.svg'), 'utf8')
    expect(svg.trimStart().startsWith('<svg')).toBe(true)
    // New mark is a solid purple tile (PNG embedded); the retired lime→yellow→violet gradient
    // must not sneak back in.
    expect(svg).not.toContain('paint0_linear')
    expect(svg).not.toContain('B4F372')
    expect(svg).toMatch(/data:image\/png;base64,/)
  })

  it('points the favicon at /open-mercato.svg', () => {
    const html = readFileSync(resolve(webRoot, 'index.html'), 'utf8')
    expect(html).toMatch(/rel=["']icon["'][^>]*href=["']\/open-mercato\.svg["']/)
  })
})
