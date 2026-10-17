import { describe, expect, it } from 'vitest'

import {
  assignBinding,
  bindingsByChord,
  chordFromEvent,
  chordProblem,
  effectiveBindings,
  formatChord,
  tabHint,
  resetBinding,
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
    expect(chordProblem('Mod+Shift+P')).toBeUndefined()
    expect(chordProblem('Alt+P')).toBeUndefined()
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

  it('a stale map that double-books a chord still runs one command — the override wins', () => {
    const byChord = bindingsByChord({ pin: 'Mod+/' })
    expect(byChord.get('Mod+/')).toBe('pin')
  })
})
