import type {
  HarnessCouncilRecord,
  HarnessInvocationRecord,
  HarnessLedgerResponse,
  HarnessPhaseRecord,
  RunEvent,
} from '@open-mercato/cezar-api-client'

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function replaceBy<T>(
  values: readonly T[],
  next: T,
  matches: (value: T, next: T) => boolean,
): T[] {
  const index = values.findIndex((value) => matches(value, next))
  if (index === -1) return [...values, next]
  const copy = [...values]
  copy[index] = next
  return copy
}

function phaseFrom(value: unknown): HarnessPhaseRecord | null {
  const row = record(value)
  return row && typeof row.id === 'string' && typeof row.status === 'string'
    ? (row as HarnessPhaseRecord)
    : null
}

function councilFrom(value: unknown): HarnessCouncilRecord | null {
  const row = record(value)
  return row && typeof row.round === 'number' && typeof row.kind === 'string'
    ? (row as HarnessCouncilRecord)
    : null
}

function invocationFrom(value: unknown): HarnessInvocationRecord | null {
  const row = record(value)
  return row && typeof row.id === 'string' && typeof row.phaseId === 'string'
    ? (row as HarnessInvocationRecord)
    : null
}

/**
 * Fold persisted + live harness events over the durable snapshot. Entity updates carry complete
 * records; feedback resets discard the previous implementation cycle before its next updates.
 * Reconnect replay is idempotent and never needs a second socket or a polling interval.
 */
export function mergeHarnessLedger(
  snapshot: HarnessLedgerResponse | undefined,
  events: readonly RunEvent[],
): HarnessLedgerResponse | undefined {
  if (!snapshot) return undefined
  let ledger: HarnessLedgerResponse = {
    ...snapshot,
    phases: [...(snapshot.phases ?? [])],
    models: [...(snapshot.models ?? [])],
    councils: [...(snapshot.councils ?? [])],
    invocations: [...(snapshot.invocations ?? [])],
    pendingMessages: [...(snapshot.pendingMessages ?? [])],
    stage: { ...snapshot.stage },
    outcome: { ...snapshot.outcome },
  }

  for (const event of events) {
    if (event.seq <= (snapshot.snapshotSeq ?? 0)) continue
    if (event.type === 'harness.feedback.applied' && typeof event.phaseId === 'string') {
      // A new cycle starts again at round 1. Keeping an earlier round 3 would make it
      // win currentImplementationCouncil forever while the authoritative read is in flight.
      const start = ledger.phases.findIndex((phase) => phase.id === event.phaseId)
      ledger = {
        ...ledger,
        councils: ledger.councils.filter((council) => council.kind !== 'implementation'),
        phases: ledger.phases.map((phase, index) => start >= 0 && index >= start
          ? { ...phase, status: 'pending', startedAt: undefined, endedAt: undefined, error: undefined }
          : phase),
        stage: { status: 'pending' },
        outcome: { status: 'pending', blockingReasons: [] },
      }
      continue
    }
    if (event.type === 'harness.phase.updated') {
      const phase = phaseFrom(event.phase)
      if (phase) ledger = { ...ledger, phases: replaceBy(ledger.phases, phase, (a, b) => a.id === b.id) }
      continue
    }
    if (event.type === 'harness.readiness.updated' && Array.isArray(event.models)) {
      ledger = { ...ledger, models: event.models as HarnessLedgerResponse['models'] }
      continue
    }
    if (event.type === 'harness.council.updated') {
      const council = councilFrom(event.council)
      if (council) {
        ledger = {
          ...ledger,
          councils: replaceBy(
            ledger.councils,
            council,
            (a, b) => a.round === b.round && a.kind === b.kind,
          ),
        }
      }
      continue
    }
    if (event.type === 'harness.invocation.updated') {
      const invocation = invocationFrom(event.invocation)
      if (invocation) {
        ledger = {
          ...ledger,
          invocations: replaceBy(ledger.invocations, invocation, (a, b) => a.id === b.id),
        }
      }
      continue
    }
    if (event.type === 'harness.stage.updated') {
      const stage = record(event.stage)
      if (stage && typeof stage.status === 'string') {
        ledger = { ...ledger, stage: stage as HarnessLedgerResponse['stage'] }
      }
      continue
    }
    if (event.type === 'harness.outcome.updated') {
      const outcome = record(event.outcome)
      if (outcome && typeof outcome.status === 'string') {
        ledger = { ...ledger, outcome: outcome as HarnessLedgerResponse['outcome'] }
      }
      continue
    }
    if (event.type === 'harness.message.consumed' && Array.isArray(event.messageIds)) {
      const consumed = new Set(event.messageIds.filter((id): id is string => typeof id === 'string'))
      ledger = {
        ...ledger,
        pendingMessages: ledger.pendingMessages.map((message) =>
          consumed.has(message.id) && !message.consumedAt
            ? { ...message, consumedAt: event.ts }
            : message,
        ),
      }
    }
  }
  return ledger
}

/**
 * The snapshot with `events` folded in and `snapshotSeq` moved to the newest harness event applied,
 * or undefined when the window holds nothing newer — so a cache write can never move it backwards.
 * The thread's window is bounded: what is not written back is lost on compaction.
 */
export function foldHarnessSnapshot(
  snapshot: HarnessLedgerResponse | undefined,
  events: readonly RunEvent[],
): HarnessLedgerResponse | undefined {
  if (!snapshot) return undefined
  const from = snapshot.snapshotSeq ?? 0
  let through = from
  for (const event of events) {
    if (event.seq > through && event.type.startsWith('harness.')) through = event.seq
  }
  if (through === from) return undefined
  return { ...mergeHarnessLedger(snapshot, events)!, snapshotSeq: through }
}

/** True when older history is unloaded and the window starts past `coveredSeq`: harness events in
 *  between were never seen, so only a fresh snapshot can account for them. */
export function harnessWindowGap(
  coveredSeq: number,
  events: readonly RunEvent[],
  hasOlder: boolean,
): boolean {
  const oldest = events[0]?.seq
  return hasOlder && oldest !== undefined && oldest > coveredSeq + 1
}

/** Whether the rail has anything to draw — the thread reserves its column only then. */
export function harnessRailHasContent(ledger: Pick<HarnessLedgerResponse, 'phases' | 'models'>): boolean {
  return ledger.phases.length > 0 || ledger.models.length > 0
}

export function activeHarnessPhase(ledger: HarnessLedgerResponse): HarnessPhaseRecord | undefined {
  return [...ledger.phases].reverse().find((phase) => phase.status === 'running')
}

export function currentImplementationCouncil(
  ledger: HarnessLedgerResponse,
): HarnessCouncilRecord | undefined {
  return ledger.councils
    .filter((council) => council.kind === 'implementation')
    .sort((a, b) => b.round - a.round)[0]
}

/** Newest council of any kind — the fallback when no implementation round has
 *  started yet (a spec council is still a council worth showing). */
export function latestCouncil(ledger: HarnessLedgerResponse): HarnessCouncilRecord | undefined {
  return [...ledger.councils].sort((a, b) => b.round - a.round)[0]
}

/**
 * The council every reviewer surface reads.
 *
 * Shared so the rail, the Review table and the drawer cannot disagree about
 * WHICH council they are showing: the rail row you click has to resolve to a
 * reviewer the drawer can find, or clicking it silently does nothing.
 */
export function displayedCouncil(ledger: HarnessLedgerResponse): HarnessCouncilRecord | undefined {
  return currentImplementationCouncil(ledger) ?? latestCouncil(ledger)
}

/** `runner/model` — show the model, which is the part that identifies it. */
export function shortModelName(id: string): string {
  const slash = id.indexOf('/')
  return slash > 0 ? id.slice(slash + 1) : id
}


/**
 * The blocking reasons as a LIST.
 *
 * The driver sometimes writes them as one semicolon-joined string, so a caller
 * that trusts `blockingReasons.length` reports "1 unresolved" for five findings
 * — which is what the run rail said while the banner beside it said five
 * (review 2026-07-27). One splitter, so every surface counts the same way.
 */
export function blockingReasonList(ledger: HarnessLedgerResponse): string[] {
  return ledger.outcome.blockingReasons.flatMap((entry) =>
    entry
      .split(/;\s+(?=\[)/)
      .map((part) => part.trim())
      .filter(Boolean),
  )
}

/**
 * `run.steps` in EXECUTION order for a harness run. The ledger's phases are
 * appended as they start, so their order is the ground truth; runs recorded
 * before the store inserted dynamic steps at the execution point (b32408a1)
 * hold them appended at the tail — Stage read as "step 7 of 19" on a run
 * whose stage ran last. Steps the ledger has not seen yet (a live run's
 * still-pending predeclared steps) keep their stored relative order after
 * the started ones — which is exactly where they belong in time.
 */
export function orderStepsByLedger<T extends { id: string }>(
  steps: readonly T[],
  ledger: Pick<HarnessLedgerResponse, 'phases'> | undefined,
): T[] {
  if (!ledger || ledger.phases.length === 0) return [...steps]
  const rank = new Map(ledger.phases.map((phase, index) => [phase.id, index] as const))
  const started = steps
    .filter((step) => rank.has(step.id))
    .sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)
  const pending = steps.filter((step) => !rank.has(step.id))
  return [...started, ...pending]
}

// Lives apart so the git toolbar, which every task view loads, never pulls this module in.
export { harnessPublishBlockedReason } from './harness-publish'
