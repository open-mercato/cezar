#!/usr/bin/env node
// The Tahoe icon catalog (spec 2026-09-25 § Replacing the icon): icons/cezar.icon compiled by
// Xcode 26's actool into icons/Assets.car, with icons/Assets.car.json recording which source it
// was compiled from. One module, so icon.mjs and the Desktop icon workflow run the same actool.
//
//   node scripts/icon-car.mjs compile <dir>        # <dir>/Assets.car + Assets.car.json (needs Xcode 26)
//   node scripts/icon-car.mjs check-source         # the committed catalog was compiled from cezar.icon as it is
//   node scripts/icon-car.mjs compare <a> <b>      # two catalogs carry the same renditions
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const ICONS_DIR = join(desktop, 'src-tauri', 'icons')
export const ICON_NAME = 'cezar'
export const ICON_DOC = join(ICONS_DIR, `${ICON_NAME}.icon`)
export const STAMP = join(ICONS_DIR, 'Assets.car.json')
/** The shell's floor: actool also flattens the icon into renditions macOS 12-15 prefer to the .icns. */
export const MIN_MACOS = JSON.parse(readFileSync(join(desktop, 'src-tauri', 'tauri.conf.json'), 'utf8')).bundle.macOS
  .minimumSystemVersion

/** Every argument actool gets, the way Xcode compiles an Icon Composer icon into a catalog. */
export function actoolArgs(doc, out) {
  return [
    'actool', doc, '--compile', out, '--output-format', 'human-readable-text', '--notices', '--warnings',
    '--output-partial-info-plist', join(out, 'partial.plist'), '--app-icon', ICON_NAME, '--include-all-app-icons',
    '--enable-on-demand-resources', 'NO', '--development-region', 'en', '--target-device', 'mac',
    '--minimum-deployment-target', MIN_MACOS, '--platform', 'macosx',
  ]
}

/** sha256 over the document's files (path and bytes, sorted), so a stale catalog is visible anywhere. */
export function sourceHash(doc = ICON_DOC) {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name !== '.DS_Store') files.push(path)
    }
  }
  walk(doc)
  const hash = createHash('sha256')
  for (const file of files.map((f) => relative(doc, f).split('\\').join('/')).sort()) {
    hash.update(`${file}\0`).update(readFileSync(join(doc, file))).update('\0')
  }
  return hash.digest('hex')
}

/** Xcode 26's actool version, or null when there is none. */
export function actoolVersion() {
  const run = spawnSync('xcrun', ['actool', '--version', '--output-format', 'human-readable-text'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const version = /short-bundle-version: ([\d.]+)/.exec(run.stdout ?? '')?.[1]
  return version && Number(version.split('.')[0]) >= 26 ? version : null
}

/** Compiles the document into `out`; returns false when no Xcode 26 actool is available. */
export function compileCatalog(out, doc = ICON_DOC) {
  const actool = actoolVersion()
  if (!actool) return false
  mkdirSync(out, { recursive: true })
  // A null stdin: actool's ibtoold fails on a closed one (tauri-apps/tauri#16538).
  execFileSync('xcrun', actoolArgs(doc, out), { stdio: ['ignore', 'inherit', 'inherit'] })
  writeFileSync(join(out, 'Assets.car.json'), `${JSON.stringify({ source: sourceHash(doc), actool }, null, 2)}\n`)
  return true
}

/** The catalog's renditions without what differs per compile (timestamps, tool versions, UUIDs). */
export function renditions(car) {
  const info = JSON.parse(execFileSync('xcrun', ['assetutil', '--info', car], { encoding: 'utf8' }))
  const keys = ['AssetType', 'Name', 'Appearance', 'Idiom', 'PixelWidth', 'PixelHeight', 'Scale', 'SHA1Digest']
  return info
    .slice(1)
    .map((asset) => JSON.stringify(Object.fromEntries(keys.filter((k) => k in asset).map((k) => [k, asset[k]]))))
    .sort()
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, a, b] = process.argv.slice(2)
  if (command === 'compile' && a) {
    if (!compileCatalog(resolve(a))) {
      console.error('icon-car: needs Xcode 26 (xcrun actool 26 or newer)')
      process.exit(1)
    }
  } else if (command === 'check-source') {
    const recorded = JSON.parse(readFileSync(STAMP, 'utf8')).source
    if (recorded !== sourceHash()) {
      console.error('icon-car: icons/Assets.car was not compiled from icons/cezar.icon as it is now: recompile it')
      process.exit(1)
    }
  } else if (command === 'compare' && a && b) {
    const [left, right] = [renditions(a), renditions(b)]
    const onlyLeft = left.filter((r) => !right.includes(r))
    const onlyRight = right.filter((r) => !left.includes(r))
    if (onlyLeft.length || onlyRight.length) {
      for (const r of onlyLeft) console.error(`only in ${a}: ${r}`)
      for (const r of onlyRight) console.error(`only in ${b}: ${r}`)
      process.exit(1)
    }
  } else {
    console.error('usage: icon-car.mjs compile <dir> | check-source | compare <a.car> <b.car>')
    process.exit(2)
  }
}
