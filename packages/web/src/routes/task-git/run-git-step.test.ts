import { describe, expect, it } from 'vitest'

import { basedOn } from './run-git-step'

describe('basedOn — is a worktree task based on the trunk? (#2428)', () => {
  it('accepts the base itself and `<base remote name>/<base>`', () => {
    expect(basedOn('main', 'main', 'origin')).toBe(true)
    expect(basedOn('origin/main', 'main', 'origin')).toBe(true)
    expect(basedOn('upstream/main', 'main', 'upstream')).toBe(true)
  })

  it('refuses another branch, another remote, a branch that only ends in the base, and no base', () => {
    expect(basedOn('develop', 'main', 'origin')).toBe(false)
    expect(basedOn('origin/develop', 'main', 'origin')).toBe(false)
    expect(basedOn('origin/main', 'main', 'upstream')).toBe(false)
    expect(basedOn('feature/main', 'main', 'origin')).toBe(false)
    expect(basedOn(undefined, 'main', 'origin')).toBe(false)
  })
})
