import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  refreshUpdaterManifest,
  refreshUpdaterManifestFile,
  signaturePathForEntry,
} from './refresh-updater-manifest.mjs'

function tmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'cezar-desktop-manifest-'))
}

function manifestFixture() {
  return {
    version: '0.1.2',
    platforms: {
      'darwin-aarch64': {
        url: 'https://github.com/open-mercato/cezar/releases/download/desktop-v0.1.2/cezar-macos-aarch64.dmg',
        signature: 'mac-old',
      },
      'linux-x86_64': {
        url: 'https://github.com/open-mercato/cezar/releases/download/desktop-v0.1.2/cezar-linux-x86_64.AppImage',
        signature: 'linux-old',
      },
      'windows-x86_64': {
        url: 'https://github.com/open-mercato/cezar/releases/download/desktop-v0.1.2/cezar-windows-x86_64-setup.exe',
        signature: 'windows-old',
      },
      'windows-x86_64-nsis': {
        url: 'https://github.com/open-mercato/cezar/releases/download/desktop-v0.1.2/Cezar%200.1.2%20x64-setup.exe',
        signature: 'windows-versioned-old',
      },
    },
  }
}

describe('desktop updater manifest signature refresh', () => {
  it('maps .sig assets by download filename and preserves platforms without new signatures', () => {
    const dir = tmpDir()
    writeFileSync(path.join(dir, 'cezar-windows-x86_64-setup.exe.sig'), 'windows-new\n')
    writeFileSync(path.join(dir, 'Cezar 0.1.2 x64-setup.exe.sig'), 'windows-versioned-new\n')
    const logs = []

    const result = refreshUpdaterManifest(manifestFixture(), dir, message => logs.push(message))

    expect(result.refreshed).toEqual(['windows-x86_64', 'windows-x86_64-nsis'])
    expect(logs).toEqual([
      'updater signature refreshed for windows-x86_64',
      'updater signature refreshed for windows-x86_64-nsis',
    ])
    expect(result.manifest.platforms['windows-x86_64'].signature).toBe('windows-new')
    expect(result.manifest.platforms['windows-x86_64-nsis'].signature).toBe('windows-versioned-new')
    expect(result.manifest.platforms['darwin-aarch64'].signature).toBe('mac-old')
    expect(result.manifest.platforms['linux-x86_64'].signature).toBe('linux-old')
  })

  it('writes the refreshed manifest with a stable trailing newline', () => {
    const dir = tmpDir()
    const manifestPath = path.join(dir, 'desktop-latest.json')
    writeFileSync(manifestPath, JSON.stringify(manifestFixture()))
    writeFileSync(path.join(dir, 'cezar-windows-x86_64-setup.exe.sig'), 'wrong-dir')
    writeFileSync(path.join(dir, 'unused.sig'), 'ignored')
    writeFileSync(path.join(dir, 'Cezar 0.1.2 x64-setup.exe.sig'), 'wrong-dir')

    const result = refreshUpdaterManifestFile(manifestPath, dir, () => {})

    expect(result.refreshed).toEqual(['windows-x86_64', 'windows-x86_64-nsis'])
    expect(readFileSync(manifestPath, 'utf8')).toMatch(/\n$/)
    const written = JSON.parse(readFileSync(manifestPath, 'utf8'))
    expect(written.platforms['windows-x86_64'].signature).toBe('wrong-dir')
    expect(written.platforms['windows-x86_64-nsis'].signature).toBe('wrong-dir')
  })

  it('throws on a malformed platform entry instead of silently publishing a bad manifest', () => {
    expect(() => signaturePathForEntry({ signature: 'missing-url' }, tmpDir())).toThrow(/missing a URL/)
  })
})
