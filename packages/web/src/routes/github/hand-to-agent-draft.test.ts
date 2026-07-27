import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  readFollowupPrompt,
  readFollowupSelection,
  resetFollowupSelection,
  writeFollowupPrompt,
  writeFollowupSelection,
} from './hand-to-agent-draft'

const ISSUE_A = 'https://github.com/acme/demo/issues/1'
const ISSUE_B = 'https://github.com/acme/demo/issues/2'

beforeEach(() => localStorage.clear())
afterEach(resetFollowupSelection)

describe('the follow-up "remembered last selection" store (#408 item 3)', () => {
  it('starts empty — no workflow, no skills', () => {
    expect(readFollowupSelection()).toEqual({ workflow: null, skills: [] })
  })

  it('round-trips a workflow + skills pick', () => {
    writeFollowupSelection({ workflow: 'ship-it', skills: ['om-fix', 'om-review'] })
    expect(readFollowupSelection()).toEqual({ workflow: 'ship-it', skills: ['om-fix', 'om-review'] })
  })

  it('survives a cold read (page reload) via localStorage, not just an in-memory cache', () => {
    writeFollowupSelection({ workflow: null, skills: ['om-fix'] })
    const raw = localStorage.getItem('cez-followup-selection') as string
    expect(JSON.parse(raw)).toEqual({ workflow: null, skills: ['om-fix'] })
  })

  it('normalizes a malformed/older stored value instead of throwing', () => {
    localStorage.setItem('cez-followup-selection', 'not json at all')
    expect(readFollowupSelection()).toEqual({ workflow: null, skills: [] })

    localStorage.setItem('cez-followup-selection', '{"workflow":7,"skills":["a",2,"b"]}')
    expect(readFollowupSelection()).toEqual({ workflow: null, skills: ['a', 'b'] })
  })
})

describe('the follow-up per-item prompt draft store (#408 item 4)', () => {
  it('an untouched item answers the empty string', () => {
    expect(readFollowupPrompt(ISSUE_A)).toBe('')
  })

  it('round-trips a typed prompt for one item', () => {
    writeFollowupPrompt(ISSUE_A, 'Also add a regression test.')
    expect(readFollowupPrompt(ISSUE_A)).toBe('Also add a regression test.')
  })

  it('keys by item URL so distinct hand-off targets never collide', () => {
    writeFollowupPrompt(ISSUE_A, 'fix A this way')
    writeFollowupPrompt(ISSUE_B, 'fix B that way')
    expect(readFollowupPrompt(ISSUE_A)).toBe('fix A this way')
    expect(readFollowupPrompt(ISSUE_B)).toBe('fix B that way')
  })

  it('writing an empty string clears the entry rather than storing it', () => {
    writeFollowupPrompt(ISSUE_A, 'draft in progress')
    expect(localStorage.getItem('cez-followup-prompt:' + ISSUE_A)).not.toBeNull()
    writeFollowupPrompt(ISSUE_A, '')
    expect(localStorage.getItem('cez-followup-prompt:' + ISSUE_A)).toBeNull()
    expect(readFollowupPrompt(ISSUE_A)).toBe('')
  })
})
