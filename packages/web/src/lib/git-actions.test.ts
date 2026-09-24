import { describe, expect, it } from 'vitest'

import type { RunStatus } from '@open-mercato/cezar-api-client'

import { gitActionPolicy, type GitActionState } from './git-actions'

/**
 * The git action policy, pinned row by row. The toolbar renders whatever this function
 * returns, so these tables ARE the toolbar's behavior spec: every disabled entry must carry
 * its human reason, hosted mode must HIDE the terminal handoff (not disable it), and the
 * Create PR → View PR flip must follow the PR URL exactly.
 */

/** A healthy local-mode baseline: worktree + changes + github forge + remote + session. */
const base: GitActionState = {
  status: 'review',
  hasWorktree: true,
  branch: 'cez/abc12345',
  changedFiles: 3,
  remote: 'git@github.com:acme/demo.git',
  forge: { kind: 'github', available: true },
  localHandoff: true,
  hasSession: true,
}

const withState = (extra: Partial<GitActionState>): GitActionState => ({ ...base, ...extra })

const find = (state: GitActionState, id: string) => {
  const bar = gitActionPolicy(state)
  return [bar.primary, ...bar.secondary, ...bar.menu].find((a) => a.id === id)
}

describe('gitActionPolicy — slots', () => {
  it('without a PR: Commit is primary, Push + Create PR secondary, terminal in the menu', () => {
    const bar = gitActionPolicy(base)
    expect(bar.primary).toEqual({ id: 'commit', label: 'Commit', enabled: true })
    expect(bar.secondary.map((a) => a.id)).toEqual(['push', 'create-pr'])
    expect(bar.menu.map((a) => a.id)).toEqual(['open-terminal'])
  })

  it('with a PR URL: View PR takes primary (with the href) and Create PR disappears', () => {
    const bar = gitActionPolicy(withState({ prUrl: 'https://github.com/acme/demo/pull/7' }))
    expect(bar.primary).toEqual({
      id: 'view-pr',
      label: 'View PR',
      enabled: true,
      href: 'https://github.com/acme/demo/pull/7',
    })
    expect(bar.secondary.map((a) => a.id)).toEqual(['commit', 'push'])
    expect(bar.secondary.every((a) => a.id !== 'create-pr')).toBe(true)
  })

  it('every disabled action carries a reason — no mute buttons anywhere', () => {
    // A worst-case state: no worktree, no forge, no remote, hosted off, no session.
    const bar = gitActionPolicy(
      withState({
        hasWorktree: false,
        branch: undefined,
        changedFiles: undefined,
        remote: undefined,
        forge: null,
        hasSession: false,
      }),
    )
    for (const action of [bar.primary, ...bar.secondary, ...bar.menu]) {
      if (!action.enabled) {
        expect(action.reason, `${action.id} must explain itself`).toBeTruthy()
      }
    }
  })
})

describe('gitActionPolicy — commit', () => {
  it('enabled when the worktree has changes and the agent is not mid-turn', () => {
    expect(find(base, 'commit')).toEqual({ id: 'commit', label: 'Commit', enabled: true })
  })

  it.each<[Partial<GitActionState>, string]>([
    [{ hasWorktree: false }, 'no worktree'],
    [{ status: 'running' }, 'still working'],
    [{ changedFiles: undefined }, 'still loading'],
    [{ changedFiles: 0 }, 'no changes to commit'],
  ])('disabled with a reason for %j', (extra, phrase) => {
    const action = find(withState(extra), 'commit')
    expect(action?.enabled).toBe(false)
    expect(action?.reason).toContain(phrase)
  })

  it.each<RunStatus>(['waiting', 'review', 'done', 'failed', 'cancelled'])(
    'stays available while the run is %s (only running blocks it)',
    (status) => {
      expect(find(withState({ status }), 'commit')?.enabled).toBe(true)
    },
  )
})

describe('gitActionPolicy — push', () => {
  it('enabled with a worktree, a branch and a remote', () => {
    expect(find(base, 'push')).toEqual({ id: 'push', label: 'Push', enabled: true })
  })

  it('the spec sentence, verbatim: no remote configured', () => {
    const action = find(withState({ remote: undefined }), 'push')
    expect(action?.enabled).toBe(false)
    expect(action?.reason).toBe('Push unavailable — no remote configured')
  })

  it.each<[Partial<GitActionState>, string]>([
    [{ hasWorktree: false }, 'no worktree'],
    [{ branch: undefined }, 'no branch'],
    [{ status: 'running' }, 'still working'],
  ])('disabled with a reason for %j', (extra, phrase) => {
    const action = find(withState(extra), 'push')
    expect(action?.enabled).toBe(false)
    expect(action?.reason).toContain(phrase)
  })
})

describe('gitActionPolicy — create PR', () => {
  it('enabled when parked with a worktree, branch and an available forge', () => {
    expect(find(base, 'create-pr')).toEqual({ id: 'create-pr', label: 'Create PR', enabled: true })
  })

  it.each<[Partial<GitActionState>, string]>([
    [{ hasWorktree: false }, 'no worktree'],
    [{ branch: undefined }, 'no worktree'],
    [{ forge: null }, 'no supported forge remote'],
    [{ forge: { kind: 'github', available: false, reason: 'gh is not logged in' } }, 'gh is not logged in'],
    [{ forge: { kind: 'github', available: false } }, 'unreachable'],
    [{ status: 'running' }, 'still active'],
    [{ status: 'queued' }, 'still active'],
    [{ status: 'waiting' }, 'still active'],
  ])('disabled with a reason for %j', (extra, phrase) => {
    const action = find(withState(extra), 'create-pr')
    expect(action?.enabled).toBe(false)
    expect(action?.reason).toContain(phrase)
  })

  it.each<RunStatus>(['review', 'done', 'failed', 'cancelled'])('enabled once the run is %s', (status) => {
    expect(find(withState({ status }), 'create-pr')?.enabled).toBe(true)
  })
})

describe('gitActionPolicy — terminal handoff (localHandoff gate)', () => {
  it('hosted mode hides the entry entirely — an empty menu, not a disabled row', () => {
    expect(gitActionPolicy(withState({ localHandoff: false })).menu).toEqual([])
  })

  it('local mode with a parked session offers it', () => {
    expect(gitActionPolicy(base).menu).toEqual([
      { id: 'open-terminal', label: 'Open in terminal', enabled: true },
    ])
  })

  it.each<[Partial<GitActionState>, string]>([
    [{ hasSession: false }, 'no agent session'],
    [{ status: 'running' }, 'still active'],
    [{ status: 'queued' }, 'still active'],
    [{ status: 'waiting' }, 'still active'],
  ])('disabled with a reason for %j', (extra, phrase) => {
    const [action] = gitActionPolicy(withState(extra)).menu
    expect(action?.enabled).toBe(false)
    expect(action?.reason).toContain(phrase)
  })
})
