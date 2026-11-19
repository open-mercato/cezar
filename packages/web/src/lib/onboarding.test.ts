import type { ProviderStatusResponse, RunRecord } from '@open-mercato/cezar-api-client'
import { describe, expect, it } from 'vitest'

import {
  agentSetupRows,
  announcementsSince,
  currentAnnouncement,
  hasSignedInAgent,
  navOwnsPath,
  newFeaturePaths,
  pendingSetupSteps,
  signedInProviders,
  visitPatch,
  recentAnnouncements,
  tasksNeedingYou,
  welcomeBackSince,
  whatsNewHasUnseen,
  welcomeBackSentence,
} from './onboarding'

const status = (...rows: ProviderStatusResponse['providers']): ProviderStatusResponse => ({ providers: rows })

describe('first-run onboarding state (spec 2026-10-26-first-run-onboarding)', () => {
  it('counts only connected, enabled agents as signed in', () => {
    const answer = status(
      { provider: 'claude', status: 'connected' },
      { provider: 'codex', status: 'connected', enabled: false },
      { provider: 'opencode', status: 'disconnected' },
    )
    expect(signedInProviders(answer)).toEqual(['claude'])
    expect(hasSignedInAgent(answer)).toBe(true)
  })

  it('does not call an unknown provider status "no agent" — the blocking screen must not flash', () => {
    expect(hasSignedInAgent(undefined)).toBeUndefined()
    expect(hasSignedInAgent(status({ provider: 'claude', status: 'not-installed' }))).toBe(false)
  })

  it('offers the install command for a missing CLI and the login command for a signed-out one', () => {
    const rows = agentSetupRows(status(
      { provider: 'claude', status: 'not-installed' },
      { provider: 'codex', status: 'disconnected' },
    ))
    expect(rows).toEqual([
      { provider: 'claude', label: 'Claude Code', state: 'missing', command: 'npm i -g @anthropic-ai/claude-code', login: 'claude' },
      { provider: 'codex', label: 'Codex', state: 'signed-out', command: 'codex login', login: 'codex login' },
    ])
  })

  it('lists worktree setup only once the config is known, and GitHub only when gh is known missing', () => {
    expect(pendingSetupSteps({ worktreeSetupConfigured: undefined, forge: undefined })).toEqual([])
    expect(pendingSetupSteps({ worktreeSetupConfigured: true, forge: { kind: 'github' } })).toEqual([])
    expect(pendingSetupSteps({ worktreeSetupConfigured: false, forge: { kind: 'github', available: false } }).map((s) => s.id))
      .toEqual(['worktrees', 'github'])
    expect(pendingSetupSteps({ worktreeSetupConfigured: false, forge: null }).map((s) => s.id)).toEqual(['worktrees'])
  })

  it('announces Design Mode only where it works, and never again once closed', () => {
    expect(currentAnnouncement({ dismissed: [], designMode: true })?.id).toBe('design-mode-2026-10')
    expect(currentAnnouncement({ dismissed: [], designMode: false })).toBeNull()
    expect(currentAnnouncement({ dismissed: undefined, designMode: undefined })).toBeNull()
    expect(currentAnnouncement({ dismissed: ['design-mode-2026-10'], designMode: true })).toBeNull()
  })
})

describe('coming back after a while (spec 2026-10-26-first-run-onboarding, "Coming back")', () => {
  const at = (iso: string) => new Date(iso).getTime()
  const now = at('2026-10-27T09:00:00.000Z')

  it('stamps the first visit without calling it a return', () => {
    expect(visitPatch(undefined, now)).toEqual({ firstVisitAt: '2026-10-27T09:00:00.000Z', lastVisitAt: '2026-10-27T09:00:00.000Z' })
  })

  it('writes at most hourly, and records a return only after two weeks away', () => {
    expect(visitPatch({ lastVisitAt: '2026-10-27T08:30:00.000Z' }, now)).toBeNull()
    expect(visitPatch({ lastVisitAt: '2026-10-20T09:00:00.000Z' }, now)).toEqual({ lastVisitAt: '2026-10-27T09:00:00.000Z' })
    expect(visitPatch({ lastVisitAt: '2026-09-20T09:00:00.000Z' }, now)).toEqual({
      lastVisitAt: '2026-10-27T09:00:00.000Z',
      returnedFrom: '2026-09-20T09:00:00.000Z',
      returnedAt: '2026-10-27T09:00:00.000Z',
    })
  })

  it('greets for three days after the return, until closed', () => {
    const back = { returnedFrom: '2026-09-20T09:00:00.000Z', returnedAt: '2026-10-27T09:00:00.000Z' }
    expect(welcomeBackSince(back, now)).toBe('2026-09-20T09:00:00.000Z')
    expect(welcomeBackSince(back, at('2026-10-31T09:00:00.000Z'))).toBeNull()
    expect(welcomeBackSince({ ...back, welcomeBackClosedAt: '2026-10-27T09:05:00.000Z' }, now)).toBeNull()
    expect(welcomeBackSince({ ...back, welcomeBackClosedAt: '2026-08-01T00:00:00.000Z' }, now)).toBe('2026-09-20T09:00:00.000Z')
  })

  it('lists only what shipped after the last visit, and only what this cockpit can do', () => {
    const ids = (since: string, designMode: boolean) => announcementsSince(since, { designMode, automations: true }).map((entry) => entry.id)
    expect(ids('2026-10-17T12:00:00.000Z', true)).toEqual(['task-tabs-2026-10', 'task-palette-2026-10'])
    expect(ids('2026-10-01T00:00:00.000Z', false)).not.toContain('design-mode-2026-10')
    expect(ids('2026-10-01T00:00:00.000Z', true)).toContain('design-mode-2026-10')
  })

  it('puts a "new" dot on a feature the user has not opened, never on a first visit', () => {
    const caps = { designMode: true, automations: true }
    expect(newFeaturePaths(undefined, caps, now).size).toBe(0)
    expect(newFeaturePaths({ firstVisitAt: '2026-10-27T09:00:00.000Z' }, caps, now).size).toBe(0)
    const old = newFeaturePaths({ firstVisitAt: '2026-08-01T00:00:00.000Z' }, caps, now)
    expect([...old.keys()]).toEqual(['/settings/worktrees', '/workflows', '/automations'])
    const opened = newFeaturePaths({ firstVisitAt: '2026-08-01T00:00:00.000Z', dismissedAnnouncements: ['workflow-editor-2026-10'] }, caps, now)
    expect(opened.has('/workflows')).toBe(false)
    expect(newFeaturePaths({ firstVisitAt: '2026-08-01T00:00:00.000Z' }, caps, at('2027-02-01T00:00:00.000Z')).size).toBe(0)
  })

  it('lets a nav item own the paths under it, but never lets Tasks own everything', () => {
    expect(navOwnsPath('/settings', '/settings/worktrees')).toBe(true)
    expect(navOwnsPath('/settings', '/settingsx')).toBe(false)
    expect(navOwnsPath('/', '/workflows')).toBe(false)
  })

  it('lists the tasks that wait on the user, latest first, never archived ones', () => {
    const run = (id: string, extra: Partial<RunRecord>): RunRecord =>
      ({ id, title: id, task: id, status: 'done', createdAt: '2026-09-01T00:00:00.000Z', ...extra }) as RunRecord
    const runs = [
      run('done', { finishedAt: '2026-09-19T00:00:00.000Z' }),
      run('older-review', { status: 'review', finishedAt: '2026-09-05T00:00:00.000Z' }),
      run('newer-review', { status: 'review', finishedAt: '2026-09-15T00:00:00.000Z' }),
      run('archived', { status: 'review', archived: true }),
    ]
    expect(tasksNeedingYou(runs).map((picked) => picked.id)).toEqual(['newer-review', 'older-review'])
  })

  it('greets with what is ready and what is new, never with how long the user was away', () => {
    const review = { status: 'review' } as const
    const waiting = { status: 'waiting' } as const
    expect(welcomeBackSentence([review], 5)).toBe('One task is ready for your review, and there are 5 new features to try.')
    expect(welcomeBackSentence([waiting], 0)).toBe('One task is waiting for your answer.')
    expect(welcomeBackSentence([review, waiting, review], 1)).toBe('3 tasks are waiting for you, and there is a new feature to try.')
    expect(welcomeBackSentence([], 2)).toBe('There are 2 new features to try.')
    expect(welcomeBackSentence([], 0)).toBeNull()
  })

  it('keeps "What\u2019s new" to the last three months, and dots it only for what shipped since it was opened', () => {
    const caps = { designMode: true, automations: true }
    expect(recentAnnouncements(caps, now).map((entry) => entry.preview)).toEqual(['tabs', 'palette', 'design', 'scripts', 'workflow', 'automations'])
    expect(recentAnnouncements(caps, at('2027-03-01T00:00:00.000Z'))).toEqual([])
    expect(whatsNewHasUnseen(undefined, caps, now)).toBe(false)
    expect(whatsNewHasUnseen({ firstVisitAt: '2026-08-01T00:00:00.000Z' }, caps, now)).toBe(true)
    expect(whatsNewHasUnseen({ firstVisitAt: '2026-08-01T00:00:00.000Z', whatsNewSeenAt: '2026-10-20T00:00:00.000Z' }, caps, now)).toBe(false)
  })
})
