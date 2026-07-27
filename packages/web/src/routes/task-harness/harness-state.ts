import type {
  HarnessCouncilRecord,
  HarnessInvocationRecord,
  HarnessLedgerResponse,
  HarnessPacketRecord,
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

function packetFrom(value: unknown): HarnessPacketRecord | null {
  const row = record(value)
  return row && typeof row.id === 'string' ? (row as HarnessPacketRecord) : null
}

function invocationFrom(value: unknown): HarnessInvocationRecord | null {
  const row = record(value)
  return row && typeof row.id === 'string' && typeof row.phaseId === 'string'
    ? (row as HarnessInvocationRecord)
    : null
}

/**
 * Fold persisted + live harness events over the durable snapshot. Every event carries a complete
 * entity (phase, council, packet, invocation), so reconnect replay is idempotent and never needs
 * a second socket or a polling interval.
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
    packets: [...(snapshot.packets ?? [])],
    invocations: [...(snapshot.invocations ?? [])],
    pendingMessages: [...(snapshot.pendingMessages ?? [])],
    stage: { ...snapshot.stage },
    outcome: { ...snapshot.outcome },
  }

  for (const event of events) {
    if (event.seq <= (snapshot.snapshotSeq ?? 0)) continue
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
    if (event.type === 'harness.packet.updated') {
      const packet = packetFrom(event.packet)
      if (packet) {
        ledger = {
          ...ledger,
          packets: replaceBy(
            ledger.packets,
            packet,
            (a, b) =>
              (a.originalId ?? a.id) === (b.originalId ?? b.id),
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
