import { describe, expect, it } from 'vitest'
import type { WorkflowGraph } from '@open-mercato/cezar-api-client'

import { simStep, startSim } from './workflow-graph'

const G: WorkflowGraph = {
  nodes: [
    { id: 'start', type: 'start' },
    { id: 'tests', type: 'check', command: 'x' },
    { id: 'retry', type: 'loop', max: 2 },
    { id: 'no', type: 'end', status: 'failed' },
  ],
  edges: [
    { from: 'start', to: 'tests' },
    { from: 'tests.fail', to: 'retry' },
    { from: 'retry.repeat', to: 'tests' },
    { from: 'retry.exhausted', to: 'no' },
  ],
}

describe('the editor simulator', () => {
  it('never mutates the previous state — a doubled React updater counts a loop visit once', () => {
    const s0 = startSim(G)
    const once = simStep(G, s0, 'tests', 'fail')
    const twice = simStep(G, s0, 'tests', 'fail') // StrictMode re-runs the updater on s0
    expect(s0.loops.size).toBe(0)
    expect(twice.loops.get('retry')).toBe(1)
    expect(once.cursor).toBe('tests')
    const s2 = simStep(G, once, 'tests', 'fail')
    expect(s2.cursor).toBe('tests')
    const s3 = simStep(G, s2, 'tests', 'fail')
    expect(s3).toMatchObject({ cursor: null, finished: 'failed' })
    expect(s3.log.at(-1)).toBe('retry.exhausted → no')
  })
})
