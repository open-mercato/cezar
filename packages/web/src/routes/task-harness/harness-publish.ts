import type { HarnessLedgerResponse } from '@open-mercato/cezar-api-client'

/**
 * Why a harness run may not be published yet — or undefined when it may (and for every
 * ordinary run). The cockpit's mirror of the server's `harnessPublishBlockReason`: the
 * stage-only contract (spec 2026-07-23-harness-orchestration) holds commit, push and PR until
 * the run reaches its review gate AND the ledger proves a ready staged outcome, or the user
 * accepted a contested one.
 */
export function harnessPublishBlockedReason(
  run: { harness?: unknown; status: string },
  ledger: HarnessLedgerResponse | undefined,
): string | undefined {
  if (!run.harness) return undefined
  if (!['review', 'done'].includes(run.status)) {
    return 'Stage-only: this harness run has not reached its review gate — publishing stays yours after review.'
  }
  if (!ledger) return 'Harness recovery snapshot is unavailable. Publishing stays blocked until it is restored.'
  if (ledger.stage.status !== 'staged') return 'The harness has not produced a verified staged handoff.'
  const { outcome } = ledger
  if (outcome.status === 'ready') return undefined
  const acceptedContested =
    outcome.status === 'contested' &&
    outcome.acceptedAt !== undefined &&
    outcome.acceptedBy === 'user' &&
    outcome.acceptanceReason !== undefined &&
    (ledger.decisions ?? []).some(
      (decision) =>
        decision.kind === 'accept-contested' &&
        decision.by === 'user' &&
        decision.at === outcome.acceptedAt &&
        decision.detail === outcome.acceptanceReason,
    )
  if (acceptedContested) return undefined
  return outcome.status === 'contested'
    ? 'Accept the unresolved harness risk in the Review tab before finishing or publishing.'
    : `Harness outcome is ${outcome.status}. Publishing requires a verified ready outcome.`
}
