import { afterEach, describe, expect, it } from 'vitest'

import {
  actionConfirms,
  actionTitle,
  clearManagerOrigins,
  cronLabel,
  isManagerPathname,
  managerRowPreview,
  managerTimeLabel,
  parseManagerCommand,
  parseManagerText,
  managerReferences,
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

  it('follows the block that names a task with its card, once per task', () => {
    const text = 'Started [[task:a/1]] for you.\nStill going.\n\nThat [[task:a/1]] again.\n\n[[task:a/1]]\n\nDone.'
    const kinds = parseManagerText(text).map((segment) => segment.kind)
    expect(kinds).toEqual(['markdown', 'task', 'markdown', 'markdown'])
  })

  it('keeps a list whole and puts its cards after it', () => {
    expect(parseManagerText('- one [[task:a/1]]\n- two [[task:a/2]]\n\nEnd')).toEqual([
      { kind: 'markdown', text: '- one [task](#cez-task/a/1)\n- two [task](#cez-task/a/2)' },
      { kind: 'task', projectId: 'a', runId: '1' },
      { kind: 'task', projectId: 'a', runId: '2' },
      { kind: 'markdown', text: 'End' },
    ])
  })

  it('cards a task the agent started without naming it', () => {
    const started = { summary: 'cez-manager task create --project a "x"', output: '[[task:a/9]]' }
    expect(parseManagerText('On it.', [started]).at(-1)).toEqual({ kind: 'task', projectId: 'a', runId: '9' })
    expect(parseManagerText('On it [[task:a/9]].', [started]).filter((segment) => segment.kind === 'task')).toHaveLength(1)
  })

  it('never cards what other commands printed, or a failed start', () => {
    const pasted = { summary: 'gh pr view 3', output: '[[task:a/9]]' }
    const failed = { summary: 'cez-manager task create "x"', output: '[[task:a/9]]', isError: true }
    expect(parseManagerText('Hi', [pasted, failed]).map((segment) => segment.kind)).toEqual(['markdown'])
  })

  describe('bare references', () => {
    const one = [{ id: 'alpha', repoUrl: 'https://github.com/o/alpha' }]
    const text = (line: string, projects = one) => (parseManagerText(line, [], projects)[0] as { text: string }).text

    it('bubbles #123 against the only connected project, as a PR when the sentence says so', () => {
      expect(text('Q11, #1821: long')).toBe('Q11, [#1821](#cez-issue/alpha/1821): long')
      expect(text('see PR #7')).toBe('see PR [#7](#cez-pr/alpha/7)')
    })

    it('takes the project a token named over guessing', () => {
      expect(text('[[pr:beta/1]] and #2', [])).toBe('[#1](#cez-pr/beta/1) and [#2](#cez-issue/beta/2)')
    })

    it('still bubbles when it cannot tell the repository', () => {
      expect(text('fixes #5', [])).toBe('fixes [#5](#cez-issue/_/5)')
    })

    it('turns a connected repository URL into the bubble and leaves a foreign one', () => {
      expect(text('https://github.com/o/alpha/pull/9')).toBe('[#9](#cez-pr/alpha/9)')
      expect(text('https://github.com/x/y/pull/9')).toBe('https://github.com/x/y/pull/9')
    })

    it('leaves code, links, headings and fragments alone', () => {
      expect(text('run `#12` now')).toBe('run `#12` now')
      expect(text('[#12](https://a.b/c)')).toBe('[#12](https://a.b/c)')
      expect(text('https://a.b/c#12')).toBe('https://a.b/c#12')
      expect(text('&#39; x')).toBe('&#39; x')
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

  it('a malformed reference in agent text is a plain link, not a crash', () => {
    expect(parseReferenceLink(`${PR_LINK_PREFIX}%zz/3`, PR_LINK_PREFIX)).toBeNull()
    expect(managerReferences([{ kind: 'markdown', text: '[x](#cez-pr/%zz/3)' }])).toEqual([])
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

describe('actionConfirms', () => {
  it('fails safe: a missing setting, a missing key and any non-false value confirm', () => {
    expect(actionConfirms(undefined, 'merge-pr')).toBe(true)
    expect(actionConfirms({}, 'merge-pr')).toBe(true)
    expect(actionConfirms({ 'merge-pr': true }, 'merge-pr')).toBe(true)
    expect(actionConfirms({ 'merge-pr': 'false' as never }, 'merge-pr')).toBe(true)
  })

  it('confirms an unknown type even when it is stored as off', () => {
    expect(actionConfirms({ 'delete-branch': false }, 'delete-branch')).toBe(true)
  })

  it('skips the step only for the type switched off', () => {
    const setting = { 'add-job': false }
    expect(actionConfirms(setting, 'add-job')).toBe(false)
    expect(actionConfirms(setting, 'merge-pr')).toBe(true)
    expect(actionConfirms(setting, 'enable-automation')).toBe(true)
  })
})
