import { describe, expect, it } from 'vitest'

import { clientSurface, isBenignError, routeShape, telemetryPageFor } from './telemetry'

describe('routeShape', () => {
  it('keeps the route and drops every user value', () => {
    expect(routeShape('/p/acme-shop/tasks/3f1c9a52-7d0e-4b6a/changes')).toBe('/p/:param/tasks/:param/changes')
    expect(routeShape('/p/acme-shop/github/prs/412')).toBe('/p/:param/github/prs/:param')
    expect(routeShape('/p/acme-shop/workflows/client-secret-flow')).toBe('/p/:param/workflows/:param')
    expect(routeShape('/settings/global/appearance')).toBe('/settings/global/appearance')
    expect(routeShape('/')).toBe('/')
  })
})

describe('telemetryPageFor', () => {
  it('maps the tracked pages and nothing else', () => {
    expect(telemetryPageFor('/dashboard')).toBe('dashboard')
    expect(telemetryPageFor('/tasks')).toBe('tasks')
    expect(telemetryPageFor('/settings/global')).toBe('settings')
    expect(telemetryPageFor('/p/x/settings/agents')).toBe('settings')
    expect(telemetryPageFor('/p/x')).toBeUndefined()
    expect(telemetryPageFor('/p/x/tasks/abc')).toBeUndefined()
    expect(telemetryPageFor('/settings/agents')).toBeUndefined()
  })
})

describe('isBenignError', () => {
  it('drops the ResizeObserver loop notices and nothing real', () => {
    expect(isBenignError('ResizeObserver loop completed with undelivered notifications.')).toBe(true)
    expect(isBenignError('ResizeObserver loop limit exceeded')).toBe(true)
    expect(isBenignError('Importing a module script failed.')).toBe(false)
    expect(isBenignError("TypeError: undefined is not an object (evaluating 'a.b')")).toBe(false)
  })
})

describe('clientSurface', () => {
  it('reads the desktop shell stamp', () => {
    expect(clientSurface()).toBe('browser')
    document.documentElement.dataset.cezDesktop = 'macos'
    expect(clientSurface()).toBe('desktop')
    delete document.documentElement.dataset.cezDesktop
  })
})
