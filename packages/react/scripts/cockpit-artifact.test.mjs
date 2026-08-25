import { expect, it } from 'vitest'

it('exports CezarCockpit from both built public entries', async () => {
  const cockpit = await import('../dist/cockpit.js')
  const root = await import('../dist/index.js')

  expect(cockpit.CezarCockpit).toBeTypeOf('function')
  expect(root.CezarCockpit).toBeTypeOf('function')
})
