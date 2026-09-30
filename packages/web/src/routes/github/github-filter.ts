import type { CSSProperties } from 'react'

import type { GithubItem } from '@open-mercato/cezar-api-client'

/**
 * Pure filtering + label-color helpers for the GitHub tab (#gh-filter). Kept apart from the
 * component so the "search by #id or text, narrow by labels" rules are table-testable and match
 * GitHub's own semantics: multiple selected labels AND together (an item must carry them all).
 */

/** Every distinct label across the items, case-insensitively sorted — the filter dropdown's list. */
export function allLabels(items: readonly GithubItem[]): string[] {
  const set = new Set<string>()
  for (const item of items) for (const label of item.labels) set.add(label)
  return [...set].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
}

/**
 * Filter by a free-text query and a set of required labels.
 *  - `query`: `#123`/`123` matches the number; anything else is a case-insensitive substring
 *    over the number, title, author and body.
 *  - `labels`: the item must carry EVERY selected label (AND, like GitHub's label filter).
 */
export function filterGithubItems(
  items: readonly GithubItem[],
  opts: { query?: string; labels?: readonly string[] } = {},
): GithubItem[] {
  const query = (opts.query ?? '').trim().toLowerCase()
  const required = opts.labels ?? []
  const numeric = query.replace(/^#/, '')
  const idOnly = numeric !== '' && /^\d+$/.test(numeric)
  return items.filter((item) => {
    if (required.length > 0 && !required.every((label) => item.labels.includes(label))) return false
    if (query === '') return true
    if (idOnly) return String(item.number).includes(numeric)
    const haystack = `#${item.number} ${item.title} ${item.author} ${item.body}`.toLowerCase()
    return haystack.includes(query)
  })
}

/** Which end of the backlog the list starts at. `newest` is the default and matches what
 *  `gh {issue,pr} list` already returns, so it is the no-op order. */
export type GithubSort = 'newest' | 'oldest'

/**
 * Order items by creation time — `newest` first (the default) or `oldest` first.
 *
 * The forge already answers created-descending, so `newest` is a no-op on a fresh payload. Sorting
 * anyway rather than reversing only for `oldest` is deliberate: the tab also renders cross-state
 * search hits, which come back in GitHub's *best-match* order, and `Array.prototype.reverse` on
 * those would produce "worst match first" rather than an age order. One comparator gives both
 * lists the same, explainable rule.
 *
 * Ties break on `number`, descending for `newest` and ascending for `oldest`. Bulk-opened PRs
 * really do share a `createdAt` to the second, and `Array.prototype.sort` is only stable with
 * respect to the input order — which, for the search hits, is relevance and therefore changes
 * under the user as they type. The tiebreak makes the rendered order a function of the item set
 * alone, so rows never reshuffle between renders.
 *
 * Returns a NEW array: the input is the react-query cache's own array, and sorting it in place
 * would mutate cached payload behind the query client's back.
 */
export function sortGithubItems(items: readonly GithubItem[], sort: GithubSort): GithubItem[] {
  // `localeCompare` would apply collation rules to what is an ISO-8601 timestamp; these sort
  // correctly as plain strings, and an unparseable/empty `createdAt` still lands somewhere
  // deterministic instead of becoming `NaN` the way `Date.parse` would.
  const direction = sort === 'oldest' ? 1 : -1
  return [...items].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -direction : direction
    return (a.number - b.number) * direction
  })
}

/**
 * Should the tab stop re-filtering what it already holds and ask the forge instead (#730)?
 *
 * `filterGithubItems` can only ever match the OPEN set the list fetched, so "zero local matches
 * for a non-empty query" is exactly the state where the answer may still exist on GitHub —
 * closed, merged, or simply outside the fetched window. A blank query is never a search (that is
 * the unfiltered list), and a query that already found something locally is not worth a `gh`
 * subprocess.
 *
 * The label filter takes part in this decision, by way of the caller: `github.tsx` derives
 * `localMatches` from `filterGithubItems(openItems, { query, labels })`, so a label filter that
 * narrows the open matches to zero DOES reach for the forge. It can only ever force the fallback,
 * never suppress it — filtering removes matches, it never adds any. That is deliberate: the hits
 * come back re-narrowed by the same label filter before rendering, so a label-filtered empty view
 * is just as legitimate a reason to ask GitHub as an unfiltered one (#837).
 */
export function shouldSearchForge(query: string, localMatches: number): boolean {
  return query.trim() !== '' && localMatches === 0
}

/** Inline style for a label chip tinted like GitHub: the label color as a translucent fill with a
 *  matching border, and readable text. Falls back to neutral tokens when no color is known. */
export function labelChipStyle(color: string | undefined): CSSProperties {
  if (!color || !/^[0-9a-fA-F]{6}$/.test(color)) {
    // `--muted-foreground`, not `--soft-foreground`: the softer token is near-invisible against
    // the pale chip fill in light mode (the #gh-list low-contrast finding).
    return { borderColor: 'var(--border)', color: 'var(--muted-foreground)' }
  }
  const solid = `#${color}`
  return {
    backgroundColor: `${solid}22`, // ~13% opacity fill, like GitHub's label pills
    borderColor: `${solid}66`,
    // Blend the label color toward the theme's foreground so the text is legible in BOTH themes:
    // `--foreground` is near-black in light mode (darkens the ink against the pale tint) and
    // near-white in dark mode (lifts it against the dark tint). One formula, no luminance branch —
    // the previous JS-computed color only ever targeted dark chips, which washed out in light mode.
    color: `color-mix(in srgb, ${solid} 50%, var(--foreground))`,
  }
}
