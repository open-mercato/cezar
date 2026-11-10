#!/usr/bin/env node
// Regenerate the installable cockpit's PNG icons from public/icon.svg (#1762):
//
//   npm run icons -w packages/web
//
// Full bleed: iOS and Android mask the tile themselves, and a transparent corner gets a plate
// behind it. The mark already sits inside the maskable safe zone, so icon-512 is both `any` and `maskable`.
// Rendering uses rsvg-convert when present, else macOS's qlmanage + sips (as desktop's icon.mjs).
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), '../public')
const SIZES = {
  'apple-touch-icon.png': 180,
  'icon-192.png': 192,
  'icon-512.png': 512,
}

const svg = readFileSync(join(publicDir, 'icon.svg'), 'utf8')
const fullBleed = svg.replace(/(<rect\b[^>]*?)\s+rx="\d+"/, '$1').replace('<svg ', '<svg width="1024" height="1024" ')
const work = mkdtempSync(join(tmpdir(), 'cezar-pwa-icons-'))
const source = join(work, 'source.svg')
writeFileSync(source, fullBleed)

const useRsvg = spawnSync('rsvg-convert', ['--version'], { stdio: 'ignore' }).status === 0
if (!useRsvg && process.platform !== 'darwin') {
  console.error('icons: need rsvg-convert (apt/brew install librsvg) to render the SVG')
  process.exit(1)
}
const master = join(work, 'master.png')
if (!useRsvg) {
  execFileSync('qlmanage', ['-t', '-s', '1024', '-o', work, source], { stdio: 'ignore' })
  renameSync(join(work, 'source.svg.png'), master)
}
for (const [name, size] of Object.entries(SIZES)) {
  const out = join(publicDir, name)
  if (useRsvg) execFileSync('rsvg-convert', ['-w', `${size}`, '-h', `${size}`, '-o', out, source])
  else execFileSync('sips', ['-z', `${size}`, `${size}`, master, '--out', out], { stdio: 'ignore' })
}
rmSync(work, { recursive: true, force: true })
console.log(`icons: regenerated ${Object.keys(SIZES).join(', ')} in ${publicDir}`)
