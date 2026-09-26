import type { ProjectsResponse, WorkspaceLastLocation } from '@open-mercato/cezar-api-client'
import { describe, expect, it } from 'vitest'

import { bareRootLanding, locationToRestore, locationToSave, sameLastLocation } from './last-location'

const REGISTRY: ProjectsResponse = {
  bootProject: 'boot',
  projectsDir: '/work',
  projects: [
    {
      id: 'boot',
      name: 'Boot',
      root: '/work/boot',
      addedAt: '2026-07-29T10:00:00.000Z',
      lastOpenedAt: '2026-07-29T10:00:00.000Z',
      source: 'local',
      status: 'ok',
    },
    {
      id: 'other',
      name: 'Other',
      root: '/work/other',
      addedAt: '2026-07-29T10:00:00.000Z',
      lastOpenedAt: '2026-07-29T10:00:00.000Z',
      source: 'local',
      status: 'not-git',
    },
    {
      id: 'gone',
      name: 'Gone',
      root: '/work/gone',
      addedAt: '2026-07-29T10:00:00.000Z',
      lastOpenedAt: '2026-07-29T10:00:00.000Z',
      source: 'local',
      status: 'missing',
    },
  ],
}

/** What the server answers when cezar was started somewhere with an EMPTY registry: the served
 *  folder is the whole list, flagged, and `bootProject` names it. (With projects registered the
 *  row is not listed at all — `bareRootLanding` below is what that case needs.) */
const UNREGISTERED_BOOT: ProjectsResponse = {
  bootProject: 'scratch',
  projectsDir: '/work',
  projects: [
    {
      id: 'scratch',
      name: 'scratch',
      root: '/tmp/scratch',
      addedAt: '',
      lastOpenedAt: '',
      source: 'local',
      status: 'ok',
      unregistered: true,
    },
  ],
}

describe('locationToSave', () => {
  it('normalizes a registered project URL including query and hash', () => {
    expect(
      locationToSave(
        {
          pathname: '/p/boot/tasks/run-1/changes',
          search: '?file=src%2Findex.ts',
          hash: '#L12',
        },
        REGISTRY,
      ),
    ).toEqual({
      projectId: 'boot',
      pathname: '/p/boot/tasks/run-1/changes',
      search: '?file=src%2Findex.ts',
      hash: '#L12',
    })
  })

  it('omits empty query and hash components', () => {
    expect(locationToSave({ pathname: '/p/boot/', search: '', hash: '' }, REGISTRY)).toEqual({
      projectId: 'boot',
      pathname: '/p/boot/',
    })
  })

  it('treats a registered not-git project as usable', () => {
    expect(locationToSave({ pathname: '/p/other/git', search: '', hash: '' }, REGISTRY)).toEqual({
      projectId: 'other',
      pathname: '/p/other/git',
    })
  })

  it.each([
    ['an unscoped path', { pathname: '/tasks/run-1', search: '', hash: '' }],
    ['an unknown project', { pathname: '/p/unknown/', search: '', hash: '' }],
    ['a missing project', { pathname: '/p/gone/', search: '', hash: '' }],
    ['an overlong path', { pathname: `/p/boot/${'x'.repeat(2041)}`, search: '', hash: '' }],
    ['a malformed encoded project', { pathname: '/p/%/', search: '', hash: '' }],
  ])('rejects %s', (_case, location) => {
    expect(locationToSave(location, REGISTRY)).toBeNull()
  })

  it('waits for the project registry before saving', () => {
    expect(locationToSave({ pathname: '/p/boot/', search: '', hash: '' }, undefined)).toBeNull()
  })

  // A first launch registers nothing (seed-once) — `GET /api/v1/projects` answers the served
  // folder with `unregistered: true`, and it has to be a usable project everywhere, this
  // included. Without that row it could never be the restore target, and the user's only
  // project would not survive reopening the bare root.
  it('saves an unregistered boot project like any other', () => {
    expect(locationToSave({ pathname: '/p/scratch/tasks', search: '', hash: '' }, UNREGISTERED_BOOT)).toEqual({
      projectId: 'scratch',
      pathname: '/p/scratch/tasks',
    })
  })
})

describe('locationToRestore', () => {
  const saved: WorkspaceLastLocation = {
    projectId: 'other',
    pathname: '/p/other/tasks/run-1/changes',
    search: '?file=x',
    hash: '#L2',
  }

  it('restores a valid registered location exactly', () => {
    expect(locationToRestore(saved, REGISTRY, 'boot')).toBe('/p/other/tasks/run-1/changes?file=x#L2')
  })

  it('restores a registered not-git project', () => {
    expect(locationToRestore({ projectId: 'other', pathname: '/p/other/' }, REGISTRY, 'boot')).toBe('/p/other/')
  })

  it.each([
    ['a non-object value', 'nope'],
    ['a missing field', { projectId: 'boot' }],
    ['an extra field', { projectId: 'boot', pathname: '/p/boot/', extra: true }],
    ['an unscoped path', { projectId: 'boot', pathname: '/tasks/run-1' }],
    ['a project/path mismatch', { projectId: 'boot', pathname: '/p/other/' }],
    ['an unknown project', { projectId: 'unknown', pathname: '/p/unknown/' }],
    ['a missing project', { projectId: 'gone', pathname: '/p/gone/' }],
    ['a search without ?', { projectId: 'boot', pathname: '/p/boot/', search: 'tab=runs' }],
    ['a hash without #', { projectId: 'boot', pathname: '/p/boot/', hash: 'L2' }],
  ])('rejects %s', (_case, value) => {
    expect(locationToRestore(value, REGISTRY, 'boot')).toBeNull()
  })

  it('accepts only the health boot project while the registry is unavailable', () => {
    expect(locationToRestore({ projectId: 'boot', pathname: '/p/boot/tasks/run-1' }, undefined, 'boot')).toBe(
      '/p/boot/tasks/run-1',
    )
    expect(locationToRestore(saved, undefined, 'boot')).toBeNull()
    expect(locationToRestore({ projectId: 'boot', pathname: '/p/boot/' }, undefined, undefined)).toBeNull()
  })
})

describe('sameLastLocation', () => {
  it('treats absent and empty optional components as equal', () => {
    const left: WorkspaceLastLocation = { projectId: 'boot', pathname: '/p/boot/' }
    const right: WorkspaceLastLocation = {
      projectId: 'boot',
      pathname: '/p/boot/',
      search: '',
      hash: '',
    }

    expect(sameLastLocation(left, right)).toBe(true)
  })

  it('detects a changed project, path, query, or hash', () => {
    const current: WorkspaceLastLocation = { projectId: 'boot', pathname: '/p/boot/', search: '?tab=runs' }

    expect(sameLastLocation(current, { ...current })).toBe(true)
    expect(sameLastLocation(undefined, current)).toBe(false)
    expect(sameLastLocation(current, { ...current, projectId: 'other' })).toBe(false)
    expect(sameLastLocation(current, { ...current, pathname: '/p/boot/git' })).toBe(false)
    expect(sameLastLocation(current, { ...current, search: '?tab=git' })).toBe(false)
    expect(sameLastLocation(current, { ...current, hash: '#L2' })).toBe(false)
  })
})

describe('bareRootLanding', () => {
  it('lands on the boot project when the registry lists it', () => {
    expect(bareRootLanding(REGISTRY, 'boot')).toBe('boot')
  })

  it('lands on the boot project when it is the whole list (empty registry)', () => {
    expect(bareRootLanding(UNREGISTERED_BOOT, 'scratch')).toBe('scratch')
  })

  it('lands on the most recently opened project when the boot folder is not listed', () => {
    const registry: ProjectsResponse = {
      ...REGISTRY,
      bootProject: 'scratch',
      projects: [
        { ...REGISTRY.projects[0]!, lastOpenedAt: '2026-07-01T10:00:00.000Z' },
        { ...REGISTRY.projects[1]!, lastOpenedAt: '2026-07-29T10:00:00.000Z' },
      ],
    }

    expect(bareRootLanding(registry, 'scratch')).toBe('other')
  })

  it('skips a missing root, and keeps the boot project when every row is missing', () => {
    const projects = REGISTRY.projects.map((project) => ({ ...project, status: 'missing' as const }))
    const usable: ProjectsResponse = {
      ...REGISTRY,
      bootProject: 'scratch',
      projects: [projects[0]!, { ...REGISTRY.projects[2]!, status: 'ok' as const }],
    }

    expect(bareRootLanding(usable, 'scratch')).toBe('gone')
    expect(bareRootLanding({ ...REGISTRY, bootProject: 'scratch', projects }, 'scratch')).toBe(
      'scratch',
    )
  })

  it('keeps the boot project when the registry is unavailable', () => {
    expect(bareRootLanding(undefined, 'scratch')).toBe('scratch')
  })
})
