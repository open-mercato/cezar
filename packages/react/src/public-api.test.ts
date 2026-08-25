// @vitest-environment node

import { expect, it } from 'vitest'

import * as root from './index'
import * as cockpit from './cockpit'
import * as tasks from './tasks'
import * as session from './session'

it('keeps all documented entry modules independently importable', () => {
  expect(root).toBeTypeOf('object')
  expect(cockpit).toBeTypeOf('object')
  expect(tasks).toBeTypeOf('object')
  expect(session).toBeTypeOf('object')
})

it('imports the public cockpit entry without browser globals', () => {
  expect(cockpit.CezarCockpit).toBeTypeOf('function')
})
