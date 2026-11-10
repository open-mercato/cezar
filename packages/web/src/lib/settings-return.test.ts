import { beforeEach, describe, expect, it } from 'vitest'

import { recordSettingsReturn, resetSettingsReturn, settingsReturnLocation } from './settings-return'

const at = (pathname: string, search = '', hash = '') => ({ pathname, search, hash })

beforeEach(resetSettingsReturn)

describe('the settings return store', () => {
  it('starts empty — a cold load into settings has nothing to come back to', () => {
    expect(settingsReturnLocation()).toBeNull()
  })

  it('remembers the last NON-settings location, query and hash included', () => {
    recordSettingsReturn(at('/p/cezar/tasks/run-1', '?tab=changes', '#file-3'))
    expect(settingsReturnLocation()).toEqual(at('/p/cezar/tasks/run-1', '?tab=changes', '#file-3'))
  })

  it('ignores settings pages, so hopping between sections never moves the way back', () => {
    recordSettingsReturn(at('/p/cezar/git'))
    recordSettingsReturn(at('/p/cezar/settings/agents'))
    recordSettingsReturn(at('/settings/global/appearance'))
    recordSettingsReturn(at('/p/other/settings'))
    expect(settingsReturnLocation()).toEqual(at('/p/cezar/git'))
  })

  it('the latest non-settings page wins', () => {
    recordSettingsReturn(at('/p/cezar/git'))
    recordSettingsReturn(at('/p/other/skills'))
    expect(settingsReturnLocation()).toEqual(at('/p/other/skills'))
  })
})
