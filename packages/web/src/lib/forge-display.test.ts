import { describe, expect, it } from 'vitest'

import { forgeCli, forgeIcon, forgeLabel, forgePrNoun } from './forge-display'
import { GithubIcon, GitlabIcon } from '@/components/icons'

/**
 * Step 3.8-review-fix (spec 2026-08-10-forge-provider-adapters): every forge-flavored bit of copy
 * the cockpit swaps by `health.forge?.kind` funnels through this module. An absent/unrecognized
 * kind must read as GitHub everywhere — the byte-identical default a pre-forge-widening server
 * (or one this cockpit build predates) is entitled to.
 */

describe('forgeLabel', () => {
  it('reads GitLab only for the gitlab kind', () => {
    expect(forgeLabel('gitlab')).toBe('GitLab')
  })

  it('defaults every other input to GitHub', () => {
    expect(forgeLabel('github')).toBe('GitHub')
    expect(forgeLabel(null)).toBe('GitHub')
    expect(forgeLabel(undefined)).toBe('GitHub')
  })
})

describe('forgeIcon', () => {
  it('picks the matching brand mark, GitHub by default', () => {
    expect(forgeIcon('gitlab')).toBe(GitlabIcon)
    expect(forgeIcon('github')).toBe(GithubIcon)
    expect(forgeIcon(null)).toBe(GithubIcon)
    expect(forgeIcon(undefined)).toBe(GithubIcon)
  })
})

describe('forgeCli', () => {
  it('names glab only for gitlab, gh otherwise', () => {
    expect(forgeCli('gitlab')).toEqual({ cli: 'glab', authCommand: 'glab auth login' })
    expect(forgeCli('github')).toEqual({ cli: 'gh', authCommand: 'gh auth login' })
    expect(forgeCli(undefined)).toEqual({ cli: 'gh', authCommand: 'gh auth login' })
  })
})

describe('forgePrNoun', () => {
  it('defaults to the singular lowercase GitHub noun', () => {
    expect(forgePrNoun('github')).toBe('pull request')
    expect(forgePrNoun(null)).toBe('pull request')
    expect(forgePrNoun(undefined)).toBe('pull request')
  })

  it('swaps to "merge request" for gitlab', () => {
    expect(forgePrNoun('gitlab')).toBe('merge request')
  })

  it('pluralizes independently of capitalization', () => {
    expect(forgePrNoun('github', { plural: true })).toBe('pull requests')
    expect(forgePrNoun('gitlab', { plural: true })).toBe('merge requests')
  })

  it('capitalizes only the leading letter', () => {
    expect(forgePrNoun('github', { capitalized: true })).toBe('Pull request')
    expect(forgePrNoun('gitlab', { capitalized: true })).toBe('Merge request')
  })

  it('combines plural and capitalized', () => {
    expect(forgePrNoun('github', { plural: true, capitalized: true })).toBe('Pull requests')
    expect(forgePrNoun('gitlab', { plural: true, capitalized: true })).toBe('Merge requests')
  })
})
