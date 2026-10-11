import type { ForgeInfo, RunStatus } from '@open-mercato/cezar-api-client'

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
  /** Files `git add -A` would commit (`GET /runs/:id/git/status`); undefined while loading. */
  uncommitted?: number
  /** Commits the upstream has not seen; null = never pushed; undefined while loading. */
  unpushed?: number | null
  /** Commits on the task's base branch (as last fetched) that the branch lacks; null = unknown. */
  behind?: number | null
  /** The repo's remote from `/api/health` (`repo.remote`); undefined when none configured. */
  remote?: string
  /** `/api/v1/health` `forge` — null means no supported forge remote (plain-git features only).
   *  The DTO rather than a local copy: `available` is OPTIONAL there (absent until the
   *  availability probe warms), and re-declaring it here is what hid that. */
  forge: ForgeInfo | null
  /** The run's PR — created or declared — once known. */
  prUrl?: string
  /** The forge's word on that PR. Merged (or closed) means it is finished: nothing to offer;
   *  `checks-failing` means CI needs the agent. */
  prStatus?: string
  /** The forge says the PR's branch will not merge into its base. Only `true` means anything. */
  prConflicting?: boolean
  /** Why a prompt cannot reach the task's agent right now (no session, provider down) — the
   *  agent-driven steps (Resolve conflicts, Fix errors) render disabled with it. */
  agentBlocked?: string
}

export type GitActionId =
  | 'commit'
  | 'push'
  | 'commit-push'
  | 'create-pr'
  | 'create-draft-pr'
  | 'update-branch'
  | 'resolve-conflicts'
  | 'fix-checks'

export interface GitAction {
  id: GitActionId
  label: string
  enabled: boolean
  /** Present exactly when disabled — the human sentence the button shows as its tooltip. */
  reason?: string
  /** The same step, said differently — tucked under the button's chevron. Only Create PR has one
   *  (Create draft PR); every other step stays a plain button. */
  alternatives?: GitAction[]
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
  if (state.uncommitted === undefined) return disabled('Commit unavailable — changes are still loading')
  if (state.uncommitted === 0) return disabled('Commit unavailable — no changes to commit')
  return { id: 'commit', label: 'Commit', enabled: true }
}

/**
 * Committing is never the goal — publishing is. So while there is uncommitted work the step is ONE
 * action, **Commit and push** (the commit dialog, then the push once the commit lands). It degrades
 * to plain Commit only when a push could not follow (no remote, no branch), so the work can still
 * be saved locally. Its availability is the commit's: the push is the part that can wait.
 */
function commitAndPushAction(state: GitActionState): GitAction {
  const commit = commitAction(state)
  // Could a push follow at all? Asked of the remote and branch only — the commit has not
  // produced the commits yet, so neither `unpushed` nor the run's status should decide it.
  const pushable = pushAction({ ...state, unpushed: undefined, status: 'done' }).enabled
  if (!pushable) return commit
  return {
    ...commit,
    id: 'commit-push',
    label: 'Commit and push',
    ...(commit.reason ? { reason: commit.reason.replace(/^Commit unavailable/, 'Commit and push unavailable') } : {}),
  }
}

function pushAction(state: GitActionState): GitAction {
  const disabled = (reason: string): GitAction => ({ id: 'push', label: 'Push', enabled: false, reason })
  if (!state.hasWorktree) return disabled(`Push unavailable — ${NO_WORKTREE_REASON}`)
  if (state.remote === undefined) return disabled('Push unavailable — no remote configured')
  if (state.branch === undefined) return disabled('Push unavailable — the run has no branch to push')
  if (state.status === 'running') return disabled('Push unavailable — the agent is still working in this worktree')
  if (state.unpushed === 0) return disabled('Push unavailable — the remote already has every commit')
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
  return {
    id: 'create-pr',
    label: 'Create PR',
    enabled: true,
    alternatives: [{ id: 'create-draft-pr', label: 'Create draft PR', enabled: true }],
  }
}

/**
 * The policy: AT MOST ONE action — the next step to get this work out of the worktree, or null
 * when there is none. No menu: one button, one meaning.
 *
 *  - No worktree, or the PR merged / closed → nothing.
 *  - Behind its base branch → **Update branch** instead of Create PR (and after Commit and push /
 *    Push / Resolve conflicts once a PR exists): the agent merges the base in.
 *  - No PR yet → **Create PR**, always: it commits what is left and pushes on its own (the
 *    server's final autosave), and needs nothing from `git status` — so it is offered even while
 *    that answer is loading or failed. Deliberately NOT gated on the run's `diffStat`: autosave
 *    leaves a finished task with nothing uncommitted, and a stale `+0 −0` beside it hid the button
 *    on tasks that had real work to publish. An empty branch gets the server's own refusal.
 *    Without a supported forge a PR cannot be opened, so the step falls back to Commit, then Push.
 *  - A PR, or no forge → nothing until `git status` has answered (no flash of a wrong step).
 *  - A PR → **Commit and push** while there are uncommitted changes (one step: the commit dialog,
 *    then the push), else **Push** while the PR is behind on commits that are already made.
 *  - A PR with everything published → **Resolve conflicts** when its branch will not merge, then
 *    **Fix errors** when CI is red; otherwise nothing. Local work goes first because the
 *    agent's merge (or fix) would otherwise start from a stale or dirty tree — and pushing is
 *    often exactly what turns the checks green.
 *
 * The chosen step can still be unavailable right now (the agent is mid-turn, no remote): it then
 * renders disabled, its reason as the tooltip — the button never silently disappears for a
 * reason the reader could fix.
 */
export function gitActionPolicy(state: GitActionState): GitAction | null {
  if (!state.hasWorktree) return null
  if (state.prStatus === 'merged' || state.prStatus === 'closed') return null
  // Behind its base: catch up FIRST — a PR opened from a stale branch only moves the problem into
  // review. Offered only while the agent can take it; otherwise the next step stays available,
  // because being behind does not block anything by itself.
  const update =
    state.behind !== undefined && state.behind !== null && state.behind > 0 && !state.agentBlocked
      ? agentStep(state, 'update-branch', 'Update branch')
      : null
  if (!state.prUrl && state.forge !== null) return update ?? createPrAction(state)
  if (state.uncommitted === undefined) return null
  const hasUncommitted = state.uncommitted > 0
  if (!state.prUrl) {
    if (hasUncommitted) return commitAndPushAction(state)
    if (state.unpushed !== 0) return pushAction(state)
    return update
  }
  if (hasUncommitted) return commitAndPushAction(state)
  if (state.unpushed !== undefined && state.unpushed !== null && state.unpushed > 0) return pushAction(state)
  // Everything is published, so what is left is the PR's own health — and fixing it is the agent's
  // job: these steps send it a prompt in this task's own conversation. Conflicts first (resolving
  // them merges the base anyway), then catching up with the base, then CI.
  if (state.prConflicting === true) return agentStep(state, 'resolve-conflicts', 'Resolve conflicts')
  if (update) return update
  if (state.prStatus === 'checks-failing') return agentStep(state, 'fix-checks', 'Fix errors')
  return null
}

function agentStep(state: GitActionState, id: GitActionId, label: string): GitAction {
  return state.agentBlocked
    ? { id, label, enabled: false, reason: `${label} unavailable — ${state.agentBlocked}` }
    : { id, label, enabled: true }
}
