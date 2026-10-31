import { describe, expect, it } from 'vitest'

import { resolveRepoAccounts } from './agent-accounts'

describe('resolveRepoAccounts', () => {
  it('falls back to the machine-wide default when the repo has no selection of its own', () => {
    // The pill must show the account the server will really run an untouched pick under.
    expect(resolveRepoAccounts(undefined, { claude: 'second-account' })).toEqual({ claude: 'second-account' })
  })

  it('lets the repo selection win over the machine-wide default, per runner', () => {
    expect(
      resolveRepoAccounts({ claude: 'work' }, { claude: 'second-account', codex: 'team' }),
    ).toEqual({ claude: 'work', codex: 'team' })
  })

  it('is undefined when nothing is chosen anywhere', () => {
    expect(resolveRepoAccounts(undefined, undefined)).toBeUndefined()
    expect(resolveRepoAccounts({}, {})).toBeUndefined()
  })
})
