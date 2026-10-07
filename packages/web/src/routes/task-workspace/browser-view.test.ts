import { describe, expect, it } from 'vitest'

import { isLoopback, normalizeAddress, tabLabel } from './browser-view'

describe('normalizeAddress', () => {
  it('assumes http for what a user actually types', () => {
    expect(normalizeAddress('localhost:3000')).toBe('http://localhost:3000/')
  })

  it('leaves an explicit scheme alone', () => {
    expect(normalizeAddress('https://example.com/path')).toBe('https://example.com/path')
  })

  it('refuses a scheme that would be script injection or a disk read', () => {
    // A `javascript:` or `data:` document in a frame the cockpit renders is script injection
    // with extra steps; `file:` would read the host's disk.
    for (const raw of ['javascript:void 0', 'data:text/html,<h1>x', 'file:///etc/passwd']) {
      expect(normalizeAddress(raw)).toBeNull()
    }
  })

  it('has nothing to load for an empty or unparseable address', () => {
    expect(normalizeAddress('   ')).toBeNull()
    expect(normalizeAddress('http://')).toBeNull()
  })
})

describe('tabLabel', () => {
  it('names a blank tab', () => {
    expect(tabLabel('')).toBe('Nowa karta')
  })

  it('uses host and port, which is what distinguishes one dev server from another', () => {
    expect(tabLabel('http://localhost:3000/')).toBe('localhost:3000')
  })

  it('keeps a real path', () => {
    expect(tabLabel('http://localhost:3000/admin/users')).toBe('localhost:3000/admin/users')
  })

  it('falls back to the raw string rather than throwing', () => {
    expect(tabLabel('not a url')).toBe('not a url')
  })
})

describe('isLoopback', () => {
  it('recognises the addresses that mean "the machine cezar runs on"', () => {
    for (const url of ['http://localhost:3000', 'http://127.0.0.1:8080', 'http://0.0.0.0:5000', 'http://mac.local:1234']) {
      expect(isLoopback(url)).toBe(true)
    }
  })

  it('leaves a real site alone', () => {
    expect(isLoopback('https://github.com/open-mercato/cezar')).toBe(false)
  })

  it('is false for nonsense rather than throwing', () => {
    expect(isLoopback('nope')).toBe(false)
  })
})
