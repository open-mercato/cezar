import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('compiled stylesheet source', () => {
  it('declares the canonical Tailwind layer order before imports and definitions', async () => {
    const file = resolve(packageDir, 'src/styles/index.css')
    const root = postcss.parse(await readFile(file, 'utf8'))
    const first = root.nodes[0]

    expect(first).toMatchObject({
      type: 'atrule',
      name: 'layer',
      params: 'theme, base, components, utilities',
    })
  })

  it('scans the private complete cockpit and the public facade sources', async () => {
    const css = await readFile(resolve(packageDir, 'src/styles/index.css'), 'utf8')

    expect(css).toContain('@source "../../../web/src/**/*.{ts,tsx}"')
    expect(css).toContain('@source "../**/*.{ts,tsx}"')
  })
})
