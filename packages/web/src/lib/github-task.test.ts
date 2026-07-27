import { describe, expect, it } from 'vitest'

import type { GithubItem } from '@open-mercato/cezar-api-client'

import { extractTaskRefs } from '../../../cezar/src/runs/task-refs'

import {
  MAX_CHAIN_STEPS,
  applyItemTokens,
  composeGithubTask,
  githubRunBody,
  githubTaskPrompt,
  githubTaskRef,
  mentionsItem,
  skillChainSteps,
} from './github-task'

function item(overrides: Partial<GithubItem> = {}): GithubItem {
  return {
    kind: 'issue',
    number: 142,
    title: 'Login form drops session on refresh',
    author: 'ada',
    createdAt: '2026-07-09T08:00:00.000Z',
    labels: ['bug'],
    body: 'Repro: log in, hit reload.',
    url: 'https://github.com/acme/demo/issues/142',
    comments: 3,
    ...overrides,
  }
}

describe('githubTaskPrompt', () => {
  it('an issue reads "Fix GitHub issue", carries the URL, and quotes the body below a rule', () => {
    expect(githubTaskPrompt(item())).toBe(
      'Fix GitHub issue #142: Login form drops session on refresh\n\n' +
        'https://github.com/acme/demo/issues/142\n\n---\n\nRepro: log in, hit reload.',
    )
  })

  it('a PR reads "Address GitHub pull request"', () => {
    expect(githubTaskPrompt(item({ kind: 'pr', number: 7 }))).toContain(
      'Address GitHub pull request #7:',
    )
  })

  it('a blank body adds no rule section', () => {
    expect(githubTaskPrompt(item({ body: '  ' }))).not.toContain('---')
  })

  it('skill names append as a hint sentence', () => {
    expect(githubTaskPrompt(item(), ['om-fix', 'om-review'])).toContain(
      'Use these skills where relevant: om-fix, om-review.',
    )
  })
})

describe('skillChainSteps', () => {
  it('one {{task}} step per skill, in selection order', () => {
    expect(skillChainSteps(['om-fix', 'om-review'])).toEqual([
      { id: 'om-fix', name: 'om-fix', skill: 'om-fix', prompt: '{{task}}' },
      { id: 'om-review', name: 'om-review', skill: 'om-review', prompt: '{{task}}' },
    ])
  })

  it('dedupes repeated ids the legacy way: om-fix, om-fix-2, om-fix-3', () => {
    expect(skillChainSteps(['om-fix', 'om-fix', 'om-fix']).map((step) => step.id)).toEqual([
      'om-fix',
      'om-fix-2',
      'om-fix-3',
    ])
  })

  it(`caps the chain at ${MAX_CHAIN_STEPS} steps`, () => {
    const names = Array.from({ length: 12 }, (_, i) => `skill-${i}`)
    expect(skillChainSteps(names)).toHaveLength(MAX_CHAIN_STEPS)
  })
})

describe('githubRunBody', () => {
  it('workflow selected → that workflow, skills as a prompt hint', () => {
    const body = githubRunBody(item(), 'ship-it', ['om-fix'])
    expect(body.workflow).toBe('ship-it')
    expect(body.steps).toBeUndefined()
    expect(body.task).toContain('Use these skills where relevant: om-fix.')
  })

  it('skills only → the skills ARE the chain, and the prompt carries no hint sentence', () => {
    const body = githubRunBody(item(), null, ['om-fix', 'om-review'])
    expect(body.workflow).toBeUndefined()
    expect(body.steps?.map((step) => step.skill)).toEqual(['om-fix', 'om-review'])
    expect(body.task).not.toContain('Use these skills')
  })

  it('nothing selected → quick-task', () => {
    expect(githubRunBody(item(), null, []).workflow).toBe('quick-task')
  })

  it('a custom prompt EXTENDS the task context rather than replacing it (#524)', () => {
    const body = githubRunBody(item(), null, [], 'Just triage this, do not fix.')
    // The user's words survive…
    expect(body.task).toContain('Just triage this, do not fix.')
    // …and so does the reference that makes them actionable.
    expect(body.task).toContain('#142')
    expect(body.task).toContain('https://github.com/acme/demo/issues/142')
  })

  it('routing is untouched, and the skills hint still rides along on the workflow branch', () => {
    const wf = githubRunBody(item(), 'ship-it', ['om-fix'], '  Investigate only.  ')
    expect(wf.workflow).toBe('ship-it')
    expect(wf.steps).toBeUndefined()
    expect(wf.task).toContain('Investigate only.')
    expect(wf.task).toContain('#142')
    expect(wf.task).toContain('Use these skills where relevant: om-fix.')

    // The skills-ARE-the-chain branch keeps carrying no hint sentence.
    const chain = githubRunBody(item(), null, ['om-fix'], 'Investigate only.')
    expect(chain.steps?.map((step) => step.skill)).toEqual(['om-fix'])
    expect(chain.task).not.toContain('Use these skills')
  })

  it('a whitespace-only custom prompt is byte-for-byte the default text', () => {
    expect(githubRunBody(item(), null, [], '   ').task).toBe(githubRunBody(item(), null, []).task)
    expect(githubRunBody(item(), null, [], undefined).task).toBe(githubTaskPrompt(item()))
  })
})

describe('githubTaskRef', () => {
  it('is the identity only — no quoted body, no skills hint (#524)', () => {
    expect(githubTaskRef(item())).toBe(
      'Fix GitHub issue #142: Login form drops session on refresh\n\n' +
        'https://github.com/acme/demo/issues/142',
    )
    expect(githubTaskRef(item())).not.toContain('Repro:')
  })

  it('a PR reads "Address GitHub pull request"', () => {
    expect(githubTaskRef(item({ kind: 'pr', number: 7 }))).toContain(
      'Address GitHub pull request #7:',
    )
  })
})

describe('mentionsItem', () => {
  it('matches the URL, or the KIND-qualified wording task-refs keys on', () => {
    expect(mentionsItem('see https://github.com/acme/demo/issues/142 first', item())).toBe(true)
    expect(mentionsItem('port issue #142 to develop', item())).toBe(true)
    expect(mentionsItem('port ISSUE 142 to develop', item())).toBe(true)
    const pr = item({ kind: 'pr', number: 77, url: 'https://github.com/acme/demo/pull/77' })
    expect(mentionsItem('rebase PR #77', pr)).toBe(true)
    expect(mentionsItem('rebase pull request 77', pr)).toBe(true)
  })

  it('a BARE #N is not enough — extractTaskRefs could only call it ambiguous', () => {
    expect(mentionsItem('port #142 to develop', item())).toBe(false)
  })

  it('the wrong kind does not count either', () => {
    // "PR 142" on an ISSUE hand-off would make task-refs record a prNumber, not an issueNumber.
    expect(mentionsItem('port PR 142 to develop', item())).toBe(false)
  })

  it('a longer number that merely starts with N does not count', () => {
    expect(mentionsItem('port issue #1420 to develop', item())).toBe(false)
    expect(mentionsItem('port issue #14 to develop', item())).toBe(false)
  })

  it('the exact prompt from the bug report mentions nothing', () => {
    expect(mentionsItem('Port this one to develop and close original PR', item())).toBe(false)
  })
})

describe('applyItemTokens', () => {
  it('substitutes {{number}}, {{title}} and {{url}}, case- and space-insensitively', () => {
    expect(applyItemTokens('rebase {{number}} onto develop', item())).toBe(
      'rebase #142 onto develop',
    )
    expect(applyItemTokens('{{ TITLE }} / {{url}}', item())).toBe(
      'Login form drops session on refresh / https://github.com/acme/demo/issues/142',
    )
  })

  it('leaves text with no tokens alone', () => {
    expect(applyItemTokens('nothing to see', item())).toBe('nothing to see')
  })

  it('a `$` in the title is literal, not a replacement pattern', () => {
    // `$&`, `$$`, `` $` ``, `$'` and `$1` are special in a replacement STRING. An issue title is
    // arbitrary user text, so substitution must go through a replacer function.
    const dollars = item({ title: "Cost $$ doubled, $& broke, $1 off, $` and $'" })
    expect(applyItemTokens('{{title}}', dollars)).toBe(dollars.title)
  })
})

describe('composeGithubTask', () => {
  it('prepends the ref block when the prompt does not carry the reference', () => {
    expect(composeGithubTask(item(), [], 'Port this one to develop and close original PR')).toBe(
      'Fix GitHub issue #142: Login form drops session on refresh\n\n' +
        'https://github.com/acme/demo/issues/142\n\n' +
        'Port this one to develop and close original PR',
    )
  })

  it('does NOT duplicate the ref when the prompt already carries it — e.g. the pre-filled box', () => {
    const base = githubTaskRef(item())
    expect(composeGithubTask(item(), [], base)).toBe(base)
    expect(composeGithubTask(item(), [], `${base}\n\nAlso add tests.`)).toBe(
      `${base}\n\nAlso add tests.`,
    )
  })

  it('a token-substituted BARE #N still gets the ref block — it is not a durable reference', () => {
    expect(composeGithubTask(item(), [], 'rebase {{number}} onto develop')).toBe(
      `${githubTaskRef(item())}\n\nrebase #142 onto develop`,
    )
  })

  it('a token inside the ITEM TITLE is never rewritten inside our own ref block', () => {
    const tokenTitle = item({ title: 'Support {{url}} in prompt templates' })
    const base = githubTaskRef(tokenTitle)
    expect(composeGithubTask(tokenTitle, [], `${base}\n\nUse {{url}} please.`)).toBe(
      `${base}\n\nUse ${tokenTitle.url} please.`,
    )
  })

  it('puts the user instruction LAST, after the context', () => {
    const task = composeGithubTask(item(), [], 'Only triage.')
    expect(task.indexOf('#142')).toBeLessThan(task.indexOf('Only triage.'))
  })
})

// The regex contract from the issue's follow-up comment: `src/runs/task-refs.ts` recovers a run's
// PR/issue attribution by scanning the task TEXT — there is no structured field to fall back on.
// Pinning it here means a future change to the composition order or separator cannot silently
// cost every custom-prompt run its chip and its `#N` title prefix.
describe('extractTaskRefs over composed hand-off text', () => {
  it('a custom prompt still yields the issue number', () => {
    const task = composeGithubTask(item(), [], 'Port this one to develop and close original PR')
    expect(extractTaskRefs(task).issueNumber).toBe(142)
  })

  it('a custom prompt still yields the PR number', () => {
    const pr = item({ kind: 'pr', number: 77, url: 'https://github.com/acme/demo/pull/77' })
    const task = composeGithubTask(pr, [], 'Port this one to develop and close original PR')
    expect(extractTaskRefs(task).prNumber).toBe(77)
  })

  it('the pre-filled box text alone is enough', () => {
    expect(extractTaskRefs(githubTaskRef(item())).issueNumber).toBe(142)
  })

  it('a prompt keeping only a bare #N still recovers the KIND, not just an ambiguous number', () => {
    // The regression F2 guards: `mentionsItem` must not accept a bare `#142` as a durable
    // reference, because `extractTaskRefs` can only call it `ambiguousNumber` — no chip, no
    // `#N` title prefix. Trimming the pre-filled box to this is an ordinary edit.
    const task = composeGithubTask(item(), [], 'port #142 to develop')
    expect(extractTaskRefs(task).issueNumber).toBe(142)
    expect(extractTaskRefs(task).ambiguousNumber).toBeUndefined()
  })
})

// #401 — the backend pair arrives pre-shaped from engineBody (components/engine-pills),
// which owns the omit rules; this builder's only job is to spread it onto every route.
describe('githubRunBody backend (#401)', () => {
  it('omitted → no runner/model at all (the pre-#401 body)', () => {
    const body = githubRunBody(item(), null, [])
    expect(body.runner).toBeUndefined()
    expect(body.model).toBeUndefined()
  })

  it('rides the workflow route', () => {
    const body = githubRunBody(item(), 'ship-it', [], undefined, {
      runner: 'codex',
      model: 'gpt-5.1-codex',
    })
    expect(body).toMatchObject({ workflow: 'ship-it', runner: 'codex', model: 'gpt-5.1-codex' })
  })

  it('rides the skills-as-chain route without disturbing the steps', () => {
    const body = githubRunBody(item(), null, ['om-fix', 'om-review'], undefined, {
      runner: 'opencode',
      model: 'anthropic/claude-sonnet-5',
    })
    expect(body.steps?.map((step) => step.skill)).toEqual(['om-fix', 'om-review'])
    expect(body).toMatchObject({ runner: 'opencode', model: 'anthropic/claude-sonnet-5' })
  })

  it('rides the quick-task route, and an all-undefined pair leaves the body clean', () => {
    expect(githubRunBody(item(), null, [], undefined, { runner: 'codex' })).toMatchObject({
      workflow: 'quick-task',
      runner: 'codex',
    })
    // engineBody returns explicit undefineds for "send nothing" — they must not become keys
    // with values, and JSON.stringify drops them on the wire.
    const clean = githubRunBody(item(), null, [], undefined, {
      runner: undefined,
      model: undefined,
    })
    expect(JSON.parse(JSON.stringify(clean))).not.toHaveProperty('runner')
    expect(JSON.parse(JSON.stringify(clean))).not.toHaveProperty('model')
  })
})
