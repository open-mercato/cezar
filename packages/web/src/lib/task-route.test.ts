import { afterEach, describe, expect, it } from 'vitest'

import { cardRedirect, forgetTaskViews, runRoute } from './task-route'

/** Where "open this run" goes (spec 2026-11-15-framework-board). */

const card = { id: 'c1', card: { framework: 'generic' } }
const adHoc = { id: 'r1' }

afterEach(forgetTaskViews)

describe('runRoute', () => {
  it('opens a card in its wizard and an ad-hoc run in its task view', () => {
    expect(runRoute(card)).toBe('/cards/c1')
    expect(runRoute(adHoc)).toBe('/tasks/r1')
  })

  it('keeps hashes on the wizard, task-view tabs on the task view', () => {
    expect(runRoute(card, { suffix: '#ask' })).toBe('/cards/c1#ask')
    expect(runRoute(card, { suffix: '/changes' })).toBe('/tasks/c1/changes')
    expect(runRoute(adHoc, { suffix: '#reply' })).toBe('/tasks/r1#reply')
  })

  it('opts out explicitly: "Open task view" carries the query the redirect honours', () => {
    expect(runRoute(card, { taskView: true })).toBe('/tasks/c1?view=task')
    expect(runRoute(adHoc, { taskView: true })).toBe('/tasks/r1')
  })
})

describe('cardRedirect — the bare /tasks/:id of a card', () => {
  it('sends an id-only link for a card to the wizard, keeping the hash', () => {
    expect(cardRedirect(card, '', '#ask')).toBe('/cards/c1#ask')
  })

  it('never redirects an ad-hoc run', () => {
    expect(cardRedirect(adHoc, '')).toBeNull()
  })

  it('stays on the task view once it was asked for, so its own tab links do not bounce', () => {
    expect(cardRedirect(card, '?view=task')).toBeNull()
    expect(cardRedirect(card, '')).toBeNull()
    expect(cardRedirect({ id: 'c2', card: {} }, '')).toBe('/cards/c2')
  })
})
