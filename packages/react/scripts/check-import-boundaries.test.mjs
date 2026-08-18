import { describe, expect, it } from 'vitest'

import { isReactPeerExternal } from '../vite.config.ts'
import { findProhibitedSpecifiers } from './import-boundaries.mjs'

describe('import boundary check', () => {
  it('finds static and literal dynamic imports despite comments and options', async () => {
    const prohibited = await findProhibitedSpecifiers(`
      import '../../../packages/web/src/app'
      import '@/components/example'
      import /* static comment */ '@open-mercato/cezar-contract'
      import '@open-mercato/cezar-react/src/session'
      import(/* dynamic comment */ 'node:fs')
      import('node:path', { with: { type: 'json' } })
    `)

    expect(prohibited).toEqual([
      '../../../packages/web/src/app',
      '@/components/example',
      '@open-mercato/cezar-contract',
      '@open-mercato/cezar-react/src/session',
      'node:fs',
      'node:path',
    ])
  })

  it('ignores import-like text outside import syntax', async () => {
    const prohibited = await findProhibitedSpecifiers(`
      /* import('node:fs') */
      const quoted = "import '@open-mercato/cezar-contract'"
      const templated = \`import('node:path')\`
      const computed = import(specifier)
    `)

    expect(prohibited).toEqual([])
  })
})

describe('React peer externalization', () => {
  it('externalizes peer package families including JSX and DOM subpaths', () => {
    expect(isReactPeerExternal('react')).toBe(true)
    expect(isReactPeerExternal('react/jsx-runtime')).toBe(true)
    expect(isReactPeerExternal('react/jsx-dev-runtime')).toBe(true)
    expect(isReactPeerExternal('react-dom')).toBe(true)
    expect(isReactPeerExternal('react-dom/client')).toBe(true)
    expect(isReactPeerExternal('reactive')).toBe(false)
    expect(isReactPeerExternal('react-domination')).toBe(false)
  })
})
