import { describe, expect, it } from 'vitest'

import { hasWorkflowGraph } from './has-workflow-graph'

const step = (id: string) => ({ id, prompt: '{{task}}' })
const run = (workflowDef: unknown) => ({ workflowDef }) as Parameters<typeof hasWorkflowGraph>[0]

describe('hasWorkflowGraph', () => {
  it('is false without a definition', () => {
    expect(hasWorkflowGraph(run(undefined))).toBe(false)
  })
  it('is false for a one-step definition (quick-task, skill runs)', () => {
    expect(hasWorkflowGraph(run({ steps: [step('do')] }))).toBe(false)
  })
  it('is true for a multi-step chain', () => {
    expect(hasWorkflowGraph(run({ steps: [step('a'), step('b')] }))).toBe(true)
  })
  it('is true for a definition with its own graph', () => {
    expect(hasWorkflowGraph(run({ steps: [step('a')], graph: { nodes: [], edges: [] } }))).toBe(true)
  })
})
