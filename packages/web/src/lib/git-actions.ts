import type { RunStatus } from '@open-mercato/cezar-api-client'

/**
 * The git action policy object (spec §"Session git view — Changes & Files tabs (#390)",
 * borrowed from paseo): ONE pure function of git/forge/capability state deciding which
 * actions the Changes toolbar offers, in which slot, enabled or not — and every disabled
 * entry carries the human reason ("Push unavailable — no remote configured").
 *
 * The toolbar component renders WHATEVER this returns and nothing else — no inline
 * conditionals over git state in JSX. That is the whole point: the rules live here, where a
 * table test can pin every row, and the component stays a dumb projector.
 */

export interface GitActionState {
  status: RunStatus
  /** The record names a worktree AND the server can still see it — a 409 "no worktree" from
   *  `/changes` must flip this false even when `worktreePath` is set. */
  hasWorktree: boolean
  /** The run's branch (absent on worktree-less runs). */
  branch?: string
  /** `stat.files` from `/changes`; undefined while the answer is still loading/unknown. */
  changedFiles?: number
  /** The repo's remote from `/api/health` (`repo.remote`); undefined when none configured. */
  remote?: string
  /** `/api/health` `forge` — null means no supported forge remote (plain-git features only). */
  forge: { kind: 'github'; available: boolean; reason?: string } | null
  /** `/api/health` `capabilities.localHandoff`. False (or unknown) = hosted mode: local-
   *  machine actions are HIDDEN entirely, never shown disabled. */
  localHandoff: boolean
  /** Whether any step recorded an agent session — the terminal handoff resumes it. */
  hasSession: boolean
  /** The run's PR, once known — flips Create PR into View PR. */
  prUrl?: string
}

export type GitActionId = 'commit' | 'push' | 'create-pr' | 'view-pr' | 'open-terminal'

export interface GitAction {
  id: GitActionId
  label: string
  enabled: boolean
  /** Present exactly when disabled — the human sentence the button shows as its tooltip. */
  reason?: string
  /** `view-pr` only: the PR's web URL. */
  href?: string
}

export interface GitActionBar {
  /** The one accent CTA. */
  primary: GitAction
  /** Outline/ghost buttons next to it, in order. */
  secondary: GitAction[]
  /** Overflow entries (kebab). Empty array = no menu at all. */
  menu: GitAction[]
}

/** "Active" as the engine means it: the session/queue still owns the run. `review` is parked,
 *  not active — same rule as run-actions.ts `isRunActive`. */
const isActive = (status: RunStatus): boolean =>
  status === 'running' || status === 'queued' || status === 'waiting'

const NO_WORKTREE_REASON = 'no worktree — this task ran directly in the repo working tree'

function commitAction(state: GitActionState): GitAction {
  const disabled = (reason: string): GitAction => ({ id: 'commit', label: 'Commit', enabled: false, reason })
  if (!state.hasWorktree) return disabled(`Commit unavailable — ${NO_WORKTREE_REASON}`)
  if (state.status === 'running') return disabled('Commit unavailable — the agent is still working in this worktree')
  if (state.changedFiles === undefined) return disabled('Commit unavailable — changes are still loading')
  if (state.changedFiles === 0) return disabled('Commit unavailable — no changes to commit')
  return { id: 'commit', label: 'Commit', enabled: true }
}

function pushAction(state: GitActionState): GitAction {
  const disabled = (reason: string): GitAction => ({ id: 'push', label: 'Push', enabled: false, reason })
  if (!state.hasWorktree) return disabled(`Push unavailable — ${NO_WORKTREE_REASON}`)
  if (state.remote === undefined) return disabled('Push unavailable — no remote configured')
  if (state.branch === undefined) return disabled('Push unavailable — the run has no branch to push')
  if (state.status === 'running') return disabled('Push unavailable — the agent is still working in this worktree')
  return { id: 'push', label: 'Push', enabled: true }
}

function createPrAction(state: GitActionState): GitAction {
  const disabled = (reason: string): GitAction => ({
    id: 'create-pr',
    label: 'Create PR',
    enabled: false,
    reason,
  })
  if (!state.hasWorktree || state.branch === undefined) {
    return disabled(`Create PR unavailable — ${NO_WORKTREE_REASON}`)
  }
  if (state.forge === null) {
    return disabled('Create PR unavailable — no supported forge remote (GitHub) detected')
  }
  if (!state.forge.available) {
    return disabled(`Create PR unavailable — ${state.forge.reason ?? 'the forge is unreachable'}`)
  }
  // The server refuses `POST /pr` while the engine owns the run — mirror it honestly here
  // rather than letting the click discover the 409.
  if (isActive(state.status)) {
    return disabled('Create PR unavailable — the run is still active; wait for the review gate')
  }
  return { id: 'create-pr', label: 'Create PR', enabled: true }
}

/**
 * The policy. Slots:
 *  - primary: **View PR** once a PR URL is known, otherwise **Commit** (the workhorse).
 *  - secondary: **Push**, then **Create PR** while there is no PR yet.
 *  - menu: **Open in terminal** (the open-in-cli session handoff) — present ONLY in local
 *    mode; hosted mode (`localHandoff: false`) hides it entirely, per the deployment-modes
 *    doctrine (hidden, not disabled — there is no "my machine" to explain a disable with).
 */
export function gitActionPolicy(state: GitActionState): GitActionBar {
  const primary: GitAction = state.prUrl
    ? { id: 'view-pr', label: 'View PR', enabled: true, href: state.prUrl }
    : commitAction(state)

  const secondary: GitAction[] = state.prUrl
    ? [commitAction(state), pushAction(state)]
    : [pushAction(state), createPrAction(state)]

  const menu: GitAction[] = []
  if (state.localHandoff) {
    // Same gate as the header's Terminal button (run-actions.ts): the engine must have let
    // go of the session, and there must be one to resume.
    const terminal: GitAction = !state.hasSession
      ? {
          id: 'open-terminal',
          label: 'Open in terminal',
          enabled: false,
          reason: 'Terminal unavailable — no agent session to resume',
        }
      : isActive(state.status)
        ? {
            id: 'open-terminal',
            label: 'Open in terminal',
            enabled: false,
            reason: 'Terminal unavailable — the session is still active in the engine',
          }
        : { id: 'open-terminal', label: 'Open in terminal', enabled: true }
    menu.push(terminal)
  }

  return { primary, secondary, menu }
}
