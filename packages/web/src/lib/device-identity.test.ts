import { describe, expect, it } from 'vitest'
import { deviceColor, deviceInitials } from './device-identity'

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
    expect(deviceColor(name)).toBe(color)
    expect(deviceInitials(name)).toBe(initials)
  })

  it('ignores surrounding whitespace and collapses runs', () => {
    expect(deviceColor('  Build box \n')).toBe('#22b3a0')
    expect(deviceInitials('  build   box ')).toBe('BB')
  })

  it('has no initials for an empty name', () => {
    expect(deviceInitials('')).toBe('')
    expect(deviceInitials('   ')).toBe('')
  })
})
