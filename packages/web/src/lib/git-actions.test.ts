import { describe, expect, it } from 'vitest'

import type { RunStatus } from '@open-mercato/cezar-api-client'

import { gitActionPolicy, type GitActionState } from './git-actions'

/**
 * The git action policy, pinned row by row. The run's git button renders whatever this returns —
 * one action or nothing — so these tables ARE the button's behavior spec: the right step for
 * every state, and every disabled step carrying its human reason.
 */

const PR = 'https://github.com/acme/demo/pull/7'

/** A healthy baseline: worktree + uncommitted work + never pushed + github forge + remote, no PR. */
const base: GitActionState = {
  status: 'review',
  hasWorktree: true,
  branch: 'cez/abc12345',
  uncommitted: 3,
  unpushed: null,
  remote: 'git@github.com:acme/demo.git',
  forge: { kind: 'github', available: true },
}

const withState = (extra: Partial<GitActionState>): GitActionState => ({ ...base, ...extra })
const id = (extra: Partial<GitActionState>) => gitActionPolicy(withState(extra))?.id ?? null

describe('gitActionPolicy — the one action', () => {
  it.each<[string, Partial<GitActionState>, string | null]>([
    // no PR yet
    ['no PR → Create PR (it commits and pushes on its own)', {}, 'create-pr'],
    ['no PR, everything committed → still Create PR', { uncommitted: 0 }, 'create-pr'],
    // Regression: autosave leaves finished tasks with nothing uncommitted, and Create PR used to
    // hide behind a stale `+0 −0` diffStat. It needs nothing from `git status` at all.
    ['no PR, git status still loading → Create PR', { uncommitted: undefined }, 'create-pr'],
    // a PR
    ['PR + uncommitted changes → Commit and push', { prUrl: PR, uncommitted: 2, unpushed: 0 }, 'commit-push'],
    ['PR + uncommitted AND unpushed → Commit and push (one step publishes both)', { prUrl: PR, uncommitted: 2, unpushed: 1 }, 'commit-push'],
    ['PR + uncommitted but no remote to push to → plain Commit', { prUrl: PR, uncommitted: 2, unpushed: 0, remote: undefined }, 'commit'],
    ['PR + unpushed commits → Push', { prUrl: PR, uncommitted: 0, unpushed: 2 }, 'push'],
    ['PR + nothing to commit or push → nothing', { prUrl: PR, uncommitted: 0, unpushed: 0 }, null],
    ['PR + no upstream to compare with → nothing', { prUrl: PR, uncommitted: 0, unpushed: null }, null],
    ['PR merged → nothing, whatever the worktree holds', { prUrl: PR, prStatus: 'merged', uncommitted: 2 }, null],
    ['PR closed → nothing', { prUrl: PR, prStatus: 'closed', unpushed: 3 }, null],
    // behind the base branch
    ['no PR but behind the base → Update branch instead of Create PR', { behind: 3 }, 'update-branch'],
    ['no PR, up to date → Create PR', { behind: 0 }, 'create-pr'],
    ['no PR, base unknown → Create PR', { behind: null }, 'create-pr'],
    ['behind but the agent cannot be reached → Create PR stays (being behind blocks nothing)', { behind: 3, agentBlocked: 'no agent session to resume' }, 'create-pr'],
    ['PR + uncommitted, behind → Commit and push first', { prUrl: PR, uncommitted: 2, unpushed: 0, behind: 3 }, 'commit-push'],
    ['PR published but behind → Update branch', { prUrl: PR, uncommitted: 0, unpushed: 0, behind: 3 }, 'update-branch'],
    ['PR conflicting AND behind → Resolve conflicts (it merges the base anyway)', { prUrl: PR, uncommitted: 0, unpushed: 0, behind: 3, prConflicting: true }, 'resolve-conflicts'],
    ['PR behind AND failing CI → Update branch first', { prUrl: PR, uncommitted: 0, unpushed: 0, behind: 3, prStatus: 'checks-failing' }, 'update-branch'],
    ['no forge, everything pushed but behind → Update branch', { forge: null, uncommitted: 0, unpushed: 0, behind: 2 }, 'update-branch'],
    // the PR's own health, once everything is published
    ['PR conflicting → Resolve conflicts', { prUrl: PR, uncommitted: 0, unpushed: 0, prConflicting: true }, 'resolve-conflicts'],
    ['PR with failing CI → Fix errors', { prUrl: PR, uncommitted: 0, unpushed: 0, prStatus: 'checks-failing' }, 'fix-checks'],
    ['conflicts AND failing CI → conflicts first (CI reruns on the merge)', { prUrl: PR, uncommitted: 0, unpushed: 0, prConflicting: true, prStatus: 'checks-failing' }, 'resolve-conflicts'],
    ['conflicting but local work unpublished → that work first', { prUrl: PR, uncommitted: 2, unpushed: 0, prConflicting: true }, 'commit-push'],
    ['failing CI but commits unpushed → Push (it may be the fix)', { prUrl: PR, uncommitted: 0, unpushed: 1, prStatus: 'checks-failing' }, 'push'],
    ['checks still pending → nothing', { prUrl: PR, uncommitted: 0, unpushed: 0, prStatus: 'checks-pending' }, null],
    ['conflict state unknown → nothing', { prUrl: PR, uncommitted: 0, unpushed: 0, prConflicting: undefined }, null],
    // no forge: a PR cannot be opened here
    ['no forge + uncommitted → Commit and push', { forge: null }, 'commit-push'],
    ['no forge + committed, never pushed → Push', { forge: null, uncommitted: 0 }, 'push'],
    ['no forge + all pushed → nothing', { forge: null, uncommitted: 0, unpushed: 0 }, null],
    // nothing known
    ['no worktree → nothing', { hasWorktree: false }, null],
    ['a PR, git status still loading → nothing (no flash of a wrong step)', { prUrl: PR, uncommitted: undefined }, null],
  ])('%s', (_name, extra, expected) => {
    expect(id(extra)).toBe(expected)
  })
})

describe('gitActionPolicy — the agent-driven steps', () => {
  it('say why when the agent cannot be reached', () => {
    const action = gitActionPolicy(
      withState({ prUrl: PR, uncommitted: 0, unpushed: 0, prConflicting: true, agentBlocked: 'no agent session to resume' }),
    )
    expect(action).toMatchObject({ id: 'resolve-conflicts', enabled: false })
    expect(action?.reason).toBe('Resolve conflicts unavailable — no agent session to resume')
  })
})

describe('gitActionPolicy — Create PR can be taken as a draft', () => {
  it('Create PR carries Create draft PR as its one alternative', () => {
    expect(gitActionPolicy(base)?.alternatives).toEqual([
      { id: 'create-draft-pr', label: 'Create draft PR', enabled: true },
    ])
  })

  it('no other step has alternatives — the button stays one action', () => {
    expect(gitActionPolicy(withState({ prUrl: PR }))?.alternatives).toBeUndefined()
    expect(gitActionPolicy(withState({ prUrl: PR, uncommitted: 0, unpushed: 1 }))?.alternatives).toBeUndefined()
  })

  it('a Create PR that cannot run offers no draft either — same reason, same block', () => {
    expect(gitActionPolicy(withState({ status: 'running' }))?.alternatives).toBeUndefined()
  })
})

describe('gitActionPolicy — a chosen step that cannot run right now says why', () => {
  it('Create PR while the agent still owns the run', () => {
    const action = gitActionPolicy(withState({ status: 'running' }))
    expect(action).toMatchObject({ id: 'create-pr', enabled: false })
    expect(action?.reason).toContain('still active')
  })

  it.each<[Partial<GitActionState>, string]>([
    [{ forge: { kind: 'github', available: false, reason: 'gh is not logged in' } }, 'gh is not logged in'],
    [{ forge: { kind: 'github', available: false } }, 'unreachable'],
    [{ branch: undefined }, 'no worktree'],
  ])('Create PR disabled for %j', (extra, phrase) => {
    const action = gitActionPolicy(withState(extra))
    expect(action).toMatchObject({ id: 'create-pr', enabled: false })
    expect(action?.reason).toContain(phrase)
  })

  it('Commit and push while the agent is writing in the worktree', () => {
    const action = gitActionPolicy(withState({ prUrl: PR, status: 'running' }))
    expect(action).toMatchObject({ id: 'commit-push', label: 'Commit and push', enabled: false })
    expect(action?.reason).toBe('Commit and push unavailable — the agent is still working in this worktree')
  })

  it.each<RunStatus>(['waiting', 'review', 'done', 'failed', 'cancelled'])(
    'Commit stays available while the run is %s (only running blocks it)',
    (status) => {
      expect(gitActionPolicy(withState({ prUrl: PR, status }))).toMatchObject({ id: 'commit-push', enabled: true })
    },
  )

  it('Push without a remote — the spec sentence, verbatim', () => {
    const action = gitActionPolicy(withState({ prUrl: PR, uncommitted: 0, unpushed: 1, remote: undefined }))
    expect(action).toMatchObject({ id: 'push', enabled: false, reason: 'Push unavailable — no remote configured' })
  })

  it('every action it returns is either enabled or explains itself', () => {
    const states: Partial<GitActionState>[] = [
      { status: 'running' },
      { forge: null, remote: undefined, uncommitted: 0 },
      { prUrl: PR, status: 'running' },
      { prUrl: PR, uncommitted: 0, unpushed: 1, branch: undefined },
    ]
    for (const extra of states) {
      const action = gitActionPolicy(withState(extra))
      if (action && !action.enabled) expect(action.reason, JSON.stringify(extra)).toBeTruthy()
    }
  })
})
