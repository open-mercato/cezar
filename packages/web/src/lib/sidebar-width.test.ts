import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  SIDEBAR_WIDTH_STORAGE_KEY,
  clampSidebarWidth,
  readStoredSidebarWidth,
  writeStoredSidebarWidth,
} from './sidebar-width'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('clampSidebarWidth', () => {
  it.each([
    // In range — rounded to whole pixels, because a drag produces fractions.
    [264, 264],
    [300, 300],
    [420, 420],
    [317.4, 317],
    [317.5, 318],
    // Out of range, both ends.
    [0, MIN_SIDEBAR_WIDTH],
    [-4000, MIN_SIDEBAR_WIDTH],
    [263, MIN_SIDEBAR_WIDTH],
    [421, MAX_SIDEBAR_WIDTH],
    [99_999, MAX_SIDEBAR_WIDTH],
  ])('%s → %s', (raw, expected) => {
    expect(clampSidebarWidth(raw)).toBe(expected)
  })

  it('parses the strings localStorage actually returns', () => {
    expect(clampSidebarWidth('300')).toBe(300)
    expect(clampSidebarWidth('300.6')).toBe(301)
    expect(clampSidebarWidth('9000')).toBe(MAX_SIDEBAR_WIDTH)
  })

  it('answers the default — not a bound — for anything it cannot read as a number', () => {
    // "unparseable" is a different claim from "too small", and clamping junk up to the minimum
    // would quietly turn a corrupt key into a deliberate-looking choice.
    for (const junk of [NaN, Infinity, -Infinity, 'wide', '', null, undefined, {}, []]) {
      expect(clampSidebarWidth(junk)).toBe(DEFAULT_SIDEBAR_WIDTH)
    }
  })
})

describe('readStoredSidebarWidth / writeStoredSidebarWidth', () => {
  it('round-trips a width through the documented key', () => {
    writeStoredSidebarWidth(340)
    expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe('340')
    expect(readStoredSidebarWidth()).toBe(340)
  })

  it('clamps on write, so a bad value never reaches storage', () => {
    writeStoredSidebarWidth(10_000)
    expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe(String(MAX_SIDEBAR_WIDTH))
  })

  it('clamps on read too, so a hand-edited or stale key cannot paint an unusable column', () => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, '12')
    expect(readStoredSidebarWidth()).toBe(MIN_SIDEBAR_WIDTH)
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, 'not a number')
    expect(readStoredSidebarWidth()).toBe(DEFAULT_SIDEBAR_WIDTH)
  })

  it('defaults when nothing has been stored', () => {
    expect(readStoredSidebarWidth()).toBe(DEFAULT_SIDEBAR_WIDTH)
  })

  it('degrades to the default when storage throws — private mode is not a crash', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(readStoredSidebarWidth()).toBe(DEFAULT_SIDEBAR_WIDTH)

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() => writeStoredSidebarWidth(300)).not.toThrow()
  })
})
