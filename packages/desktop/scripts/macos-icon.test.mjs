import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

import { ICON_NAME, actoolArgs, catalogHash, renditionsOf, sourceHash, stampProblem } from './icon-car.mjs'

// The macOS icon pair (spec 2026-09-25 § Replacing the icon): the Icon Composer catalog Assets.car
// (CFBundleIconName), drawn by macOS 26 and, flattened, by macOS 12-15, and icon.icns, the fallback.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const tauri = path.join(root, 'packages/desktop/src-tauri')
const icons = path.join(tauri, 'icons')
const json = file => JSON.parse(readFileSync(file, 'utf8'))

describe('macOS app icon', () => {
  it('bundles the catalog only on macOS, beside the .icns', () => {
    const base = json(path.join(tauri, 'tauri.conf.json')).bundle.icon
    const mac = json(path.join(tauri, 'tauri.macos.conf.json')).bundle.icon

    expect(base).not.toContain('icons/Assets.car')
    expect(mac).toEqual(expect.arrayContaining(['icons/icon.icns', 'icons/Assets.car']))
    for (const icon of [...base, ...mac]) expect(existsSync(path.join(tauri, icon)), icon).toBe(true)
  })

  it('keeps the Icon Composer document whole: its layer image exists', () => {
    const doc = json(path.join(icons, 'cezar.icon/icon.json'))
    const images = doc.groups.flatMap(group => group.layers.map(layer => layer['image-name']))

    expect(doc['supported-platforms'].squares).toContain('macOS')
    expect(images.length).toBeGreaterThan(0)
    for (const image of images) expect(existsSync(path.join(icons, 'cezar.icon/Assets', image)), image).toBe(true)
  })

  it('compiles the catalog with the icon name and deployment floor the app declares', () => {
    const floor = json(path.join(tauri, 'tauri.conf.json')).bundle.macOS.minimumSystemVersion
    const args = actoolArgs('doc.icon', 'out')

    expect(ICON_NAME).toBe('cezar')
    expect(args.slice(args.indexOf('--app-icon'), args.indexOf('--app-icon') + 2)).toEqual(['--app-icon', 'cezar'])
    const target = args.indexOf('--minimum-deployment-target')
    expect(args[target + 1]).toBe(floor)
  })

  it('compiles in CI and in npm run icon through the one shared module', () => {
    const workflow = parse(readFileSync(path.join(root, '.github/workflows/desktop-icon.yml'), 'utf8'))
    const compile = step(workflow.jobs.compile.steps, 'Compile cezar.icon with actool').run
    const script = readFileSync(path.join(root, 'packages/desktop/scripts/icon.mjs'), 'utf8')

    expect(compile).toContain('icon-car.mjs compile out')
    expect(compile).not.toContain('xcrun actool')
    expect(script).toContain("from './icon-car.mjs'")
    expect(script).not.toContain("'actool'")
  })

  it('fails CI on a stale committed catalog: source and stamp, then renditions against a fresh compile', () => {
    const workflow = parse(readFileSync(path.join(root, '.github/workflows/desktop-icon.yml'), 'utf8'))
    const gate = step(workflow.jobs.compile.steps, 'Check the committed Assets.car is current').run

    expect(gate).toContain('icon-car.mjs check-source')
    expect(gate).toMatch(/icon-car\.mjs compare out\/Assets\.car "\$ICONS\/Assets\.car"/)
  })

  it('keeps the committed Assets.car paired with its stamp and compiled from cezar.icon as it is now', () => {
    const stamp = json(path.join(icons, 'Assets.car.json'))

    expect(stampProblem(stamp, sourceHash(), catalogHash()), 'recompile: npm run icon on Xcode 26, or commit the assets-car artifact').toBeNull()
  })

  it('names a stamp that belongs to another source or another catalog', () => {
    const stamp = { source: 's', car: 'c' }

    expect(stampProblem(stamp, 's', 'c')).toBeNull()
    expect(stampProblem(stamp, 'other', 'c')).toMatch(/not compiled from icons\/cezar\.icon/)
    expect(stampProblem(stamp, 's', 'other')).toMatch(/commit them together/)
  })

  it('compares renditions without per-compile noise but with every other digest and size', () => {
    const header = { Timestamp: 1, AssetStorageVersion: 'Xcode 26.6' }
    const bitmap = { AssetType: 'Icon Image', Name: 'cezar', PixelWidth: 64, Scale: 2, SHA1Digest: 'A', RenditionName: 'x-UUID1.png' }
    const vector = { AssetType: 'Vector', Name: 'cezar_Assets/mark', SHA1Digest: 'V' }
    const base = renditionsOf([header, bitmap, vector])

    expect(renditionsOf([{ Timestamp: 2 }, { ...bitmap, SHA1Digest: 'B', RenditionName: 'x-UUID2.png' }, vector])).toEqual(base)
    expect(renditionsOf([header, { ...bitmap, PixelWidth: 32 }, vector])).not.toEqual(base)
    expect(renditionsOf([header, bitmap, { ...vector, SHA1Digest: 'W' }])).not.toEqual(base)
    expect(renditionsOf([header, bitmap])).not.toEqual(base)
  })

  it('fails a release whose macOS bundle lacks either icon, and checks the inputs before uploading', () => {
    const steps = parse(readFileSync(path.join(root, '.github/workflows/desktop-release.yml'), 'utf8')).jobs.build.steps
    const names = steps.map(item => item.name)
    const verify = step(steps, "Verify the macOS bundle's icons").run
    const inputs = step(steps, 'Check the macOS icon inputs').run
    const cleanup = step(steps, "Remove this leg's macOS assets from the draft")

    expect(verify).toContain('Contents/Resources/Assets.car')
    expect(verify).toMatch(/plutil -extract CFBundleIconName raw .*\) *" *= *cezar/)
    expect(verify).toContain('plutil -extract CFBundleIconFile raw')
    expect(inputs).toContain('icon-car.mjs check-source')
    expect(names.indexOf('Check the macOS icon inputs')).toBeLessThan(names.indexOf('Build and upload with tauri-action'))
    expect(cleanup.if).toContain('failure()')
    expect(cleanup.if).toContain("steps.tauri.outcome != 'skipped'")
    expect(step(steps, 'Build and upload with tauri-action').id).toBe('tauri')
    expect(cleanup.run).toMatch(/isDraft -q \.isDraft\)" != true \]; then[\s\S]*exit 0[\s\S]*delete-asset/)
    expect(names.at(-1)).toBe("Remove this leg's macOS assets from the draft")
  })

  it('takes back exactly the failed leg\'s macOS assets and nothing else', () => {
    const cleanup = step(parse(readFileSync(path.join(root, '.github/workflows/desktop-release.yml'), 'utf8')).jobs.build.steps, "Remove this leg's macOS assets from the draft")
    const [, silicon, intel] = /&& '([^']+)' \|\| '([^']+)'/.exec(cleanup.env.ARCH)
    const pattern = /grep -E "([^"]+)"/.exec(cleanup.run)[1]
    const matches = arch => name => new RegExp(pattern.replaceAll('${ARCH}', arch)).test(name)
    // Every asset of the desktop-v0.1.14 release.
    const legs = {
      [silicon]: ['Cezar_0.1.14_aarch64.dmg', 'Cezar_aarch64.app.tar.gz', 'Cezar_aarch64.app.tar.gz.sig', 'cezar-macos-aarch64.dmg', 'cezar-macos-aarch64.dmg.sha256'],
      [intel]: ['Cezar_0.1.14_x64.dmg', 'Cezar_x64.app.tar.gz', 'Cezar_x64.app.tar.gz.sig', 'cezar-macos-x86_64.dmg', 'cezar-macos-x86_64.dmg.sha256'],
    }
    const others = [
      'cezar-linux-x86_64.AppImage', 'cezar-linux-x86_64.AppImage.sha256', 'cezar-linux-x86_64.deb', 'cezar-linux-x86_64.deb.sha256',
      'cezar-linux-x86_64.pkg.tar.zst', 'cezar-linux-x86_64.pkg.tar.zst.sha256', 'cezar-windows-x86_64-setup.exe',
      'cezar-windows-x86_64-setup.exe.sha256', 'Cezar_0.1.14_amd64.AppImage', 'Cezar_0.1.14_amd64.AppImage.sig', 'Cezar_0.1.14_amd64.deb',
      'Cezar_0.1.14_amd64.deb.sig', 'Cezar_0.1.14_x64-setup.exe', 'Cezar_0.1.14_x64-setup.exe.sig', 'desktop-latest.json',
    ]

    for (const [arch, own] of Object.entries(legs)) {
      const other = Object.entries(legs).find(([key]) => key !== arch)[1]
      for (const name of own) expect(matches(arch)(name), `${arch} ${name}`).toBe(true)
      for (const name of [...other, ...others]) expect(matches(arch)(name), `${arch} ${name}`).toBe(false)
    }
  })
})

function step(steps, name) {
  const found = steps.find(item => item.name === name)
  if (!found) throw new Error(`missing workflow step: ${name}`)
  return found
}
