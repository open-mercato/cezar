#!/usr/bin/env node
// Rewrites the tap's Casks/cezar.rb for a new desktop release: the version and the sha256 in
// each of `on_arm` / `on_intel`. Run by desktop-release.yml's Homebrew tap job.
//   node bump-homebrew-cask.mjs <cask.rb> <version> <arm64 sha256> <x86_64 sha256>
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SHA = /^[0-9a-f]{64}$/
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

// Compares the numeric x.y.z cores only; a pre-release suffix never makes a version "older".
export function isOlderVersion(candidate, current) {
  const core = v => (v.match(/^(\d+)\.(\d+)\.(\d+)/) ?? []).slice(1).map(Number)
  const [a, b] = [core(candidate), core(current)]
  if (a.length !== 3 || b.length !== 3) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i]
  return false
}

export function caskVersion(source) {
  return source.match(/^\s*version\s+"([^"]*)"/m)?.[1]
}

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
  const source = readFileSync(file, 'utf8')
  const current = caskVersion(source)
  // A re-run of an older release's workflow must not roll brew users back.
  if (current && isOlderVersion(version, current)) {
    console.log(`::warning::${file} is already at ${current}; not downgrading it to ${version}.`)
    process.exit(0)
  }
  writeFileSync(file, bumpCask(source, version, armSha, intelSha))
}
