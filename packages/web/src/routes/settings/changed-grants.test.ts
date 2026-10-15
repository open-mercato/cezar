import { describe, expect, it } from 'vitest'

import { changedGrants } from './isolation-section'

/**
 * The project page shows the EFFECTIVE grants — machine-wide ones included —
 * and used to write that whole map back into the repo. Every inherited grant
 * was then pinned there, and revoking it machine-wide did nothing in this
 * project. Only what the operator changed may be written.
 */
describe('what a project page writes when one credential is toggled', () => {
  // ssh and aws come from the machine; the repo has chosen nothing.
  const effective = { ssh: true, aws: { mode: 'copy' as const } }

  it('ticking one credential writes that one, not the inherited ones', () => {
    expect(changedGrants(effective, { ...effective, gcloud: true })).toEqual({ gcloud: true })
  })

  it('unticking an inherited one writes an explicit false, not a deletion', () => {
    // Deleting the repo's key would just inherit the grant straight back on.
    const { aws: _dropped, ...next } = effective
    expect(changedGrants(effective, next)).toEqual({ aws: false })
  })

  it('changing a mode writes only that credential', () => {
    expect(changedGrants(effective, { ...effective, aws: { mode: 'mount' } })).toEqual({ aws: { mode: 'mount' } })
  })

  it('no change, no write', () => {
    expect(changedGrants(effective, { ...effective })).toEqual({})
  })
})
