import { describe, expect, it, vi } from 'vitest'

import { autoLayout, compileSteps, graphForWorkflow } from './workflow-graph'

// #1937: whatever dagre throws on, a valid workflow still gets a layout instead of crashing the page.
vi.mock('@dagrejs/dagre', async (importOriginal) => {
  const real = (await importOriginal()) as { default: Record<string, unknown> }
  return {
    default: {
      ...real.default,
      layout: () => {
        throw new Error('Not possible to find intersection inside of the rectangle')
      },
    },
  }
})

describe('autoLayout fallback when dagre throws', () => {
  const chain = compileSteps([
    { id: 'implement', prompt: '{{task}}' },
    { id: 'verify', command: 'npm test' },
  ])

  it('still places every node, left to right along the walk', () => {
    const layout = autoLayout(chain, { rowWidth: Infinity })
    expect(Object.keys(layout).sort()).toEqual(chain.nodes.map((n) => n.id).sort())
    expect(layout.implement!.x).toBeLessThan(layout.verify!.x)
  })

  it('graphForWorkflow returns a complete layout instead of throwing', () => {
    const g = graphForWorkflow({ steps: [], graph: chain })
    expect(chain.nodes.every((n) => g.layout?.[n.id])).toBe(true)
  })
})
