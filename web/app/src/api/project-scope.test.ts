import { afterEach, describe, expect, it } from 'vitest'

import { apiBase, getApiScope, queryScope, scopeApiPath, setApiScope } from './project-scope'

afterEach(() => {
  setApiScope(null)
})

describe('scopeApiPath — unscoped', () => {
  // THE invariant of step 3.1: with no scope set, every URL is exactly what it was. Not
  // "equivalent" — byte-identical, because the legacy `/api/*` surface is protected
  // (BACKWARD_COMPATIBILITY.md) and the boot project must keep speaking it.
  it.each([
    '/api/runs',
    '/api/runs/run-1/files?path=shot.png&raw=1',
    '/api/runs/run-1/events',
    '/api/health',
    '/api/workspace/events',
    '/api/github?limit=5&refresh=1',
  ])('is the identity for %s', (path) => {
    expect(scopeApiPath(path)).toBe(path)
  })

  it('reports the unscoped state', () => {
    expect(getApiScope()).toBeNull()
    expect(apiBase()).toBe('/api')
    expect(queryScope()).toBe('default')
  })
})

describe('scopeApiPath — scoped', () => {
  it('prefixes project routes with /api/p/<id>', () => {
    setApiScope('cezar')
    expect(scopeApiPath('/api/runs')).toBe('/api/p/cezar/runs')
    expect(scopeApiPath('/api/runs/run-1/files?path=x.png&raw=1')).toBe('/api/p/cezar/runs/run-1/files?path=x.png&raw=1')
    expect(scopeApiPath('/api/runs/run-1/events')).toBe('/api/p/cezar/runs/run-1/events')
    expect(apiBase()).toBe('/api/p/cezar')
    expect(queryScope()).toBe('cezar')
  })

  it('URL-encodes the project id', () => {
    // Registered slugs are tame, but the id rides into a URL — encode like every path segment.
    setApiScope('a b/c')
    expect(scopeApiPath('/api/runs')).toBe('/api/p/a%20b%2Fc/runs')
    expect(apiBase()).toBe('/api/p/a%20b%2Fc')
  })

  it('leaves workspace-level routes alone — they are single-mount, prefixing would 404', () => {
    setApiScope('cezar')
    expect(scopeApiPath('/api/health')).toBe('/api/health')
    expect(scopeApiPath('/api/models?runner=codex')).toBe('/api/models?runner=codex')
    expect(scopeApiPath('/api/projects')).toBe('/api/projects')
    expect(scopeApiPath('/api/workspace/events')).toBe('/api/workspace/events')
    expect(scopeApiPath('/api/workspace/config')).toBe('/api/workspace/config')
    expect(scopeApiPath('/api/workspace/ui-state')).toBe('/api/workspace/ui-state')
    expect(scopeApiPath('/api/providers/status')).toBe('/api/providers/status')
    expect(scopeApiPath('/api/providers/status?refresh=1')).toBe('/api/providers/status?refresh=1')
    expect(scopeApiPath('/api/providers/connect')).toBe('/api/providers/connect')
    // The folder picker (step 4.2): one filesystem behind the workspace, not one per project.
    expect(scopeApiPath('/api/fs/browse')).toBe('/api/fs/browse')
    expect(scopeApiPath('/api/fs/browse?path=%2Fhome%2Fme')).toBe('/api/fs/browse?path=%2Fhome%2Fme')
  })

  it('never double-prefixes an already-scoped path', () => {
    setApiScope('cezar')
    expect(scopeApiPath('/api/p/cezar/runs')).toBe('/api/p/cezar/runs')
    expect(scopeApiPath('/api/p/other/runs')).toBe('/api/p/other/runs')
  })

  it('does not scope a lookalike project route that only shares a prefix with a workspace one', () => {
    setApiScope('cezar')
    // `/api/healthcheck` is not `/api/health`; the exemption matches whole segments only.
    expect(scopeApiPath('/api/healthcheck')).toBe('/api/p/cezar/healthcheck')
  })

  it('leaves non-API paths untouched', () => {
    setApiScope('cezar')
    expect(scopeApiPath('/new')).toBe('/new')
    expect(scopeApiPath('https://github.com/o/r/pull/7')).toBe('https://github.com/o/r/pull/7')
  })

  it('treats the empty string as unscoped — there is no project ""', () => {
    setApiScope('')
    expect(getApiScope()).toBeNull()
    expect(scopeApiPath('/api/runs')).toBe('/api/runs')
  })
})
