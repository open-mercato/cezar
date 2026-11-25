import { afterEach, describe, expect, it } from 'vitest'

import { cleanManagerLocation, managerHref, rememberManagerLocation } from './manager-location'

afterEach(() => sessionStorage.clear())

it('remembers workspace approvals independently of manager ids, including an empty workspace', () => {
  rememberManagerLocation('/manager/approvals')
  expect(managerHref(['global'])).toBe('/manager/approvals')
  expect(managerHref([])).toBe('/manager/approvals')
})

it('remembers Manager mode\'s Now and its filter, not as a manager id', () => {
  rememberManagerLocation('/manager/now?manager=global')
  expect(managerHref(['global'])).toBe('/manager/now?manager=global')
  rememberManagerLocation('/manager/now')
  expect(managerHref([])).toBe('/manager/now')
})

it('remembers the workspace Questions page, not as a manager id', () => {
  rememberManagerLocation('/manager/questions')
  expect(managerHref(['global'])).toBe('/manager/questions')
  expect(managerHref([])).toBe('/manager/questions')
})

it('still falls back when a remembered manager was deleted', () => {
  rememberManagerLocation('/manager/deleted')
  expect(managerHref(['global'])).toBe('/manager')
})

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
