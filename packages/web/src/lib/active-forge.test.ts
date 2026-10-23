import { describe, expect, it } from 'vitest'

import type { HealthResponse, ProjectListEntry, ProjectsResponse } from '@open-mercato/cezar-api-client'
import { activeForgeOf, cliFor, forgeCliUnavailableReason } from './active-forge'

const GH_OK = { name: 'gh' as const, available: true, version: 'authenticated' }

/** Booted in `$HOME` (not a repo, never registered): health has no forge at all (#1410). */
const HOME_HEALTH = {
  bootProject: 'home',
  forge: null,
  checks: [GH_OK],
} as unknown as HealthResponse

const entry = (id: string, extra: Partial<ProjectListEntry> = {}): ProjectListEntry => ({
  id,
  name: id,
  root: `/srv/${id}`,
  addedAt: '',
  lastOpenedAt: '',
  source: 'checkout',
  status: 'ok',
  ...extra,
})

/** One cloned GitHub project — a single-entry registry, so the shell renders the FLAT nav. */
const ONE_CLONE: ProjectsResponse = {
  bootProject: 'home',
  projectsDir: '~/cezar/projects',
  projects: [entry('cezar', { forge: 'github' })],
}

describe('activeForgeOf', () => {
  it('a cloned GitHub project served from a non-repo boot folder has a forge', () => {
    expect(activeForgeOf(HOME_HEALTH, ONE_CLONE, 'cezar')).toEqual({ kind: 'github', available: true })
  })

  it('a non-boot project without a forge remote is null — the "no remote" note is true there', () => {
    const registry = { ...ONE_CLONE, projects: [entry('plain')] }
    const githubBoot = { ...HOME_HEALTH, forge: { kind: 'github', available: true } } as HealthResponse
    expect(activeForgeOf(githubBoot, registry, 'plain')).toBeNull()
  })

  it('a non-boot GitHub project is unavailable, with a gh reason, when the host gh check fails', () => {
    const health = { ...HOME_HEALTH, checks: [{ name: 'gh', available: false }] } as HealthResponse
    expect(activeForgeOf(health, ONE_CLONE, 'cezar')).toEqual({ kind: 'github', available: false, reason: forgeCliUnavailableReason('gh') })
    expect(forgeCliUnavailableReason('gh')).toContain('`gh auth login`')
  })

  it('picks the host check by the forge\'s own CLI', () => {
    expect(cliFor('github')).toBe('gh')
    // Another probed tool failing says nothing about GitHub.
    const health = { ...HOME_HEALTH, checks: [GH_OK, { name: 'git', available: false }] } as HealthResponse
    expect(activeForgeOf(health, ONE_CLONE, 'cezar')).toEqual({ kind: 'github', available: true })
  })

  // Review on #1465: a fork with a second forge (GitLab via `glab`, #847 / #1226) hit this.
  it('never lends gh\'s answer to a forge kind with another CLI', () => {
    const gitlab = { ...ONE_CLONE, projects: [entry('shop', { forge: 'gitlab' as unknown as 'github' })] }
    for (const available of [true, false]) {
      const health = { ...HOME_HEALTH, checks: [{ name: 'gh', available }] } as HealthResponse
      expect(activeForgeOf(health, gitlab, 'shop')).toEqual({ kind: 'gitlab' })
    }
  })

  it('a server that never probed gh leaves a non-boot project\'s availability unknown', () => {
    const health = { ...HOME_HEALTH, checks: [] } as unknown as HealthResponse
    expect(activeForgeOf(health, ONE_CLONE, 'cezar')).toEqual({ kind: 'github' })
  })

  it('the boot project — by id, by the `default` alias, or unscoped — keeps health\'s answer', () => {
    const health = { ...HOME_HEALTH, forge: { kind: 'github', available: false, reason: 'gh not logged in' } } as HealthResponse
    expect(activeForgeOf(health, ONE_CLONE, 'home')).toEqual(health.forge)
    expect(activeForgeOf(health, ONE_CLONE, 'default')).toEqual(health.forge)
    expect(activeForgeOf(health, ONE_CLONE, null)).toEqual(health.forge)
  })

  it('never throws on a partial registry or health answer', () => {
    expect(activeForgeOf(HOME_HEALTH, {} as ProjectsResponse, 'cezar')).toBeUndefined()
    const noChecks = { bootProject: 'home', forge: null } as unknown as HealthResponse
    expect(activeForgeOf(noChecks, ONE_CLONE, 'cezar')).toEqual({ kind: 'github' })
  })

  it('is unknown, not "no remote", while the registry or health has not answered', () => {
    expect(activeForgeOf(HOME_HEALTH, undefined, 'cezar')).toBeUndefined()
    expect(activeForgeOf(undefined, ONE_CLONE, 'cezar')).toBeUndefined()
  })
})
