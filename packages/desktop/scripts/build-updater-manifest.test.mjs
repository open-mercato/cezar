import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildUpdaterManifest, readSignatures } from './build-updater-manifest.mjs'

const base = 'https://github.com/open-mercato/cezar/releases/download/desktop-v0.1.12'

// The `.sig` assets desktop-v0.1.12's build legs uploaded.
function releaseSignatures() {
  return {
    'Cezar_aarch64.app.tar.gz': 'sig-mac-arm\n',
    'Cezar_x64.app.tar.gz': 'sig-mac-intel',
    'Cezar_0.1.12_x64-setup.exe': 'sig-win',
    'Cezar_0.1.12_amd64.AppImage': 'sig-appimage',
    'Cezar_0.1.12_amd64.deb': 'sig-deb',
  }
}

describe('buildUpdaterManifest', () => {
  it('writes every platform key tauri-action wrote, pointing each at its own signed bundle', () => {
    const manifest = buildUpdaterManifest({
      version: '0.1.12',
      downloadBase: `${base}/`,
      signatures: releaseSignatures(),
      pubDate: '2026-11-20T00:00:00.000Z',
    })

    expect(manifest).toMatchObject({ version: '0.1.12', notes: '', pub_date: '2026-11-20T00:00:00.000Z' })
    expect(Object.keys(manifest.platforms).sort()).toEqual([
      'darwin-aarch64',
      'darwin-aarch64-app',
      'darwin-x86_64',
      'darwin-x86_64-app',
      'linux-x86_64',
      'linux-x86_64-appimage',
      'linux-x86_64-deb',
      'windows-x86_64',
      'windows-x86_64-nsis',
    ])
    expect(manifest.platforms['darwin-aarch64']).toEqual({ signature: 'sig-mac-arm', url: `${base}/Cezar_aarch64.app.tar.gz` })
    expect(manifest.platforms['darwin-x86_64-app']).toEqual({ signature: 'sig-mac-intel', url: `${base}/Cezar_x64.app.tar.gz` })
    expect(manifest.platforms['windows-x86_64-nsis']).toEqual({ signature: 'sig-win', url: `${base}/Cezar_0.1.12_x64-setup.exe` })
    expect(manifest.platforms['linux-x86_64'].url).toBe(`${base}/Cezar_0.1.12_amd64.AppImage`)
    expect(manifest.platforms['linux-x86_64-deb'].signature).toBe('sig-deb')
  })

  it('refuses a manifest that would leave a platform behind', () => {
    const signatures = releaseSignatures()
    delete signatures['Cezar_x64.app.tar.gz']

    expect(() => buildUpdaterManifest({ version: '0.1.12', downloadBase: base, signatures })).toThrow(/missing darwin-x86_64/)
  })

  it('refuses two bundles for one platform, and skips signatures that are not updater bundles', () => {
    const logs = []
    const manifest = buildUpdaterManifest({
      version: '0.1.12',
      downloadBase: base,
      signatures: { ...releaseSignatures(), 'notes.txt': 'x' },
      log: line => logs.push(line),
    })
    expect(Object.values(manifest.platforms).some(entry => entry.url.endsWith('notes.txt'))).toBe(false)
    expect(logs).toEqual(['ignoring notes.txt.sig: not an updater bundle'])

    expect(() => buildUpdaterManifest({
      version: '0.1.12',
      downloadBase: base,
      signatures: { ...releaseSignatures(), 'Cezar_0.1.11_x64-setup.exe': 'old' },
    })).toThrow(/two updater bundles claim windows-x86_64/)
  })

  it('reads each .sig file as the signature of the asset it is named after', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cezar-desktop-sigs-'))
    writeFileSync(path.join(dir, 'Cezar_0.1.12_x64-setup.exe.sig'), 'sig-win')
    writeFileSync(path.join(dir, 'Cezar_0.1.12_x64-setup.exe'), 'not a signature')

    expect(readSignatures(dir)).toEqual({ 'Cezar_0.1.12_x64-setup.exe': 'sig-win' })
  })
})
