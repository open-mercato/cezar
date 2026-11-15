import { describe, expect, it } from 'vitest'

import config, { artifactsProxyKey, reactRuntimeChunk } from '../vite.config'

describe('production chunking', () => {
  it('keeps the coupled React runtime in a focused vendor chunk', () => {
    expect(reactRuntimeChunk.name).toBe('react-runtime')
    expect(reactRuntimeChunk.test.test('/repo/node_modules/react/index.js')).toBe(true)
    expect(reactRuntimeChunk.test.test('/repo/node_modules/react-dom/client.js')).toBe(true)
    expect(reactRuntimeChunk.test.test('/repo/node_modules/scheduler/index.js')).toBe(true)

    expect(reactRuntimeChunk.test.test('/repo/node_modules/react-router/index.js')).toBe(false)
    expect(reactRuntimeChunk.test.test('/repo/node_modules/@tanstack/react-query/index.js')).toBe(
      false,
    )
    expect(reactRuntimeChunk.test.test('/repo/web/app/src/routes.tsx')).toBe(false)
  })

  it('retains Vite default chunk-size warnings', () => {
    expect(config.build?.chunkSizeWarningLimit).toBeUndefined()
    expect(config.build?.rolldownOptions?.output).toMatchObject({
      codeSplitting: { groups: [reactRuntimeChunk] },
    })
  })
})

describe('dev proxy and artifact pages (#1920)', () => {
  const proxy = config.server?.proxy as Record<string, { changeOrigin?: boolean }>
  const keys = Object.keys(proxy)

  it('proxies artifact routes without rewriting Host, ahead of the /api entry', () => {
    expect(proxy[artifactsProxyKey]?.changeOrigin).toBeUndefined()
    expect(keys.indexOf(artifactsProxyKey)).toBeLessThan(keys.indexOf('/api'))
    expect(proxy['/api']?.changeOrigin).toBe(true)
  })

  it('matches both aliases of the artifact route and nothing else', () => {
    const re = new RegExp(artifactsProxyKey)
    expect(re.test('/api/v1/runs/r1/artifacts/report.html')).toBe(true)
    expect(re.test('/api/v1/p/my-app/runs/r1/artifacts/shots/a.png')).toBe(true)
    expect(re.test('/api/v1/runs/r1/files')).toBe(false)
  })
})
