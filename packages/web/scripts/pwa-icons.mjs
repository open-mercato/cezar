#!/usr/bin/env node
// Regenerate the installable cockpit's PNG icons from public/icon.svg (#1762):
//
//   npm run icons -w packages/web
//
// Full bleed: iOS and Android mask the tile themselves, and a transparent corner gets a plate
// behind it. icon-512 only grazes the maskable safe zone (the inner 80% circle), so the maskable
// icon shrinks the mark to leave launchers' circular and squircle masks a margin.
// Rendering uses rsvg-convert when present, else macOS's qlmanage + sips (as desktop's icon.mjs).
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), '../public')
const SIZES = {
  'apple-touch-icon.png': 180,
  'icon-192.png': 192,
  'icon-512.png': 512,
  'icon-maskable-512.png': 512,
}

const svg = readFileSync(join(publicDir, 'icon.svg'), 'utf8')
const fullBleed = svg.replace(/(<rect\b[^>]*?)\s+rx="\d+"/, '$1').replace('<svg ', '<svg width="1024" height="1024" ')
const work = mkdtempSync(join(tmpdir(), 'cezar-pwa-icons-'))
const source = join(work, 'source.svg')
writeFileSync(source, fullBleed)
const maskableSource = join(work, 'maskable.svg')
writeFileSync(maskableSource, fullBleed.replace('<g ', '<g transform="translate(352 352) scale(0.78) translate(-352 -352)" '))

const useRsvg = spawnSync('rsvg-convert', ['--version'], { stdio: 'ignore' }).status === 0
if (!useRsvg && process.platform !== 'darwin') {
  console.error('icons: need rsvg-convert (apt/brew install librsvg) to render the SVG')
  process.exit(1)
}
const masters = new Map()
const render = (svgFile) => {
  if (!masters.has(svgFile)) {
    execFileSync('qlmanage', ['-t', '-s', '1024', '-o', work, svgFile], { stdio: 'ignore' })
    masters.set(svgFile, `${svgFile}.png`)
  }
  return masters.get(svgFile)
}
for (const [name, size] of Object.entries(SIZES)) {
  const out = join(publicDir, name)
  const svgFile = name.includes('maskable') ? maskableSource : source
  if (useRsvg) execFileSync('rsvg-convert', ['-w', `${size}`, '-h', `${size}`, '-o', out, svgFile])
  else execFileSync('sips', ['-z', `${size}`, `${size}`, render(svgFile), '--out', out], { stdio: 'ignore' })
}
rmSync(work, { recursive: true, force: true })
console.log(`icons: regenerated ${Object.keys(SIZES).join(', ')} in ${publicDir}`)
