#!/usr/bin/env node
// Writes `desktop-latest.json` from the release's `.sig` assets, once, in the publish job.
// tauri-action's own `latest.json` is read-merge-replaced by every build leg in parallel and
// races (desktop-v0.1.12: one leg 404'd, the manifest lost darwin-x86_64).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// The keys tauri-action wrote for these bundles, so an installed shell resolves the same entry.
const BUNDLES = [
  { test: /_aarch64\.app\.tar\.gz$/, keys: ['darwin-aarch64', 'darwin-aarch64-app'] },
  { test: /_x64\.app\.tar\.gz$/, keys: ['darwin-x86_64', 'darwin-x86_64-app'] },
  { test: /-setup\.exe$/, keys: ['windows-x86_64', 'windows-x86_64-nsis'] },
  { test: /\.AppImage$/, keys: ['linux-x86_64', 'linux-x86_64-appimage'] },
  { test: /\.deb$/, keys: ['linux-x86_64-deb'] },
]

export const REQUIRED_PLATFORMS = ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64', 'linux-x86_64']

/** signatures: { [assetName]: signature } — the asset each `.sig` belongs to. */
export function buildUpdaterManifest({ version, downloadBase, signatures, pubDate = new Date().toISOString(), log = () => {} }) {
  const platforms = {}
  for (const [asset, signature] of Object.entries(signatures).sort(([a], [b]) => a.localeCompare(b))) {
    const bundle = BUNDLES.find(item => item.test.test(asset))
    if (!bundle) {
      log(`ignoring ${asset}.sig: not an updater bundle`)
      continue
    }
    for (const key of bundle.keys) {
      if (platforms[key]) throw new Error(`two updater bundles claim ${key}: ${asset} and ${platforms[key].asset}`)
      platforms[key] = { asset, signature: signature.trim(), url: `${downloadBase.replace(/\/$/, '')}/${encodeURIComponent(asset)}` }
    }
  }
  const missing = REQUIRED_PLATFORMS.filter(key => !platforms[key])
  if (missing.length > 0) throw new Error(`updater manifest is missing ${missing.join(', ')}`)
  return {
    version,
    notes: '',
    pub_date: pubDate,
    platforms: Object.fromEntries(Object.entries(platforms).map(([key, { signature, url }]) => [key, { signature, url }])),
  }
}

export function readSignatures(signaturesDir) {
  const signatures = {}
  for (const file of readdirSync(signaturesDir)) {
    if (file.endsWith('.sig')) signatures[file.slice(0, -'.sig'.length)] = readFileSync(path.join(signaturesDir, file), 'utf8')
  }
  return signatures
}

function main(argv) {
  const [outPath, signaturesDir, version, downloadBase] = argv
  if (!outPath || !signaturesDir || !version || !downloadBase) {
    console.error('usage: build-updater-manifest.mjs <desktop-latest.json> <signature-dir> <version> <download-base-url>')
    process.exitCode = 2
    return
  }
  const manifest = buildUpdaterManifest({ version, downloadBase, signatures: readSignatures(signaturesDir), log: console.log })
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`updater manifest: ${Object.keys(manifest.platforms).join(', ')}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
}
