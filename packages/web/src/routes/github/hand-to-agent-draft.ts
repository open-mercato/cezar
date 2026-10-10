import type { Runner } from '@open-mercato/cezar-api-client'

import { RUNNERS } from '@/routes/new-task-form'

/**
 * Follow-up composer persistence (#408), localStorage-backed like `new-task-draft.ts` — the
 * same store-per-file convention, just two stores instead of one because the two pieces of
 * state have different lifetimes:
 *
 *  - The PICKER PICK (workflow + skills + engine) is a "way of working, not a property of one
 *    item" (see `HandToAgent`'s doc block) — it already survives switching between GitHub items
 *    within a session via route state (`github.tsx`). This adds survival across a full page
 *    reload, and — read on FIRST mount — doubles as the "remembered last selection" (#408 item
 *    3) that pre-fills a hand-off you have never touched yet.
 *  - The PROMPT is per hand-off TARGET — an issue/PR's instructions are its own, not shared —
 *    keyed by the item's URL so switching between issues never leaks one item's in-progress
 *    text into another's textarea (#408 item 4).
 *
 * Both degrade to "nothing remembered" in private mode / a full quota — never a throw, same
 * stance as `new-task-draft.ts`.
 */

export interface FollowupSelection {
  workflow: string | null
  skills: string[]
  /**
   * The engine pick (#906). It belongs here for the reason the workflow does — it is a way of
   * working, not a property of one item — and it MUST be here, because an unremembered pick is
   * indistinguishable from "never touched", and "never touched" is precisely the state that lets
   * the NATIVE agent default (`~/.claude/settings.json`) override the user's own repeated choice
   * (`resolveModel`, new-task-form.ts).
   *
   * `null` therefore keeps meaning "never touched", and an explicit auto pick is `model: ''`.
   * Collapsing the two is the bug, not a tidy-up: `''` must round-trip as `''`.
   */
  runner: Runner | null
  model: string | null
}

const EMPTY_SELECTION: FollowupSelection = { workflow: null, skills: [], runner: null, model: null }

const SELECTION_KEY = 'cez-followup-selection'

const KNOWN_RUNNERS: readonly Runner[] = RUNNERS.map((option) => option.id)

/** Tolerant per-key normalization, the store's existing stance: a garbage value degrades to
 *  "never touched" rather than throwing or riding a request. The two-field shape written before
 *  #906 still reads — its missing engine keys are exactly "never touched". */
function normalizeSelection(raw: unknown): FollowupSelection {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    workflow: typeof obj.workflow === 'string' ? obj.workflow : null,
    skills: Array.isArray(obj.skills) ? obj.skills.filter((s): s is string => typeof s === 'string') : [],
    // A runner this build does not know (an older/newer cezar, or a hand-edited value) is not a
    // runner — the pill would render nothing selectable and the POST would name a dead backend.
    runner: KNOWN_RUNNERS.includes(obj.runner as Runner) ? (obj.runner as Runner) : null,
    model: typeof obj.model === 'string' ? obj.model : null,
  }
}

export function readFollowupSelection(): FollowupSelection {
  try {
    const stored = localStorage.getItem(SELECTION_KEY)
    return stored ? normalizeSelection(JSON.parse(stored)) : { ...EMPTY_SELECTION }
  } catch {
    return { ...EMPTY_SELECTION } // private mode / bad JSON — start clean, still works this session
  }
}

/**
 * Read-modify-write, so one owner of the selection never clobbers another's keys — the same
 * stance `PUT /api/config` takes on the raw `config.json`. It matters here because the pieces
 * have separate owners: `github.tsx` writes the workflow/skills pick, and the engine pick is
 * written by the shared hook in `engine-pills.tsx`. A full overwrite would let whichever
 * effect ran last erase the other's choice.
 */
export function writeFollowupSelection(patch: Partial<FollowupSelection>): void {
  try {
    localStorage.setItem(SELECTION_KEY, JSON.stringify({ ...readFollowupSelection(), ...patch }))
  } catch {
    // Storage disabled/full — the picker still works this session, just won't be remembered.
  }
}

/** Test isolation. */
export function resetFollowupSelection(): void {
  try {
    localStorage.removeItem(SELECTION_KEY)
  } catch {
    // ignore
  }
}

const PROMPT_KEY_PREFIX = 'cez-followup-prompt:'

/** An untouched item (never typed into, or already spent by a successful run) answers ''. */
export function readFollowupPrompt(itemUrl: string): string {
  try {
    return localStorage.getItem(PROMPT_KEY_PREFIX + itemUrl) ?? ''
  } catch {
    return ''
  }
}

/** Empty text REMOVES the entry rather than storing '' — an untouched or just-submitted item
 *  leaves no trace, so this store never grows unbounded with every item ever visited. */
export function writeFollowupPrompt(itemUrl: string, prompt: string): void {
  try {
    if (prompt === '') localStorage.removeItem(PROMPT_KEY_PREFIX + itemUrl)
    else localStorage.setItem(PROMPT_KEY_PREFIX + itemUrl, prompt)
  } catch {
    // Storage disabled/full — the textarea still works this session, just won't be remembered.
  }
}
