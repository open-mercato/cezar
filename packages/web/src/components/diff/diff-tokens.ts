import type { SynHighlight, SynToken } from '@/lib/highlighter'

import type { HunkLine } from './parse-patch'

/** Tokens aligned to `lines`, each contiguous run highlighted per side, so lexer state never
 *  crosses hidden lines or a `-`/`+` pair. Null while the grammar is not loaded. */
export function tokenizeDiffLines(
  lines: readonly HunkLine[],
  highlightText: (text: string) => SynHighlight | null,
): SynToken[][] | null {
  const out: SynToken[][] = new Array(lines.length)
  for (const segment of contiguousSegments(lines)) {
    const sides: Array<(line: HunkLine) => boolean> = [
      (line) => line.kind !== 'add',
      (line) => line.kind !== 'del',
    ]
    for (const onSide of sides) {
      const indexes = segment.filter((index) => onSide(lines[index]!))
      if (indexes.length === 0) continue
      const result = highlightText(indexes.map((index) => lines[index]!.text).join('\n'))
      if (!result) return null
      // A context line sits on both sides; the new side, highlighted second, wins.
      indexes.forEach((index, at) => {
        out[index] = result.tokens[at] ?? [{ content: lines[index]!.text }]
      })
    }
  }
  return out
}

// ---- the token cache ----------------------------------------------------------------------------
// Shiki was ~80% of the CPU of re-opening the Changes tab (profiled on a 46-file diff): every mount
// re-highlighted every visible file. Tokens are a pure function of (grammar, lines), so they are
// cached by content, across mounts and tasks, bounded by the characters the keys hold. A cached
// character also costs its share of token objects (~16 bytes), so 2M characters is ~40 MB at most.

const TOKEN_CACHE_MAX_CHARS = 2_000_000
const tokenCache = new Map<string, SynToken[][]>()
let tokenCacheChars = 0

/** The cache key: everything `tokenizeDiffLines` reads — grammar, side, line numbers, text. */
export function diffTokensKey(lang: string, lines: readonly HunkLine[]): string {
  let key = lang
  for (const line of lines) key += `\n${line.kind[0]}${line.oldLine ?? ''},${line.newLine ?? ''}\t${line.text}`
  return key
}

export function cachedDiffTokens(key: string): SynToken[][] | undefined {
  const tokens = tokenCache.get(key)
  if (tokens !== undefined) {
    // Least recently used goes first: re-insert on every hit.
    tokenCache.delete(key)
    tokenCache.set(key, tokens)
  }
  return tokens
}

export function storeDiffTokens(key: string, tokens: SynToken[][]): void {
  if (key.length > TOKEN_CACHE_MAX_CHARS / 4 || tokenCache.has(key)) return
  tokenCache.set(key, tokens)
  tokenCacheChars += key.length
  for (const oldest of tokenCache.keys()) {
    if (tokenCacheChars <= TOKEN_CACHE_MAX_CHARS) break
    tokenCacheChars -= oldest.length
    tokenCache.delete(oldest)
  }
}

/** Test-only: the cache is module-level, so one case's tokens would leak into the next. */
export function resetDiffTokenCache(): void {
  tokenCache.clear()
  tokenCacheChars = 0
}

// ---- the tokenize queue -------------------------------------------------------------------------
// Highlighting runs after paint, a few files per macrotask, so opening a big diff never blocks the
// main thread in one long task (it did: 330–480 ms per tab switch).

const SLICE_MS = 8
const queue: Array<{ run: () => void; cancelled: boolean }> = []
let draining = false

function drain(): void {
  const started = performance.now()
  while (queue.length > 0 && performance.now() - started < SLICE_MS) {
    const job = queue.shift()!
    if (!job.cancelled) job.run()
  }
  if (queue.length > 0) setTimeout(drain, 0)
  else draining = false
}

/** Queue one tokenize job; returns its cancel. */
export function scheduleTokenize(run: () => void): () => void {
  const job = { run, cancelled: false }
  queue.push(job)
  if (!draining) {
    draining = true
    setTimeout(drain, 0)
  }
  return () => {
    job.cancelled = true
  }
}

/** Index runs of `lines` whose old/new line numbers follow on from the previous line. */
function contiguousSegments(lines: readonly HunkLine[]): number[][] {
  const segments: number[][] = []
  let current: number[] = []
  let lastOld: number | undefined
  let lastNew: number | undefined
  lines.forEach((line, index) => {
    const follows =
      current.length > 0 &&
      (line.oldLine === undefined || lastOld === undefined || line.oldLine === lastOld + 1) &&
      (line.newLine === undefined || lastNew === undefined || line.newLine === lastNew + 1)
    if (!follows && current.length > 0) {
      segments.push(current)
      current = []
      lastOld = undefined
      lastNew = undefined
    }
    current.push(index)
    if (line.oldLine !== undefined) lastOld = line.oldLine
    if (line.newLine !== undefined) lastNew = line.newLine
  })
  if (current.length > 0) segments.push(current)
  return segments
}
