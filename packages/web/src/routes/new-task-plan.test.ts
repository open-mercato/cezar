import { describe, expect, it } from 'vitest'

import type { WorkflowStepDef } from '@open-mercato/cezar-api-client'

import {
  buildPlannedRunBody,
  moveStep,
  pendingPlanOf,
  planTaskLine,
  removeStep,
  stepHint,
} from './new-task-plan'

const STEPS: WorkflowStepDef[] = [
  { id: 'implement', name: 'Implement', prompt: '{{task}}' },
  { id: 'verify', name: 'Verify', command: 'npm test' },
  { id: 'review', name: 'Review', prompt: 'Review the changes' },
]
const ids = (steps: WorkflowStepDef[]) => steps.map((s) => s.id)

describe('removeStep', () => {
  it.each([
    { name: 'first', index: 0, expected: ['verify', 'review'] },
    { name: 'middle', index: 1, expected: ['implement', 'review'] },
    { name: 'last', index: 2, expected: ['implement', 'verify'] },
    { name: 'below range (stale click)', index: -1, expected: ['implement', 'verify', 'review'] },
    { name: 'above range (stale click)', index: 3, expected: ['implement', 'verify', 'review'] },
    { name: 'non-integer', index: 1.5, expected: ['implement', 'verify', 'review'] },
  ])('removes the $name step', ({ index, expected }) => {
    expect(ids(removeStep(STEPS, index))).toEqual(expected)
  })

  it('never mutates the input list', () => {
    removeStep(STEPS, 1)
    expect(ids(STEPS)).toEqual(['implement', 'verify', 'review'])
  })
})

describe('moveStep', () => {
  it.each([
    { name: 'down by one', from: 0, to: 1, expected: ['verify', 'implement', 'review'] },
    { name: 'up by one', from: 2, to: 1, expected: ['implement', 'review', 'verify'] },
    { name: 'first to last', from: 0, to: 2, expected: ['verify', 'review', 'implement'] },
    { name: 'last to first', from: 2, to: 0, expected: ['review', 'implement', 'verify'] },
    { name: 'no-op (same slot)', from: 1, to: 1, expected: ['implement', 'verify', 'review'] },
    { name: 'target clamped below', from: 1, to: -5, expected: ['verify', 'implement', 'review'] },
    { name: 'target clamped above', from: 0, to: 99, expected: ['verify', 'review', 'implement'] },
    { name: 'invalid from ignored', from: 7, to: 0, expected: ['implement', 'verify', 'review'] },
    { name: 'negative from ignored', from: -1, to: 2, expected: ['implement', 'verify', 'review'] },
  ])('$name', ({ from, to, expected }) => {
    expect(ids(moveStep(STEPS, from, to))).toEqual(expected)
  })

  it('never mutates the input list', () => {
    moveStep(STEPS, 0, 2)
    expect(ids(STEPS)).toEqual(['implement', 'verify', 'review'])
  })

  it('is safe on an empty list', () => {
    expect(moveStep([], 0, 1)).toEqual([])
  })
})

describe('stepHint', () => {
  it.each([
    { name: 'check step → its command', step: STEPS[1]!, expected: 'npm test' },
    { name: 'agent step → its prompt', step: STEPS[0]!, expected: '{{task}}' },
    {
      name: 'command wins when both exist (a check never prompts)',
      step: { id: 'x', command: 'make lint', prompt: 'nope' } as WorkflowStepDef,
      expected: 'make lint',
    },
    { name: 'neither → empty', step: { id: 'bare' } as WorkflowStepDef, expected: '' },
  ])('$name', ({ step, expected }) => {
    expect(stepHint(step)).toBe(expected)
  })
})

describe('planTaskLine', () => {
  it('keeps only the first line', () => {
    expect(planTaskLine('do the thing\nand then more')).toBe('do the thing')
  })
  it('caps long lines with an ellipsis at the requested width', () => {
    expect(planTaskLine('abcdefgh', 5)).toBe('abcd…')
    expect(planTaskLine('abcde', 5)).toBe('abcde')
  })
})

describe('pendingPlanOf', () => {
  it('carries the task, the answer, and DEFENSIVE copies of steps and images', () => {
    const images = [{ mediaType: 'image/png', data: 'AAA' }]
    const plan = pendingPlanOf('fix it', images, {
      steps: STEPS,
      rationale: 'why',
      fallback: false,
    })
    expect(plan).toEqual({ task: 'fix it', steps: STEPS, rationale: 'why', fallback: false, images })
    expect(plan.steps).not.toBe(STEPS)
    expect(plan.images).not.toBe(images)
  })
})

describe('buildPlannedRunBody — the POST /api/v1/runs wire contract for approved plans', () => {
  const base = {
    task: 'tighten the tests',
    steps: STEPS,
    model: '',
    runner: 'claude' as const,
    defaultRunner: 'claude' as const,
    variants: 1,
    images: [],
  }

  it('defaults collapse away: only task + inline steps go on the wire', () => {
    expect(buildPlannedRunBody(base)).toEqual({
      task: 'tighten the tests',
      steps: STEPS,
      model: undefined,
      runner: undefined,
      variants: undefined,
      images: undefined,
      generateFollowups: undefined,
    })
  })

  it('never sends a workflow name — an edited plan may match no saved chain', () => {
    expect('workflow' in buildPlannedRunBody(base)).toBe(false)
  })

  it('keeps an explicit runner pick even when it equals the project default', () => {
    expect(buildPlannedRunBody({ ...base, runnerExplicit: true }).runner).toBe('claude')
  })

  it('omits the displayed native default when model selection is locked', () => {
    expect(
      buildPlannedRunBody({ ...base, model: 'native-sonnet', modelsLocked: true }).model,
    ).toBeUndefined()
  })

  it.each([
    { name: 'model rides when chosen', patch: { model: 'sonnet' }, key: 'model', expected: 'sonnet' },
    { name: 'connected fallback rides when it differs from the default', patch: { runner: 'codex' as const }, key: 'runner', expected: 'codex' },
    { name: 'variants ride above ×1', patch: { variants: 3 }, key: 'variants', expected: 3 },
  ])('$name', ({ patch, key, expected }) => {
    const body = buildPlannedRunBody({ ...base, ...patch }) as unknown as Record<string, unknown>
    expect(body[key]).toEqual(expected)
  })

  it('images captured at plan time ride into the run, copied', () => {
    const images = [{ mediaType: 'image/png', data: 'AAA' }]
    const body = buildPlannedRunBody({ ...base, images })
    expect(body.images).toEqual(images)
    expect(body.images).not.toBe(images)
  })

  it('copies the steps so later overlay edits cannot mutate an in-flight body', () => {
    const body = buildPlannedRunBody(base)
    expect(body.steps).toEqual(STEPS)
    expect(body.steps).not.toBe(STEPS)
  })

  it('sends only the opt-out value for follow-up generation', () => {
    expect(buildPlannedRunBody({ ...base, generateFollowups: false }).generateFollowups).toBe(false)
    expect(buildPlannedRunBody({ ...base, generateFollowups: true }).generateFollowups).toBeUndefined()
  })
})
