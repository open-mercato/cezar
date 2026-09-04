// @vitest-environment node

import { expect, it } from 'vitest'

import * as root from './index'
import * as cockpit from './cockpit'

it('keeps the documented JavaScript entry modules independently importable', () => {
  expect(root).toBeTypeOf('object')
  expect(cockpit).toBeTypeOf('object')
})

it('imports the public cockpit entry without browser globals', () => {
  expect(cockpit.CezarCockpit).toBeTypeOf('function')
})
