/**
 * A linear port of remend's `links` handler (remend 1.3, `protocol` mode) — the step Streamdown
 * runs on the WHOLE reply on every streaming delta to close a half-typed `[text](url`.
 *
 * remend's version re-scans the text from the start for every `[` (is it inside code?) and
 * again forward for its `]`, so its cost grows with links × length: on an 18k-char reply it was
 * most of a delta's parse time. Here both answers come from one pass each. Only the growing
 * reply uses this (see `Markdown`); the settled render keeps remend's own handler.
 */

const INCOMPLETE_LINK = '](streamdown:incomplete-link)'

/** `inCode[pos]` is remend's `isInsideCode(text, pos)`: inside a fence or an open backtick span
 *  counting only what starts before `pos`. One forward pass instead of one per position. */
function codeStateTable(text: string): Uint8Array {
  const table = new Uint8Array(text.length + 1)
  let span = false
  let fence = false
  let filled = 0
  let s = 0
  while (s < text.length) {
    // Every position up to and including this step's start sees the state before the step.
    const state = span || fence ? 1 : 0
    for (; filled <= s; filled += 1) table[filled] = state
    if (text[s] === '\\' && s + 1 < text.length && text[s + 1] === '`') {
      s += 2
    } else if (text.startsWith('```', s)) {
      fence = !fence
      s += 3
    } else {
      if (!fence && text[s] === '`') span = !span
      s += 1
    }
  }
  const state = span || fence ? 1 : 0
  for (; filled <= text.length; filled += 1) table[filled] = state
  return table
}

/** For every `[`, the index of the `]` that closes it (raw nesting, like remend), else -1. */
function closingBrackets(text: string): Int32Array {
  const close = new Int32Array(text.length).fill(-1)
  const open: number[] = []
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '[') open.push(i)
    else if (text[i] === ']' && open.length > 0) close[open.pop()!] = i
  }
  return close
}

/** The `[` a `]` at `end` closes, scanning back (remend's `findMatchingOpenBracket`). */
function openingBracket(text: string, end: number): number {
  let depth = 1
  for (let i = end - 1; i >= 0; i -= 1) {
    if (text[i] === ']') depth += 1
    else if (text[i] === '[' && --depth === 0) return i
  }
  return -1
}

export function completeIncompleteLink(text: string): string {
  const inCode = codeStateTable(text)

  // `[text](partial-url` — the URL is still arriving.
  const urlStart = text.lastIndexOf('](')
  if (urlStart !== -1 && !inCode[urlStart] && text.indexOf(')', urlStart + 2) === -1) {
    const open = openingBracket(text, urlStart)
    if (open !== -1 && !inCode[open]) {
      const image = open > 0 && text[open - 1] === '!'
      const before = text.substring(0, image ? open - 1 : open)
      return image ? before : `${before}[${text.substring(open + 1, urlStart)}]${INCOMPLETE_LINK.slice(1)}`
    }
  }

  // `[text` — the closing bracket has not arrived; the last such `[` wins.
  const close = closingBrackets(text)
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (text[i] !== '[' || inCode[i] || close[i] !== -1) continue
    return i > 0 && text[i - 1] === '!' ? text.substring(0, i - 1) : `${text}${INCOMPLETE_LINK}`
  }
  return text
}
