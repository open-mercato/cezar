import { describe, expect, it } from 'vitest'

import { parentDir } from './fs-path'

describe('parentDir', () => {
  it('drops the last POSIX segment and stops at /', () => {
    expect(parentDir('/home/user/repos')).toBe('/home/user')
    expect(parentDir('/home/user/repos/')).toBe('/home/user')
    expect(parentDir('/home')).toBe('/')
    expect(parentDir('/')).toBeNull()
  })

  it('steps from a top-level Windows folder to the drive ROOT, never the bare drive', () => {
    expect(parentDir('C:\\Repos')).toBe('C:\\')
    expect(parentDir('C:/Repos')).toBe('C:/')
    expect(parentDir('C:\\Repos\\ProjectName')).toBe('C:\\Repos')
  })

  it('has no parent at a drive root or a UNC share root', () => {
    expect(parentDir('C:\\')).toBeNull()
    expect(parentDir('C:')).toBeNull()
    expect(parentDir('\\\\server\\share')).toBeNull()
    expect(parentDir('\\\\server\\share\\')).toBeNull()
    expect(parentDir('\\\\server\\share\\repo')).toBe('\\\\server\\share')
  })

  it('has no parent for a single relative segment', () => {
    expect(parentDir('repos')).toBeNull()
  })
})

describe('parentDir with extended Windows paths', () => {
  it('preserves the separator at an extended drive root', () => {
    expect(parentDir('\\\\?\\C:\\Repos')).toBe('\\\\?\\C:\\')
    expect(parentDir('\\\\?\\C:\\')).toBeNull()
  })
  it('stops at an extended UNC share root', () => {
    expect(parentDir('\\\\?\\UNC\\server\\share\\repo')).toBe('\\\\?\\UNC\\server\\share')
    expect(parentDir('\\\\?\\UNC\\server\\share')).toBeNull()
    expect(parentDir('\\\\?\\UNC\\server\\share\\')).toBeNull()
  })
})
