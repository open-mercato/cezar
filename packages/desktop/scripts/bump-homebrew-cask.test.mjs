import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { bumpCask } from './bump-homebrew-cask.mjs'

const cask = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../homebrew/Casks/cezar.rb'), 'utf8')
const ARM = 'a'.repeat(64)
const INTEL = 'b'.repeat(64)

describe('bumpCask', () => {
  it('rewrites the version and each architecture sha256, nothing else', () => {
    const out = bumpCask(cask, '0.2.0', ARM, INTEL)
    expect(out).toContain('version "0.2.0"')
    expect(out).toMatch(new RegExp(`on_arm do\\s*\\n\\s*sha256 "${ARM}"`))
    expect(out).toMatch(new RegExp(`on_intel do\\s*\\n\\s*sha256 "${INTEL}"`))
    expect(out).toContain('releases/download/desktop-v#{version}/cezar-macos-aarch64.dmg')
    expect(out.split('\n').length).toBe(cask.split('\n').length)
    expect(bumpCask(out, '0.1.11', ...cask.match(/sha256 "([0-9a-f]{64})"/g).map(s => s.slice(8, -1)))).toBe(cask)
  })

  it('refuses malformed input instead of writing a broken cask', () => {
    expect(() => bumpCask(cask, 'v0.2.0', ARM, INTEL)).toThrow(/version/)
    expect(() => bumpCask(cask, '0.2.0', 'nope', INTEL)).toThrow(/sha256/)
    expect(() => bumpCask(cask.replace(/\s*on_intel do[\s\S]*?end\n/, '\n'), '0.2.0', ARM, INTEL)).toThrow(/on_intel/)
  })
})
