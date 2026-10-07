import { describe, expect, it } from 'vitest'

import { telemetryEventInputSchema, telemetryRouteSchema } from '@open-mercato/cezar-api-client'

import { clientSurface, isBenignError, isCanonicalRoute, routeShape } from './telemetry'

describe('routeShape', () => {
  it('keeps the route and drops every user value', () => {
    expect(routeShape('/p/acme-shop/tasks/3f1c9a52-7d0e-4b6a/changes')).toBe('/p/:param/tasks/:param/changes')
    expect(routeShape('/p/acme-shop/github/prs/412')).toBe('/p/:param/github/prs/:param')
    expect(routeShape('/p/acme-shop/workflows/client-secret-flow')).toBe('/p/:param/workflows/:param')
    expect(routeShape('/settings/global/appearance')).toBe('/settings/global/appearance')
    expect(routeShape('/')).toBe('/')
  })
})

describe('isCanonicalRoute', () => {
  it('counts pages, not the redirects in front of them', () => {
    expect(isCanonicalRoute('/p/x')).toBe(true)
    expect(isCanonicalRoute('/p/x/settings/agents')).toBe(true)
    expect(isCanonicalRoute('/tasks')).toBe(true)
    expect(isCanonicalRoute('/dashboard')).toBe(true)
    expect(isCanonicalRoute('/settings/global/appearance')).toBe(true)
    expect(isCanonicalRoute('/')).toBe(false)
    expect(isCanonicalRoute('/settings/agents')).toBe(false)
    expect(isCanonicalRoute('/inbox')).toBe(false)
  })
})

describe('routeShape vs the server contract', () => {
  it('always produces a label the server accepts', () => {
    for (const path of ['/p/acme/tasks/3f1c/changes', '/p/a/settings/prompt-templates', '/dashboard', '/p/x', '/p/x/github/prs/12']) {
      expect(telemetryRouteSchema.safeParse(routeShape(path)).success).toBe(true)
    }
    // A raw path never passes: a project slug is not in the vocabulary.
    expect(telemetryRouteSchema.safeParse('/p/acme-shop/tasks').success).toBe(false)
    expect(telemetryRouteSchema.safeParse('/p/3f1c9a52/tasks').success).toBe(false)
    expect(telemetryRouteSchema.safeParse('/').success).toBe(true)
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

describe('telemetry event relay contract', () => {
  it('accepts only known surfaces, never free text, and leaves cli to the server', () => {
    expect(telemetryEventInputSchema.safeParse({ event: 'message_sent', label: 'github' }).success).toBe(true)
    expect(telemetryEventInputSchema.safeParse({ event: 'message_sent', label: 'cli' }).success).toBe(false)
    expect(telemetryEventInputSchema.safeParse({ event: 'message_sent', label: 'fix the login bug' }).success).toBe(false)
    expect(telemetryEventInputSchema.safeParse({ event: 'anything_else', label: 'new_task' }).success).toBe(false)
    expect(telemetryEventInputSchema.safeParse({ event: 'diff_comment_added', label: 'multi_line' }).success).toBe(true)
    expect(telemetryEventInputSchema.safeParse({ event: 'diff_comment_added', label: 'new_task' }).success).toBe(false)
  })
})
