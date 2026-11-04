import type { RunRecord, WaitEdge } from '@open-mercato/cezar-api-client'

/**
 * Cross-task waits in the cockpit (spec `.ai/specs/2026-10-05-cross-task-waits.md` § UI/UX) — the
 * pure half: which edges are live, where a target lives, how long until a deadline, and which runs
 * a waiter may still wait for. The components in `components/task-waits.tsx` only render these.
 */

/** The statuses a target cannot be waited on in any more — waiting for them answers at once. */
const SETTLED: readonly string[] = ['done', 'review', 'failed', 'cancelled']

/** The edges still holding the run parked. */
export function pendingWaits(run: Pick<RunRecord, 'waits'>): WaitEdge[] {
  return (run.waits ?? []).filter((edge) => edge.state === 'pending')
}

/**
 * The cockpit path of a wait's target: inside the active project a flat `/tasks/<id>` (the scoped
 * `Link` prefixes it), anywhere else an explicit `/p/<project>/tasks/<id>` that the scoped `Link`
 * leaves alone. `default` is the boot alias, which `/p/default/…` already answers.
 */
export function waitTargetPath(edge: Pick<WaitEdge, 'target'>, activeProjectId: string | null, bootProjectId?: string | null): string {
  const { projectId, runId } = edge.target
  // `null` (the unscoped mount) and `default` both mean the boot project; so does its own id.
  const norm = (id: string | null) => (id === null || id === 'default' ? (bootProjectId ?? 'default') : id)
  return norm(projectId) === norm(activeProjectId) ? `/tasks/${runId}` : `/p/${encodeURIComponent(projectId)}/tasks/${runId}`
}

/** "23 h", "12 min", "a moment" — the time left before a deadline, coarse on purpose. */
export function timeLeftLabel(deadline: string, now: number): string {
  const ms = Date.parse(deadline) - now
  if (!Number.isFinite(ms) || ms <= 60_000) return 'a moment'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h`
  return `${Math.round(hours / 24)} days`
}

/**
 * The runs the "Wait for task…" picker offers: not yet settled, never the waiter itself, matched
 * case-insensitively on the title or the id prefix. Newest first — the task you are thinking of is
 * usually the one you just started.
 */
export function waitCandidates<T extends Pick<RunRecord, 'id' | 'title' | 'titleSummary' | 'status' | 'createdAt'>>(
  runs: readonly T[],
  waiterId: string | null,
  query: string,
): T[] {
  const needle = query.trim().toLowerCase()
  return runs
    .filter((run) => run.id !== waiterId && !SETTLED.includes(run.status))
    .filter((run) => {
      if (!needle) return true
      const title = (run.titleSummary ?? run.title).toLowerCase()
      return title.includes(needle) || run.id.toLowerCase().startsWith(needle)
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** The default deadline the picker offers, in minutes — the engine's own default (24 h). */
export const DEFAULT_WAIT_TIMEOUT_MINUTES = 24 * 60
