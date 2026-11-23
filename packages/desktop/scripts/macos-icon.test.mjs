import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

// The macOS icon pair (spec 2026-09-25 § Replacing the icon): icon.icns for macOS 12-15 and the
// Icon Composer catalog Assets.car (CFBundleIconName) for macOS 26.
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

  it('compiles the catalog with the same icon name and deployment floor the app declares', () => {
    const script = readFileSync(path.join(root, 'packages/desktop/scripts/icon.mjs'), 'utf8')
    const floor = json(path.join(tauri, 'tauri.conf.json')).bundle.macOS.minimumSystemVersion
    const compile = step(parse(readFileSync(path.join(root, '.github/workflows/desktop-icon.yml'), 'utf8')).jobs.compile.steps, 'Compile cezar.icon with actool').run

    expect(script).toContain(`const MIN_MACOS = '${floor}'`)
    expect(script).toContain("const ICON_NAME = 'cezar'")
    expect(compile).toContain(`--minimum-deployment-target ${floor}`)
    expect(compile).toContain('--app-icon cezar')
  })

  it('fails a release whose macOS bundle lacks either icon', () => {
    const verify = step(
      parse(readFileSync(path.join(root, '.github/workflows/desktop-release.yml'), 'utf8')).jobs.build.steps,
      "Verify the macOS bundle's signature",
    ).run

    expect(verify).toContain('Contents/Resources/Assets.car')
    expect(verify).toMatch(/plutil -extract CFBundleIconName raw .*\) *" *= *cezar/)
    expect(verify).toContain('plutil -extract CFBundleIconFile raw')
  })
})

function step(steps, name) {
  const found = steps.find(item => item.name === name)
  if (!found) throw new Error(`missing workflow step: ${name}`)
  return found
}
