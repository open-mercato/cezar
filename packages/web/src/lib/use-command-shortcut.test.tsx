import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  commandShortcutHint,
  isEditableTarget,
  shouldTriggerCommandShortcut,
  shouldTriggerKeyShortcut,
  useCommandShortcut,
  type CommandShortcutEvent,
} from './use-command-shortcut'

afterEach(cleanup)

/** A predicate-shaped event from plain fields — target defaults to a non-editable element. */
function keyEvent(overrides: Partial<CommandShortcutEvent> = {}): CommandShortcutEvent {
  return {
    key: 'k',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    target: document.createElement('div'),
    ...overrides,
  }
}

describe('shouldTriggerCommandShortcut — modifier matrix', () => {
  it.each([
    { name: '⌘K', event: { metaKey: true }, fires: true },
    { name: 'Ctrl+K', event: { ctrlKey: true }, fires: true },
    { name: 'both modifiers at once', event: { metaKey: true, ctrlKey: true }, fires: true },
    { name: 'bare K, no modifier', event: {}, fires: false },
    { name: '⇧⌘K — shift disqualifies', event: { metaKey: true, shiftKey: true }, fires: false },
    { name: '⌥⌘K — alt disqualifies', event: { metaKey: true, altKey: true }, fires: false },
    { name: 'Ctrl+Shift+K', event: { ctrlKey: true, shiftKey: true }, fires: false },
    { name: '⌘J — wrong key', event: { key: 'j', metaKey: true }, fires: false },
    { name: 'a held key (auto-repeat)', event: { metaKey: true, repeat: true }, fires: false },
  ] as const)('$name → $fires', ({ event, fires }) => {
    expect(shouldTriggerCommandShortcut(keyEvent(event), 'k')).toBe(fires)
  })

  it('compares the key case-insensitively (Caps Lock reports "K")', () => {
    expect(shouldTriggerCommandShortcut(keyEvent({ key: 'K', metaKey: true }), 'k')).toBe(true)
  })

  it('rejects an event with no usable key at all', () => {
    expect(
      shouldTriggerCommandShortcut(keyEvent({ key: undefined as unknown as string, metaKey: true }), 'k')
    ).toBe(false)
  })
})

describe('shouldTriggerCommandShortcut — editable-target suppression', () => {
  function editable(make: () => HTMLElement): CommandShortcutEvent {
    return keyEvent({ metaKey: true, target: make() })
  }

  it.each([
    { name: 'an <input>', make: () => document.createElement('input') },
    { name: 'a <textarea>', make: () => document.createElement('textarea') },
    { name: 'a <select>', make: () => document.createElement('select') },
    {
      name: 'a contenteditable region',
      make: () => {
        const div = document.createElement('div')
        div.setAttribute('contenteditable', 'true')
        return div
      },
    },
    {
      name: 'a child of a contenteditable region',
      make: () => {
        const region = document.createElement('div')
        region.setAttribute('contenteditable', '')
        const child = document.createElement('span')
        region.appendChild(child)
        return child
      },
    },
  ])('does not fire from $name', ({ make }) => {
    expect(shouldTriggerCommandShortcut(editable(make), 'k')).toBe(false)
  })

  it('DOES fire from the palette’s own input — the one editable exception', () => {
    const input = document.createElement('input')
    input.setAttribute('cmdk-input', '')
    expect(shouldTriggerCommandShortcut(editable(() => input), 'k')).toBe(true)
  })

  it('fires from a non-editable element and from a null target', () => {
    expect(shouldTriggerCommandShortcut(keyEvent({ metaKey: true }), 'k')).toBe(true)
    expect(shouldTriggerCommandShortcut(keyEvent({ metaKey: true, target: null }), 'k')).toBe(true)
  })
})

describe('shouldTriggerKeyShortcut — bare key, no modifiers', () => {
  it('fires on the lone key', () => {
    expect(shouldTriggerKeyShortcut(keyEvent({ key: 'c' }), 'c')).toBe(true)
  })

  it.each([
    { name: 'meta', event: { metaKey: true } },
    { name: 'ctrl', event: { ctrlKey: true } },
    { name: 'alt', event: { altKey: true } },
    { name: 'shift', event: { shiftKey: true } },
    { name: 'repeat', event: { repeat: true } },
  ])('any modifier or repeat disqualifies ($name)', ({ event }) => {
    expect(shouldTriggerKeyShortcut(keyEvent({ key: 'c', ...event }), 'c')).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(shouldTriggerKeyShortcut(keyEvent({ key: 'C' }), 'c')).toBe(true)
  })

  it('any editable target swallows it — INCLUDING the palette input', () => {
    const input = document.createElement('input')
    input.setAttribute('cmdk-input', '')
    expect(shouldTriggerKeyShortcut(keyEvent({ key: 'c', target: input }), 'c')).toBe(false)
    expect(shouldTriggerKeyShortcut(keyEvent({ key: 'c', target: document.createElement('textarea') }), 'c')).toBe(false)
  })
})

describe('isEditableTarget', () => {
  it('is false for a button and for null', () => {
    expect(isEditableTarget(document.createElement('button'))).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
  })
})

function Probe({ onFire }: { onFire: () => void }) {
  useCommandShortcut('k', onFire)
  return <input data-testid="field" />
}

describe('useCommandShortcut', () => {
  it('fires once per chord and prevents the browser default', () => {
    const onFire = vi.fn()
    render(<Probe onFire={onFire} />)

    const event = new KeyboardEvent('keydown', { key: 'k', metaKey: true, cancelable: true, bubbles: true })
    window.dispatchEvent(event)

    expect(onFire).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('does not double-fire on auto-repeat while the key is held', () => {
    const onFire = vi.fn()
    render(<Probe onFire={onFire} />)

    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    fireEvent.keyDown(window, { key: 'k', metaKey: true, repeat: true })
    fireEvent.keyDown(window, { key: 'k', metaKey: true, repeat: true })

    expect(onFire).toHaveBeenCalledTimes(1)
  })

  it('stays quiet while the user types the letter in an input', () => {
    const onFire = vi.fn()
    const { getByTestId } = render(<Probe onFire={onFire} />)

    // Bubbles up to the window listener with the input as target — the realistic path.
    fireEvent.keyDown(getByTestId('field'), { key: 'k', metaKey: true })

    expect(onFire).not.toHaveBeenCalled()
  })

  it('unsubscribes on unmount', () => {
    const onFire = vi.fn()
    const { unmount } = render(<Probe onFire={onFire} />)
    unmount()

    fireEvent.keyDown(window, { key: 'k', metaKey: true })

    expect(onFire).not.toHaveBeenCalled()
  })
})

/* The chord is both bindings at once; only its printed label is platform-specific, and the
 * spec's rule is that a kbd hint renders the platform's own symbol. The sidebar's search bar
 * is the first caller (#702) — it used to hardcode ⌘K, which is simply wrong on a PC. */
describe('commandShortcutHint — the platform symbol a kbd hint prints', () => {
  it.each([
    { platform: 'MacIntel', hint: '⌘K' },
    { platform: 'iPhone', hint: '⌘K' },
    { platform: 'iPad', hint: '⌘K' },
    { platform: 'Win32', hint: 'Ctrl+K' },
    { platform: 'Linux x86_64', hint: 'Ctrl+K' },
    // Chrome froze navigator.platform behind an empty string on some clients — the safe
    // default is the one every keyboard has.
    { platform: '', hint: 'Ctrl+K' },
  ])('renders $hint on $platform', ({ platform, hint }) => {
    expect(commandShortcutHint('k', platform)).toBe(hint)
  })

  it('upper-cases the key so callers can pass the same lowercase letter the binding uses', () => {
    expect(commandShortcutHint('n', 'MacIntel')).toBe('⌘N')
    expect(commandShortcutHint('N', 'Win32')).toBe('Ctrl+N')
  })
})
