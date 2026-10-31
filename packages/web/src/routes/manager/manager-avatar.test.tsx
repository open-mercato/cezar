import { describe, expect, it } from 'vitest'

import { avatarParts } from './manager-avatar'

describe('avatarParts', () => {
  it('gives each of the 64 values its own look', () => {
    const looks = new Set(Array.from({ length: 64 }, (_, i) => {
      const { shape, hue } = avatarParts(i)
      return `${shape}|${hue}`
    }))
    expect(looks.size).toBe(64)
  })

  it('tolerates a value off the contract instead of painting nothing', () => {
    expect(avatarParts(99).shape).toBeTruthy()
    expect(avatarParts(-3).shape).toBeTruthy()
  })
})
