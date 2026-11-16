import { afterEach, describe, expect, it } from 'vitest'
import { cleanManagerLocation, managerHref, rememberManagerLocation } from './manager-location'

afterEach(() => sessionStorage.clear())
describe('remembered Manager destinations', () => {
  it('drops overlays while preserving unrelated filters and fragments', () => {
    rememberManagerLocation('/manager/a?watching=1&filter=mine#latest')
    expect(managerHref(['a'])).toBe('/manager/a?filter=mine#latest')
    expect(cleanManagerLocation('/manager/a?watching=1')).toBe('/manager/a')
  })
  it('cleans old stored destinations as well as new writes', () => {
    sessionStorage.setItem('cez-last-manager', '/manager/a?watching=1&filter=mine')
    expect(managerHref(['a'])).toBe('/manager/a?filter=mine')
  })
})
