/**
 * The Files sub-tab's path filter, as pure data (spec `.ai/specs/2026-10-05-repo-file-browser.md`
 * Phase 2, #1279). The whole repository index is already in the browser from one `GET /repo/tree`,
 * so matching is a client-side pass over an array — no endpoint, no server-side matcher reachable
 * over HTTP, no cancellation story.
 *
 * Matching is a case-insensitive SUBSEQUENCE over the full repo-relative path, which is what makes
 * `webrepofiles` find `packages/web/src/routes/repo-git/repo-files.tsx`. Paths only: content search
 * is a grep surface with its own cost and abuse profile and belongs to its own spec.
 */

/** True when every character of `needle` appears in `haystack`, in order. Both already lowercased. */
function isSubsequence(haystack: string, needle: string): boolean {
  let at = 0
  for (const char of needle) {
    at = haystack.indexOf(char, at)
    if (at === -1) return false
    // `char.length`, not 1: iterating a string yields code POINTS, so an astral character is two
    // code units wide and advancing by one would let its trailing surrogate match again.
    at += char.length
  }
  return true
}

export interface PathMatches {
  /** The matches to render, at most `limit` of them. */
  results: string[]
  /** How many matched in total — `total > results.length` is the "N more" case. */
  total: number
}

/**
 * The `limit` best matches for `query`, plus the total that matched.
 *
 * Ranking, in order: a match whose BASENAME carries the subsequence first (typing `appts` means the
 * file called that far more often than a coincidence spanning three directories), then the shorter
 * path, then alphabetical so the order never depends on the index's own.
 *
 * An empty query is "no filter": the paths come back as given and UNCAPPED, because the caller
 * renders the tree in that case — and the tree is bounded by its closed folders, not by this cap.
 */
export function matchPaths(paths: readonly string[], query: string, limit: number): PathMatches {
  const needle = query.trim().toLowerCase()
  if (needle === '') return { results: [...paths], total: paths.length }

  const matched: { path: string; basenameMatch: boolean }[] = []
  for (const path of paths) {
    const lower = path.toLowerCase()
    if (!isSubsequence(lower, needle)) continue
    const basename = lower.slice(lower.lastIndexOf('/') + 1)
    matched.push({ path, basenameMatch: isSubsequence(basename, needle) })
  }

  matched.sort((a, b) => {
    if (a.basenameMatch !== b.basenameMatch) return a.basenameMatch ? -1 : 1
    if (a.path.length !== b.path.length) return a.path.length - b.path.length
    return a.path.localeCompare(b.path)
  })

  return { results: matched.slice(0, limit).map((match) => match.path), total: matched.length }
}
