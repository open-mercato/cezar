import { afterEach, describe, expect, it } from 'vitest'

import {
  actionTitle,
  clearManagerOrigins,
  cronLabel,
  isManagerPathname,
  managerRowPreview,
  managerTimeLabel,
  parseManagerCommand,
  parseManagerText,
  parseReferenceLink,
  PR_LINK_PREFIX,
  projectsLabel,
  resolveManagerOrigin,
} from './managers'
import { managerFixture } from '@/routes/manager/manager-fixtures'

afterEach(clearManagerOrigins)

describe('isManagerPathname', () => {
  it.each([
    ['/manager', true],
    ['/manager/new', true],
    ['/manager/global', true],
    ['/managers', false],
    ['/p/manager', false],
    ['/', false],
  ])('%s → %s', (path, expected) => expect(isManagerPathname(path)).toBe(expected))
})

describe('parseManagerText', () => {
  it('makes a task alone on its line a card, and keeps the text around it', () => {
    expect(parseManagerText('Before\n\n[[task:alpha/run-1]]\n\nAfter')).toEqual([
      { kind: 'markdown', text: 'Before' },
      { kind: 'task', projectId: 'alpha', runId: 'run-1' },
      { kind: 'markdown', text: 'After' },
    ])
  })

  it('takes a bulleted task line as a card and several tokens as several cards', () => {
    expect(parseManagerText('- [[task:a/1]] [[task:b/2]]')).toEqual([
      { kind: 'task', projectId: 'a', runId: '1' },
      { kind: 'task', projectId: 'b', runId: '2' },
    ])
  })

  it('keeps inline references inside their sentence as links', () => {
    const [segment] = parseManagerText('Merged [[pr:alpha/12]] and [[task:beta/r2]] today')
    expect(segment).toEqual({
      kind: 'markdown',
      text: 'Merged [#12](#cez-pr/alpha/12) and [task](#cez-task/beta/r2) today',
    })
  })

  it('leaves fenced code literal', () => {
    const text = '```\n[[task:a/1]]\n```'
    expect(parseManagerText(text)).toEqual([{ kind: 'markdown', text }])
  })

  it('hides a half-streamed token rather than flashing brackets', () => {
    expect(parseManagerText('Working on [[task:alp')).toEqual([{ kind: 'markdown', text: 'Working on' }])
    expect(parseManagerText('Hello [[')).toEqual([{ kind: 'markdown', text: 'Hello' }])
  })

  it('leaves ordinary double brackets alone mid-text', () => {
    expect(parseManagerText('see [[wiki]] page')).toEqual([{ kind: 'markdown', text: 'see [[wiki]] page' }])
  })

  it('round-trips an encoded project id', () => {
    const [segment] = parseManagerText('x [[pr:my%20proj/3]] y')
    const href = /\((#[^)]+)\)/.exec((segment as { text: string }).text)?.[1]
    expect(parseReferenceLink(href, PR_LINK_PREFIX)).toEqual({ projectId: 'my%20proj', id: '3' })
  })
})

describe('parseManagerCommand', () => {
  it('recognizes only a whole-message command', () => {
    expect(parseManagerCommand('/status')?.prompt).toContain('status')
    expect(parseManagerCommand(' /stop ')?.name).toBe('stop')
    expect(parseManagerCommand('/status please')).toBeNull()
    expect(parseManagerCommand('/unknown')).toBeNull()
    expect(parseManagerCommand('status')).toBeNull()
  })

  it('leaves /check and /stop to their routes', () => {
    expect(parseManagerCommand('/check')?.prompt).toBeUndefined()
    expect(parseManagerCommand('/stop')?.prompt).toBeUndefined()
  })
})

describe('labels', () => {
  it('names the cadence', () => {
    expect([0, 15, 60, 240, 1440].map(cronLabel)).toEqual(['Off', '15 min', '1 hour', '4 hours', '1 day'])
  })

  it('names the projects', () => {
    const names = (id: string) => (id === 'a' ? 'Alpha' : undefined)
    expect(projectsLabel('all', names)).toBe('All projects access')
    expect(projectsLabel(['a'], names)).toBe('Alpha')
    expect(projectsLabel(['gone'], names)).toBe('gone')
    expect(projectsLabel(['a', 'b'], names)).toBe('2 projects')
  })

  it('walks clock, yesterday, weekday, date', () => {
    const now = new Date(2026, 9, 31, 12, 0)
    expect(managerTimeLabel(new Date(2026, 9, 31, 7, 34).toISOString(), now)).toMatch(/7:34/)
    expect(managerTimeLabel(new Date(2026, 9, 30, 23, 0).toISOString(), now)).toBe('Yesterday')
    expect(managerTimeLabel(new Date(2026, 9, 27, 9, 0).toISOString(), now)).toBe(
      new Date(2026, 9, 27).toLocaleDateString([], { weekday: 'long' }),
    )
    expect(managerTimeLabel(new Date(2026, 8, 1).toISOString(), now)).not.toBe('')
    expect(managerTimeLabel(undefined, now)).toBe('')
    expect(managerTimeLabel('nope', now)).toBe('')
  })

  it('titles an action', () => {
    expect(actionTitle({ type: 'merge-pr', projectId: 'a', number: 3 })).toBe('Merge #3')
    expect(actionTitle({ type: 'enable-automation', projectId: 'a', automationId: 'x', name: 'Nightly' })).toBe(
      'Enable automation Nightly',
    )
  })

  it('leads a row with what waits on the user', () => {
    expect(managerRowPreview(managerFixture({ pendingActions: 2, preview: 'hi' }))).toBe('2 approvals waiting')
    expect(managerRowPreview(managerFixture({ preview: 'hi' }))).toBe('hi')
    expect(managerRowPreview(managerFixture({ status: 'working' }))).toBe('Working…')
    expect(managerRowPreview(managerFixture())).toBe('No messages yet')
  })
})

describe('resolveManagerOrigin', () => {
  it('survives the task tabs, whose URLs carry no router state', () => {
    expect(resolveManagerOrigin('r1', null)).toBeUndefined()
    expect(resolveManagerOrigin('r1', { manager: { id: 'g', name: 'Global' } })).toEqual({ id: 'g', name: 'Global' })
    expect(resolveManagerOrigin('r1', null)).toEqual({ id: 'g', name: 'Global' })
    expect(resolveManagerOrigin('r2', null)).toBeUndefined()
  })

  it('ignores malformed state', () => {
    expect(resolveManagerOrigin('r3', { manager: { id: 1 } })).toBeUndefined()
  })
})
