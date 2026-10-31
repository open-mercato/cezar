import type { ProjectsResponse } from '@open-mercato/cezar-api-client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { isCezarShell, isPhone, lastProjectIndex, showsBottomBar } from './phone-app'

const REGISTRY = {
  projects: [
    { id: 'boot', status: 'ok' },
    { id: 'other', status: 'ok' },
    { id: 'gone', status: 'missing' },
  ],
  bootProject: 'boot',
  projectsDir: '',
} as unknown as ProjectsResponse

function device({ coarse = true, standalone = false, width = 390, height = 844, userAgent = 'Mozilla/5.0' } = {}) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: (query === '(pointer: coarse)' && coarse) || (query === '(display-mode: standalone)' && standalone),
  }))
  vi.stubGlobal('screen', { width, height })
  vi.stubGlobal('navigator', { userAgent })
}

afterEach(() => vi.unstubAllGlobals())

describe('isPhone', () => {
  it.each([
    ['a phone', {}, true],
    ['a landscape phone', { width: 932, height: 430 }, true],
    ['a narrow desktop window on a small screen', { coarse: false, width: 500, height: 800 }, false],
    ['an iPad mini', { width: 744, height: 1133 }, false],
  ])('%s', (_case, screenOf, expected) => {
    device(screenOf)
    expect(isPhone()).toBe(expected)
  })

  it('no matchMedia is not a phone', () => {
    vi.stubGlobal('matchMedia', undefined)
    vi.stubGlobal('screen', { width: 390, height: 844 })
    expect(isPhone()).toBe(false)
  })
})

describe('showsBottomBar', () => {
  it.each([
    ['a phone browser tab', {}, false],
    ['a phone PWA', { standalone: true }, true],
    ['the shell, whose webview is not display-mode standalone', { userAgent: 'x CezarMobile/0.1 (ios)' }, true],
    ['a desktop PWA', { coarse: false, width: 1440, height: 900, standalone: true }, false],
    ['a tablet PWA', { width: 744, height: 1133, standalone: true }, false],
  ])('%s', (_case, input, expected) => {
    device(input)
    expect(showsBottomBar()).toBe(expected)
  })

  it('reads iOS home-screen apps from navigator.standalone', () => {
    device()
    vi.stubGlobal('navigator', { userAgent: 'Safari', standalone: true })
    expect(showsBottomBar()).toBe(true)
  })
})

describe('isCezarShell', () => {
  it('needs the token with its slash', () => {
    device({ userAgent: 'Mozilla/5.0 CezarMobile/0.1 (android)' })
    expect(isCezarShell()).toBe(true)
    device({ userAgent: 'Mozilla/5.0 CezarMobileish' })
    expect(isCezarShell()).toBe(false)
  })
})

describe('lastProjectIndex', () => {
  const remembered = { projectId: 'other', pathname: '/p/other/git/commits' }

  it('is the remembered project, not the page inside it', () => {
    expect(lastProjectIndex(remembered, REGISTRY, 'boot')).toBe('/p/other/')
  })

  it('reads the project off the path alone, whatever query the page had', () => {
    const queried = { projectId: 'other', pathname: '/p/other', search: '?a=100%' }
    expect(lastProjectIndex(queried, REGISTRY, 'boot')).toBe('/p/other/')
  })

  it('falls back to the bare-root landing for nothing remembered or a project that left', () => {
    expect(lastProjectIndex(null, REGISTRY, 'boot')).toBe('/p/boot/')
    expect(lastProjectIndex({ projectId: 'gone', pathname: '/p/gone/' }, REGISTRY, 'boot')).toBe('/p/boot/')
  })

  it('is the bare root before anything is known', () => {
    expect(lastProjectIndex(remembered, undefined, undefined)).toBe('/')
  })
})
