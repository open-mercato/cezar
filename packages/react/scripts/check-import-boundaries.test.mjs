import { describe, expect, it } from 'vitest'

import { isReactPackageExternal, isReactPeerExternal } from '../vite.config.ts'
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

  it('parses TSX while still finding static and dynamic imports', async () => {
    const prohibited = await findProhibitedSpecifiers(`
      import type { Secret } from '@open-mercato/cezar-contract'
      const view = <section>{String('safe')}</section>
      const load = () => import('node:fs')
    `)

    expect(prohibited).toEqual([
      '@open-mercato/cezar-contract',
      'node:fs',
    ])
  })

  it('does not let import.meta or import/export property names hide later imports', async () => {
    const prohibited = await findProhibitedSpecifiers(`
      const moduleUrl = import.meta.url
      import 'node:fs'
      const importer = loader.import
      import('node:path')
      const exported = loader.export
      export type { Secret } from '@open-mercato/cezar-contract'
    `)

    expect(prohibited).toEqual([
      'node:fs',
      'node:path',
      '@open-mercato/cezar-contract',
    ])
  })

  it('ignores harmless import/export property syntax in semicolonless TSX', async () => {
    const prohibited = await findProhibitedSpecifiers(`
      const moduleUrl = import.meta.url
      const importer = loader.import
      const exported = loader.export
      const record = { import: 'safe', export: 'safe' }
      const view = <section data-import="safe">safe</section>
    `)

    expect(prohibited).toEqual([])
  })

  it('keeps shared runtime dependencies external to the library bundle', () => {
    expect(isReactPackageExternal('@open-mercato/cezar-api-client')).toBe(true)
    expect(isReactPackageExternal('@tanstack/react-query')).toBe(true)
    expect(isReactPackageExternal('@tanstack/react-query/devtools')).toBe(true)
    expect(isReactPackageExternal('@tanstack/reactive-query')).toBe(false)
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
