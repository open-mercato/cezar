import { describe, expect, it } from 'vitest'

import { resolveNodeId } from './node-id'

const ids = ['plan', 'build']

describe('resolveNodeId', () => {
  it('slugifies a display-name-like draft instead of rejecting it', () => {
    expect(resolveNodeId('Run tests', 'plan', ids)).toEqual({ ok: true, id: 'Run-tests' })
    expect(resolveNodeId('build.step', 'plan', ids)).toEqual({ ok: true, id: 'build-step' })
    expect(resolveNodeId('café check', 'plan', ids)).toEqual({ ok: true, id: 'cafe-check' })
  })
  it('accepts the node’s own id, also after slugifying', () => {
    expect(resolveNodeId('plan', 'plan', ids)).toEqual({ ok: true, id: 'plan' })
    expect(resolveNodeId(' plan ', 'plan', ids)).toEqual({ ok: true, id: 'plan' })
  })
  it('names the reason: taken vs invalid vs empty', () => {
    expect(resolveNodeId('build', 'plan', ids)).toMatchObject({ ok: false, reason: 'taken' })
    expect(resolveNodeId('Build', 'plan', ['Build'])).toMatchObject({ ok: false, reason: 'taken' })
    expect(resolveNodeId('日本語', 'plan', ids)).toMatchObject({ ok: false, reason: 'invalid' })
    expect(resolveNodeId('  ', 'plan', ids)).toMatchObject({ ok: false, reason: 'empty' })
  })
})
