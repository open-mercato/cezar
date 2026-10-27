import { describe, expect, it } from 'vitest'

import type { HealthResponse, ProjectsResponse } from '@open-mercato/cezar-api-client'
import { withServedBootProject } from './served-boot-project'

const HEALTH: HealthResponse = {
  version: '0.0.0-test',
  projects: [],
  bootProject: 'repob',
  repoRoot: '/home/me/dev/repoB',
  repo: { root: '/home/me/dev/repoB', branch: 'main' },
  checks: [],
  defaultRunner: 'claude',
  forge: null,
  capabilities: {
    localHandoff: true,
    terminal: false,
    designMode: false,
    tokenMetrics: true,
    tokenUsageMetrics: true,
    costMetrics: true,
    followups: false,
    singleProject: false,
    automations: false,
    dispatch: false,
  },
}

const REPO_A = {
  id: 'repoa',
  name: 'repoA',
  root: '/home/me/dev/repoA',
  addedAt: '2026-10-13T10:00:00.000Z',
  lastOpenedAt: '2026-10-13T10:00:00.000Z',
  source: 'local' as const,
  status: 'ok' as const,
}

/** The #1432 workspace: repoA registered, cezar started in repoB, which the registry omits. */
const REGISTRY: ProjectsResponse = { projects: [REPO_A], bootProject: 'repob', projectsDir: '~/cezar/projects' }

describe('withServedBootProject', () => {
  it('adds the launch folder, flagged unregistered, while it is the project on screen', () => {
    expect(withServedBootProject(REGISTRY, 'repob', HEALTH)?.projects).toEqual([
      {
        id: 'repob',
        name: 'repoB',
        root: '/home/me/dev/repoB',
        addedAt: '',
        lastOpenedAt: '',
        source: 'local',
        status: 'ok',
        unregistered: true,
        branch: 'main',
      },
      REPO_A,
    ])
  })

  it('says not-git, with no branch, for a launch folder outside a repository', () => {
    const [entry] = withServedBootProject(REGISTRY, 'repob', { ...HEALTH, repo: null })?.projects ?? []
    expect(entry?.status).toBe('not-git')
    expect(entry && 'branch' in entry).toBe(false)
  })

  it.each<[string, ProjectsResponse, string | null, HealthResponse | undefined]>([
    ['another project is on screen', REGISTRY, 'repoa', HEALTH],
    ['no project is on screen', REGISTRY, null, HEALTH],
    ['the registry already lists the launch folder', { ...REGISTRY, projects: [{ ...REPO_A, id: 'repob' }] }, 'repob', HEALTH],
    ['health names another boot project', REGISTRY, 'repob', { ...HEALTH, bootProject: 'other' }],
    ['the cockpit is hosted, where repoRoot is only a basename', REGISTRY, 'repob', { ...HEALTH, capabilities: { ...HEALTH.capabilities, localHandoff: false } }],
    ['health has not answered', REGISTRY, 'repob', undefined],
  ])('returns the registry untouched when %s', (_name, registry, active, health) => {
    expect(withServedBootProject(registry, active, health)).toBe(registry)
  })

  it('passes an absent registry through', () => {
    expect(withServedBootProject(undefined, 'repob', HEALTH)).toBeUndefined()
  })
})
