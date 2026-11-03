import { describe, expect, it } from 'vitest'

import { newDraft } from './editor-draft'
import { draftSentence, railSteps, triggerComplete } from './editor-sentence'

/** The editor's readback line and its step rail (spec 2026-10-26-first-run-onboarding § Automations editor). */
describe('draftSentence', () => {
  it('reads a fresh draft back in plain words', () => {
    expect(draftSentence(newDraft(), true)).toBe('Every day at 04:00: a quick task on the default agent, autonomous.')
  })

  it('names the skill, the agent, the model, the pause mode and the subtasks when set', () => {
    const draft = { ...newDraft(), kind: 'github' as const, events: ['issue.opened' as const], skill: 'triage', runner: 'codex' as const, model: 'gpt-5', autonomous: false, dispatch: true, maxSubtasks: 6 }
    expect(draftSentence(draft, true)).toBe('On issue.opened · every 5 min: skill triage on codex (gpt-5), pausing when it needs you, up to 6 subtasks.')
    // Dispatch is not mentioned where the cockpit has it off: it would not fire there.
    expect(draftSentence(draft, false)).toBe('On issue.opened · every 5 min: skill triage on codex (gpt-5), pausing when it needs you.')
  })
})

describe('railSteps', () => {
  it('starts on When for a fresh draft, with everything open', () => {
    // A schedule is always complete, so the rail is already past When.
    expect(railSteps(newDraft(), false).map((step) => step.state)).toEqual(['done', 'current', 'next'])
  })

  it('ticks What with a prompt and lands on Go live, all ticked once named', () => {
    const withPrompt = { ...newDraft(), prompt: 'Bump the deps.' }
    expect(railSteps(withPrompt, false).map((step) => step.state)).toEqual(['done', 'done', 'current'])
    expect(railSteps({ ...withPrompt, name: 'Nightly' }, false).map((step) => step.state)).toEqual(['done', 'done', 'done'])
  })

  it('holds on When for a GitHub trigger with no event, or a label event with no changed labels', () => {
    const github = { ...newDraft(), kind: 'github' as const, prompt: 'x', name: 'y' }
    expect(triggerComplete({ ...github, events: [] }, false)).toBe(false)
    expect(railSteps({ ...github, events: [] }, false).map((step) => step.state)).toEqual(['current', 'next', 'next'])
    expect(triggerComplete({ ...github, events: ['issue.labeled'] }, false)).toBe(false)
    expect(triggerComplete({ ...github, events: ['issue.labeled'], filters: { ...github.filters, changedLabels: 'bug' } }, false)).toBe(true)
    // A tracker trigger is complete only when its fields say so.
    expect(triggerComplete({ ...github, kind: 'tracker' }, false)).toBe(false)
    expect(triggerComplete({ ...github, kind: 'tracker' }, true)).toBe(true)
  })
})
