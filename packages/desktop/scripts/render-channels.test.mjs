import { describe, expect, it } from 'vitest'

import { renderAur, renderWinget, wingetDir } from './render-channels.mjs'

const SHA = 'ab'.repeat(32)

describe('renderWinget', () => {
  it('points the installer at the versioned release with an upper-case sha256', () => {
    const files = renderWinget('0.1.12', SHA, '2026-11-27')
    expect(Object.keys(files).sort()).toEqual(['OpenMercato.Cezar.installer.yaml', 'OpenMercato.Cezar.locale.en-US.yaml', 'OpenMercato.Cezar.yaml'])
    const installer = files['OpenMercato.Cezar.installer.yaml']
    expect(installer).toContain('InstallerUrl: https://github.com/open-mercato/cezar/releases/download/desktop-v0.1.12/cezar-windows-x86_64-setup.exe')
    expect(installer).toContain(`InstallerSha256: ${SHA.toUpperCase()}`)
    expect(installer).toContain('InstallerType: nullsoft')
    expect(installer).toContain('ReleaseDate: 2026-11-27')
    for (const text of Object.values(files)) {
      expect(text).toContain('PackageVersion: 0.1.12')
      expect(text).not.toContain('%V')
    }
  })
  it('lays out winget-pkgs paths', () => {
    expect(wingetDir('0.1.12')).toBe('manifests/o/OpenMercato/Cezar/0.1.12')
  })
  it('rejects a bad version or sha', () => {
    expect(() => renderWinget('latest', SHA)).toThrow(/not a version/)
    expect(() => renderWinget('0.1.12', 'abc')).toThrow(/not a sha256/)
  })
})

describe('renderAur', () => {
  it('pins the release .deb by sha256 and derives from arch/PKGBUILD', () => {
    const { PKGBUILD, '.SRCINFO': srcinfo } = renderAur('0.1.12', SHA)
    expect(PKGBUILD).toContain('pkgver=0.1.12')
    expect(PKGBUILD).toContain('desktop-v0.1.12/cezar-linux-x86_64.deb')
    expect(PKGBUILD).toContain(`sha256sums=('${SHA}')`)
    expect(PKGBUILD).not.toContain('SKIP')
    expect(PKGBUILD).not.toContain('@VERSION@')
    expect(PKGBUILD).toContain('"$srcdir/cezar-0.1.12.deb"')
    expect(srcinfo).toContain('pkgbase = cezar-desktop-bin')
    expect(srcinfo).toContain('\tpkgver = 0.1.12')
    expect(srcinfo).toContain('\tdepends = webkit2gtk-4.1')
    expect(srcinfo).toContain('\toptdepends = nodejs: Node.js 20 or newer, required to run cezar (any install on PATH works)')
    expect(srcinfo).toContain(`\tsha256sums = ${SHA}`)
    expect(srcinfo).toContain('\tlicense = MIT')
    expect(srcinfo.endsWith('pkgname = cezar-desktop-bin\n')).toBe(true)
  })
  it('fails loudly when the template changes shape', () => {
    expect(() => renderAur('0.1.12', SHA, 'pkgver=@VERSION@\n')).toThrow(/expected exactly one/)
  })
})
