import type { Runner } from '@open-mercato/cezar-api-client'
import type { TaskSource } from './new-task-form'

/**
 * The new-task draft store (spec: "Queued form state survives navigation (draft store)").
 *
 * localStorage-backed so the form is refresh-resilient: stepping away to check a thread — or
 * accidentally reloading the tab — loses nothing. Nulls mean "the user has not chosen" — the
 * form falls back to persisted/last-used/default values, so an untouched draft never shadows a
 * fresher `lastTask` from the server. Images are deliberately NOT persisted (multi-MB base64
 * would blow the ~5 MB localStorage quota); everything the pickers hold is.
 *
 * Every entry point takes the project the draft belongs to (multi-project spec, step 3.4) —
 * see `storageKey` below for what scopes what.
 */
export interface NewTaskDraft {
  text: string
  source: TaskSource | null
  runner: Runner | null
  /** Per-task agent account (spec 2026-07-29-agent-profiles). `null` = follow the project's own
   *  selection, which is what every draft that never touched the control means. Sticky like the
   *  other pickers — which login a repo's work runs under is a way of working, not a whim. */
  agentProfile: string | null
  model: string | null
  variants: number
  /** The `Start | Plan first` toggle (#383). Sticky like the pickers: plan-first is a way of
   *  working, not a per-task whim — it survives navigation with the rest of the draft. */
  planFirst: boolean
  /** Worktree opt-out (#worktree-toggle): false runs in the repo working tree. null → the
   *  remembered `lastWorktree` / default (isolated worktree). */
  worktree: boolean | null
  /** Autonomous (#autonomous): true never pauses for the user. null → remembered
   *  `lastAutonomous` / default (off). */
  autonomous: boolean | null
  /** Follow-up generation is default-on. null → remembered value / on. */
  generateFollowups: boolean | null
}

export interface ComposerRunModeInput {
  hasGit: boolean
  variants: number
  planFirst: boolean
  explicitAutonomous: boolean | null
  explicitWorktree: boolean | null
  interactive?: boolean
  configuredAutonomous: boolean | 'source-dependent'
  configuredWorktree: boolean
  source: TaskSource['source']
}

/** Resolve run-mode values once, in precedence order: hard constraints, explicit draft
 * choices, an interactive-skill recommendation, then the configured (or source-dependent)
 * default. Parallel variants are the only hard Worktree constraint; ordinary workflows can
 * run in place when the user or workspace policy opts out. `configuredAutonomous`/
 * `configuredWorktree` carry the workspace run defaults; `'source-dependent'` autonomy means
 * skills default on and everything else off. */
export function resolveComposerRunMode(input: ComposerRunModeInput): {
  autonomous: boolean
  worktree: boolean
} {
  const autonomousFallback = input.configuredAutonomous === 'source-dependent'
    ? input.source === 'skill'
    : input.configuredAutonomous
  const recommended = input.interactive === true ? false : undefined
  const autonomous = input.planFirst
    ? false
    : (input.explicitAutonomous ?? recommended ?? autonomousFallback)
  const worktree = !input.hasGit
    ? false
    : input.variants > 1
      ? true
      : (input.explicitWorktree ?? recommended ?? input.configuredWorktree)
  return { autonomous, worktree }
}

const EMPTY: NewTaskDraft = {
  text: '',
  source: null,
  runner: null,
  agentProfile: null,
  model: null,
  variants: 1,
  planFirst: false,
  worktree: null,
  autonomous: null,
  generateFollowups: null,
}

const STORAGE_KEY = 'cez-new-task-draft'

/**
 * The per-project storage key (multi-project spec, "New task": `cez-new-task-draft:<projectId>`).
 *
 * Drafts are project state — a half-typed task for the shop frontend must not surface in the
 * cezar composer when the project pill swaps scope — so each project gets its own key.
 *
 * `null` (the argument's default) keeps the BARE legacy key. That is the same "unscoped means
 * byte-identical" invariant the rest of step 3.1 keeps (`apiPath`, `queryScope`): the boot
 * project mounts unscoped, so its draft stays exactly where it has always been and a task typed
 * before this upgrade is still there after it. Only non-boot projects pay the suffix.
 */
function storageKey(projectId: string | null): string {
  return projectId === null ? STORAGE_KEY : `${STORAGE_KEY}:${projectId}`
}

/** Coerce arbitrary parsed JSON back into a NewTaskDraft, defaulting anything malformed — the
 *  store must survive a hand-edited or older-shape localStorage value without throwing. */
function normalize(raw: unknown): NewTaskDraft {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    text: typeof obj.text === 'string' ? obj.text : '',
    source: isSource(obj.source) ? obj.source : null,
    runner: typeof obj.runner === 'string' ? (obj.runner as Runner) : null,
    agentProfile: typeof obj.agentProfile === 'string' ? obj.agentProfile : null,
    model: typeof obj.model === 'string' ? obj.model : null,
    variants: obj.variants === 2 || obj.variants === 3 ? obj.variants : 1,
    planFirst: obj.planFirst === true,
    worktree: typeof obj.worktree === 'boolean' ? obj.worktree : null,
    autonomous: typeof obj.autonomous === 'boolean' ? obj.autonomous : null,
    generateFollowups:
      typeof obj.generateFollowups === 'boolean' ? obj.generateFollowups : null,
  }
}

function isSource(raw: unknown): raw is TaskSource {
  return (
    !!raw &&
    typeof raw === 'object' &&
    ((raw as TaskSource).source === 'skill' || (raw as TaskSource).source === 'workflow') &&
    typeof (raw as TaskSource).ref === 'string'
  )
}

// In-memory cache mirrors storage so reads stay synchronous and cheap; storage is the source of
// truth across reloads. Keyed by storage key, so one open cockpit holds every project's draft
// independently — swapping the pill back and forth never round-trips through a stale singleton.
const cache = new Map<string, NewTaskDraft>()

export function readDraft(projectId: string | null = null): NewTaskDraft {
  const key = storageKey(projectId)
  const cached = cache.get(key)
  if (cached) return { ...cached }
  let draft: NewTaskDraft
  try {
    const stored = localStorage.getItem(key)
    draft = stored ? normalize(JSON.parse(stored)) : { ...EMPTY }
  } catch {
    draft = { ...EMPTY } // private mode / bad JSON — start clean, still works this session
  }
  cache.set(key, draft)
  return { ...draft }
}

export function writeDraft(next: NewTaskDraft, projectId: string | null = null): void {
  const key = storageKey(projectId)
  cache.set(key, { ...next })
  try {
    localStorage.setItem(key, JSON.stringify(next))
  } catch {
    // Storage disabled/full — the in-memory cache still survives navigation this session.
  }
}

/** After a successful submit: the text is spent, the picker choices remain — the next task
 *  usually runs the same way (legacy keeps its pills too). */
export function clearDraftText(projectId: string | null = null): void {
  writeDraft({ ...readDraft(projectId), text: '' }, projectId)
}

/** Test isolation — drop EVERY project's cache and stored draft, so the next read re-consults
 *  storage (a fresh page). */
export function resetDraft(): void {
  cache.clear()
  try {
    for (const key of Object.keys(localStorage)) {
      if (key === STORAGE_KEY || key.startsWith(`${STORAGE_KEY}:`)) localStorage.removeItem(key)
    }
  } catch {
    // ignore
  }
}
