import { shortAge } from '@/lib/format'
import type { ArtifactsBySubjectResponse, RunArtifactVersion, RunStatus } from '@open-mercato/cezar-api-client'

/**
 * Assess Impact's pure half (spec 2026-10-22-html-artifacts-and-impact § UI/UX → PR detail,
 * Git → Files, task chip): which state the shared control is in, and the small rules around it.
 */

export const IMPACT_FILE = 'impact.html'

/** `.ai/specs/**\/*.md` — the only repository files that get the control. */
const SPEC_PATH_RE = /^\.ai\/specs\/(?:[^/]+\/)*[^/]+\.md$/

export function isSpecPath(path: string | null | undefined): path is string {
  if (!path || !SPEC_PATH_RE.test(path)) return false
  return !path.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')
}

const ACTIVE: ReadonlySet<RunStatus> = new Set<RunStatus>(['queued', 'running', 'waiting'])

export type ImpactState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  /** No run has this subject, or the newest ended without a report (`note` says how). */
  | { kind: 'assess'; runId?: string; note?: string }
  | { kind: 'assessing'; runId: string }
  | { kind: 'open'; runId: string; stale: boolean; meta: string }

/**
 * `liveStatus`: the run's status from the stream-patched runs list, which moves before the
 * subject answer is refetched — so Assessing… flips without a poll.
 */
export function impactState(
  answer: ArtifactsBySubjectResponse | undefined,
  opts: { pending: boolean; error?: Error | null; liveStatus?: RunStatus; now?: number },
): ImpactState {
  if (opts.error) return { kind: 'error', message: opts.error.message }
  if (opts.pending || answer === undefined) return { kind: 'loading' }
  if (answer.run === null) return { kind: 'assess' }
  const runId = answer.run.id
  const status = opts.liveStatus ?? answer.run.status
  const impact = answer.artifacts.find((artifact) => artifact.name === IMPACT_FILE)
  // A report, once rendered, is openable even while the session lives on (parked at `waiting`, or
  // revising after a correction — the last good version stays served, R4).
  if (!impact && ACTIVE.has(status)) return { kind: 'assessing', runId }
  if (!impact) {
    const note =
      status === 'failed' ? 'The last assessment failed without a report.'
      : status === 'cancelled' ? 'The last assessment was stopped before its report.'
      : 'The last assessment ended without a report.'
    return { kind: 'assess', runId, note }
  }
  const sha = answer.subject.kind === 'pr' ? answer.subject.headSha : answer.subject.blobSha
  const meta = impactMeta(sha, impact.updatedAt, answer.versions, opts.now)
  return { kind: 'open', runId, stale: answer.stale === true, meta }
}

/** `abc1234 · 2h ago · v3` — the version only once a revision was kept. */
export function impactMeta(
  sha: string,
  updatedAt: string,
  versions: readonly RunArtifactVersion[] | undefined,
  now: number = Date.now(),
): string {
  const age = shortAge(updatedAt, now)
  const parts = [sha.slice(0, 7), age ? `${age} ago` : '']
  const newest = versions?.at(-1)
  if (newest) parts.push(`v${newest.version}`)
  return parts.filter(Boolean).join(' · ')
}

export function impactAssetsPath(runId: string): string {
  return `/tasks/${runId}/assets/${IMPACT_FILE}`
}

/** Runs that already took their one auto-switch to Assets, for this browser session (spec § "The
 *  moment an artifact appears": once, never again after the user leaves). */
const AUTO_SWITCH_KEY = 'cez-impact-auto-switched'
const AUTO_SWITCH_CAP = 50

function readAutoSwitched(): string[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(AUTO_SWITCH_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

export function hasAutoSwitched(runId: string): boolean {
  return readAutoSwitched().includes(runId)
}

export function markAutoSwitched(runId: string): void {
  try {
    const ids = [...readAutoSwitched().filter((id) => id !== runId), runId].slice(-AUTO_SWITCH_CAP)
    sessionStorage.setItem(AUTO_SWITCH_KEY, JSON.stringify(ids))
  } catch {
    // Storage blocked: the in-memory guard in the hook still holds for this visit.
  }
}
