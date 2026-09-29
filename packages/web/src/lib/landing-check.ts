import type { LandingCheck, RunEvent, RunRecord } from '@open-mercato/cezar-api-client'

/**
 * The landing check's UI vocabulary (spec `.ai/specs/2026-09-29-landing-check.md`, PR 5).
 *
 * Pure on purpose, like `lib/attention.ts`: the chip on a task row, the row link in the
 * invoking run's header and the card on the check run's thread all derive their state from the
 * ONE mapping below, so two surfaces can never disagree about what a verdict says.
 *
 * Two facts shape everything here:
 *
 *  - The record is written in TWO stages — the frozen subject first, the resolved commands and
 *    the verdict later — so "no verdict yet" is a normal, honest state (`checking`), not an
 *    error, and every renderer has to survive a subject-only record.
 *  - `landingCheckStale` is a READ-time fact the server attaches only where a verdict exists.
 *    A stale verdict keeps its text (the stored record is never rewritten); the marker is an
 *    additional fact about it, which is why the chip carries both.
 */

/** What the chip says — every state the record can produce, plus `stale` at read time. */
export type LandingCheckState =
  | 'checking'
  | 'passed'
  | 'failed'
  | 'conflict'
  | 'nothing-to-check'
  | 'could-not-run'
  | 'stale'

/** The tones the design system's dot carries; kept structurally local so this module stays
 *  UI-free (the same reason `lib/attention.ts` declares its own). */
export type LandingCheckTone = 'success' | 'pending' | 'danger' | 'neutral'

export interface LandingCheckChipState {
  state: LandingCheckState
  /** The verdict the chip reports — absent while `checking` (there is none yet). */
  verdict?: Exclude<LandingCheckState, 'checking' | 'stale'>
  label: string
  tone: LandingCheckTone
  pulse: boolean
  /** True when the server marked the recorded subject moved since the verdict was written. */
  stale: boolean
  /** One sentence for the chip's `title` — the full story, since the chip is 12px of it. */
  title: string
}

/** What a terminal run without a verdict means: the check ended without ever concluding. */
const VERDICT_LABEL: Record<Exclude<LandingCheckState, 'checking' | 'stale'>, string> = {
  passed: 'passed',
  failed: 'failed',
  conflict: 'conflict',
  'nothing-to-check': 'nothing to check',
  'could-not-run': 'could not run',
}

const STALE_TITLE =
  'the recorded base or a source moved since this verdict was written — re-run the check to get a verdict about what is there now'

export interface LandingCheckChipInput {
  status?: RunRecord['status']
  landingCheck: LandingCheck | undefined
  /** `ApiRun.landingCheckStale` — absent unless the server attached it for a verdict. */
  landingCheckStale?: boolean
}

/**
 * Can this run still move its landing check forward? `queued`, `running` and `waiting` can; a
 * terminal status cannot, and a status the record does not carry at all counts as live (the
 * caller does not KNOW it is over, and claiming "could not run" on a guess would be worse).
 *
 * ONE definition, read by both surfaces that must not disagree: the chip (where a terminal run
 * without a verdict reads `could-not-run` rather than pulsing `checking` forever) and the card's
 * stage trail (where a dead run must not paint a stage as success or say "applying…"). Two
 * copies of this predicate is exactly how they drift apart.
 */
export function landingCheckLive(status: RunRecord['status'] | undefined): boolean {
  return status === undefined || ['queued', 'running', 'waiting'].includes(status)
}

/**
 * `landingCheck` → the chip's state, or `undefined` for a run that is not a landing check.
 *
 * The one subtle case: a TERMINAL run with no verdict. Every engine path normally records one,
 * so reaching a terminal status without one means the check never concluded — reporting a
 * pulsing `checking` over a finished run would be a lie, and `could-not-run` is the honest name.
 */
export function landingCheckChip(input: LandingCheckChipInput): LandingCheckChipState | undefined {
  const check = input.landingCheck
  if (check === undefined) return undefined
  if (check.verdict === undefined) {
    if (landingCheckLive(input.status)) {
      return {
        state: 'checking',
        label: 'checking',
        tone: 'pending',
        pulse: true,
        stale: false,
        title: 'the check is still running — no verdict yet',
      }
    }
    return {
      state: 'could-not-run',
      label: VERDICT_LABEL['could-not-run'],
      verdict: 'could-not-run',
      tone: 'pending',
      pulse: false,
      stale: false,
      title: 'the check run ended without a verdict',
    }
  }
  const verdict = check.verdict
  const stale = input.landingCheckStale === true
  const reason = check.reason !== undefined ? ` — ${humanizeLandingReason(check.reason)}` : ''
  return {
    state: stale ? 'stale' : verdict,
    verdict,
    label: VERDICT_LABEL[verdict],
    // `nothing-to-check` is neutral and `could-not-run` is pending: neither may ever wear the
    // success tone. Only a `passed` verdict is green.
    tone: verdict === 'passed' ? 'success' : verdict === 'failed' || verdict === 'conflict' ? 'danger' : verdict === 'nothing-to-check' ? 'neutral' : 'pending',
    pulse: false,
    stale,
    title: stale
      ? `landing check ${VERDICT_LABEL[verdict]}${reason} — ${STALE_TITLE}`
      : `landing check ${VERDICT_LABEL[verdict]}${reason}`,
  }
}

/** `commands-changed-vs-base` → "commands changed vs base" — the record's reasons are slugs. */
export function humanizeLandingReason(reason: string): string {
  return reason.replace(/[-_]+/g, ' ').trim()
}

// ---- per-command rows ------------------------------------------------------------------------

export type LandingCheckOutcome = 'passed' | 'failed' | 'not-run' | 'could-not-run'

export interface LandingCheckRow {
  id: string
  kind: 'install' | 'command'
  command: string
  outcome: LandingCheckOutcome
  exitCode?: number | null
  /** The tail-preserving output from the run's own `check-output` event, when there is one. */
  output?: string
}

/** One `check-output` transcript event, narrowed off the wire's open envelope. */
interface CheckOutputEvent {
  command: string | undefined
  text: string | undefined
}

function outputEvents(events: readonly RunEvent[]): CheckOutputEvent[] {
  return events
    .filter((event) => event.type === 'check-output')
    .map((event) => ({
      command: typeof event.command === 'string' ? event.command : undefined,
      text: typeof event.text === 'string' ? event.text : undefined,
    }))
}

/**
 * The card's rows: the install step (when the frozen base declared one), then every recorded
 * gate command — in EXECUTION order, which `results` already is.
 *
 * The record keeps no output text (`results` carries command/exit/outcome/timings only), so a
 * row's tail comes from the run's own `check-output` event, matched by command and consumed in
 * order (the transcript is append-only and the check runs its commands serially, so the nth
 * occurrence of a command is the nth time it ran). No event → the row still renders with its
 * exit code and outcome; the tail is simply absent, never invented.
 */
export function landingCheckRows(check: LandingCheck, events: readonly RunEvent[]): LandingCheckRow[] {
  const outputs = outputEvents(events)
  let cursor = 0
  const take = (command: string): CheckOutputEvent | undefined => {
    for (let index = cursor; index < outputs.length; index += 1) {
      const candidate = outputs[index]!
      if (candidate.command === command) {
        cursor = index + 1
        return candidate
      }
    }
    return undefined
  }

  const rows: LandingCheckRow[] = []
  if (check.install !== undefined) {
    const command = check.install.argv.join(' ')
    const output = take(command)
    rows.push({
      id: 'install',
      kind: 'install',
      command,
      outcome: check.install.outcome,
      exitCode: check.install.exitCode,
      ...(output?.text !== undefined ? { output: output.text } : {}),
    })
  }
  for (const [index, result] of (check.results ?? []).entries()) {
    const output = take(result.command)
    rows.push({
      id: `check-${index + 1}`,
      kind: 'command',
      command: result.command,
      outcome: result.outcome,
      exitCode: result.exitCode,
      ...(output?.text !== undefined ? { output: output.text } : {}),
    })
  }
  return rows
}

/**
 * Gate steps the run's rail still holds as `pending` on a terminal run — commands the engine
 * stopped before running (it halts at the first non-green outcome). Shown as one muted line so
 * the card does not read as if every command ran.
 */
export function landingCheckNotRun(run: Pick<RunRecord, 'status' | 'steps'>): number {
  if (['queued', 'running', 'waiting'].includes(run.status)) return 0
  return run.steps.filter((step) => step.kind === 'check' && step.id !== 'install' && step.status === 'pending').length
}

// ---- the subject -----------------------------------------------------------------------------

export interface LandingSubjectFacts {
  baseRef: string
  baseSha: string
  sourceCount: number
  sourceRefs: readonly string[]
  treeSha?: string
  /** `runId (reason)` for every candidate the derivation left out, in record order. */
  excluded: readonly string[]
}

export function landingSubjectFacts(check: LandingCheck): LandingSubjectFacts {
  const subject = check.subject
  return {
    baseRef: subject.baseRef,
    baseSha: subject.baseSha,
    sourceCount: subject.sources.length,
    sourceRefs: subject.sources.map((source) => source.ref),
    ...(subject.treeSha !== undefined ? { treeSha: subject.treeSha } : {}),
    excluded: (subject.excluded ?? []).map(
      (entry) => `${entry.runId.slice(0, 8)} (${entry.reason})`,
    ),
  }
}

/** Short sha for display — the record's 40-char hex is noise in a one-line summary. */
export function shortSha(sha: string | undefined): string | undefined {
  return sha === undefined ? undefined : sha.slice(0, 8)
}
