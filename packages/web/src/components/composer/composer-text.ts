/**
 * The caret math behind the composer's `/` and `@` autocomplete (#380) — pure string
 * functions, because "does typing here open the menu" and "where does the completion land"
 * are exactly the kind of rules that must be table-tested rather than divined from a popover
 * in jsdom. The component only ever calls these with `textarea.value` and `selectionStart`.
 */

export type TriggerChar = '/' | '@'

export interface TriggerState {
  trigger: TriggerChar
  /** Index of the trigger character itself in the text. */
  start: number
  /** What the user typed after the trigger, up to the caret — the filter query. */
  query: string
}

const TRIGGERS: ReadonlySet<string> = new Set<TriggerChar>(['/', '@'])

/**
 * Is the caret inside an open `/skill` or `@file` token?
 *
 * The token starts at the nearest trigger char at a WORD BOUNDARY (start of text, or after
 * whitespace/newline) scanning left from the caret, and must contain no whitespace — a space
 * commits the token and closes the menu. Mid-word triggers stay inert: `https://` and
 * `user@host` never open a menu, because their trigger char follows a non-space character.
 */
export function detectTrigger(text: string, caret: number): TriggerState | null {
  for (let i = caret - 1; i >= 0; i -= 1) {
    const char = text[i]!
    if (/\s/.test(char)) return null
    if (TRIGGERS.has(char)) {
      if (i > 0 && !/\s/.test(text[i - 1]!)) return null // mid-word: URL, e-mail, path…
      return { trigger: char as TriggerChar, start: i, query: text.slice(i + 1, caret) }
    }
  }
  return null
}

/**
 * Replace the open token (trigger..caret) with the chosen completion plus one trailing space,
 * leaving everything after the caret untouched. Answers the new text AND where the caret
 * belongs, so the component can restore it — inserting into the middle of a draft must not
 * fling the caret to the end.
 */
export function applyCompletion(
  text: string,
  state: TriggerState,
  caret: number,
  completion: string,
): { text: string; caret: number } {
  const inserted = `${state.trigger}${completion} `
  return {
    text: text.slice(0, state.start) + inserted + text.slice(caret),
    caret: state.start + inserted.length,
  }
}
