#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function signaturePathForEntry(entry, signaturesDir) {
  if (!entry || typeof entry.url !== 'string') {
    throw new Error('manifest platform entry is missing a URL')
  }
  const assetName = decodeURIComponent(path.basename(new URL(entry.url).pathname))
  return path.join(signaturesDir, `${assetName}.sig`)
}

export function refreshUpdaterManifest(manifest, signaturesDir, log = () => {}) {
  const refreshed = []
  for (const [platform, entry] of Object.entries(manifest.platforms ?? {})) {
    const signaturePath = signaturePathForEntry(entry, signaturesDir)
    if (!existsSync(signaturePath)) continue

    const signature = readFileSync(signaturePath, 'utf8').trim()
    if (signature !== entry.signature) {
      log(`updater signature refreshed for ${platform}`)
      refreshed.push(platform)
    }
    entry.signature = signature
  }
  return { manifest, refreshed }
}

export function refreshUpdaterManifestFile(manifestPath, signaturesDir, log = console.log) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const result = refreshUpdaterManifest(manifest, signaturesDir, log)
  writeFileSync(manifestPath, `${JSON.stringify(result.manifest, null, 2)}\n`)
  return result
}

function main(argv) {
  const [manifestPath, signaturesDir] = argv
  if (!manifestPath || !signaturesDir) {
    console.error('usage: refresh-updater-manifest.mjs <desktop-latest.json> <signature-dir>')
    process.exitCode = 2
    return
  }
  refreshUpdaterManifestFile(manifestPath, signaturesDir)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
}
