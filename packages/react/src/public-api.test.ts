import { expect, it } from 'vitest'

import * as root from './index'
import * as tasks from './tasks'
import * as session from './session'

it('keeps all three documented entry modules independently importable', () => {
  expect(root).toBeTypeOf('object')
  expect(tasks).toBeTypeOf('object')
  expect(session).toBeTypeOf('object')
})
