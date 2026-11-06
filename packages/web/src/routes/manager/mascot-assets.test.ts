import { describe, expect, it } from 'vitest'
import { managerMascotSchema } from '@open-mercato/cezar-api-client'
import { mascotAsset } from './mascot-assets'
import { MASCOT_PARTS } from './mascot-renderer'

describe('shipped mascot artwork', () => {
 it('resolves every contracted character and shared animation part through Vite', () => {
  for (const mascot of managerMascotSchema.options) {
   for (const part of ['portrait', 'standing', ...MASCOT_PARTS]) {
    const owner = ['laptop', 'typing-left', 'typing-right', 'focused'].includes(part) ? 'shared' : mascot
    expect(mascotAsset(owner, part)).toBeTruthy()
   }
  }
 })
 it('refuses a missing part instead of silently displaying the SPA shell as an image', () => {
  expect(() => mascotAsset('base', 'missing')).toThrow('Missing mascot artwork')
 })
})
