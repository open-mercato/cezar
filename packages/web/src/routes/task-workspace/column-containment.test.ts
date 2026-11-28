import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// jsdom has no layout, so the 320px guarantee (#1382) is pinned structurally: every column scroller
// must be able to shrink below its content (min-w-0); the e2e measures the real widths.
describe('workspace column scrollers', () => {
  it('every [data-slot="main"] column scroller carries min-w-0', () => {
    const src = readFileSync(resolve(__dirname, 'workspace-columns.tsx'), 'utf8')
    const mains = src.match(/<div data-slot="main" className="[^"]*"/g) ?? []
    expect(mains.length).toBeGreaterThanOrEqual(2)
    for (const m of mains) expect(m).toContain('min-w-0')
  })
})
