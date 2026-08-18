import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'

describe('compiled stylesheet source', () => {
  it('declares the canonical Tailwind layer order before imports and definitions', async () => {
    const file = resolve(process.cwd(), 'src/styles/index.css')
    const root = postcss.parse(await readFile(file, 'utf8'))
    const first = root.nodes[0]

    expect(first).toMatchObject({
      type: 'atrule',
      name: 'layer',
      params: 'theme, base, components, utilities',
    })
  })
})
