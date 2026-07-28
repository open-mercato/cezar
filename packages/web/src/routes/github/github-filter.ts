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
