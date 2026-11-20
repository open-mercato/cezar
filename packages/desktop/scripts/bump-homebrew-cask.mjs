#!/usr/bin/env node
// Rewrites the tap's Casks/cezar.rb for a new desktop release: the version and the sha256 in
// each of `on_arm` / `on_intel`. Run by desktop-release.yml's Homebrew tap job.
//   node bump-homebrew-cask.mjs <cask.rb> <version> <arm64 sha256> <x86_64 sha256>
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SHA = /^[0-9a-f]{64}$/
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

export function bumpCask(source, version, armSha, intelSha) {
  if (!VERSION.test(version)) throw new Error(`not a version: ${version}`)
  for (const sha of [armSha, intelSha]) if (!SHA.test(sha)) throw new Error(`not a sha256: ${sha}`)
  const replaceOnce = (text, pattern, replacement, what) => {
    if ((text.match(new RegExp(pattern.source, pattern.flags + 'g')) ?? []).length !== 1) throw new Error(`expected exactly one ${what} in the cask`)
    return text.replace(pattern, replacement)
  }
  let out = replaceOnce(source, /^(\s*version\s+)"[^"]*"/m, `$1"${version}"`, 'version')
  out = replaceOnce(out, /(on_arm do\s*\n\s*sha256\s+)"[0-9a-f]*"/, `$1"${armSha}"`, 'on_arm sha256')
  out = replaceOnce(out, /(on_intel do\s*\n\s*sha256\s+)"[0-9a-f]*"/, `$1"${intelSha}"`, 'on_intel sha256')
  return out
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, version, armSha, intelSha] = process.argv.slice(2)
  if (!intelSha) {
    console.error('usage: bump-homebrew-cask.mjs <cask.rb> <version> <arm64 sha256> <x86_64 sha256>')
    process.exit(2)
  }
  writeFileSync(file, bumpCask(readFileSync(file, 'utf8'), version, armSha, intelSha))
}
