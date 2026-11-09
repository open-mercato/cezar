import { QueryClientProvider } from '@tanstack/react-query'
import { ReactFlowProvider } from '@xyflow/react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { queryKeys } from '@/api/queries'
import type { ApiRun, StepState, WorkflowDef } from '@open-mercato/cezar-api-client'

import { TaskGraphView } from './task-graph'

/**
 * The Graph tab on a run that closed without failing: the node of the step that closed it reads
 * orange "closed · idle" (#2024) or a still "needs you" (#2025), like the run header and the step
 * rail. jsdom never measures a node, so these read the nodes' DOM attributes, not their layout.
 */

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  // A child's record comes from the cache; nothing here should reach the network.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const AT = '2026-11-09T10:00:00.000Z'
const LATER = '2026-11-09T10:05:00.000Z'

const DEF: WorkflowDef = {
  name: 'verify',
  source: 'file',
  steps: [
    { id: 'implement', name: 'Implement', prompt: '{{task}}' },
    { id: 'tests', name: 'Tests', command: 'npm test', onFail: { retry: 'implement', max: 2 } },
    { id: 'fix', name: 'Fix failures', prompt: 'fix' },
  ],
}

const step = (id: string, extra: Partial<StepState> = {}): StepState => ({
  id,
  name: id,
  kind: 'agent',
  status: 'done',
  iterations: 1,
  tokensUsed: 0,
  ...extra,
})

const run = (extra: Partial<ApiRun> = {}): ApiRun => ({
  id: 'r1',
  title: 'verify',
  workflow: 'verify',
  task: 'do it',
  status: 'failed',
  createdAt: AT,
  tokensUsed: 0,
  archived: false,
  workflowDef: DEF,
  steps: [
    step('implement'),
    step('tests', { kind: 'check', status: 'failed', finishedAt: AT }),
    step('fix', { status: 'failed', finishedAt: LATER }),
  ],
  ...extra,
})

function renderGraph(record: ApiRun, cached: ApiRun[] = []) {
  const client = createQueryClient()
  for (const r of cached) client.setQueryData(queryKeys.runs.detail(r.id), r)
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ReactFlowProvider>
          <TaskGraphView run={record} embedded />
        </ReactFlowProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const nodeEl = (id: string) => document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"] [data-node-status]`)
const statusDot = (id: string) => nodeEl(id)?.querySelector('[aria-label]')?.getAttribute('aria-label')

describe('the Graph tab on an idle-closed run (#2024)', () => {
  it('draws the closing step orange with the "closed · idle" label', () => {
    renderGraph(run({ idleClosedAt: LATER }))
    const node = nodeEl('fix')
    expect(node?.getAttribute('data-node-status')).toBe('idle')
    expect(node?.querySelector('.ring-conflict')).not.toBeNull()
    expect(node?.querySelector('.bg-conflict')).not.toBeNull()
    expect(node?.querySelector('.ring-danger, .bg-danger')).toBeNull()
    expect(statusDot('fix')).toBe('closed · idle')
  })

  it('recolours only the step that idle-closed the run', () => {
    renderGraph(run({ idleClosedAt: LATER }))
    expect(nodeEl('tests')?.getAttribute('data-node-status')).toBe('failed')
    expect(statusDot('tests')).toBe('failed')
  })

  it('the details panel reads "closed · idle"', () => {
    renderGraph(run({ idleClosedAt: LATER }))
    fireEvent.click(document.querySelector('.react-flow__node[data-id="fix"]')!)
    const panel = screen.getByLabelText('Node details')
    expect(panel.textContent).toContain('closed · idle')
    expect(panel.textContent).not.toContain('failed')
  })

  it('a failed run without idleClosedAt stays red "failed"', () => {
    renderGraph(run())
    const node = nodeEl('fix')
    expect(node?.getAttribute('data-node-status')).toBe('failed')
    expect(node?.querySelector('.ring-danger')).not.toBeNull()
    expect(statusDot('fix')).toBe('failed')
  })


  it("a multi-step child card shows the child's idle-closing step as an orange dot", () => {
    const child = run({
      id: 'child-1',
      idleClosedAt: LATER,
      steps: [step('a', { name: 'Plan' }), step('b', { name: 'Build', status: 'failed', finishedAt: LATER })],
    })
    const parent = run({
      steps: [step('implement', { status: 'running' }), step('tests', { status: 'pending' }), step('fix', { status: 'pending' })],
      graphState: { loops: {}, taken: [], outputs: { implement: { runId: 'child-1' } } },
    })
    renderGraph(parent, [child])
    const inner = document.querySelector('.react-flow__node[data-id="implement"] [aria-label="steps inside"]')
    const dots = inner ? [...inner.querySelectorAll('[title]')] : []
    expect(dots.map((d) => d.getAttribute('title'))).toEqual(['Plan — done', 'Build — closed · idle'])
    expect(dots[1]?.querySelector('.bg-conflict')).not.toBeNull()
  })
})

describe('the Graph tab on a run closed on an unanswered question (#2025)', () => {
  it('draws the closing step as a still "needs you" node, even when the idle timer closed it', () => {
    renderGraph(run({ idleClosedAt: LATER, awaitingAnswerSince: LATER }))
    const node = nodeEl('fix')
    expect(node?.getAttribute('data-node-status')).toBe('answer')
    expect(node?.querySelector('.ring-info')).not.toBeNull()
    expect(node?.querySelector('.bg-info')).not.toBeNull()
    expect(node?.querySelector('.ring-danger, .bg-danger, .ring-conflict, .bg-conflict')).toBeNull()
    // Still, unlike a live `waiting` node: no session is left.
    expect(node?.querySelector('.motion-safe\\:animate-pulse')).toBeNull()
    expect(statusDot('fix')).toBe('needs you')
  })

  it('recolours only the closing step, and the details panel reads "needs you"', () => {
    renderGraph(run({ awaitingAnswerSince: LATER }))
    expect(nodeEl('tests')?.getAttribute('data-node-status')).toBe('failed')
    fireEvent.click(document.querySelector('.react-flow__node[data-id="fix"]')!)
    const panel = screen.getByLabelText('Node details')
    expect(panel.textContent).toContain('needs you')
    expect(panel.textContent).not.toContain('failed')
  })

  it("a multi-step child card shows the child's closing step as a still blue dot", () => {
    const child = run({
      id: 'child-1',
      awaitingAnswerSince: LATER,
      steps: [step('a', { name: 'Plan' }), step('b', { name: 'Ask', status: 'failed', finishedAt: LATER })],
    })
    const parent = run({
      steps: [step('implement', { status: 'running' }), step('tests', { status: 'pending' }), step('fix', { status: 'pending' })],
      graphState: { loops: {}, taken: [], outputs: { implement: { runId: 'child-1' } } },
    })
    renderGraph(parent, [child])
    const inner = document.querySelector('.react-flow__node[data-id="implement"] [aria-label="steps inside"]')
    const dots = inner ? [...inner.querySelectorAll('[title]')] : []
    expect(dots.map((d) => d.getAttribute('title'))).toEqual(['Plan — done', 'Ask — needs you'])
    const dot = dots[1]?.querySelector('.bg-info')
    expect(dot).not.toBeNull()
    expect(dot?.getAttribute('class')).not.toContain('animate-pulse')
  })
})
