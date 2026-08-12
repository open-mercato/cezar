import type { RunRecord, RunStatus, Runner } from '@open-mercato/cezar-api-client'
import { cliTargetRunner } from '@/components/open-in-menu'

export { cliTargetRunner }


/**
 * The run header's action policy — WHICH actions a run offers, as a pure function of the
 * record, ported from the legacy header (web/app.js `updateDetail`) so both cockpits agree.
 * The header component only maps these booleans to buttons; every rule lives here where a
 * table test can pin it per status.
 */

/** "Active" in the legacy sense: the engine still owns the run (a queued run is parked but
 *  claimed). `review` is deliberately NOT active — a parked review can be continued, archived
 *  or deleted like any finished run. */
export function isRunActive(status: RunStatus): boolean {
  return status === 'running' || status === 'queued' || status === 'waiting'
}

/** The latest agent session across steps — what Continue/Terminal resume. */
export function lastSessionId(run: RunRecord): string | undefined {
  return [...run.steps].reverse().find((step) => step.sessionId)?.sessionId
}

/**
 * The session id shapes the backends mint — the mirror of the server's `SAFE_SESSION_ID`
 * (server.ts, #431). Kept in lockstep by hand: the cockpit bundles separately from the
 * server, so it cannot import it. Widen both or neither.
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,199}$/

/** The per-backend take-over command — mirrors the server's `resumeCommand` (server.ts), and
 *  like it treats records without a runner as Claude (they predate the choice).
 *
 *  Undefined for an id the server would refuse (#431): this string is offered to the user as a
 *  one-click copy for pasting into a terminal, so it is a shell splice of an agent-recorded id
 *  exactly like the server's take-over command. Validate rather than quote, for the same reason
 *  the server does — the paste target may be bash OR cmd.exe, and no charset here is special to
 *  either. Fails closed: no hint beats a hint that runs `rm -rf ~` on paste. */
export function resumeCommand(runner: Runner | undefined, sessionId: string): string | undefined {
  if (!SAFE_SESSION_ID.test(sessionId)) return undefined
  switch (runner) {
    case 'codex':
      return `codex resume ${sessionId}`
    case 'opencode':
      return `opencode --session ${sessionId}`
    default:
      return `claude --resume ${sessionId}`
  }
}

/** The copyable "take over interactively" line under the header — only once the engine has
 *  let go of the session (same gate as the Terminal button). Prefixes the `cd` when the run
 *  has its own worktree, because the resume only makes sense from in there. Absent for an id
 *  `resumeCommand` refuses (#431), exactly as for a run that never recorded a session. */
export function resumeHint(run: RunRecord): string | undefined {
  if (isRunActive(run.status)) return undefined
  const sessionId = lastSessionId(run)
  if (sessionId === undefined) return undefined
  const command = resumeCommand(run.runner, sessionId)
  if (command === undefined) return undefined
  return run.worktreePath ? `cd ${run.worktreePath} && ${command}` : command
}

/** Does picking this "Open in…" CLI target resume THIS run's own session, or start a fresh
 *  one (#402)? Only the backend that produced the session can resume it — a foreign CLI's
 *  session id means nothing to a different agent, so cross-runner picks always launch clean.
 *  Legacy runs with no `runner` recorded predate the runner choice and default to Claude, same
 *  as `resumeCommand`.
 *  Active runs never resume, same gate as `resumeHint`/`runActionFlags.terminal`: the engine
 *  seeds `sessionId` when the step STARTS (workflows/run.ts), so a running run already has one
 *  and would otherwise offer to attach a second CLI to the transcript the engine is driving.
 *  Those picks launch a fresh CLI in the worktree instead — what the server does too. */
export function cliTargetResumes(run: RunRecord, targetId: string): boolean {
  const runner = cliTargetRunner(targetId)
  if (!runner) return false
  if (isRunActive(run.status)) return false
  return runner === (run.runner ?? 'claude') && lastSessionId(run) !== undefined
}

export interface RunActionFlags {
  /** waiting → close the session; review → accept the changes without a PR. Both POST /finish. */
  finish: boolean
  /** Reopen the last agent session in-process. */
  continueRun: boolean
  /** Hand the session to a real terminal (open-in-cli). */
  terminal: boolean
  /** The handoff-notes panel — always available; an unseeded file is an honest empty state. */
  notes: boolean
  /** Archive when live, unarchive when archived — the record itself says which. */
  archive: boolean
  /** Stop an active run. Mutually exclusive with delete, by construction below. */
  cancel: boolean
  /** Remove the run, its transcript, worktree and branch. Terminal runs only. */
  deleteRun: boolean
}

export function runActionFlags(run: RunRecord): RunActionFlags {
  const active = isRunActive(run.status)
  const hasSession = lastSessionId(run) !== undefined
  return {
    finish: run.status === 'waiting' || run.status === 'review',
    continueRun: !active && hasSession,
    terminal: !active && hasSession,
    notes: true,
    archive: !active,
    cancel: active,
    deleteRun: !active,
  }
}

/** The Finish button's tooltip — review-gate accept reads differently from closing a session. */
export function finishTitle(status: RunStatus): string {
  return status === 'review' ? 'Accept the changes without a PR' : 'Close the session'
}

/**
 * 1-based position among the queued, unarchived runs, FIFO by `createdAt` — the legacy
 * queued-placeholder math (web/app.js `queuePosition`, spec 006). Undefined when the run is
 * not itself queued (or the list doesn't know it yet — SSE races the detail fetch).
 */
export function queuePosition(runs: RunRecord[], runId: string): number | undefined {
  const queued = runs
    .filter((run) => !run.archived && run.status === 'queued')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const index = queued.findIndex((run) => run.id === runId)
  return index >= 0 ? index + 1 : undefined
}
