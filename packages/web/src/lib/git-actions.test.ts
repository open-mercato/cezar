import { describe, expect, it } from 'vitest'

import type { RunStatus } from '@open-mercato/cezar-api-client'

import { gitActionPolicy, trunkGitActionPolicy, type GitActionState } from './git-actions'

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
    ['no PR, commits over the base → Create PR', { uncommitted: 0, ahead: 2 }, 'create-pr'],
    ['no PR, even with the base but uncommitted work → Create PR (it commits first)', { uncommitted: 2, ahead: 0 }, 'create-pr'],
    ['no PR, base unknown and clean → Create PR (the server decides)', { uncommitted: 0, ahead: null }, 'create-pr'],
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
    ['no PR but behind the base → still Create PR (Update branch rides under its chevron)', { behind: 3 }, 'create-pr'],
    // Telemetry 16aef26d: an empty branch was offered, pushed, then refused by gh. Not even offered now.
    ['no PR, nothing changed → no button at all', { uncommitted: 0, ahead: 0 }, null],
    ['no PR, nothing changed, even behind → no button', { uncommitted: 0, ahead: 0, behind: 4 }, null],
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

  it('behind its base, Create PR offers Update branch under the chevron too', () => {
    expect(gitActionPolicy(withState({ behind: 3 }))?.alternatives).toEqual([
      { id: 'create-draft-pr', label: 'Create draft PR', enabled: true },
      { id: 'update-branch', label: 'Update branch', enabled: true },
    ])
  })

  it('no other step has alternatives — the button stays one action', () => {
    expect(gitActionPolicy(withState({ prUrl: PR }))?.alternatives).toBeUndefined()
    expect(gitActionPolicy(withState({ prUrl: PR, uncommitted: 0, unpushed: 1 }))?.alternatives).toBeUndefined()
  })

  it('a Create PR that cannot run offers no draft either — same reason, same block', () => {
    expect(gitActionPolicy(withState({ status: 'running', agentBlocked: 'no agent session to resume' }))?.alternatives).toBeUndefined()
  })
})

describe('gitActionPolicy — a chosen step that cannot run right now says why', () => {
  it.each<[RunStatus, string]>([
    ['running', 'the agent is still working'],
    ['queued', 'the agent is still working'],
    // "needs you": the turn is over but the session is open — the server still refuses (409).
    ['waiting', 'end the session to open a PR'],
  ])('Create PR by the server (no agent to ask) while the engine owns a %s run', (status, phrase) => {
    const action = gitActionPolicy(withState({ status, agentBlocked: 'no agent session to resume' }))
    expect(action).toMatchObject({ id: 'create-pr', enabled: false })
    expect(action?.reason).toContain(phrase)
  })

  it.each<RunStatus>(['running', 'queued', 'waiting'])(
    'Create PR by the agent is offered while the run is %s — the agent takes it in its session',
    (status) => {
      expect(gitActionPolicy(withState({ status }))).toMatchObject({ id: 'create-pr', enabled: true })
    },
  )

  it.each<[Partial<GitActionState>]>([
    [{ uncommitted: 0, ahead: 2 }],
    [{ uncommitted: 1, ahead: 0 }],
    [{ uncommitted: 0, ahead: null }],
    [{ uncommitted: undefined, ahead: undefined }],
  ])('Create PR stays enabled for %j — committed work, dirty tree, or an unknown answer', (extra) => {
    expect(gitActionPolicy(withState(extra))).toMatchObject({ id: 'create-pr', enabled: true })
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

  it('Commit and push by the server (no agent to ask) while the agent is writing in the worktree', () => {
    const action = gitActionPolicy(withState({ prUrl: PR, status: 'running', agentBlocked: 'no agent session to resume' }))
    expect(action).toMatchObject({ id: 'commit-push', label: 'Commit and push', enabled: false })
    expect(action?.reason).toBe('Commit and push unavailable — the agent is still working in this worktree')
  })

  it.each<RunStatus>(['waiting', 'review', 'done', 'failed', 'cancelled'])(
    'Commit by the server stays available while the run is %s (only running blocks it)',
    (status) => {
      expect(gitActionPolicy(withState({ prUrl: PR, status, agentBlocked: 'no agent session to resume' }))).toMatchObject({ id: 'commit-push', enabled: true })
    },
  )

  it('Commit and push or Push by the agent stay available mid-turn: the agent takes them next', () => {
    expect(gitActionPolicy(withState({ prUrl: PR, status: 'running' }))).toMatchObject({ id: 'commit-push', enabled: true })
    expect(gitActionPolicy(withState({ prUrl: PR, status: 'running', uncommitted: 0, unpushed: 1 }))).toMatchObject({
      id: 'push',
      enabled: true,
    })
  })

  it('Push without a remote — the spec sentence, verbatim', () => {
    const action = gitActionPolicy(withState({ prUrl: PR, uncommitted: 0, unpushed: 1, remote: undefined }))
    expect(action).toMatchObject({ id: 'push', enabled: false, reason: 'Push unavailable — no remote configured' })
  })

  it('every action it returns is either enabled or explains itself', () => {
    const states: Partial<GitActionState>[] = [
      { status: 'running', agentBlocked: 'no agent session to resume' },
      { forge: null, remote: undefined, uncommitted: 0 },
      { prUrl: PR, status: 'running', agentBlocked: 'no agent session to resume' },
      { prUrl: PR, uncommitted: 0, unpushed: 1, branch: undefined },
    ]
    for (const extra of states) {
      const action = gitActionPolicy(withState(extra))
      if (action && !action.enabled) expect(action.reason, JSON.stringify(extra)).toBeTruthy()
    }
  })
})

describe('trunkGitActionPolicy (spec 2026-10-20-trunk-based-projects)', () => {
  const forge = { kind: 'github', available: true } as GitActionState['forge']
  const base = { status: 'waiting' as RunStatus, base: 'main', uncommitted: 2, unpushed: 0, behind: 0, forge }

  it('offers Commit to the base branch, with Create PR under the chevron', () => {
    const action = trunkGitActionPolicy(base)
    expect(action).toMatchObject({ id: 'land', label: 'Commit to main', enabled: true })
    expect(action?.alternatives?.map((a) => a.id)).toEqual(['create-pr', 'create-draft-pr'])
  })

  it('adds Update branch while the remote is ahead, and offers only that when nothing is pending', () => {
    expect(trunkGitActionPolicy({ ...base, behind: 3 })?.alternatives?.map((a) => a.id)).toContain('update-branch')
    expect(trunkGitActionPolicy({ ...base, uncommitted: 0, behind: 3 })).toMatchObject({ id: 'update-branch', enabled: true })
    expect(trunkGitActionPolicy({ ...base, uncommitted: 0 })).toBeNull()
    expect(trunkGitActionPolicy({ ...base, uncommitted: undefined })).toBeNull()
  })

  it('lands committed-but-unpushed work too, and waits while the agent works', () => {
    expect(trunkGitActionPolicy({ ...base, uncommitted: 0, unpushed: 1 })).toMatchObject({ id: 'land', enabled: true })
    expect(trunkGitActionPolicy({ ...base, status: 'running' })).toMatchObject({ id: 'land', enabled: false })
  })

  it('keeps Commit and disables Create PR without a forge', () => {
    const action = trunkGitActionPolicy({ ...base, forge: null })
    expect(action).toMatchObject({ id: 'land', enabled: true })
    expect(action?.alternatives?.[0]).toMatchObject({ id: 'create-pr', enabled: false })
  })
})

describe('an impact run (spec 2026-10-22-html-artifacts-and-impact, Q11)', () => {
  it('offers no Create PR and no Create draft PR', () => {
    expect(gitActionPolicy(withState({ assessment: true }))).toBeNull()
    expect(gitActionPolicy(withState({ assessment: true, uncommitted: 0, ahead: 2 }))).toBeNull()
    // Without the flag the same state is Create PR, with the draft under its chevron.
    expect(gitActionPolicy(withState({}))?.alternatives?.map((a) => a.id)).toContain('create-draft-pr')
  })

  it('drops both PR steps from the trunk chevron', () => {
    const forge = { kind: 'github', available: true } as GitActionState['forge']
    const trunk = { status: 'waiting' as RunStatus, base: 'main', uncommitted: 2, unpushed: 0, behind: 0, forge, assessment: true }
    expect(trunkGitActionPolicy(trunk)?.alternatives?.map((a) => a.id)).toEqual([])
  })
})
