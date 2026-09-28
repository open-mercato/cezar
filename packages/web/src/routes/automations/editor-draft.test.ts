import { describe, expect, it } from 'vitest'

import type { AutomationDefinition } from '@open-mercato/cezar-api-client'

import {
  applyTemplate,
  cliDefinitionOf,
  fromDefinition,
  needsChangedLabels,
  newDraft,
  pickSource,
  scheduleBody,
  sourceOf,
  splitList,
  templatePick,
  toBody,
} from './editor-draft'

const SCHEDULE_DEF: AutomationDefinition = {
  id: 'a1',
  revision: 3,
  name: 'Nightly dependency bump',
  enabled: true,
  kind: 'schedule',
  schedule: { type: 'weekly', hour: 16, minute: 30, day: 5 },
  task: {
    prompt: 'Bump deps',
    workflow: 'fix-and-verify',
    runner: 'codex',
    model: 'gpt-future',
    autonomous: true,
    dispatch: { maxSubtasks: 6, reviewChild: false },
  },
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z',
}

const GITHUB_DEF: AutomationDefinition = {
  id: 'a2',
  revision: 1,
  name: 'Triage',
  enabled: false,
  kind: 'github',
  events: ['issue.opened', 'issue.labeled'],
  intervalSeconds: 600,
  filters: {
    authors: ['alice', 'bob'],
    changedLabels: ['bug'],
    lookbackDays: 14,
    maxRecords: 50,
  },
  task: { prompt: 'Read {{github.url}}', workflow: 'quick-task', autonomous: false },
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z',
}

describe('newDraft', () => {
  it('starts paused, daily at 04:00, quick-task, autonomous, no dispatch, empty prompt', () => {
    const draft = newDraft()
    expect(draft).toMatchObject({
      name: '',
      kind: 'schedule',
      schedule: { type: 'daily', hour: 4, minute: 0 },
      workflow: 'quick-task',
      autonomous: true,
      dispatch: false,
      enabled: false,
      prompt: '',
    })
  })
})

describe('fromDefinition / toBody', () => {
  it('round-trips a schedule definition', () => {
    const draft = fromDefinition(SCHEDULE_DEF)
    expect(draft.enabled).toBe(true)
    expect(draft.dispatch).toBe(true)
    expect(draft.maxSubtasks).toBe(6)
    expect(draft.reviewChild).toBe(false)
    expect(draft.runner).toBe('codex')
    expect(toBody(draft)).toEqual({
      name: 'Nightly dependency bump',
      kind: 'schedule',
      schedule: { type: 'weekly', hour: 16, minute: 30, day: 5 },
      task: SCHEDULE_DEF.task,
    })
  })

  it('round-trips a github definition, filters as comma lists', () => {
    const draft = fromDefinition(GITHUB_DEF)
    expect(draft.filters.authors).toBe('alice, bob')
    expect(draft.filters.changedLabels).toBe('bug')
    expect(draft.filters.lookbackDays).toBe(14)
    expect(toBody(draft)).toEqual({
      name: 'Triage',
      kind: 'github',
      events: ['issue.opened', 'issue.labeled'],
      intervalSeconds: 600,
      filters: { authors: ['alice', 'bob'], changedLabels: ['bug'], lookbackDays: 14, maxRecords: 50 },
      task: { prompt: 'Read {{github.url}}', workflow: 'quick-task', autonomous: false },
    })
  })

  it('sends only the active kind — a schedule body carries no events or filters', () => {
    const draft = { ...fromDefinition(GITHUB_DEF), kind: 'schedule' as const }
    const body = toBody(draft)
    expect(body.kind).toBe('schedule')
    expect(body).not.toHaveProperty('events')
    expect(body).not.toHaveProperty('filters')
    expect(body).not.toHaveProperty('intervalSeconds')
  })

  it('omits an untouched runner and an auto model; sends dispatch only when on', () => {
    const body = toBody({ ...newDraft(), name: ' x ', prompt: 'p', model: '' })
    expect(body.name).toBe('x')
    expect(body.task).toEqual({ prompt: 'p', workflow: 'quick-task', autonomous: true })
  })

  it('reads a one-step skill chain back as the skill, and keeps other inline steps untouched', () => {
    const skillSteps = [{ id: 'task', name: 'om-review', skill: 'om-review', prompt: '{{task}}' }]
    const skill = fromDefinition({ ...SCHEDULE_DEF, task: { prompt: 'p', steps: skillSteps } })
    expect(sourceOf(skill)).toEqual({ source: 'skill', ref: 'om-review' })
    expect(toBody(skill).task).toEqual({ prompt: 'p', steps: skillSteps, autonomous: false })

    const planSteps = [{ id: 'plan', prompt: 'Plan it' }, { id: 'do', skill: 'om-fix', prompt: '{{task}}' }]
    const custom = fromDefinition({ ...SCHEDULE_DEF, task: { prompt: 'p', steps: planSteps } })
    expect(sourceOf(custom)).toBeNull()
    expect(toBody(custom).task.steps).toEqual(planSteps)
    // A pick replaces the custom chain.
    expect(toBody({ ...custom, ...pickSource({ source: 'workflow', ref: 'fix-and-verify' }) }).task)
      .toEqual({ prompt: 'p', workflow: 'fix-and-verify', autonomous: false })
  })

  it('sends the picked agent account, and a template naming a runner drops it', () => {
    const picked = { ...newDraft(), prompt: 'p', runner: 'claude' as const, account: 'work' }
    expect(toBody(picked).task).toMatchObject({ runner: 'claude', agentProfile: 'work' })
    expect(toBody({ ...picked, account: null }).task.agentProfile).toBeUndefined()
    expect(fromDefinition({ ...SCHEDULE_DEF, task: { prompt: 'p', agentProfile: 'work' } }).account).toBe('work')
    // An account belongs to one runner, so a template that names one must not inherit it.
    const template = { name: 'Sweep', kind: 'schedule' as const, prompt: 'sweep' }
    expect(applyTemplate(picked, { ...template, runner: 'codex' }).account).toBeNull()
    expect(applyTemplate(picked, template).account).toBe('work')
  })

  it('clamps lookback and max records into the server bounds', () => {
    const draft = newDraft()
    draft.kind = 'github'
    draft.filters = { ...draft.filters, lookbackDays: 400, maxRecords: 0 }
    expect(toBody(draft).filters).toEqual({ lookbackDays: 90, maxRecords: 1 })
  })
})

describe('scheduleBody', () => {
  it('keeps only the keys the type reads', () => {
    expect(scheduleBody({ type: 'hours', every: 6, hour: 4, minute: 0 })).toEqual({ type: 'hours', every: 6 })
    expect(scheduleBody({ type: 'daily', day: 3 })).toEqual({ type: 'daily', hour: 4, minute: 0 })
    expect(scheduleBody({ type: 'weekly' })).toEqual({ type: 'weekly', hour: 4, minute: 0, day: 1 })
  })
})

describe('applyTemplate', () => {
  it('fills name, kind, trigger, prompt and task and leaves the rest', () => {
    const draft = { ...newDraft(), enabled: true, autonomous: false }
    const next = applyTemplate(draft, {
      name: 'Flaky test hunt',
      kind: 'schedule',
      schedule: { type: 'weekly', day: 2, hour: 2, minute: 0 },
      prompt: 'Run the suite 5×',
      workflow: 'fix-and-verify',
      dispatch: { maxSubtasks: 8, reviewChild: true },
    })
    expect(next).toMatchObject({
      name: 'Flaky test hunt',
      schedule: { type: 'weekly', day: 2, hour: 2, minute: 0 },
      prompt: 'Run the suite 5×',
      workflow: 'fix-and-verify',
      dispatch: true,
      maxSubtasks: 8,
      reviewChild: true,
      enabled: true,
      autonomous: false,
    })
  })

  it('switches to github with events and interval', () => {
    const next = applyTemplate(newDraft(), {
      name: 'Triage new issues',
      kind: 'github',
      events: ['issue.opened'],
      intervalSeconds: 300,
      prompt: 'Read it',
    })
    expect(next.kind).toBe('github')
    expect(next.events).toEqual(['issue.opened'])
    expect(next.dispatch).toBe(false)
  })

  it('reads another project\'s automation through templatePick', () => {
    const pick = templatePick({
      project: { id: 'p2', name: 'shop' },
      id: 'x',
      name: 'Sweep',
      kind: 'schedule',
      schedule: { type: 'daily', hour: 7 },
      task: { prompt: 'sweep', runner: 'codex', autonomous: true },
    })
    expect(pick).toEqual({
      name: 'Sweep',
      kind: 'schedule',
      schedule: { type: 'daily', hour: 7 },
      prompt: 'sweep',
      runner: 'codex',
      autonomous: true,
    })
    expect(applyTemplate(newDraft(), pick).runner).toBe('codex')
  })
})

describe('helpers', () => {
  it('splitList trims and drops empties', () => {
    expect(splitList(' a, b ,,c ')).toEqual(['a', 'b', 'c'])
    expect(splitList('')).toEqual([])
  })

  it('needsChangedLabels for the two label events only', () => {
    expect(needsChangedLabels(['issue.opened'])).toBe(false)
    expect(needsChangedLabels(['issue.unlabeled'])).toBe(true)
  })

  it('cliDefinitionOf carries the enable flag and the body', () => {
    const cli = cliDefinitionOf({ ...fromDefinition(SCHEDULE_DEF), enabled: true })
    expect(cli.enable).toBe(true)
    expect(cli.schedule).toEqual({ type: 'weekly', hour: 16, minute: 30, day: 5 })
    expect(cliDefinitionOf(fromDefinition(GITHUB_DEF))).not.toHaveProperty('enable')
  })
})

describe('tracker event draft', () => {
  const association = { kind: 'jira' as const, source: { id: 'cloud', webUrl: 'https://example.atlassian.net' }, externalId: '100', externalName: 'Team', connectionId: '11111111-1111-4111-8111-111111111111' }
  it('round trips an event trigger without converting it into a GitHub poll', () => {
    const definition = { ...GITHUB_DEF, kind: 'tracker' as const, events: undefined,
      trackerTrigger: { events: ['issue.status_changed' as const], targetStatusIds: ['todo-id'], requiredLabels: ['bug', 'urgent'], association }, intervalSeconds: 1800 }
    const draft = fromDefinition(definition)
    expect(draft.kind).toBe('tracker')
    expect(toBody(draft)).toMatchObject({ kind: 'tracker', trackerTrigger: definition.trackerTrigger, intervalSeconds: 1800 })
    expect(toBody(draft)).not.toHaveProperty('events')
    expect(cliDefinitionOf(draft)).toHaveProperty('trackerTrigger', definition.trackerTrigger)
  })
  it('keeps a legacy tracker visibly unconfigured rather than guessing status-change semantics', () => {
    const draft = fromDefinition({ ...GITHUB_DEF, kind: 'tracker' })
    expect(draft.kind).toBe('tracker')
    expect(draft.trackerTrigger).toBeUndefined()
  })
})
