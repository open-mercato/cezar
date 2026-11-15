import { describe, expect, it } from 'vitest'

import { deriveAttention } from '@/lib/attention'

import { automationState, runAttention, schedulerState } from './automation-state'

describe('runAttention', () => {
  it('is the canonical attention function, status by status — never a hand-picked tone', () => {
    for (const status of ['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled'] as const) {
      expect(runAttention(status)).toEqual(deriveAttention({ status }))
    }
    // The grammar the surfaces rely on: running pulses violet, a gate is blue, done is calm green.
    expect(runAttention('running')).toMatchObject({ tone: 'violet', pulse: true, label: 'running' })
    expect(runAttention('review')).toMatchObject({ tone: 'info', label: 'needs review' })
    expect(runAttention('done')).toMatchObject({ tone: 'success', pulse: false })
    expect(runAttention('queued')).toMatchObject({ tone: 'neutral' })
  })
})

describe('automationState', () => {
  it('rests green for an enabled schedule, watches amber for an enabled poll, grey when paused', () => {
    expect(automationState({ kind: 'schedule', enabled: true })).toEqual({ tone: 'success', pulse: false, label: 'enabled' })
    expect(automationState({ kind: 'github', enabled: true })).toEqual({ tone: 'pending', pulse: true, label: 'enabled' })
    expect(automationState({ kind: 'tracker', enabled: true })).toEqual({ tone: 'pending', pulse: true, label: 'enabled' })
    expect(automationState({ kind: 'schedule', enabled: false })).toEqual({ tone: 'neutral', pulse: false, label: 'paused' })
  })

  it('names a GitHub poll paused by a missing forge before anything else', () => {
    expect(automationState({ kind: 'github', enabled: true }, false).label).toBe('paused by capability')
    expect(automationState({ kind: 'schedule', enabled: true }, false).label).toBe('enabled')
  })
})

describe('schedulerState', () => {
  it('is green when armed and grey when idle', () => {
    expect(schedulerState('scheduled')).toMatchObject({ tone: 'success', label: 'Scheduler running' })
    expect(schedulerState('idle')).toMatchObject({ tone: 'neutral', label: 'Scheduler idle' })
  })
})
