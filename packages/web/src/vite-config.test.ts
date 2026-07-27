import { describe, expect, it } from 'vitest'

import config, { reactRuntimeChunk } from '../vite.config'

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
