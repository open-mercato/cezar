import type { Skill, WorkflowDef } from '@/api/types'

/**
 * The shared skill presentation rules (#377/#380): the ⌘K palette, the composer's `/`
 * autocomplete, and (R4) the new-task skill picker must agree on what "project first" means
 * and how a typed query narrows the list — so the rules live here, not in any one surface.
 */

/** Project-oriented skills first, user-global after — the #377/#555 ordering rule. Team skills
 *  are configured and cached per project even though their files live in a shared remote repo,
 *  so they belong with project skills. Only `global` comes from the user's home catalog. */
const PROJECT_SKILL_SOURCES: ReadonlySet<Skill['source']> = new Set([
  'ai',
  'cezar',
  'agents',
  'team',
])

/** Project skills render emphasized (bold) wherever skills are listed. Accepts anything
 *  carrying a `source` so tag components need not conjure a whole Skill. */
export function isProjectSkill(skill: Pick<Skill, 'source'>): boolean {
  return PROJECT_SKILL_SOURCES.has(skill.source)
}

/** The sort is stable, so within each half the server's own order (alphabetical —
 *  `src/skills.ts` sorts the merged catalog by name) is preserved. */
export function orderSkills(skills: readonly Skill[]): Skill[] {
  return [...skills].sort((a, b) => Number(!isProjectSkill(a)) - Number(!isProjectSkill(b)))
}

/** How many "Most used" skills a picker promotes above the locality groups (#519). */
const MOST_USED_LIMIT = 5

/** The three display tiers every skill picker renders, in this order (#519). */
export interface SkillTiers {
  /** Skills actually picked before (`skillUsage` count > 0), frequency descending, capped. */
  mostUsed: Skill[]
  /** Remaining project skills (#377 locality), in the incoming (server-alphabetical) order. */
  project: Skill[]
  /** Remaining user-global skills, in the incoming order. */
  global: Skill[]
}

/**
 * Partition skills into the picker display tiers (#519): **Most used** first — skills with a
 * `skillUsage` count > 0, frequency descending, ties broken locality-first then by incoming
 * order, capped at `mostUsedLimit` — then **project**, then **global**, each remainder keeping
 * the incoming order. A skill promoted into `mostUsed` is NOT repeated in its locality group.
 * `usage` is the ui-state `skillUsage` map (name → times chosen, counted across every picker
 * surface). With no usage at all this degrades to the plain #377 project-first split. The one
 * source of tier truth: grouped pickers render the three tiers, flat surfaces flatten them
 * through `orderSkillsByUsage`.
 */
export function partitionSkillsForDisplay(
  skills: readonly Skill[],
  usage: Readonly<Record<string, number>> | undefined,
  { mostUsedLimit = MOST_USED_LIMIT }: { mostUsedLimit?: number } = {},
): SkillTiers {
  const mostUsed = skills
    .map((skill, index) => ({ skill, index, count: usageCount(usage, skill.name) }))
    .filter((entry) => entry.count > 0)
    .sort(
      (a, b) =>
        b.count - a.count ||
        Number(!isProjectSkill(a.skill)) - Number(!isProjectSkill(b.skill)) ||
        a.index - b.index,
    )
    .slice(0, mostUsedLimit)
    .map((entry) => entry.skill)
  const promoted = new Set(mostUsed)
  const rest = skills.filter((skill) => !promoted.has(skill))
  return {
    mostUsed,
    project: rest.filter(isProjectSkill),
    global: rest.filter((skill) => !isProjectSkill(skill)),
  }
}

/**
 * The flat frequency order (#408, re-tiered by #519): the `partitionSkillsForDisplay` tiers
 * flattened — most-used first (frequency descending, capped), then project, then global — so
 * flat surfaces (the workflows palette, the ⌘K palette, the `/` autocomplete's base order)
 * agree with the grouped pickers. With no usage data this is exactly `orderSkills`.
 */
export function orderSkillsByUsage(
  skills: readonly Skill[],
  usage: Readonly<Record<string, number>> | undefined,
): Skill[] {
  const tiers = partitionSkillsForDisplay(skills, usage)
  return [...tiers.mostUsed, ...tiers.project, ...tiers.global]
}

/** One skill's count out of the `skillUsage` map. `Object.hasOwn`, not a plain lookup: `usage`
 *  comes from `JSON.parse`, so it carries Object.prototype — a skill named `constructor` or
 *  `toString` would otherwise resolve to the INHERITED function, which `??` does not catch,
 *  turning the comparator into NaN and the bump into string garbage. */
function usageCount(usage: Readonly<Record<string, number>> | undefined, name: string): number {
  if (!usage || !Object.hasOwn(usage, name)) return 0
  const count = usage[name]
  return typeof count === 'number' ? count : 0
}

/** A pure reducer over the ui-state `skillUsage` map (#408): bump one skill's count by one. The
 *  server's `PUT /api/ui-state` merge is shallow (`uiStateSchema` passthrough), so a successful
 *  run start always sends the WHOLE updated map back, never just the one changed entry. */
export function bumpSkillUsage(
  usage: Readonly<Record<string, number>> | undefined,
  name: string,
): Record<string, number> {
  return { ...usage, [name]: usageCount(usage, name) + 1 }
}

/**
 * Does `query` fuzzy-match `candidate`? Case-insensitive subsequence — `omfx` finds
 * `om-fix-issue` — the same permissiveness cmdk gives the palette, minus its score-reordering:
 * the composer autocomplete filters WITHOUT re-sorting, so the project-first order above
 * survives any query (a deliberate difference from the palette, where cmdk may interleave).
 */
export function fuzzyMatch(candidate: string, query: string): boolean {
  if (query === '') return true
  const haystack = candidate.toLowerCase()
  const needle = query.toLowerCase()
  let at = 0
  for (const char of needle) {
    at = haystack.indexOf(char, at)
    if (at === -1) return false
    at += 1
  }
  return true
}

/** Workflows referencing a skill, as "workflow › step" breadcrumbs — the skill detail's
 *  "Used by" list (legacy `skillUsedBy`, ported). Steps fall back to their id when unnamed. */
export function skillUsedBy(workflows: readonly WorkflowDef[], name: string): string[] {
  const out: string[] = []
  for (const workflow of workflows) {
    for (const step of workflow.steps ?? []) {
      if (step.skill === name) out.push(`${workflow.name} › ${step.name ?? step.id}`)
    }
  }
  return out
}

/** Characters that begin a new "word" inside a skill value ("skill om-auto-review-pr /path"):
 *  whitespace and the separators used in names and paths. Lets us tell a whole-word or
 *  word-start hit ("review" in "om-auto-**review**-pr") from an incidental buried substring. */
const WORD_BOUNDARY = /[\s\-/_.]/

/** How well a single lowercased `word` matches inside a lowercased `haystack`.
 *  0 = absent, 1 = buried substring, 2 = starts on a word boundary, 3 = a whole word
 *  (bounded on both sides). Scans every occurrence and keeps the strongest — so the score
 *  reflects match *quality*, not where the first hit happens to land. */
function wordScore(haystack: string, word: string): number {
  let best = 0
  for (let from = haystack.indexOf(word); from !== -1; from = haystack.indexOf(word, from + 1)) {
    let score = 1
    const before = haystack[from - 1]
    if (from === 0 || (before !== undefined && WORD_BOUNDARY.test(before))) {
      const after = haystack[from + word.length]
      score = after === undefined || WORD_BOUNDARY.test(after) ? 3 : 2
    }
    if (score > best) best = score
    if (best === 3) break
  }
  return best
}

/**
 * Multi-word filter for cmdk `<Command filter={…}>`: splits the typed query on whitespace
 * and requires every word to appear as a case-insensitive substring in the combined
 * value + keywords text.  "auto review" finds "om-auto-review-pr", "verify ui" finds
 * "om-auto-verify-ui".  Returns a 0–1 score (0 = no match) so cmdk hides non-matches and
 * ranks the rest.
 *
 * The score is the average per-word match *quality* (#484): a whole-word / word-start hit
 * outranks an incidental buried substring, so an (almost-)exact match sorts to the top. It
 * is deliberately independent of the haystack length — the old coverage ratio diluted every
 * match on a long value+path down to ~0.5, leaving cmdk nothing to rank by.
 */
export function multiWordFilter(value: string, search: string, keywords?: string[]): number {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return 1
  const haystack = [value, ...(keywords ?? [])].join(' ').toLowerCase()
  let total = 0
  for (const word of words) {
    const score = wordScore(haystack, word)
    if (score === 0) return 0 // every word must match
    total += score
  }
  return total / (words.length * 3) // normalize into (0, 1]
}

/**
 * How well a whole `query` matches a single `text` (a skill name or its description).
 * 0 = no match; higher = better: exact > prefix > word-boundary hit > buried substring >
 * subsequence. The subsequence fallback keeps `fuzzyMatch`'s permissiveness ("omfx" still
 * finds "om-fix-issue"), just ranked below the literal hits so the best match wins.
 */
export function matchScore(text: string, query: string): number {
  if (query === '') return 1
  const haystack = text.toLowerCase()
  const needle = query.toLowerCase()
  if (haystack === needle) return 6
  if (haystack.startsWith(needle)) return 5
  const idx = haystack.indexOf(needle)
  if (idx > 0) {
    const before = haystack[idx - 1]
    return before !== undefined && WORD_BOUNDARY.test(before) ? 4 : 3
  }
  return fuzzyMatch(haystack, needle) ? 1 : 0
}

/** Split a skill/workflow name on hyphens so each part is independently searchable as a
 *  cmdk keyword — keeps the description keyword too. */
export function skillKeywords(name: string, description?: string | null): string[] {
  const parts = name.split('-').filter(Boolean)
  return description ? [...parts, description] : parts
}

/** A name hit outranks a description-only hit by this much, so an (almost-)exact name match
 *  always sorts above a skill that merely mentions the query in its description (#484). */
const NAME_MATCH_BONUS = 10

/** How well a name/description pair matches a typed query. The query is split on whitespace
 *  and EVERY word must appear in the name or the description (the multi-keyword rule from #411:
 *  "fix project" finds `om-fix` "project fixer"); a query that misses any word scores 0. Each
 *  word contributes its `matchScore` quality (exact > prefix > word-boundary > substring >
 *  subsequence), and a word that lands in the NAME is boosted over one that only lands in the
 *  description — so the total ranks (almost-)exact name matches to the top (#484). Empty query
 *  is a neutral match (1). The shared match signal behind every skill/workflow search surface. */
export function queryScore(name: string, description: string | null | undefined, query: string): number {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return 1
  let total = 0
  for (const word of words) {
    const nameScore = matchScore(name, word)
    const descScore = description ? matchScore(description, word) : 0
    if (nameScore === 0 && descScore === 0) return 0 // every word must match somewhere
    total += nameScore > 0 ? nameScore + NAME_MATCH_BONUS : descScore
  }
  return total
}

/** A heavily-used skill may win among comparably-scoring matches (#519), but never outrank a
 *  clearly better name match: the bonus is bounded to `MOST_USED_LIMIT * USAGE_BONUS_STEP`,
 *  well under the `NAME_MATCH_BONUS` gap between match tiers. */
const USAGE_BONUS_STEP = 0.5

/** Filter a name/description list down to matches and rank them by match quality (#484),
 *  preserving the incoming order for an empty query and for equally-scored ties — so a
 *  caller's most-used-first or project-first order survives. When `usage` is given (#519), a
 *  bounded usage bonus is folded into the score and the usage count breaks remaining ties, so
 *  a typed query no longer discards frequency entirely. This is the shared ranking engine
 *  behind both the composer `/` autocomplete and the cmdk pickers: the pickers rank in JS
 *  through this rather than trusting cmdk's built-in score-sort, which does not reliably
 *  re-order the list in this app (React re-renders reset cmdk's imperative DOM ordering), so
 *  before #484 an (almost-)exact match could sit below weaker ones. */
function rankByQuery<T extends { name: string; description?: string | null }>(
  items: readonly T[],
  query: string,
  usage?: Readonly<Record<string, number>>,
): T[] {
  if (query.trim() === '') return [...items]
  return items
    .map((item, index) => {
      const base = queryScore(item.name, item.description, query)
      const count = usageCount(usage, item.name)
      const bonus = Math.min(count, MOST_USED_LIMIT) * USAGE_BONUS_STEP
      return { item, index, count, score: base > 0 ? base + bonus : 0 }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.count - a.count || a.index - b.index)
    .map((entry) => entry.item)
}

/** Rank skills for a grouped picker by match quality, keeping the caller's incoming order
 *  (most-used-first / project-first) for ties and the empty query — with the #519 usage
 *  tie-break when `usage` is given. Callers split the result into their own display groups
 *  (`partitionSkillsForDisplay`); each group stays match-ranked. */
export function searchSkills(
  skills: readonly Skill[],
  query: string,
  usage?: Readonly<Record<string, number>>,
): Skill[] {
  return rankByQuery(skills, query, usage)
}

/** Rank workflows for a picker by match quality — the workflow counterpart of `searchSkills`. */
export function searchWorkflows(workflows: readonly WorkflowDef[], query: string): WorkflowDef[] {
  return rankByQuery(workflows, query)
}

/** The `/` autocomplete's list for a typed query: ordered most-used → project → global (#519,
 *  via `orderSkillsByUsage`), then filtered and **ranked by match quality** (#484 — an
 *  (almost-)exact match must sort to the top, the same rule the pickers now follow; supersedes
 *  the old #380 "filter without re-sorting"). Matches on the name and, as a fallback, the
 *  description ("review" should find `om-code-review` even when the name says less than the
 *  description does). Ties keep the usage-then-locality order, so an empty query and
 *  equally-good matches still render most-used skills first, then project before global/team.
 *  Without `usage` this is exactly the pre-#519 project-first behavior. */
export function filterSkills(
  skills: readonly Skill[],
  query: string,
  usage?: Readonly<Record<string, number>>,
): Skill[] {
  return rankByQuery(orderSkillsByUsage(skills, usage), query, usage)
}
