import { describe, expect, it } from 'vitest'

import { cliFlagsOf, cliJsonOf, cliOf, everyFlag, flagExpressible } from './automation-cli'

describe('automation-cli', () => {
  it('prints a schedule as the flag form with the derived cron', () => {
    expect(cliOf({
      name: 'Nightly dependency bump', kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 },
      task: { prompt: 'Bump deps', workflow: 'fix-and-verify', runner: 'claude', model: 'sonnet', autonomous: true, dispatch: { maxSubtasks: 4, reviewChild: true } },
    })).toBe('cez automation add --name "Nightly dependency bump" --cron "0 4 * * *" --workflow "fix-and-verify" --runner "claude" --model "sonnet" --autonomous --dispatch --max-subtasks 4 --review-child --prompt "Bump deps"')
  })

  it('quotes --workflow/--runner/--model so a shell metacharacter in either cannot escape the flag (a cross-project template or an "automation from a prompt" run can name either)', () => {
    expect(cliFlagsOf({
      name: 'x', kind: 'schedule', schedule: { type: 'hours', every: 1 },
      task: { prompt: 'p', workflow: '`touch pwned`', runner: 'a; rm -rf /', model: '$(whoami)' },
    })).toBe('cez automation add --name "x" --cron "0 */1 * * *" --workflow "\\`touch pwned\\`" --runner "a; rm -rf /" --model "\\$(whoami)" --prompt "p"')
  })

  it('emits --no-autonomous when a saved automation was explicitly set non-autonomous, so Copy as CLI round-trips it instead of defaulting back to autonomous', () => {
    expect(cliFlagsOf({ name: 'x', kind: 'schedule', schedule: { type: 'daily' }, task: { prompt: 'p', autonomous: false } }))
      .toBe('cez automation add --name "x" --cron "0 4 * * *" --no-autonomous --prompt "p"')
    // autonomous: true and autonomous: undefined keep their prior behavior.
    expect(cliFlagsOf({ name: 'x', kind: 'schedule', schedule: { type: 'daily' }, task: { prompt: 'p', autonomous: true } }))
      .toContain('--autonomous')
    expect(cliFlagsOf({ name: 'x', kind: 'schedule', schedule: { type: 'daily' }, task: { prompt: 'p' } }))
      .not.toContain('autonomous')
  })

  it('prints a simple poll as flags and an untitled one as "untitled"', () => {
    expect(cliOf({ name: '', kind: 'github', events: ['issue.opened'], intervalSeconds: 300, task: { prompt: '' } }))
      .toBe('cez automation add --name "untitled" --on issue.opened --every 5m --prompt "…"')
    expect(cliFlagsOf({ name: 'x', kind: 'github', events: ['pull_request.opened', 'issue.opened'], intervalSeconds: 3600, filters: { anyLabels: ['bug'], authors: ['alice'] }, task: { prompt: 'p' }, enable: true }))
      .toBe('cez automation add --name "x" --on pull_request.opened,issue.opened --every 1h --label "bug" --author "alice" --enable --prompt "p"')
  })

  it('escapes shell metacharacters in quoted values', () => {
    expect(cliFlagsOf({ name: 'say "hi" $HOME', kind: 'schedule', schedule: { type: 'hours', every: 6 }, task: { prompt: 'a `b`' } }))
      .toBe('cez automation add --name "say \\"hi\\" \\$HOME" --cron "0 */6 * * *" --prompt "a \\`b\\`"')
  })

  it('falls back to the JSON form for filters flags cannot carry', () => {
    const definition = { name: 'Assigned', kind: 'github' as const, events: ['issue.opened' as const], intervalSeconds: 300, filters: { assignees: ['bob'] }, task: { prompt: "it's {{github.url}}" } }
    expect(flagExpressible(definition)).toBe(false)
    const json = cliOf(definition)
    expect(json.startsWith("cez automation create --json '")).toBe(true)
    expect(json).toContain('"assignees":["bob"]')
    expect(json).toContain('"lookbackDays":7')
    // A single quote inside the body is closed, escaped and reopened for a POSIX shell.
    expect(json).toContain(`it'\\''s`)
    expect(cliJsonOf({ name: 'S', kind: 'schedule', schedule: { type: 'daily' }, task: { prompt: 'x' }, enable: true })).toContain('"enable":true')
  })

  it('spells intervals', () => {
    expect(everyFlag(120)).toBe('2m')
    expect(everyFlag(7200)).toBe('2h')
    expect(everyFlag(90)).toBe('90s')
  })
})


it('preserves required tracker labels in Copy as CLI JSON', () => {
  const trackerTrigger = { association: { kind: 'jira' as const, source: { id: 'cloud', webUrl: 'https://fixture.atlassian.net' }, externalId: '1', externalName: 'Project' }, events: ['issue.opened' as const], requiredLabels: ['bug', 'urgent'] }
  const command = cliOf({ name: 'bugs', kind: 'tracker', trackerTrigger, task: { prompt: 'Fix' } })
  expect(command).toContain('"requiredLabels":["bug","urgent"]')
})
