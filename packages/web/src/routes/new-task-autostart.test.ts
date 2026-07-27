import { describe, expect, it } from 'vitest'

import type { CreateRunInput } from '@open-mercato/cezar-api-client'

import { bookmarkletRunBody, deepLinkToast, unknownSkillPrefillText } from './new-task-autostart'
import type { NewTaskParams } from './new-task-params'

const params = (over: Partial<NewTaskParams>): NewTaskParams => ({
  skill: '',
  ref: '',
  auto: true,
  key: 'k',
  todo: '', // saved bookmarklets never carry one (#374) — the default here says so
  ...over,
})

/** The unattended-start wire shape — pinned against `handleDeepLink()` in web/app.js. The only
 *  deliberate difference from legacy is `prompt: '{{task}}'` instead of the literal ref (Step
 *  1.1's shape), identical after template substitution server-side. */
describe('bookmarkletRunBody', () => {
  const cases: Array<[name: string, input: NewTaskParams, body: CreateRunInput]> = [
    [
      'skill + ref → the one-step inline chain',
      params({ skill: 'om-fix', ref: 'https://github.com/o/r/pull/1' }),
      {
        task: 'https://github.com/o/r/pull/1',
        steps: [{ id: 'task', name: 'om-fix', skill: 'om-fix', prompt: '{{task}}' }],
        model: undefined,
        runner: undefined,
        variants: undefined,
        images: undefined,
      },
    ],
    [
      'no skill → quick-task (legacy verbatim)',
      params({ ref: 'do the thing' }),
      {
        task: 'do the thing',
        workflow: 'quick-task',
        model: undefined,
        runner: undefined,
        variants: undefined,
        images: undefined,
      },
    ],
  ]
  for (const [name, input, body] of cases) {
    it(name, () => {
      expect(bookmarkletRunBody(input, 'claude', 'claude')).toEqual(body)
    })
  }

  it('keeps the protected body byte-identical when the connected runner is the server default', () => {
    const sent = JSON.parse(
      JSON.stringify(bookmarkletRunBody(params({ ref: 'x' }), 'claude', 'claude')),
    ) as object
    expect(Object.keys(sent).sort()).toEqual(['task', 'workflow'])
  })

  it('sends an explicit connected fallback when the server default is disconnected', () => {
    const sent = JSON.parse(
      JSON.stringify(bookmarkletRunBody(params({ ref: 'x' }), 'codex', 'claude')),
    ) as CreateRunInput
    expect(sent).toEqual({ task: 'x', workflow: 'quick-task', runner: 'codex' })
  })
})

describe('deepLinkToast', () => {
  it('failed carries the server reason, as danger', () => {
    expect(deepLinkToast({ kind: 'failed', message: 'boom' }, '')).toEqual({
      message: 'Auto-start failed: boom — review and press Start',
      tone: 'danger',
    })
  })
  it('blocked names the bad key, as danger — and wins over an unknown skill', () => {
    expect(deepLinkToast({ kind: 'blocked' }, 'ghost')).toEqual({
      message: 'Auto-start blocked (bad key) — review and press Start',
      tone: 'danger',
    })
  })
  it('an unknown skill on a plain prefill is called out honestly', () => {
    expect(deepLinkToast({ kind: 'prefill' }, 'ghost')).toEqual({
      message: 'Unknown skill "ghost" — prefilled for quick-task; review and press Start',
      tone: 'danger',
    })
  })
  it('a plain prefill is a quiet nudge', () => {
    expect(deepLinkToast({ kind: 'prefill' }, '')).toEqual({
      message: 'Prefilled from link — review and press Start',
      tone: 'default',
    })
  })
})

it('unknownSkillPrefillText is byte-for-byte the legacy embedding', () => {
  expect(unknownSkillPrefillText('om-fix', 'https://x')).toBe('Use the "om-fix" skill on: https://x')
})
