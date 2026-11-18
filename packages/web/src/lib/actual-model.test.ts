import { describe, expect, it } from 'vitest'

import { requestedToActual, runModelLine, sameModelId, titleWithModel } from './actual-model'

describe('actual model display', () => {
  it('arrows a request that resolved to something else, and hides the arrow when they agree', () => {
    expect(requestedToActual('auto', 'claude-opus-5-5')).toBe('auto → claude-opus-5-5')
    expect(requestedToActual('opus', 'claude-opus-5-5')).toBe('opus → claude-opus-5-5')
    expect(requestedToActual('claude-opus-5-5', 'claude-opus-5-5[1m]')).toBe('claude-opus-5-5')
    expect(requestedToActual('auto', undefined)).toBe('auto')
    expect(sameModelId('anthropic/claude-opus-5-5', 'claude-opus-5-5')).toBe(true)
  })

  it('adds the model line to a row tooltip only when the agent reported one', () => {
    expect(runModelLine({ model: '', actualModel: 'gpt-5.5' })).toBe('Model: auto → gpt-5.5')
    expect(titleWithModel('Fix it', { model: 'opus', actualModel: 'claude-opus-5-5' })).toBe('Fix it\nModel: opus → claude-opus-5-5')
    expect(titleWithModel('Fix it', { model: 'opus' })).toBe('Fix it')
  })
})
