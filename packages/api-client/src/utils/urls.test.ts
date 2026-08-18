import { describe, expect, it } from 'vitest'

import { projectApiPath, resolveCezarUrl } from './urls.ts'

describe('projectApiPath', () => {
  it.each([
    [null, '/runs', '/api/v1/runs'],
    ['project/a', '/runs', '/api/v1/p/project%2Fa/runs'],
  ] as const)('builds an instance project path for %s', (projectId, suffix, expected) => {
    expect(projectApiPath(projectId, suffix)).toBe(expected)
  })
})

describe('resolveCezarUrl', () => {
  it('joins a normalized client base with a root-relative API path', () => {
    expect(resolveCezarUrl('https://cezar.test/base/', '/api/v1/runs')).toBe(
      'https://cezar.test/base/api/v1/runs',
    )
  })

  it('keeps same-origin paths root-relative', () => {
    expect(resolveCezarUrl('', '/api/v1/runs')).toBe('/api/v1/runs')
  })
})
