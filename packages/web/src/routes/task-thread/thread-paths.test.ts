import { describe, expect, it } from 'vitest'

import { shortenWorktreePaths } from './thread-paths'

const root = '/Users/me/projects/repo/.ai/cezar/worktrees/571c15ae-1111-4222-8333-444455556666'

describe('shortenWorktreePaths', () => {
  it.each([
    [`cd ${root} && npm test`, 'npm test'],
    [`cd ${root}/ && npm test`, 'npm test'],
    [`cd ${root}; grep -rn foo src`, 'grep -rn foo src'],
    [`cd "${root}" && ls`, 'ls'],
    [`cd ${root}/packages/web && npm test`, 'cd packages/web && npm test'],
    [`grep -rn foo ${root}/packages/web/src`, 'grep -rn foo packages/web/src'],
    [`${root}/packages/web/src/app.tsx`, 'packages/web/src/app.tsx'],
    [`git -C ${root} status`, 'git -C . status'],
    [`rg x --path=${root}/src`, 'rg x --path=src'],
    [`cat '${root}/a b.ts'`, "cat 'a b.ts'"],
  ])('%s → %s', (input, output) => {
    expect(shortenWorktreePaths(input)).toBe(output)
  })

  it.each([
    ['npm test'],
    ['/Users/me/projects/repo/src/app.ts'],
    ['cd /tmp && ls'],
  ])('leaves %s alone', (input) => {
    expect(shortenWorktreePaths(input)).toBe(input)
  })
})
