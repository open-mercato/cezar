/**
 * Follow-up prompt templates (#413): a small set of reusable snippets a user can insert into a
 * follow-up instructions box — the GitHub hand-over's custom prompt (`routes/github/hand-to-agent.tsx`)
 * and the Inbox's "Add instructions" composer (`routes/inbox.tsx`). Both surfaces read the SAME
 * list through `normalizePromptTemplates`, so editing it in one place (Settings → Prompt
 * templates) reshapes what shows up in both.
 *
 * Zero-config by design: `DEFAULT_PROMPT_TEMPLATES` ship built-in and need no setup. The list is
 * only ever persisted once a user edits it — `ui-state.json`'s additive `promptTemplates` key
 * (`.passthrough()` schema, the #408 `skillUsage` pattern) — so "no key at all" and "the built-ins,
 * saved verbatim" are indistinguishable in effect but the former costs nothing to ship.
 */

export interface PromptTemplate {
  id: string
  label: string
  text: string
  /**
   * Skill names (`Skill.name` — the repo's skill identity) this template is assigned to. When one
   * of these skills is picked in a composer and the prompt box is still untouched, the template
   * auto-applies (`autoApplyText` / `resolveAutoApply`). Absent or empty = a manual-only template:
   * it still lists in the menu, it just never applies itself.
   */
  skills?: string[]
}

const LABEL_MAX = 80
const TEXT_MAX = 2000
const LIST_MAX = 50
/** Matches the server's `ref` bound for a skill name (`uiStateSchema.lastTask.ref`). */
const SKILL_NAME_MAX = 200
/** A template assigned to more skills than this is almost certainly a mis-edit, not a workflow. */
const SKILLS_MAX = 50

/** Sensible built-ins (issue #413: "a small set of reusable prompt templates"). Order is the
 *  order they render in the menu and in Settings. */
export const DEFAULT_PROMPT_TEMPLATES: readonly PromptTemplate[] = [
  {
    id: 'add-tests',
    label: 'Add tests',
    text: 'Also add or update tests covering this change.',
  },
  {
    id: 'explain-change',
    label: 'Explain the change',
    text: 'Explain what changed and why before finishing.',
  },
  {
    id: 'keep-minimal',
    label: 'Keep it minimal',
    text: 'Keep the change as small and targeted as possible — no unrelated refactors.',
  },
  {
    id: 'update-docs',
    label: 'Update docs',
    text: 'Also update any relevant documentation or comments.',
  },
  {
    id: 'check-edge-cases',
    label: 'Double-check edge cases',
    text: 'Double-check edge cases and error handling before finishing.',
  },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

/**
 * Coerce the `promptTemplates` ui-state field (or anything read from it) into a usable list.
 *
 * `undefined` (the key was never written — first run, or an old ui-state.json) is the only case
 * that falls back to the built-ins; a present-but-malformed value degrades the same way (garbage
 * must not brick the menu), but a deliberately EMPTY array (`[]`) stays empty — a user who
 * cleared every template gets no templates, not the defaults reappearing underneath them.
 */
export function normalizePromptTemplates(raw: unknown): PromptTemplate[] {
  if (raw === undefined) return DEFAULT_PROMPT_TEMPLATES.map((template) => ({ ...template }))
  if (!Array.isArray(raw)) return DEFAULT_PROMPT_TEMPLATES.map((template) => ({ ...template }))

  const seen = new Set<string>()
  const out: PromptTemplate[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    const label = typeof entry.label === 'string' ? entry.label.trim() : ''
    const text = typeof entry.text === 'string' ? entry.text.trim() : ''
    if (!id || !label || !text || seen.has(id)) continue
    seen.add(id)
    const skills = normalizeAssignedSkills(entry.skills)
    out.push({
      id,
      label: label.slice(0, LABEL_MAX),
      text: text.slice(0, TEXT_MAX),
      // Omitted rather than `[]` when empty: "assigned to nothing" and "no assignment field" mean
      // the same thing, and keeping one shape keeps the Settings dirty-check (a JSON compare)
      // from seeing a phantom edit on every load of an old ui-state.json.
      ...(skills.length > 0 ? { skills } : {}),
    })
    if (out.length >= LIST_MAX) break
  }
  return out
}

/** Assigned skill names: same "garbage degrades, never throws" contract as the list itself —
 *  a non-array, or entries that are not usable names, simply yield no assignment. */
function normalizeAssignedSkills(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const name = entry.trim()
    if (!name || seen.has(name)) continue
    seen.add(name.slice(0, SKILL_NAME_MAX))
    if (seen.size >= SKILLS_MAX) break
  }
  return [...seen]
}

/** Templates assigned to ANY of `skillNames`, in list order (so Settings' ordering decides what
 *  a multi-skill selection stacks up as, not the order the skills happened to be toggled). */
export function templatesForSkills(
  templates: readonly PromptTemplate[],
  skillNames: readonly string[],
): PromptTemplate[] {
  if (skillNames.length === 0) return []
  const wanted = new Set(skillNames)
  return templates.filter((template) => template.skills?.some((name) => wanted.has(name)))
}

/** The prompt text a skill selection auto-applies: every assigned template, blank-line separated
 *  (the `insertTemplate` separator, so a stacked auto-apply reads like a hand-stacked one).
 *  No assignments → `''`, which callers treat as "auto-apply contributes nothing". */
export function autoApplyText(
  templates: readonly PromptTemplate[],
  skillNames: readonly string[],
): string {
  return templatesForSkills(templates, skillNames)
    .map((template) => template.text)
    .join('\n\n')
}

/**
 * Resolve what the prompt box should hold after a skill selection changes.
 *
 * The one hard rule (#413 follow-up: "auto applied *if user didnt enter prompt yet*"): text the
 * user typed is NEVER overwritten. Auto-apply may only write into a box that is either empty or
 * still holds exactly what a previous auto-apply put there — so re-picking skills reshuffles the
 * auto-applied text, but the moment you type, the box is yours and stays yours.
 *
 * Clearing the box by hand opts back in (`current === ''`), which is the same "empty means
 * untouched" test the box started with — no hidden mode a user can get stuck in.
 *
 * `previousAuto` is what this function last returned as `applied` ('' on first run). Returning it
 * back out (rather than having the caller track it) keeps the whole rule pure and testable.
 *
 * `base` is text the box is PRE-FILLED with and that auto-apply must preserve rather than
 * overwrite — the GitHub hand-off's item reference (#524). "Untouched" widens to "empty OR still
 * exactly the base", and auto-applied text stacks below the base, blank-line separated like
 * `insertTemplate`. A caller that passes no base (`new-task.tsx`) gets the original rule exactly.
 *
 * `applied` reports only genuinely auto-applied text, never the bare base — otherwise clearing
 * the box by hand would leave `current` matching neither `base` nor `previousAuto`, and the box
 * would be stuck "user-owned" forever, silently killing auto-apply for that item.
 */
export function resolveAutoApply(
  current: string,
  previousAuto: string,
  nextAuto: string,
  base = '',
): { text: string; applied: string } {
  if (current === '' || current === base || current === previousAuto) {
    const text = base && nextAuto ? `${base}\n\n${nextAuto}` : base || nextAuto
    return { text, applied: nextAuto ? text : '' }
  }
  // The user owns the box now — leave it alone, and keep remembering the auto text we wrote, so
  // that clearing it back to empty later re-opens the door above.
  return { text: current, applied: previousAuto }
}

/** A fresh id for a template a user adds in Settings — client-side only, never sent anywhere
 *  else, so a timestamp+random suffix is plenty (no collision handling needed beyond that). */
export function makeTemplateId(): string {
  return `tpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Insert `snippet` into `text` at `caret`, separated from whatever is already there by a blank
 * line (so stacking a few templates reads as separate instructions, not a run-on sentence).
 * Empty text is a plain assignment — no leading blank line for the first template. Returns the
 * caret position right after the inserted snippet so the caller can restore focus there.
 *
 * BOTH sides are separated: a caret parked mid-text (the user clicked back into the box to fix a
 * typo, then picked a template) would otherwise splice the snippet straight onto the tail —
 * "Fix\n\nAlso add tests. the bug". Each side only gets what it is missing, so the result is
 * idempotent and never grows more than one blank line or leaves trailing whitespace.
 */
export function insertTemplate(
  text: string,
  caret: number,
  snippet: string,
): { text: string; caret: number } {
  const safeCaret = Math.max(0, Math.min(caret, text.length))
  const before = text.slice(0, safeCaret)
  const after = text.slice(safeCaret)

  let leading = ''
  if (before.length > 0) {
    if (before.endsWith('\n\n')) leading = ''
    else if (before.endsWith('\n')) leading = '\n'
    else leading = '\n\n'
  }

  // The tail is about to start a line of its own, so the SPACES that used to separate it from the
  // caret ("ALPHA| OMEGA" → the space before OMEGA) would become leading indentation on that line,
  // which is never what was meant. Horizontal whitespace only, and stripped BEFORE `trailing` is
  // measured: a leading newline is part of the separator we are about to complete, not padding —
  // eating it ("One.\n|Two." → "One.\n\nSNIP\nTwo.") would cost the blank line this is all for.
  const tail = after.replace(/^[ \t]+/, '')

  let trailing = ''
  if (tail.length > 0) {
    if (tail.startsWith('\n\n')) trailing = ''
    else if (tail.startsWith('\n')) trailing = '\n'
    else trailing = '\n\n'
  }

  return {
    text: before + leading + snippet + trailing + tail,
    // Right after the snippet itself — the trailing separator belongs to the tail, not to the
    // text the user just inserted.
    caret: before.length + leading.length + snippet.length,
  }
}
