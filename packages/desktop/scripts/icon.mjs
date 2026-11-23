#!/usr/bin/env node
// Regenerate every app icon from ONE source SVG:
//
//   npm run icon                              # from packages/web/public/icon.svg (the brand mark)
//   npm run icon -- path/to/new.svg           # from a new mark
//   npm run icon -- new.svg --bg '#1a1a2e'    # …whose tile is another colour
//
// Three outputs, because the platforms draw an app icon differently:
// - Windows .ico and Linux PNGs: the mark full-bleed on the 1024px canvas, via `tauri icon`.
// - icon.icns, for macOS 15 and older: those draw the .icns as-is, so the rounded tile is baked
//   in, inside Apple's icon grid (an 824px tile centred, transparent margin, a soft shadow).
//   Full-bleed there is a hard-edged square in the Dock.
// - cezar.icon + Assets.car, for macOS 26: an Icon Composer document (fill + glyph layer) that the
//   system masks, lights and tints itself, in every appearance. Without it Tahoe falls back to the
//   .icns. Assets.car is compiled with Xcode 26's actool; without one the .icon is still written
//   and the stale Assets.car is reported (the desktop-check workflow compiles it too).
// The splash logo (ui/icon.svg) is refreshed from the same source.
// Rendering needs rsvg-convert (brew/apt install librsvg): the legacy tile needs real alpha.
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const desktop = resolve(here, '..')
const args = process.argv.slice(2)
const bgAt = args.indexOf('--bg')
const bgArg = bgAt >= 0 ? args[bgAt + 1] : undefined
const positional = args.filter((arg, i) => arg !== '--bg' && (bgAt < 0 || i !== bgAt + 1))
/** The brand tile's colour — what fills the corners the mark's own rounded tile leaves empty. */
const TILE_COLOR = '#000000'
/** Apple's macOS icon grid (Big Sur to Sequoia): the tile, its offset and corner on a 1024 canvas. */
const GRID = { tile: 824, inset: 100, radius: 185.4 }
/** The deployment floor of the shell (tauri.conf.json `minimumSystemVersion`), for actool. */
const MIN_MACOS = '12.0'
const ICON_NAME = 'cezar'

const source = resolve(positional[0] ?? resolve(desktop, '../web/public/icon.svg'))
if (!existsSync(source)) {
  console.error(`icon: source not found: ${source}`)
  process.exit(1)
}
if (spawnSync('rsvg-convert', ['--version'], { stdio: 'ignore' }).status !== 0) {
  console.error('icon: need rsvg-convert (brew install librsvg / apt install librsvg2-bin)')
  process.exit(1)
}

const svg = readFileSync(source, 'utf8')
const size = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(svg)
if (!size) {
  console.error('icon: the source SVG needs a viewBox="0 0 W H"')
  process.exit(1)
}
const [w, h] = [Number(size[1]), Number(size[2])]
const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
const gradient = /fill="url\(#([^)]+)\)"/.exec(svg)?.[1]
const tileFill = bgArg ?? (gradient ? `url(#${gradient})` : TILE_COLOR)
// The mark's own full-size background rect, if it has one: Tahoe gets the glyph without it.
const bgRect = new RegExp(`<rect\\b(?![^>]*\\b[xy]="[1-9])[^>]*\\bwidth="${w}"[^>]*\\bheight="${h}"[^>]*/>`).exec(inner)
const bgRectFill = bgRect && /\bfill="(#[0-9a-fA-F]{6})"/.exec(bgRect[0])?.[1]
const NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"'

/** The mark on its tile colour, scaled to `px` and placed at `at`. */
const markOnTile = (px, at = 0) => `<g transform="${at ? `translate(${at} ${at}) ` : ''}scale(${(px / Math.max(w, h)).toFixed(6)})">
<rect width="${w}" height="${h}" fill="${tileFill}"/>
${inner}
</g>`

const fullBleed = `<svg width="1024" height="1024" viewBox="0 0 1024 1024" fill="none" ${NS}>
${markOnTile(1024)}
</svg>
`
const { tile, inset, radius } = GRID
const legacyTile = `<svg width="1024" height="1024" viewBox="0 0 1024 1024" fill="none" ${NS}>
<defs>
<clipPath id="cezar-tile"><rect x="${inset}" y="${inset}" width="${tile}" height="${tile}" rx="${radius}"/></clipPath>
<filter id="cezar-shadow" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="10" stdDeviation="10" flood-color="#000" flood-opacity="0.3"/></filter>
</defs>
<rect x="${inset}" y="${inset}" width="${tile}" height="${tile}" rx="${radius}" fill="#000" filter="url(#cezar-shadow)"/>
<g clip-path="url(#cezar-tile)">
${markOnTile(tile, inset)}
</g>
</svg>
`
// Icon Composer canvas: 1024pt, the system's squircle covers all of it.
const glyph = bgRect && bgRectFill && !bgArg ? inner.replace(bgRect[0], '') : null
const tahoeLayer = `<svg width="1024" height="1024" viewBox="0 0 1024 1024" fill="none" ${NS}>
${glyph ? `<g transform="scale(${(1024 / Math.max(w, h)).toFixed(6)})">${glyph}</g>` : markOnTile(1024)}
</svg>
`
const srgb = (hex) =>
  `srgb:${[1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(5)).join(',')},1.00000`
const fillHex = /^#[0-9a-fA-F]{6}$/.test(bgArg ?? '') ? bgArg : (bgRectFill ?? TILE_COLOR)
const iconJson = {
  fill: { solid: srgb(fillHex) },
  groups: [
    {
      layers: [{ glass: true, 'image-name': 'mark.svg', name: 'mark' }],
      shadow: { kind: 'neutral', opacity: 0.5 },
      translucency: { enabled: true, value: 0.5 },
    },
  ],
  'supported-platforms': { squares: ['macOS'] },
}
if (!glyph) console.warn('icon: no plain full-size background rect in the mark — the Tahoe icon keeps it in its layer')

const iconsDir = join(desktop, 'src-tauri', 'icons')
const work = mkdtempSync(join(tmpdir(), 'cezar-icon-'))
const render = (name, body) => {
  const svgPath = join(work, `${name}.svg`)
  const pngPath = join(work, `${name}.png`)
  writeFileSync(svgPath, body)
  execFileSync('rsvg-convert', ['-w', '1024', '-h', '1024', '-o', pngPath, svgPath])
  return pngPath
}

writeFileSync(join(iconsDir, 'source.svg'), fullBleed)
writeFileSync(join(iconsDir, 'macos-legacy.svg'), legacyTile)
execFileSync('npx', ['tauri', 'icon', render('full-bleed', fullBleed), '-o', iconsDir], { cwd: desktop, stdio: 'inherit' })
for (const extra of ['android', 'ios']) rmSync(join(iconsDir, extra), { recursive: true, force: true })
// Only the .icns is taken from the tile render; every other file stays full-bleed.
const legacyOut = join(work, 'legacy')
execFileSync('npx', ['tauri', 'icon', render('legacy', legacyTile), '-o', legacyOut], { cwd: desktop, stdio: 'ignore' })
copyFileSync(join(legacyOut, 'icon.icns'), join(iconsDir, 'icon.icns'))

const iconDoc = join(iconsDir, `${ICON_NAME}.icon`)
rmSync(iconDoc, { recursive: true, force: true })
mkdirSync(join(iconDoc, 'Assets'), { recursive: true })
writeFileSync(join(iconDoc, 'icon.json'), `${JSON.stringify(iconJson, null, 2)}\n`)
writeFileSync(join(iconDoc, 'Assets', 'mark.svg'), tahoeLayer)
compileAssetsCar(iconDoc)

copyFileSync(source, join(desktop, 'ui', 'icon.svg'))
rmSync(work, { recursive: true, force: true })
console.log(`icon: regenerated ${iconsDir} and ui/icon.svg from ${source}`)

/** Xcode 26's actool, run the way Xcode itself compiles an Icon Composer icon into a catalog. */
function compileAssetsCar(doc) {
  const version = spawnSync('xcrun', ['actool', '--version', '--output-format', 'human-readable-text'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const major = Number(/short-bundle-version: (\d+)/.exec(version.stdout ?? '')?.[1] ?? 0)
  if (major < 26) {
    console.warn(
      'icon: no Xcode 26 actool here, so icons/Assets.car was NOT recompiled: run this again on a Mac with Xcode 26',
    )
    return
  }
  const out = join(work, 'car')
  mkdirSync(out, { recursive: true })
  // A null stdin: actool's ibtoold fails on a closed one (tauri-apps/tauri#16538).
  execFileSync(
    'xcrun',
    ['actool', doc, '--compile', out, '--output-format', 'human-readable-text', '--notices', '--warnings',
      '--output-partial-info-plist', join(out, 'partial.plist'), '--app-icon', ICON_NAME, '--include-all-app-icons',
      '--enable-on-demand-resources', 'NO', '--development-region', 'en', '--target-device', 'mac',
      '--minimum-deployment-target', MIN_MACOS, '--platform', 'macosx'],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  )
  copyFileSync(join(out, 'Assets.car'), join(iconsDir, 'Assets.car'))
}
