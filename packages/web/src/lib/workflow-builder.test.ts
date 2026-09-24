import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import type { WorkflowStepDef } from '@open-mercato/cezar-api-client'

import {
  WB_MAX_STEPS,
  draftFromPlan,
  insertStep,
  moveStep,
  removeStep,
  saveBody,
  skillStack,
  skillStep,
  stepCountLabel,
  workflowSlug,
  workflowYaml,
} from './workflow-builder'

/** A pure "apply this skill to the task" agent step — what a palette drop produces. */
const stackStep = (skill: string, id = skill): WorkflowStepDef => ({
  id,
  name: skill,
  skill,
  prompt: '{{task}}',
})

const CHECK: WorkflowStepDef = {
  id: 'tests',
  name: 'Run tests',
  command: 'npm test',
  onFail: { retry: 'fix', max: 2 },
}

// ---- the compact-form mirror -------------------------------------------------------------------

describe('skillStack', () => {
  it('answers the skill list for a pure stack', () => {
    expect(skillStack([stackStep('a'), stackStep('b')])).toEqual(['a', 'b'])
  })

  it('answers null for an empty canvas', () => {
    expect(skillStack([])).toBeNull()
  })

  it.each<[reason: string, step: WorkflowStepDef]>([
    ['a check step', CHECK],
    ['a custom prompt', { ...stackStep('a'), prompt: 'do it differently' }],
    ['a renamed step', { ...stackStep('a'), name: 'Something else' }],
    ['a per-step model', { ...stackStep('a'), model: 'opus' }],
    ['a per-step runner', { ...stackStep('a'), runner: 'codex' }],
    ['an onFail loop', { ...stackStep('a'), onFail: { retry: 'a', max: 2 } }],
    ['a plain prompt step (no skill)', { id: 'p', prompt: '{{task}}' }],
  ])('anything richer — %s — forces the full steps form', (_reason, step) => {
    expect(skillStack([stackStep('x'), step])).toBeNull()
  })
})

// ---- palette → canvas ---------------------------------------------------------------------------

describe('skillStep / insertStep (palette → canvas add)', () => {
  it('a palette drop becomes the canonical agent step', () => {
    expect(skillStep('om-fix', [])).toEqual({
      id: 'om-fix',
      name: 'om-fix',
      skill: 'om-fix',
      prompt: '{{task}}',
    })
  })

  it('adding the same skill twice keeps ids unique (om-fix, om-fix-2, om-fix-3)', () => {
    let steps: WorkflowStepDef[] = []
    for (let i = 0; i < 3; i++) steps = insertStep(steps, skillStep('om-fix', steps), steps.length)
    expect(steps.map((s) => s.id)).toEqual(['om-fix', 'om-fix-2', 'om-fix-3'])
    // Still a pure stack — the shorthand repeats the skill.
    expect(skillStack(steps)).toEqual(['om-fix', 'om-fix', 'om-fix'])
  })

  it('inserts at the drop index and clamps out-of-range indexes', () => {
    const steps = [stackStep('a'), stackStep('b')]
    expect(insertStep(steps, stackStep('c'), 1).map((s) => s.id)).toEqual(['a', 'c', 'b'])
    expect(insertStep(steps, stackStep('c'), 99).map((s) => s.id)).toEqual(['a', 'b', 'c'])
    expect(insertStep(steps, stackStep('c'), -5).map((s) => s.id)).toEqual(['c', 'a', 'b'])
    // Immutable: the input list is untouched.
    expect(steps.map((s) => s.id)).toEqual(['a', 'b'])
  })
})

// ---- reorder / remove ---------------------------------------------------------------------------

describe('moveStep (drag reorder)', () => {
  const steps = [stackStep('a'), stackStep('b'), stackStep('c')]

  it('moves down and up', () => {
    expect(moveStep(steps, 0, 2).map((s) => s.id)).toEqual(['b', 'c', 'a'])
    expect(moveStep(steps, 2, 0).map((s) => s.id)).toEqual(['c', 'a', 'b'])
  })

  it('a cancelled or out-of-range drag is a no-op, never a crash', () => {
    expect(moveStep(steps, 1, 1).map((s) => s.id)).toEqual(['a', 'b', 'c'])
    expect(moveStep(steps, -1, 2).map((s) => s.id)).toEqual(['a', 'b', 'c'])
    expect(moveStep(steps, 0, 3).map((s) => s.id)).toEqual(['a', 'b', 'c'])
  })

  it('removeStep drops exactly the given index', () => {
    expect(removeStep(steps, 1).map((s) => s.id)).toEqual(['a', 'c'])
  })
})

// ---- the 8-step limit ---------------------------------------------------------------------------

describe('WB_MAX_STEPS', () => {
  it('mirrors the server save/run limit', () => {
    expect(WB_MAX_STEPS).toBe(8)
  })
})

// ---- YAML preview / export ----------------------------------------------------------------------

describe('workflowYaml', () => {
  it('a pure stack round-trips through YAML in the portable compact form', () => {
    const steps = [stackStep('test-conventions'), stackStep('commit-style')]
    const text = workflowYaml('My Flow', 'Checks then commit style.', steps)
    expect(parse(text)).toEqual({
      name: 'My Flow',
      description: 'Checks then commit style.',
      skills: ['test-conventions', 'commit-style'],
    })
  })

  it('a richer flow round-trips in the full steps form, checks and loops intact', () => {
    const steps: WorkflowStepDef[] = [
      { id: 'fix', name: 'Fix it', skill: 'om-fix', prompt: '{{task}}\nBe careful.', model: 'opus' },
      CHECK,
    ]
    const text = workflowYaml('fix-and-test', '', steps)
    expect(parse(text)).toEqual({
      name: 'fix-and-test',
      steps: [
        {
          id: 'fix',
          name: 'Fix it',
          skill: 'om-fix',
          // A YAML block scalar keeps its final newline — same as the legacy serializer.
          prompt: '{{task}}\nBe careful.\n',
          model: 'opus',
        },
        { id: 'tests', name: 'Run tests', command: 'npm test', onFail: { retry: 'fix', max: 2 } },
      ],
    })
  })

  it('quotes scalars YAML would mistype and keeps plain ones bare', () => {
    const text = workflowYaml('true', '', [stackStep('2fast', 'no')])
    // `true`, `no` and `2fast` would parse as boolean/number-ish — they must come back strings.
    expect(parse(text)).toEqual({ name: 'true', skills: ['2fast'] })
    const plain = workflowYaml('my-flow', '', [stackStep('om-fix')])
    expect(plain).toContain('name: my-flow')
    expect(plain).not.toContain('"my-flow"')
  })

  it('an empty canvas previews as an empty (still valid) skills list, defaulting the name', () => {
    expect(parse(workflowYaml('  ', '', []))).toEqual({ name: 'my-workflow', skills: [] })
  })
})

// ---- save body / labels / slug ------------------------------------------------------------------

describe('saveBody', () => {
  it('sends the compact skills form for a pure stack', () => {
    expect(saveBody(' my-flow ', ' desc ', [stackStep('a'), stackStep('a', 'a-2')])).toEqual({
      name: 'my-flow',
      description: 'desc',
      skills: ['a', 'a'],
    })
  })

  it('sends full steps (and omits an empty description) for a richer flow', () => {
    const steps = [stackStep('a'), CHECK]
    expect(saveBody('flow', '', steps)).toEqual({ name: 'flow', steps })
  })
})

describe('stepCountLabel / workflowSlug', () => {
  it('counts skills for a pure stack, steps otherwise, singular at one', () => {
    expect(stepCountLabel([])).toBe('0 steps')
    expect(stepCountLabel([stackStep('a')])).toBe('1 skill')
    expect(stepCountLabel([stackStep('a'), stackStep('b')])).toBe('2 skills')
    expect(stepCountLabel([CHECK])).toBe('1 step')
  })

  it('slugs the export file name the way the server slugs the saved path', () => {
    expect(workflowSlug('My Great Flow!')).toBe('my-great-flow')
    expect(workflowSlug('  ---  ')).toBe('workflow')
  })
})

describe('draftFromPlan (auto chain creator, #414)', () => {
  it('adopts the planner’s proposed name and steps', () => {
    const plan = {
      name: 'fix-and-review',
      steps: [
        { id: 'implement', name: 'Implement', prompt: '{{task}}' },
        { id: 'verify', name: 'Verify', command: 'npm test' },
      ] satisfies WorkflowStepDef[],
      rationale: 'do it',
      fallback: false,
    }
    expect(draftFromPlan(plan, 'my-workflow')).toEqual({
      name: 'fix-and-review',
      steps: plan.steps,
    })
  })

  it('keeps the current name when the plan proposed none (never blanks it)', () => {
    const plan = { steps: [{ id: 'task', name: 'Do it', prompt: '{{task}}' }] }
    expect(draftFromPlan(plan, 'my-workflow').name).toBe('my-workflow')
    expect(draftFromPlan({ ...plan, name: '   ' }, 'my-workflow').name).toBe('my-workflow')
  })

  it('caps the chain at the server’s step limit', () => {
    const steps = Array.from({ length: WB_MAX_STEPS + 3 }, (_, i) => ({
      id: `s${i}`,
      name: `Step ${i}`,
      prompt: '{{task}}',
    }))
    expect(draftFromPlan({ steps }, 'x').steps).toHaveLength(WB_MAX_STEPS)
  })

  it('re-dedupes ids so a repaired plan can’t seed a duplicate-id canvas', () => {
    const steps = [
      { id: 'review', name: 'Review', prompt: '{{task}}' },
      { id: 'review', name: 'Review again', prompt: '{{task}}' },
    ]
    expect(draftFromPlan({ steps }, 'x').steps.map((s) => s.id)).toEqual(['review', 'review-2'])
  })
})
