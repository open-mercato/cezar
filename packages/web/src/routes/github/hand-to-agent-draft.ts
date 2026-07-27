/**
 * Follow-up composer persistence (#408), localStorage-backed like `new-task-draft.ts` — the
 * same store-per-file convention, just two stores instead of one because the two pieces of
 * state have different lifetimes:
 *
 *  - The PICKER PICK (workflow + skills) is a "way of working, not a property of one item"
 *    (see `HandToAgent`'s doc block) — it already survives switching between GitHub items
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
}

const EMPTY_SELECTION: FollowupSelection = { workflow: null, skills: [] }

const SELECTION_KEY = 'cez-followup-selection'

function normalizeSelection(raw: unknown): FollowupSelection {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    workflow: typeof obj.workflow === 'string' ? obj.workflow : null,
    skills: Array.isArray(obj.skills) ? obj.skills.filter((s): s is string => typeof s === 'string') : [],
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

export function writeFollowupSelection(next: FollowupSelection): void {
  try {
    localStorage.setItem(SELECTION_KEY, JSON.stringify(next))
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
