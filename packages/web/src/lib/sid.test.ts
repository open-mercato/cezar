import { afterEach, describe, expect, it } from 'vitest'

import { sid, uuidv7 } from './sid'

describe('sid', () => {
  afterEach(() => localStorage.clear())

  it('is a v7 uuid, created once and kept under cezar:sid', () => {
    const first = sid()
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(sid()).toBe(first)
    expect(localStorage.getItem('cezar:sid')).toBe(first)
  })

  it('encodes its creation time', () => {
    const id = uuidv7(Date.UTC(2026, 9, 7))
    expect(parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(Date.UTC(2026, 9, 7))
  })
})
