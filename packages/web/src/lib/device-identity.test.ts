import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { deviceColor, deviceColorIndex, deviceInitials } from './device-identity'

// The spec's palette, in slot order; the cockpit reads it from the `--color-device-N` tokens.
const PALETTE = ['#7c6cf0', '#e0912a', '#2fb862', '#2a9fd8', '#e05a73', '#22b3a0']

// The switcher spec's golden vectors: Android and iOS pin the same table.
const GOLDEN: Array<[string, string, string]> = [
  ['Studio iMac', '#7c6cf0', 'SI'],
  ['Build box', '#22b3a0', 'BB'],
  ['MacBook Pro', '#2a9fd8', 'MP'],
  ['Home server', '#e05a73', 'HS'],
  ['patryk-mbp', '#2a9fd8', 'P'],
  ['Żółw', '#e0912a', 'Ż'],
  ['a', '#e0912a', 'A'],
  ['Mac 🍎 mini', '#e05a73', 'MM'],
  ['🍎', '#e05a73', ''],
]

describe('device identity', () => {
  it.each(GOLDEN)('%s → %s %s', (name, color, initials) => {
    expect(PALETTE[deviceColorIndex(name)]).toBe(color)
    expect(deviceInitials(name)).toBe(initials)
  })

  it('ignores surrounding whitespace and collapses runs', () => {
    expect(PALETTE[deviceColorIndex('  Build box \n')]).toBe('#22b3a0')
    expect(deviceInitials('  build   box ')).toBe('BB')
  })

  it('names the token for the slot, and the tokens hold the spec palette', () => {
    expect(deviceColor('Build box')).toBe('var(--color-device-6)')
    const css = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../styles/index.css'), 'utf8')
    PALETTE.forEach((hex, i) => expect(css).toContain(`--color-device-${i + 1}: ${hex};`))
  })

  it('has no initials for an empty name', () => {
    expect(deviceInitials('')).toBe('')
    expect(deviceInitials('   ')).toBe('')
  })
})
