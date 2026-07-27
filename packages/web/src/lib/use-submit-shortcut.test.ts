import { describe, expect, it } from 'vitest'

import { isSubmitShortcut, submitShortcutHint, type SubmitShortcutEvent } from './use-submit-shortcut'

const event = (overrides: Partial<SubmitShortcutEvent> = {}): SubmitShortcutEvent => ({
  key: 'Enter',
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...overrides,
})

describe('isSubmitShortcut — the spec matrix (Enter / Shift+Enter / ⌘↵ / Ctrl+↵)', () => {
  const table: Array<{ name: string; input: SubmitShortcutEvent; sends: boolean }> = [
    { name: 'plain Enter sends', input: event(), sends: true },
    { name: '⌘↵ sends (macOS)', input: event({ metaKey: true }), sends: true },
    { name: 'Ctrl+↵ sends (Windows/Linux)', input: event({ ctrlKey: true }), sends: true },
    { name: '⌘ and Ctrl together still send', input: event({ metaKey: true, ctrlKey: true }), sends: true },
    { name: 'Shift+Enter is the newline, never a send', input: event({ shiftKey: true }), sends: false },
    { name: 'Shift wins even over ⌘', input: event({ shiftKey: true, metaKey: true }), sends: false },
    { name: 'Alt+Enter is left alone', input: event({ altKey: true }), sends: false },
    { name: 'a held key must not machine-gun sends', input: event({ repeat: true }), sends: false },
    { name: 'Enter mid-IME-composition commits the IME, not the message', input: event({ isComposing: true }), sends: false },
    { name: 'any other key is not a send', input: event({ key: 'a' }), sends: false },
    { name: '⌘+non-Enter is not a send', input: event({ key: 'k', metaKey: true }), sends: false },
  ]

  for (const { name, input, sends } of table) {
    it(name, () => {
      expect(isSubmitShortcut(input)).toBe(sends)
    })
  }
})

describe('submitShortcutHint — the platform’s own symbols', () => {
  it.each([
    ['MacIntel', '⌘↵'],
    ['iPhone', '⌘↵'],
    ['iPad', '⌘↵'],
    ['Win32', 'Ctrl+↵'],
    ['Linux x86_64', 'Ctrl+↵'],
    ['', 'Ctrl+↵'],
  ])('%s → %s', (platform, hint) => {
    expect(submitShortcutHint(platform)).toBe(hint)
  })
})
