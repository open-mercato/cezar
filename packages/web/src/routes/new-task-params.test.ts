import { describe, expect, it } from 'vitest'

import { newTaskPrefillHref, parseNewTaskParams, type NewTaskParams } from './new-task-params'

const empty: NewTaskParams = { skill: '', ref: '', auto: false, key: '', todo: '' }

/** The saved-bookmarklet contract (spec 011) — protected by BACKWARD_COMPATIBILITY.md,
 *  and these links live in users' browsers, not in this repo. The cases below mirror
 *  `initFromQuery()` in web/app.js so the React `/new` accepts exactly what the legacy
 *  page did. */
describe('parseNewTaskParams', () => {
  const cases: Array<[name: string, search: string, expected: NewTaskParams]> = [
    ['no query at all', '', empty],
    [
      'the full bookmarklet link',
      '?skill=om-code-review&ref=https%3A%2F%2Fgithub.com%2Fo%2Fr%2Fpull%2F1&auto=1&key=s3cret',
      { skill: 'om-code-review', ref: 'https://github.com/o/r/pull/1', auto: true, key: 's3cret', todo: '' },
    ],
    ['skill only (the "open the composer with this skill" bookmarklet)', '?skill=om-fix', { ...empty, skill: 'om-fix' }],
    // `task` is the older spelling of `ref`; app.js still accepts it, so must we.
    ['legacy `task` alias for `ref`', '?task=issue-12', { ...empty, ref: 'issue-12' }],
    ['`ref` wins over `task` when both are present', '?ref=a&task=b', { ...empty, ref: 'a' }],
    // Only the exact string `1` arms auto-start — anything else is a plain visit.
    ['auto=0 is not auto-start', '?auto=0', empty],
    ['auto=true is not auto-start', '?auto=true', empty],
    ['auto present but empty is not auto-start', '?auto=', empty],
    ['whitespace around skill/ref is trimmed', '?skill=%20om-fix%20&ref=%20x%20', { ...empty, skill: 'om-fix', ref: 'x' }],
    ['unknown params are ignored', '?skill=om-fix&nope=1', { ...empty, skill: 'om-fix' }],
    // #374: the Inbox's Run adds `todo` so the composer can report the launch back.
    ['the inbox prefill link', '?skill=om-fix&ref=fix+it&todo=t1', { ...empty, skill: 'om-fix', ref: 'fix it', todo: 't1' }],
    ['whitespace around todo is trimmed', '?todo=%20t1%20', { ...empty, todo: 't1' }],
    // A saved bookmarklet has no `todo` — that must stay an absence, not an empty-string id.
    ['no todo is the empty string, not undefined', '?skill=om-fix&auto=1&key=k', { ...empty, skill: 'om-fix', auto: true, key: 'k' }],
  ]

  for (const [name, search, expected] of cases) {
    it(name, () => {
      expect(parseNewTaskParams(search)).toEqual(expected)
    })
  }

  it('takes a URLSearchParams too (what useSearchParams hands the route)', () => {
    expect(parseNewTaskParams(new URLSearchParams('skill=om-fix&auto=1'))).toEqual({
      ...empty,
      skill: 'om-fix',
      auto: true,
    })
  })
})

/** The in-app half of the contract (#374). The rule that matters: a prefill link is inert —
 *  it can never arm the unattended start, whatever it carries. */
describe('newTaskPrefillHref', () => {
  it('emits only the params it was given', () => {
    expect(newTaskPrefillHref({ skill: 'om-fix', ref: 'fix it', todo: 't1' })).toBe(
      '/new?skill=om-fix&ref=fix+it&todo=t1',
    )
    expect(newTaskPrefillHref({ ref: 'fix it' })).toBe('/new?ref=fix+it')
    expect(newTaskPrefillHref({})).toBe('/new')
  })

  it('NEVER emits auto/key — not even alongside a todo id (#355: no blind launch)', () => {
    const params = new URLSearchParams(
      newTaskPrefillHref({ skill: 'om-fix', ref: 'fix it', todo: 't1' }).split('?')[1],
    )
    expect(params.has('auto')).toBe(false)
    expect(params.has('key')).toBe(false)
  })

  it('round-trips through the parser (the link the Inbox builds is the one /new reads)', () => {
    const href = newTaskPrefillHref({ skill: 'om-fix', ref: 'fix it\nnow', todo: 't1' })
    expect(parseNewTaskParams(href.split('?')[1] ?? '')).toEqual({
      ...empty,
      skill: 'om-fix',
      ref: 'fix it\nnow',
      todo: 't1',
    })
  })
})
