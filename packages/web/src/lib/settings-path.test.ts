import { describe, expect, it } from 'vitest'

import { isSettingsPathname } from './settings-path'

describe('isSettingsPathname', () => {
  it.each([
    '/settings/global',
    '/settings/global/',
    '/settings/global/appearance',
    '/p/cezar/settings',
    '/p/cezar/settings/agents',
    '/p/default/settings/worktrees',
    // Legacy flat spellings — one frame before their redirect lands on a family above.
    '/settings',
    '/settings/agents',
    '/settings/skills',
  ])('%s is a settings page', (pathname) => {
    expect(isSettingsPathname(pathname)).toBe(true)
  })

  it.each([
    '/',
    '/p/cezar/',
    '/p/cezar/skills',
    '/p/cezar/settingsfoo',
    '/settingsfoo',
    '/p/cezar/tasks/run-1',
    '/new',
  ])('%s is not', (pathname) => {
    expect(isSettingsPathname(pathname)).toBe(false)
  })
})
