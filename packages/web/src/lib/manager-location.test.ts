import { afterEach, expect, it } from 'vitest'

import { managerHref, rememberManagerLocation } from './manager-location'

afterEach(() => sessionStorage.clear())

it('remembers workspace approvals independently of manager ids, including an empty workspace', () => {
  rememberManagerLocation('/manager/approvals')
  expect(managerHref(['global'])).toBe('/manager/approvals')
  expect(managerHref([])).toBe('/manager/approvals')
})

it('still falls back when a remembered manager was deleted', () => {
  rememberManagerLocation('/manager/deleted')
  expect(managerHref(['global'])).toBe('/manager')
})
