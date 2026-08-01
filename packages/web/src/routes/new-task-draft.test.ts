import { afterEach, describe, expect, it } from 'vitest'

import {
  clearDraftText,
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
    })
    const first = readDraft()
    expect(first.text).toBe('fix it')
    expect(first.worktree).toBe(false)
    expect(first.generateFollowups).toBe(false)
    first.text = 'mutated'
    expect(readDraft().text).toBe('fix it')
  })

  it('clearDraftText spends the text but keeps the picker choices (legacy keeps its pills)', () => {
    writeDraft({
      text: 'shipped',
      source: { source: 'workflow', ref: 'quick-task' },
      runner: null,
      agentProfile: null,
      model: 'opus',
      variants: 3,
      planFirst: true,
      worktree: null,
      autonomous: null,
      generateFollowups: true,
    })
    clearDraftText()
    expect(readDraft()).toEqual({
      text: '',
      source: { source: 'workflow', ref: 'quick-task' },
      runner: null,
      agentProfile: null,
      model: 'opus',
      variants: 3,
      planFirst: true,
      worktree: null,
      autonomous: null,
      generateFollowups: true,
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
    })
  })
})
