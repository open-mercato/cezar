#!/usr/bin/env node
// The Tahoe icon catalog (spec 2026-09-25 § Replacing the icon): icons/cezar.icon compiled by
// Xcode 26's actool into icons/Assets.car, with icons/Assets.car.json recording the source it was
// compiled from and the catalog's own hash. One module, so icon.mjs and the Desktop icon workflow
// run the same actool.
//
//   node scripts/icon-car.mjs compile <dir>        # <dir>/Assets.car + Assets.car.json (needs Xcode 26)
//   node scripts/icon-car.mjs check-source         # the stamp names cezar.icon as it is and this Assets.car
//   node scripts/icon-car.mjs compare <a> <b>      # two catalogs carry the same renditions
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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

/**
 * sha256 over the files the document is made of: icon.json and the layer images it names, text
 * with LF line endings, so a CRLF checkout or a stray editor file never reads as a new source.
 */
export function sourceHash(doc = ICON_DOC) {
  const json = readFileSync(join(doc, 'icon.json'))
  const images = JSON.parse(json.toString('utf8')).groups.flatMap((group) =>
    group.layers.map((layer) => `Assets/${layer['image-name']}`),
  )
  const hash = createHash('sha256')
  for (const file of ['icon.json', ...new Set(images)].sort()) {
    const bytes = readFileSync(join(doc, file))
    const text = /\.(json|svg)$/.test(file) ? Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n')) : bytes
    hash.update(`${file}\0`).update(text).update('\0')
  }
  return hash.digest('hex')
}

/** sha256 of a compiled catalog's bytes, so a stamp pairs with exactly one Assets.car. */
export function catalogHash(car = join(ICONS_DIR, 'Assets.car')) {
  return createHash('sha256').update(readFileSync(car)).digest('hex')
}

/** Why the committed pair is not current, or null: the stamp must name this source and this catalog. */
export function stampProblem(stamp, source, catalog) {
  if (stamp.source !== source) return 'icons/Assets.car was not compiled from icons/cezar.icon as it is now: recompile it'
  if (stamp.car !== catalog) return 'icons/Assets.car is not the catalog its Assets.car.json was written for: commit them together'
  return null
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
  const stamp = { source: sourceHash(doc), car: catalogHash(join(out, 'Assets.car')), actool }
  writeFileSync(join(out, 'Assets.car.json'), `${JSON.stringify(stamp, null, 2)}\n`)
  return true
}

/**
 * An `assetutil --info` listing without what differs per compile: timestamps, tool versions,
 * UUIDs, and the pixel digests of the flattened `Icon Image` bitmaps, which actool re-renders
 * differently each time. Those still compare by name, size and scale; the hashes in
 * Assets.car.json are the content gate.
 */
export function renditionsOf(info) {
  const keys = ['AssetType', 'Name', 'Appearance', 'Idiom', 'PixelWidth', 'PixelHeight', 'Scale', 'SHA1Digest']
  return info
    .slice(1)
    .map((asset) => {
      const kept = keys.filter((k) => k in asset && !(k === 'SHA1Digest' && asset.AssetType === 'Icon Image'))
      return JSON.stringify(Object.fromEntries(kept.map((k) => [k, asset[k]])))
    })
    .sort()
}

export function renditions(car) {
  return renditionsOf(JSON.parse(execFileSync('xcrun', ['assetutil', '--info', car], { encoding: 'utf8' })))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, a, b] = process.argv.slice(2)
  if (command === 'compile' && a) {
    if (!compileCatalog(resolve(a))) {
      console.error('icon-car: needs Xcode 26 (xcrun actool 26 or newer)')
      process.exit(1)
    }
  } else if (command === 'check-source') {
    const problem = stampProblem(JSON.parse(readFileSync(STAMP, 'utf8')), sourceHash(), catalogHash())
    if (problem) {
      console.error(`icon-car: ${problem}`)
      process.exit(1)
    }
  } else if (command === 'compare' && a && b) {
    const [left, right] = [renditions(a), renditions(b)]
    const onlyLeft = left.filter((r) => !right.includes(r))
    const onlyRight = right.filter((r) => !left.includes(r))
    if (onlyLeft.length || onlyRight.length) {
      for (const r of onlyLeft) console.error(`only in ${a}: ${r}`)
      for (const r of onlyRight) console.error(`only in ${b}: ${r}`)
      const recorded = JSON.parse(readFileSync(STAMP, 'utf8')).actool
      const here = actoolVersion()
      if (recorded !== here) {
        console.error(`icon-car: the toolchain changed: the committed catalog came from actool ${recorded}, this runner has ${here ?? 'none'}`)
      }
      process.exit(1)
    }
  } else {
    console.error('usage: icon-car.mjs compile <dir> | check-source | compare <a.car> <b.car>')
    process.exit(2)
  }
}
