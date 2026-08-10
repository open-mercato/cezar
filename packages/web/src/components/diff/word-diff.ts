/**
 * Word-level intra-line diff for paired del/add lines (spec #390: "word-level intra-line
 * diff") — a small LCS over word/space/punctuation tokens, no library. Deliberately
 * conservative: dissimilar lines (a full rewrite) get NO word marks, because marking 95% of
 * a line tells the reader nothing; the guard thresholds below encode that.
 *
 * Also home to `overlaySegments`, the pure merge of syntax tokens (the Shiki singleton's
 * per-line output) with word spans — one line of rendered diff is tokens × marks, split at
 * every boundary of either, so highlighting and word emphasis compose instead of competing.
 */

import type { SynToken } from '@/lib/highlighter'

export interface WordSpan {
  text: string
  /** True for the tokens this side does not share with the other side. */
  changed: boolean
}

/** Words, whitespace runs, and punctuation runs — the units the LCS aligns. */
const TOKEN_RE = /[A-Za-z0-9_]+|\s+|[^\sA-Za-z0-9_]+/g

/** Past this many tokens per side the O(n·m) DP is not worth the jank — no word marks. */
const MAX_TOKENS = 300

/** Lines sharing fewer than this fraction of tokens are rewrites, not edits — no marks. */
const MIN_SIMILARITY = 0.3

export interface WordDiff {
  del: WordSpan[]
  add: WordSpan[]
}

/**
 * Word spans for one del/add line pair, or null when marks would not help the reader
 * (identical lines, rewrites, degenerate or oversized input).
 */
export function diffWords(before: string, after: string): WordDiff | null {
  if (before === after) return null
  const a = before.match(TOKEN_RE) ?? []
  const b = after.match(TOKEN_RE) ?? []
  if (a.length === 0 || b.length === 0) return null
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) return null

  // Classic LCS table; dimensions are capped above so worst case is 300×300 numbers.
  const width = b.length + 1
  const dp = new Uint16Array((a.length + 1) * width)
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i * width + j] =
        a[i - 1] === b[j - 1]
          ? (dp[(i - 1) * width + (j - 1)] ?? 0) + 1
          : Math.max(dp[(i - 1) * width + j] ?? 0, dp[i * width + (j - 1)] ?? 0)
    }
  }
  const common = dp[a.length * width + b.length] ?? 0
  if (common / Math.max(a.length, b.length) < MIN_SIMILARITY) return null

  // Backtrack: tokens on the LCS path are "kept", everything else is changed.
  const keptA = new Array<boolean>(a.length).fill(false)
  const keptB = new Array<boolean>(b.length).fill(false)
  let i = a.length
  let j = b.length
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      keptA[i - 1] = true
      keptB[j - 1] = true
      i--
      j--
    } else if ((dp[(i - 1) * width + j] ?? 0) >= (dp[i * width + (j - 1)] ?? 0)) {
      i--
    } else {
      j--
    }
  }
  return { del: toSpans(a, keptA), add: toSpans(b, keptB) }
}

/** Collapse per-token flags into runs — adjacent tokens with the same flag render as one span. */
function toSpans(tokens: string[], kept: boolean[]): WordSpan[] {
  const spans: WordSpan[] = []
  tokens.forEach((token, index) => {
    const changed = !(kept[index] ?? false)
    const last = spans[spans.length - 1]
    if (last && last.changed === changed) last.text += token
    else spans.push({ text: token, changed })
  })
  return spans
}

/** One renderable run of a diff line: text with an optional syntax color and a word mark. */
export interface RenderSegment {
  text: string
  /** A `var(--syn-*)` reference from the Shiki singleton, when highlighting is resident. */
  color?: string
  changed: boolean
}

/**
 * Merge a line's syntax tokens with its word spans into flat segments, splitting at every
 * boundary of either sequence. Both sequences concatenate to the same line text; if tokens
 * are missing (grammar not yet loaded) the spans alone render, and vice versa.
 */
export function overlaySegments(
  tokens: readonly SynToken[] | null,
  spans: readonly WordSpan[] | null | undefined,
  text: string,
): RenderSegment[] {
  if (!spans || spans.length === 0) {
    if (!tokens) return text === '' ? [] : [{ text, changed: false }]
    return tokens.map((token) => ({ text: token.content, color: token.color, changed: false }))
  }
  if (!tokens || tokens.length === 0) {
    return spans.map((span) => ({ text: span.text, changed: span.changed }))
  }

  const out: RenderSegment[] = []
  let ti = 0
  let tOff = 0
  let si = 0
  let sOff = 0
  while (ti < tokens.length && si < spans.length) {
    const token = tokens[ti]!
    const span = spans[si]!
    const tRemaining = token.content.length - tOff
    const sRemaining = span.text.length - sOff
    const length = Math.min(tRemaining, sRemaining)
    if (length > 0) {
      out.push({ text: token.content.slice(tOff, tOff + length), color: token.color, changed: span.changed })
      tOff += length
      sOff += length
    }
    // Advance past exhausted (or empty) units; both may finish on the same boundary.
    if (token.content.length - tOff <= 0) {
      ti++
      tOff = 0
    }
    if (span.text.length - sOff <= 0) {
      si++
      sOff = 0
    }
  }
  // Length disagreements (a truncated token stream) degrade to unmarked tails, never a loss.
  while (ti < tokens.length) {
    const token = tokens[ti]!
    const tail = token.content.slice(tOff)
    if (tail !== '') out.push({ text: tail, color: token.color, changed: false })
    ti++
    tOff = 0
  }
  return out
}
