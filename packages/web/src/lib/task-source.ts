import type { UiState } from '@open-mercato/cezar-api-client'

/**
 * What a start surface runs: a named workflow or a single skill.
 *
 * Here rather than beside the composer's own form rules (`routes/new-task-form.ts`, which
 * re-exports both) because the shared source picker and the automations editor need them too, and
 * a `components/` module must not reach into a `routes/` one. The shape is the one the server's
 * `ui-state.json` stores as `lastTask`, so persistence needs no mapping.
 */
export type TaskSource = NonNullable<UiState['lastTask']>

/** The zero-config built-in: one agent step that runs the prompt. It is what a task with NO
 *  source picked runs as, which is why the picker does not also offer it as a workflow row —
 *  "No skill" and "quick-task" would be two names for one run. */
export const QUICK_TASK = 'quick-task'
