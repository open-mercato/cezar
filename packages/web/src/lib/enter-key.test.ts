import { describe, expect, it } from 'vitest'

import { composerEnterSends, enterInsertsNewline, TOUCH_PRIMARY_QUERY } from './enter-key'

const media = (touchPrimary: boolean) => ({
  matchMedia: (query: string) => ({ matches: query === TOUCH_PRIMARY_QUERY && touchPrimary }) as MediaQueryList,
})

const enter = { key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false }

describe('enterInsertsNewline', () => {
  it('is on for a touch-first device and off for a mouse-first one (a touch laptop included)', () => {
    expect(enterInsertsNewline(media(true))).toBe(true)
    expect(enterInsertsNewline(media(false))).toBe(false)
  })

  it('is off without matchMedia', () => {
    expect(enterInsertsNewline(undefined)).toBe(false)
    expect(enterInsertsNewline({} as Pick<Window, 'matchMedia'>)).toBe(false)
  })
})

describe('composerEnterSends', () => {
  it.each([
    ['desktop Enter', enter, false, true],
    ['desktop Shift+Enter', { ...enter, shiftKey: true }, false, false],
    ['desktop ⌘↵', { ...enter, metaKey: true }, false, true],
    ['phone Enter', enter, true, false],
    ['phone Shift+Enter', { ...enter, shiftKey: true }, true, false],
    ['phone hardware ⌘↵', { ...enter, metaKey: true }, true, true],
    ['phone hardware Ctrl+↵', { ...enter, ctrlKey: true }, true, true],
    ['IME composition', { ...enter, isComposing: true }, false, false],
    ['Safari IME commit (keyCode 229)', { ...enter, keyCode: 229 }, false, false],
    ['a held Enter', { ...enter, repeat: true }, false, false],
    ['another key', { ...enter, key: 'a' }, false, false],
  ])('%s', (_, event, phone, sends) => {
    expect(composerEnterSends(event, phone)).toBe(sends)
  })
})
