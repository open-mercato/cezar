import { describe, expect, it } from 'vitest'

import { attachmentCountBucket, telemetryEventInputSchema, telemetryRouteSchema } from '@open-mercato/cezar-api-client'

import {
  apiRouteShape,
  clientSurface,
  errorToastReport,
  isBenignError,
  isCanonicalRoute,
  routeShape,
  scrubToastMessage,
  transportCauseContext,
} from './telemetry'
import { noteFailedRequest, recentFailedRequest, resetFailedRequest } from './failed-request'

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

describe('attachment count buckets (telemetry 7054e5f2)', () => {
  it('buckets every count into the closed label set', () => {
    expect([1, 2, 4, 5, 10, 11, 20, 25].map(attachmentCountBucket)).toEqual(['1', '2-4', '2-4', '5-10', '5-10', '11-20', '11-20', '11-20'])
  })
})

describe('error toast reports', () => {
  it('names the API call that failed, never its ids or names', () => {
    expect(apiRouteShape('/api/v1/p/acme-shop/runs/22f53332-5ba7/messages')).toBe('/api/v1/p/:param/runs/:param/messages')
    // A project slug that happens to be a route word is still a project slug.
    expect(apiRouteShape('/api/v1/p/runs/runs/abc')).toBe('/api/v1/p/:param/runs/:param')
    expect(apiRouteShape('/api/v1/workflows/client-secret-flow')).toBe('/api/v1/workflows/:param')
  })

  it('reports a toast after a failed request as that request', () => {
    const report = errorToastReport({ method: 'POST', path: '/api/v1/p/acme/runs/abc/messages', status: 409, at: 1000 }, 1250)
    expect(report).toEqual({
      type: 'ApiError',
      context: {
        'request.method': 'POST',
        'request.route': '/api/v1/p/:param/runs/:param/messages',
        'request.status': 409,
        'request.age_ms': 250,
      },
    })
  })

  it('names the transport failure behind a request that got no answer (#1437)', () => {
    resetFailedRequest()
    noteFailedRequest('/api/v1/p/acme/runs/abc/continue', 'post', 0, undefined, new TypeError('Load failed'))
    const failure = recentFailedRequest()
    expect(errorToastReport(failure, failure!.at).context).toEqual({
      'request.method': 'POST',
      'request.route': '/api/v1/p/:param/runs/:param/continue',
      'request.status': 0,
      'request.age_ms': 0,
      'request.cause_name': 'TypeError',
      'request.cause_message': 'Load failed',
    })
    resetFailedRequest()
  })

  it('scrubs and bounds the transport cause, and adds nothing without one', () => {
    expect(transportCauseContext(new TypeError('Fetch API cannot load http://127.0.0.1:4000/api/v1/p/acme/runs/x due to access control checks.')))
      .toEqual({
        'request.cause_name': 'TypeError',
        'request.cause_message': 'Fetch API cannot load /api/v1/p/:param/runs/:param due to access control checks.',
      })
    const odd = transportCauseContext({ name: 'not a name!', message: 'x'.repeat(5000) })
    expect(odd['request.cause_name']).toBe('other')
    expect(odd['request.cause_message']).toHaveLength(256)
    expect(transportCauseContext(undefined)).toEqual({})
    expect(errorToastReport({ method: 'GET', path: '/api/v1/health', status: 0, at: 0 }, 0).context).not.toHaveProperty('request.cause_name')
  })

  it('reports a toast with no failed request as a client-side error toast', () => {
    expect(errorToastReport(null)).toEqual({ type: 'ErrorToast', context: {} })
    expect(errorToastReport({ method: 'POST', path: '/api/v1/providers/connect', status: 409, at: 1000, provider: 'claude' }, 1000).context)
      .toMatchObject({ 'request.route': '/api/v1/providers/connect', 'request.provider': 'claude' })
  })
})

describe('scrubToastMessage', () => {
  it('reduces an API URL to its route shape, slug and query included', () => {
    expect(scrubToastMessage('cannot reach the cezar server (/api/v1/p/acme-shop/runs/abc/messages?x=1)', [])).toBe(
      'cannot reach the cezar server (/api/v1/p/:param/runs/:param/messages)',
    )
    expect(scrubToastMessage('http://127.0.0.1:4000/api/v1/workflows/secret-flow failed', [])).toBe(
      '/api/v1/workflows/:param failed',
    )
  })

  it('masks quoted values, branches, repositories and paths', () => {
    expect(scrubToastMessage('No workflow named “client-deploy” — starting a new one.', [])).toBe(
      'No workflow named <value> — starting a new one.',
    )
    expect(scrubToastMessage("branch 'feature/login' already exists", [])).toBe('branch <value> already exists')
    expect(scrubToastMessage('cannot push cez/1a2b3c4d to acme/shop', [])).toBe('cannot push <path> to <path>')
    expect(scrubToastMessage("can't open /Users/me/code/shop/README.md", [])).toBe("can't open <path>")
  })

  it('masks the names and ids of known projects, longest first and whole words only', () => {
    expect(scrubToastMessage('Acme Shop already has the maximum of 8 tags', ['Acme Shop', 'acme-shop'])).toBe(
      '<project> already has the maximum of 8 tags',
    )
    expect(scrubToastMessage('project acme-shop not found', ['acme', 'acme-shop'])).toBe('project <project> not found')
    expect(scrubToastMessage('session closed', ['ses', 'x'])).toBe('session closed')
  })

  it('masks label: value tails, emails, curly single quotes and any-case project names', () => {
    expect(scrubToastMessage('invalid branch name: feature-login', [])).toBe('invalid branch name: <detail>')
    expect(scrubToastMessage('unknown account: work-account', [])).toBe('unknown account: <detail>')
    expect(scrubToastMessage('push rejected for jane@acme.com', [])).toBe('push rejected for <email>')
    expect(scrubToastMessage('plan ‘secret-plan’ is missing', [])).toBe('plan <value> is missing')
    expect(scrubToastMessage('ACME-SHOP is busy', ['acme-shop'])).toBe('<project> is busy')
    expect(scrubToastMessage('cannot reach the cezar server (/api/v1/health)', [])).toBe(
      'cannot reach the cezar server (/api/v1/health)',
    )
  })

  it('leaves a message without user data alone', () => {
    expect(scrubToastMessage('session closed', [])).toBe('session closed')
  })
})
