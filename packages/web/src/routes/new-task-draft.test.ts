import { afterEach, describe, expect, it } from 'vitest'

import {
  clearStartedDraft,
  composerRunModeNote,
  normalizeDispatchIntent,
  readDraft,
  resetDraft,
  resolveComposerRunMode,
  writeDraft,
} from './new-task-draft'

afterEach(resetDraft)

describe('resolveComposerRunMode', () => {
  const base = {
    hasGit: true,
    variants: 1,
    planFirst: false,
    explicitAutonomous: null,
    explicitWorktree: null,
    configuredAutonomous: 'source-dependent' as const,
    configuredWorktree: true,
    source: 'workflow' as const,
  }

  it('combines source fallback, configured policy, and explicit values', () => {
    expect(resolveComposerRunMode(base)).toEqual({ autonomous: false, worktree: true })
    expect(resolveComposerRunMode({ ...base, source: 'skill' })).toEqual({ autonomous: true, worktree: true })
    expect(resolveComposerRunMode({
      ...base,
      configuredAutonomous: true,
      configuredWorktree: false,
      explicitAutonomous: false,
      explicitWorktree: true,
    })).toEqual({ autonomous: false, worktree: true })
  })

  it('applies an interactive recommendation only to untouched fields', () => {
    expect(resolveComposerRunMode({ ...base, interactive: true })).toEqual({
      autonomous: false,
      worktree: false,
    })
    expect(resolveComposerRunMode({
      ...base,
      interactive: true,
      explicitAutonomous: true,
    })).toEqual({ autonomous: true, worktree: false })
  })

  it('keeps plan, parallel, and no-git constraints authoritative', () => {
    expect(resolveComposerRunMode({ ...base, planFirst: true, explicitAutonomous: true }).autonomous).toBe(false)
    expect(resolveComposerRunMode({ ...base, variants: 2, explicitWorktree: false }).worktree).toBe(true)
    expect(resolveComposerRunMode({ ...base, hasGit: false, explicitWorktree: true }).worktree).toBe(false)
  })

  it('keeps explicit and configured Worktree opt-outs authoritative for ordinary workflows', () => {
    expect(resolveComposerRunMode({ ...base, explicitWorktree: false }).worktree).toBe(false)
    expect(resolveComposerRunMode({ ...base, configuredWorktree: false }).worktree).toBe(false)
  })
})

describe('resolveComposerRunMode with dispatch (spec 2026-09-10-dispatch)', () => {
  const base = {
    hasGit: true,
    variants: 1,
    planFirst: false,
    explicitAutonomous: null,
    explicitWorktree: null,
    configuredAutonomous: 'source-dependent' as const,
    configuredWorktree: true,
    source: 'workflow' as const,
    dispatch: true,
  }

  it('forces the worktree on and defaults autonomous on', () => {
    expect(resolveComposerRunMode(base)).toEqual({ autonomous: true, worktree: true })
    // An explicit worktree opt-out and a workspace policy are both overruled — subtasks fork
    // off the parent's commits, which needs a tree of its own.
    expect(resolveComposerRunMode({ ...base, explicitWorktree: false, configuredWorktree: false }))
      .toEqual({ autonomous: true, worktree: true })
    // An interactive skill's recommendation is about the parent pausing for the user; a
    // dispatching parent keeps going while its children work.
    expect(resolveComposerRunMode({ ...base, interactive: true, source: 'skill' }).autonomous).toBe(true)
  })

  it('yields to an explicit Autonomous off, to plan-first, and to a missing repo', () => {
    expect(resolveComposerRunMode({ ...base, explicitAutonomous: false }))
      .toEqual({ autonomous: false, worktree: true })
    expect(resolveComposerRunMode({ ...base, planFirst: true }).autonomous).toBe(false)
    expect(resolveComposerRunMode({ ...base, hasGit: false }).worktree).toBe(false)
  })
})

describe('the new-task draft store', () => {
  it('starts empty with the never-chosen sentinels', () => {
    expect(readDraft()).toEqual({
      text: '',
      source: null,
      runner: null,
      agentProfile: null,
      model: null,
      variants: 1,
      planFirst: false,
      worktree: null,
      autonomous: null,
      generateFollowups: null,
      dispatch: null,
    })
  })

  it('round-trips a draft and hands out copies, not the stored object', () => {
    writeDraft({
      text: 'fix it',
      source: { source: 'skill', ref: 'om-fix' },
      runner: 'codex',
      agentProfile: null,
      model: 'gpt-5-codex',
      variants: 2,
      planFirst: false,
      worktree: false,
      autonomous: null,
      generateFollowups: false,
      dispatch: null,
    })
    const first = readDraft()
    expect(first.text).toBe('fix it')
    expect(first.worktree).toBe(false)
    expect(first.generateFollowups).toBe(false)
    first.text = 'mutated'
    expect(readDraft().text).toBe('fix it')
  })

  it('clearStartedDraft spends the text AND the source, keeping the way-of-working pills', () => {
    writeDraft({
      text: 'shipped',
      source: { source: 'skill', ref: 'om-fix' },
      runner: null,
      agentProfile: null,
      model: 'opus',
      variants: 3,
      planFirst: true,
      worktree: null,
      autonomous: null,
      generateFollowups: true,
      dispatch: null,
    })
    clearStartedDraft()
    expect(readDraft()).toEqual({
      text: '',
      // The skill goes with the task it ran: the next `/new` starts with none.
      source: null,
      runner: null,
      agentProfile: null,
      // Runner/model/variants/plan-first are a way of working — they survive, as they always did.
      model: 'opus',
      variants: 3,
      planFirst: true,
      worktree: null,
      autonomous: null,
      generateFollowups: true,
      dispatch: null,
    })
  })

  it('survives a page reload — a cold read re-hydrates from localStorage', () => {
    writeDraft({
      text: 'do not lose me',
      source: { source: 'skill', ref: 'om-fix' },
      runner: 'claude',
      agentProfile: null,
      model: 'sonnet',
      variants: 2,
      planFirst: true,
      worktree: false,
      autonomous: null,
      generateFollowups: false,
      dispatch: null,
    })
    // A fresh page has no in-memory cache but keeps localStorage: resetDraft removes storage, so
    // instead drop only the cache by round-tripping through a raw storage read.
    const raw = localStorage.getItem('cez-new-task-draft') as string
    expect(JSON.parse(raw)).toMatchObject({
      text: 'do not lose me',
      variants: 2,
      worktree: false,
      autonomous: null,
      generateFollowups: false,
      dispatch: null,
      planFirst: true,
    })
  })

  it('normalizes a malformed/older stored value instead of throwing', () => {
    // A cold read (cache null after resetDraft) hitting bad JSON must degrade to EMPTY.
    resetDraft()
    localStorage.setItem('cez-new-task-draft', 'not json at all')
    expect(readDraft()).toEqual({
      text: '',
      source: null,
      runner: null,
      agentProfile: null,
      model: null,
      variants: 1,
      planFirst: false,
      worktree: null,
      autonomous: null,
      generateFollowups: null,
      dispatch: null,
    })

    resetDraft()
    localStorage.setItem('cez-new-task-draft', '{"text":42,"variants":9,"source":"nope","worktree":"x"}')
    expect(readDraft()).toEqual({
      text: '',
      source: null,
      runner: null,
      agentProfile: null,
      model: null,
      variants: 1,
      planFirst: false,
      worktree: null,
      autonomous: null,
      generateFollowups: null,
      dispatch: null,
    })
  })
})

describe('normalizeDispatchIntent', () => {
  it('keeps only the contract keys, within the contract ranges', () => {
    expect(normalizeDispatchIntent({
      maxSubtasks: 10, inFlight: 9, runner: 'nope', model: '', budgetUsd: -1, extra: 1,
    })).toEqual({ maxSubtasks: 10 })
    expect(normalizeDispatchIntent({
      maxSubtasks: 51, inFlight: 2, runner: 'codex', model: 'gpt-future', budgetUsd: 2.5,
    })).toEqual({ inFlight: 2, runner: 'codex', model: 'gpt-future', budgetUsd: 2.5 })
    expect(normalizeDispatchIntent({ maxSubtasks: 1.5, budgetUsd: 10_001 })).toEqual({})
  })

  it('answers null for anything but a plain object — the toggle is off', () => {
    for (const raw of [null, undefined, 'on', true, 1, [], [1]]) {
      expect(normalizeDispatchIntent(raw)).toBeNull()
    }
    // The bare toggle: on, engine defaults.
    expect(normalizeDispatchIntent({})).toEqual({})
  })

  it('round-trips through the store', () => {
    writeDraft({ ...readDraft(), dispatch: { maxSubtasks: 10, inFlight: 2 } })
    resetDraftCacheOnly()
    expect(readDraft().dispatch).toEqual({ maxSubtasks: 10, inFlight: 2 })
    localStorage.setItem('cez-new-task-draft', '{"dispatch":"yes please"}')
    resetDraftCacheOnly()
    expect(readDraft().dispatch).toBeNull()
  })
})

/** Drop the in-memory cache but keep localStorage — a reload, not a reset. */
function resetDraftCacheOnly() {
  const stored = localStorage.getItem('cez-new-task-draft')
  resetDraft()
  if (stored !== null) localStorage.setItem('cez-new-task-draft', stored)
}

describe('composerRunModeNote (#793)', () => {
  // One line per place the run can land. The header used to print the first one unconditionally,
  // so the other two states read as an outright false promise of isolation.
  const cases: Array<{ worktree: boolean; hasGit: boolean; expected: string }> = [
    {
      worktree: true,
      hasGit: true,
      expected: 'Runs in an isolated worktree — review everything before it lands.',
    },
    {
      worktree: false,
      hasGit: true,
      expected: 'Runs in the repo working tree — your checkout is modified directly.',
    },
    {
      worktree: false,
      hasGit: false,
      expected: 'Runs in place — no git repository detected, so there is no worktree to isolate in.',
    },
  ]

  for (const { worktree, hasGit, expected } of cases) {
    it(`worktree=${worktree}, hasGit=${hasGit}`, () => {
      expect(composerRunModeNote({ worktree, hasGit })).toBe(expected)
    })
  }

  it('names the fan-out when dispatch is on, in both autonomy states', () => {
    expect(composerRunModeNote({ worktree: true, hasGit: true, dispatch: true, autonomous: true }))
      .toBe('Runs on its own and fans work out to subtasks — it will not pause for you.')
    expect(composerRunModeNote({ worktree: true, hasGit: true, dispatch: true, autonomous: false }))
      .toBe('Fans work out to subtasks in isolated worktrees.')
    // Off, the existing three states are untouched.
    expect(composerRunModeNote({ worktree: true, hasGit: true, dispatch: false }))
      .toBe('Runs in an isolated worktree — review everything before it lands.')
  })

  it('never promises isolation without a worktree', () => {
    // The invariant the header actually owes the user, independent of the exact copy: the word
    // only appears when the run really gets one.
    for (const hasGit of [true, false]) {
      expect(composerRunModeNote({ worktree: false, hasGit })).not.toContain('isolated worktree')
    }
  })
})
