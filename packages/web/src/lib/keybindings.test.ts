import { describe, expect, it } from 'vitest'

import {
  altGrProblem,
  assignBinding,
  bindingsByChord,
  chordFromEvent,
  chordProblem,
  effectiveBindings,
  formatChord,
  tabHint,
  resetBinding,
  sanitizeOverrides,
  type ChordEvent,
} from './keybindings'

const key = (code: string, key: string, mods: Partial<ChordEvent> = {}): ChordEvent => ({
  code,
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
})

describe('chords', () => {
  it('spells ⌘ as Mod on a Mac and Ctrl as Mod elsewhere', () => {
    expect(chordFromEvent(key('Slash', '/', { metaKey: true }), true)).toBe('Mod+/')
    expect(chordFromEvent(key('Slash', '/', { ctrlKey: true }), false)).toBe('Mod+/')
    // On a Mac, ⌃ is its own modifier.
    expect(chordFromEvent(key('KeyT', 't', { ctrlKey: true }), true)).toBe('Ctrl+T')
  })

  it('names keys by code, so ⌥P is P and not π', () => {
    expect(chordFromEvent(key('KeyP', 'π', { altKey: true, metaKey: true }), true)).toBe('Mod+Alt+P')
    expect(chordFromEvent(key('Digit1', '!', { metaKey: true, shiftKey: true }), true)).toBe('Mod+Shift+1')
  })

  it('AltGr is typing, not a chord', () => {
    const altGr = key('KeyQ', '@', { ctrlKey: true, altKey: true, getModifierState: (k: string) => k === 'AltGraph' })
    expect(chordFromEvent(altGr, false)).toBeNull()
    // Firefox on a Mac says AltGraph for any ⌥ — an ⌥ chord there still records.
    const option = key('KeyP', 'π', { altKey: true, getModifierState: (k: string) => k === 'AltGraph' })
    expect(chordFromEvent(option, true)).toBe('Alt+P')
    expect(altGrProblem(altGr, false)).toMatch(/Ctrl\+Alt/)
    expect(altGrProblem(option, true)).toBeUndefined()
    expect(chordFromEvent(key('AltRight', 'AltGraph', { ctrlKey: true, altKey: true }), false)).toBeNull()
    expect(chordFromEvent(key('KeyQ', 'q', { ctrlKey: true, altKey: true, getModifierState: () => false }), false)).toBe('Mod+Alt+Q')
  })

  it('ignores a lone modifier', () => {
    expect(chordFromEvent(key('MetaLeft', 'Meta', { metaKey: true }), true)).toBeNull()
  })

  it('a tab badge is the bare digit for ⌘N, the full chord otherwise', () => {
    expect(tabHint('Mod+3', true)).toBe('3')
    expect(tabHint('Mod+Alt+3', true)).toBe('⌥⌘3')
    expect(tabHint(undefined)).toBeUndefined()
  })

  it('prints the platform spelling', () => {
    expect(formatChord('Mod+Shift+P', true)).toBe('⇧⌘P')
    expect(formatChord('Mod+Shift+P', false)).toBe('Ctrl+Shift+P')
    expect(formatChord('Mod+/', true)).toBe('⌘/')
  })

  it('refuses typing keys and chords the browser or cezar owns', () => {
    expect(chordProblem('P')).toBeDefined()
    expect(chordProblem('Shift+P')).toBeDefined()
    expect(chordProblem('Mod+K')).toBeDefined()
    expect(chordProblem('Mod+W')).toBeDefined()
    // The Preview's Design Mode key (spec 2026-10-09-design-mode §7a).
    expect(chordProblem('Alt+D')).toBeDefined()
    expect(chordProblem('Mod+Shift+P')).toBeUndefined()
    expect(chordProblem('Alt+P')).toBeUndefined()
  })

  it('refuses Ctrl+Alt off a Mac, where it is AltGr', () => {
    expect(chordProblem('Mod+Alt+P', false)).toBeDefined()
    expect(chordProblem('Mod+Alt+P', true)).toBeUndefined()
  })
})

describe('bindings', () => {
  it('ships ⌘1–⌘9 for the tabs and ⌘/ for the terminal column', () => {
    const bindings = effectiveBindings()
    expect(bindings.get('tab:1')).toBe('Mod+1')
    expect(bindings.get('tab:9')).toBe('Mod+9')
    expect(bindings.get('terminal-column')).toBe('Mod+/')
  })

  it('an override replaces a default; null unbinds it', () => {
    expect(effectiveBindings({ 'terminal-column': 'Mod+J' }).get('terminal-column')).toBe('Mod+J')
    expect(effectiveBindings({ 'tab:1': null }).has('tab:1')).toBe(false)
  })

  it('assigning a held chord takes it from its owner, default or not', () => {
    let overrides = assignBinding({}, 'pin', 'Mod+/')
    expect(bindingsByChord(overrides).get('Mod+/')).toBe('pin')
    expect(effectiveBindings(overrides).has('terminal-column')).toBe(false)
    overrides = assignBinding(overrides, 'archive', 'Mod+/')
    expect(effectiveBindings(overrides).get('archive')).toBe('Mod+/')
    expect(effectiveBindings(overrides).has('pin')).toBe(false)
  })

  it('re-assigning a default stores nothing, and reset returns to it', () => {
    expect(assignBinding({}, 'tab:1', 'Mod+1')).toEqual({})
    const moved = assignBinding({}, 'tab:1', 'Mod+Alt+1')
    expect(resetBinding(moved, 'tab:1')).toEqual({})
  })

  it('reset takes the default chord back from whichever command holds it', () => {
    const moved = assignBinding({}, 'pin', 'Mod+/')
    const reset = resetBinding(moved, 'terminal-column')
    expect(effectiveBindings(reset).get('terminal-column')).toBe('Mod+/')
    expect(effectiveBindings(reset).has('pin')).toBe(false)
    expect(reset).toEqual({})
    // No default: reset just drops the override.
    expect(resetBinding({ pin: 'Mod+J' }, 'pin')).toEqual({})
  })

  it('stored overrides keep only what the ui-state PUT accepts', () => {
    expect(sanitizeOverrides(undefined)).toEqual({})
    expect(sanitizeOverrides('Mod+J')).toEqual({})
    expect(sanitizeOverrides(['Mod+J'])).toEqual({})
    expect(
      sanitizeOverrides({ pin: 'Mod+J', 'tab:1': null, archive: 5, rename: '', stop: 'x'.repeat(41), ['x'.repeat(121)]: 'Mod+L' }),
    ).toEqual({ pin: 'Mod+J', 'tab:1': null })
    const many = Object.fromEntries(Array.from({ length: 250 }, (_, index) => [`id:${index}`, null]))
    expect(Object.keys(sanitizeOverrides(many))).toHaveLength(200)
    // A malformed value never reaches formatChord.
    expect(() => [...effectiveBindings(sanitizeOverrides({ pin: 5 })).values()].map((chord) => formatChord(chord))).not.toThrow()
  })

  it('a stale map that double-books a chord still runs one command — the override wins', () => {
    const byChord = bindingsByChord({ pin: 'Mod+/' })
    expect(byChord.get('Mod+/')).toBe('pin')
  })
})
