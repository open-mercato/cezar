import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

import { ICON_NAME, MIN_MACOS, actoolArgs, sourceHash } from './icon-car.mjs'

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

    expect(MIN_MACOS).toBe(floor)
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

  it('keeps the committed Assets.car compiled from cezar.icon as it is now', () => {
    const stamp = json(path.join(icons, 'Assets.car.json'))

    expect(stamp.source, 'icons/Assets.car is stale: recompile it (npm run icon on Xcode 26, or the assets-car artifact)').toBe(sourceHash())
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
    expect(names.at(-1)).toBe("Remove this leg's macOS assets from the draft")
  })
})

function step(steps, name) {
  const found = steps.find(item => item.name === name)
  if (!found) throw new Error(`missing workflow step: ${name}`)
  return found
}
