import { describe, expect, it } from 'vitest'
import { managerMascotSchema } from '@open-mercato/cezar-api-client'
import { mascotAsset } from './mascot-assets'
import { mascotPortrait } from './mascot-portraits'
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
  expect(() => mascotPortrait('missing')).toThrow('Missing mascot portrait')
 })
 it('offers every portrait at 96, 192 and 256 px so a 44 px avatar never fetches the 256 px file', () => {
  for (const mascot of managerMascotSchema.options) {
   const { src, srcSet } = mascotPortrait(mascot)
   expect(src).toContain('portrait-96')
   expect(srcSet.split(', ').map((entry) => entry.split(' ')[1])).toEqual(['96w', '192w', '256w'])
  }
 })
})
