import type { ProjectListEntry } from '@open-mercato/cezar-api-client'

/**
 * The tag vocabulary of a workspace — what makes tagging the SECOND repo cheap.
 *
 * Tags only group anything if two projects spell one the same way, and free text does not
 * converge on its own: `storefront`, `store-front` and `Storefront` are three groups that were
 * meant to be one. The server normalizes each list it stores (trim, case-insensitive dedupe,
 * sort), but it can only deduplicate WITHIN one project — nothing there stops the next project
 * from inventing a near-miss. Offering the tags that already exist is what does.
 *
 * Pure, and deliberately not part of `lib/global-tasks.ts`: the settings editor that writes tags
 * and the page that reads them both need this, and neither should have to import the other's
 * module to get it.
 */

/**
 * Every tag in the registry, deduped case-insensitively (first spelling wins, matching the
 * server's own normalization) and sorted. Two projects spelling one tag differently therefore
 * offer a single suggestion rather than two.
 */
export function allProjectTags(projects: readonly ProjectListEntry[]): string[] {
  const bySpelling = new Map<string, string>()
  for (const project of projects) {
    for (const tag of project.tags ?? []) {
      const key = tag.toLowerCase()
      if (!bySpelling.has(key)) bySpelling.set(key, tag)
    }
  }
  return [...bySpelling.values()].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }),
  )
}

/** How many suggestions a token field offers at once. Enough to cover a real workspace's
 *  vocabulary, few enough that the list never becomes its own scrolling problem. */
export const TAG_SUGGESTION_LIMIT = 8

/**
 * What to offer while someone types a tag into `project`'s field.
 *
 * - tags the project ALREADY carries are dropped: re-adding one is a no-op the server would
 *   answer 200 to, which looks like it worked;
 * - an empty query offers the whole vocabulary, so the field is discoverable before a keystroke
 *   ("what tags exist here?" is the first question, and it has an answer);
 * - a query matches as a case-insensitive SUBSTRING, with prefix matches first — typing `st`
 *   should lead with `storefront`, not with `test`;
 * - an exact match (in any case) is dropped too: the field's own Enter already commits it, so a
 *   suggestion row saying the same thing is a second way to do one thing.
 */
export function suggestTags(
  all: readonly string[],
  taken: readonly string[],
  query: string,
  limit = TAG_SUGGESTION_LIMIT,
): string[] {
  const needle = query.trim().toLowerCase()
  const used = new Set(taken.map((tag) => tag.toLowerCase()))
  const matches = all.filter((tag) => {
    const lowered = tag.toLowerCase()
    if (used.has(lowered)) return false
    if (needle === '') return true
    return lowered.includes(needle) && lowered !== needle
  })
  if (needle === '') return matches.slice(0, limit)
  return matches
    .sort((a, b) => {
      const byPrefix =
        Number(b.toLowerCase().startsWith(needle)) - Number(a.toLowerCase().startsWith(needle))
      return byPrefix || a.localeCompare(b, undefined, { sensitivity: 'base' })
    })
    .slice(0, limit)
}

/**
 * The server's own storage rule (`normalizeProjectTags`, `workspace/projects.ts`), mirrored for
 * ONE purpose: rendering an optimistic update that will not visibly rearrange itself when the
 * server's answer arrives a moment later.
 *
 * Deliberately not the authority — the server normalizes what it stores and its answer overwrites
 * this. What would be worse than the duplication is the alternative: an optimistic chip list in
 * insertion order that reshuffles into alphabetical order on every save, which reads as the UI
 * changing its mind.
 */
export function normalizeTagsForDisplay(tags: readonly string[]): string[] {
  const bySpelling = new Map<string, string>()
  for (const raw of tags) {
    const tag = raw.trim()
    if (!tag) continue
    const key = tag.toLowerCase()
    if (!bySpelling.has(key)) bySpelling.set(key, tag)
  }
  return [...bySpelling.values()].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }),
  )
}
