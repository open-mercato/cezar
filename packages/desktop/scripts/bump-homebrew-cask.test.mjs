import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { bumpCask, caskVersion, isOlderVersion } from './bump-homebrew-cask.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const cask = readFileSync(path.join(here, '../homebrew/Casks/cezar.rb'), 'utf8')
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

  it('orders versions by their numeric core', () => {
    expect(caskVersion(cask)).toBe('0.1.11')
    expect(isOlderVersion('0.1.9', '0.1.11')).toBe(true)
    expect(isOlderVersion('0.1.11', '0.1.11')).toBe(false)
    expect(isOlderVersion('0.2.0', '0.1.11')).toBe(false)
    expect(isOlderVersion('0.2.0-beta.1', '0.2.0')).toBe(false)
  })

  it('never downgrades the tap when an older release workflow is re-run', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'cask-')), 'cezar.rb')
    writeFileSync(file, cask)
    const out = execFileSync(process.execPath, [path.join(here, 'bump-homebrew-cask.mjs'), file, '0.1.9', ARM, INTEL], { encoding: 'utf8' })
    expect(out).toContain('not downgrading')
    expect(readFileSync(file, 'utf8')).toBe(cask)
    execFileSync(process.execPath, [path.join(here, 'bump-homebrew-cask.mjs'), file, '0.2.0', ARM, INTEL])
    expect(caskVersion(readFileSync(file, 'utf8'))).toBe('0.2.0')
  })

  it('adds the binary stanzas once, only when asked, right after the app', () => {
    expect(bumpCask(cask, '0.2.0', ARM, INTEL)).not.toContain('binary')
    const out = bumpCask(cask, '0.2.0', ARM, INTEL, { binaries: true })
    expect(out).toContain(
      'app "Cezar.app"\n  binary "#{appdir}/Cezar.app/Contents/Resources/bin/cez"\n  binary "#{appdir}/Cezar.app/Contents/Resources/bin/cezar"\n',
    )
    expect(bumpCask(out, '0.2.1', ARM, INTEL, { binaries: true })).toBe(out.replace('version "0.2.0"', 'version "0.2.1"'))
    expect(bumpCask(out, '0.2.1', ARM, INTEL)).toContain('binary', 'never removed once there')
  })
})
