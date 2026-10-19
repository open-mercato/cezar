/**
 * Keyboard shortcuts for task-palette commands (spec 2026-10-17-task-palette): the chord grammar,
 * the shipped defaults, and how the user's overrides combine with them. Pure — the hook that
 * stores overrides is `use-keybindings.ts`, the dispatcher lives in the task palette.
 *
 * A chord is one key plus modifiers, canonical order `Mod+Ctrl+Alt+Shift+Key`. `Mod` is ⌘ on
 * Apple hardware and Ctrl elsewhere; `Ctrl` is only ever spelled on Apple, where it is a
 * different key from `Mod`. Stored as that string, so a binding means the same on every machine.
 */

export type Overrides = Readonly<Record<string, string | null>>

export function isApplePlatform(
  platform: string = typeof navigator === 'undefined' ? '' : navigator.platform,
): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform)
}

/** `event.code` → the key's name in a chord. By code, not `event.key`: ⌥P types `π` on a Mac. */
const CODE_KEYS: Record<string, string> = {
  Slash: '/',
  Backslash: '\\',
  Period: '.',
  Comma: ',',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  Enter: 'Enter',
  Space: 'Space',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Tab: 'Tab',
  Escape: 'Escape',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
}

function keyName(event: Pick<KeyboardEvent, 'code' | 'key'>): string | null {
  const code = event.code ?? ''
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6)
  if (/^F([1-9]|1[0-2])$/.test(code)) return code
  if (code in CODE_KEYS) return CODE_KEYS[code]!
  // No usable code (synthetic events, odd layouts): a single printable key still names itself.
  const key = event.key ?? ''
  if (key.length === 1 && key !== ' ') return key.toUpperCase()
  return null
}

export type ChordEvent = Pick<KeyboardEvent, 'code' | 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'> &
  Partial<Pick<KeyboardEvent, 'getModifierState'>>

/** The chord a keydown spells, or null for a lone modifier or a key chords cannot name. */
export function chordFromEvent(event: ChordEvent, apple = isApplePlatform()): string | null {
  if (['Meta', 'Control', 'Alt', 'Shift', 'OS', 'AltGraph'].includes(event.key)) return null
  // Windows reports AltGr as Ctrl+Alt: that is a layout typing `@` or `€`, not a chord. Firefox on a
  // Mac reports AltGraph for every ⌥, where ⌥ chords are real.
  if (!apple && event.getModifierState?.('AltGraph')) return null
  const key = keyName(event)
  if (!key) return null
  const parts: string[] = []
  if (apple ? event.metaKey : event.ctrlKey) parts.push('Mod')
  if (apple && event.ctrlKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  parts.push(key)
  return parts.join('+')
}

/** The chord as the platform prints it: `⌘⇧P` on a Mac, `Ctrl+Shift+P` elsewhere. */
export function formatChord(chord: string, apple = isApplePlatform()): string {
  const parts = chord.split('+')
  // `Mod++` would split into ['Mod', '', ''] — no chord here ends in '+', but stay total.
  const key = parts.at(-1) || '+'
  const modifiers = parts.slice(0, -1)
  if (apple) {
    const symbols: Record<string, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Mod: '⌘' }
    // macOS's own order: ⌃⌥⇧⌘.
    const order = ['Ctrl', 'Alt', 'Shift', 'Mod']
    return order.filter((m) => modifiers.includes(m)).map((m) => symbols[m]).join('') + key
  }
  const names: Record<string, string> = { Mod: 'Ctrl', Alt: 'Alt', Shift: 'Shift' }
  return [...modifiers.map((m) => names[m] ?? m), key].join('+')
}

/**
 * Is something on screen that owns the keyboard — a palette, a dialog, a menu? Then task shortcuts
 * do not fire, and the tab badges that advertise them must not show either: one predicate, so the
 * hint never promises a key that would do nothing.
 */
export function shortcutsBlocked(root: ParentNode = document): boolean {
  return root.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]') !== null
}

/** The badge for a tab: just the digit for the plain ⌘N it ships with, the full chord otherwise. */
export function tabHint(chord: string | undefined, apple = isApplePlatform()): string | undefined {
  if (!chord) return undefined
  const plain = /^Mod\+([1-9])$/.exec(chord)
  return plain ? plain[1] : formatChord(chord, apple)
}

/** Taken by the browser, the OS or the cockpit itself — never offered for a command. */
const RESERVED = new Set([
  'Mod+K', // ⌘K palette
  'Mod+P', // ⌘P palette
  'Mod+N', // new task (desktop shell)
  'Mod+Enter', // submit, everywhere
  'Mod+Shift+`', // new terminal tab
  'Mod+A',
  'Mod+C',
  'Mod+V',
  'Mod+X',
  'Mod+Z',
  'Mod+Shift+Z',
  'Mod+F',
  'Mod+L',
  'Mod+R',
  'Mod+T',
  'Mod+W',
  'Mod+Q',
  'Mod+Shift+T',
  'Mod+Shift+N',
  'Mod+Shift+W',
])

/** Why a keydown `chordFromEvent` dropped as AltGr cannot be bound — the recorder's message for it. */
export function altGrProblem(event: ChordEvent, apple = isApplePlatform()): string | undefined {
  if (apple || ['Control', 'Alt', 'AltGraph'].includes(event.key)) return undefined
  if (!(event.getModifierState?.('AltGraph') || (event.ctrlKey && event.altKey))) return undefined
  return 'Ctrl+Alt — types characters on many layouts'
}

/** Why `chord` cannot be bound, or undefined when it can. */
export function chordProblem(chord: string, apple = isApplePlatform()): string | undefined {
  const modifiers = chord.split('+').slice(0, -1)
  // A bare key or Shift+key is typing; the workspace's own bare keys are not rebindable here.
  if (!modifiers.some((m) => m === 'Mod' || m === 'Ctrl' || m === 'Alt')) {
    return 'Use ⌘/Ctrl, ⌃ or ⌥ with the key'
  }
  // Off a Mac, Ctrl+Alt is AltGr on many layouts — the chord would eat a typed character.
  if (!apple && modifiers.includes('Mod') && modifiers.includes('Alt')) return 'Ctrl+Alt types characters on many layouts'
  if (RESERVED.has(chord)) return 'That shortcut is taken by the browser or cezar'
  return undefined
}

/** The shortcuts cezar ships. ⌘1–⌘9 go to the task's tabs, like a browser's. */
export const DEFAULT_KEYBINDINGS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`tab:${index + 1}`, `Mod+${index + 1}`])),
  'terminal-column': 'Mod+/',
}

const MAX_STORED_BINDINGS = 200

/**
 * The stored overrides, reduced to what the ui-state PUT accepts (`setWorkspaceUiStateInputSchema`):
 * a hand-edited `~/.cezar/ui-state.json` must neither crash `formatChord` nor 400 every later write.
 */
export function sanitizeOverrides(stored: unknown): Overrides {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {}
  const result: Record<string, string | null> = {}
  for (const [id, chord] of Object.entries(stored)) {
    if (Object.keys(result).length >= MAX_STORED_BINDINGS) break
    if (id.length < 1 || id.length > 120) continue
    if (chord === null || (typeof chord === 'string' && chord.length >= 1 && chord.length <= 40)) result[id] = chord
  }
  return result
}

/** command id → chord, after the user's overrides. */
export function effectiveBindings(overrides: Overrides = {}): Map<string, string> {
  const result = new Map<string, string>()
  for (const [id, chord] of Object.entries(DEFAULT_KEYBINDINGS)) {
    if (!(id in overrides)) result.set(id, chord)
  }
  for (const [id, chord] of Object.entries(overrides)) {
    if (chord) result.set(id, chord)
  }
  // An override wins its chord: a default still holding it is shadowed, never doubly bound.
  const owner = new Map<string, string>()
  for (const [id, chord] of result) {
    const previous = owner.get(chord)
    if (previous === undefined || (id in overrides && !(previous in overrides))) owner.set(chord, id)
  }
  return new Map([...result].filter(([id, chord]) => owner.get(chord) === id))
}

/** chord → command id — what the dispatcher reads. */
export function bindingsByChord(overrides: Overrides = {}): Map<string, string> {
  return new Map([...effectiveBindings(overrides)].map(([id, chord]) => [chord, id]))
}

/** The overrides after binding `chord` to `id` (or unbinding it, `null`): whichever command held
 *  the chord gives it up, so one chord always runs one command. */
export function assignBinding(overrides: Overrides, id: string, chord: string | null): Record<string, string | null> {
  const next: Record<string, string | null> = { ...overrides }
  if (chord) {
    for (const [other, held] of effectiveBindings(overrides)) {
      if (other !== id && held === chord) {
        if (DEFAULT_KEYBINDINGS[other]) next[other] = null
        else delete next[other]
      }
    }
  }
  if (chord === (DEFAULT_KEYBINDINGS[id] ?? null)) delete next[id]
  else next[id] = chord
  return next
}

/** Back to the shipped default for `id` — taken back from whichever command holds it now. */
export function resetBinding(overrides: Overrides, id: string): Record<string, string | null> {
  return assignBinding(overrides, id, DEFAULT_KEYBINDINGS[id] ?? null)
}

/** Every command a shortcut can run, for Settings → Keyboard. Ids are `buildTaskCommands`'. */
export const BINDABLE_COMMANDS: readonly { id: string; label: string; group: string }[] = [
  { id: 'reply', label: 'Write to the agent', group: 'Actions' },
  { id: 'toggle-read', label: 'Mark read / unread', group: 'Actions' },
  { id: 'pin', label: 'Pin / Unpin', group: 'Actions' },
  { id: 'archive', label: 'Archive / Unarchive', group: 'Actions' },
  { id: 'rename', label: 'Rename', group: 'Actions' },
  { id: 'end-session', label: 'End session', group: 'Actions' },
  { id: 'accept', label: 'Accept changes without a PR', group: 'Actions' },
  { id: 'stop', label: 'Stop', group: 'Actions' },
  { id: 'delete', label: 'Delete', group: 'Actions' },
  { id: 'git:commit', label: 'Commit', group: 'Git' },
  { id: 'git:commit-push', label: 'Commit and push', group: 'Git' },
  { id: 'git:push', label: 'Push', group: 'Git' },
  { id: 'git:create-pr', label: 'Create PR', group: 'Git' },
  { id: 'git:create-draft-pr', label: 'Create draft PR', group: 'Git' },
  { id: 'git:update-branch', label: 'Update branch', group: 'Git' },
  { id: 'git:resolve-conflicts', label: 'Resolve conflicts', group: 'Git' },
  { id: 'git:fix-checks', label: 'Fix errors', group: 'Git' },
  { id: 'open-pr', label: 'Open pull request', group: 'Git' },
  ...Array.from({ length: 9 }, (_, index) => ({ id: `tab:${index + 1}`, label: `Tab ${index + 1}`, group: 'Go to view' })),
  { id: 'view:session', label: 'Chat', group: 'Go to view' },
  { id: 'view:changes', label: 'Changes', group: 'Go to view' },
  { id: 'view:commits', label: 'Commits', group: 'Go to view' },
  { id: 'view:files', label: 'Files', group: 'Go to view' },
  { id: 'view:graph', label: 'Graph', group: 'Go to view' },
  { id: 'view:notes', label: 'Notes', group: 'Go to view' },
  { id: 'view:browser', label: 'Preview', group: 'Go to view' },
  { id: 'view:terminal', label: 'Terminal', group: 'Go to view' },
  { id: 'full-view', label: 'Full view', group: 'Layout' },
  { id: 'split', label: 'Split view', group: 'Layout' },
  { id: 'terminal', label: 'Show / hide terminal', group: 'Layout' },
  { id: 'terminal-column', label: 'Terminal in a column', group: 'Layout' },
  { id: 'open:terminal-resume', label: 'Terminal (resume session)', group: 'Open in' },
  { id: 'copy:link', label: 'Copy task link', group: 'Copy' },
  { id: 'copy:branch', label: 'Copy branch name', group: 'Copy' },
  { id: 'copy:path', label: 'Copy worktree path', group: 'Copy' },
  { id: 'copy:resume', label: 'Copy resume command', group: 'Copy' },
  { id: 'copy:pr', label: 'Copy pull request link', group: 'Copy' },
  { id: 'copy:id', label: 'Copy task id', group: 'Copy' },
]
