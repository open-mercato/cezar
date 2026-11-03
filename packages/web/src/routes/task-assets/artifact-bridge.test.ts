import { describe, expect, it } from 'vitest'

import { ARTIFACT_REF_LABEL_MAX, askMessage, parseArtifactRef } from './artifact-bridge'

describe('parseArtifactRef', () => {
  it('accepts the one shape and caps the label at 200 chars', () => {
    expect(parseArtifactRef({ type: 'cezar.artifact.ref', ref: 'cap-review-gate', label: 'Review gate' })).toEqual({
      ref: 'cap-review-gate',
      label: 'Review gate',
    })
    const long = parseArtifactRef({ type: 'cezar.artifact.ref', ref: 'x', label: 'a'.repeat(50_000) })
    expect(long?.label).toHaveLength(ARTIFACT_REF_LABEL_MAX)
  })

  it('drops unknown types, malformed bodies and an over-long ref', () => {
    expect(parseArtifactRef({ type: 'send', text: 'rm -rf' })).toBeNull()
    expect(parseArtifactRef({ type: 'cezar.artifact.ref', ref: '', label: 'x' })).toBeNull()
    expect(parseArtifactRef({ type: 'cezar.artifact.ref', ref: 'r'.repeat(129), label: 'x' })).toBeNull()
    expect(parseArtifactRef({ type: 'cezar.artifact.ref', ref: 'x' })).toBeNull()
    expect(parseArtifactRef('cezar.artifact.ref')).toBeNull()
    expect(parseArtifactRef(null)).toBeNull()
  })
})

describe('askMessage', () => {
  it('prefixes the reference', () => {
    expect(askMessage({ ref: 'cap-a', label: 'Gate' }, 'why?')).toBe('About cap-a ("Gate"): why?')
    expect(askMessage(null, 'why?')).toBe('why?')
  })
})
