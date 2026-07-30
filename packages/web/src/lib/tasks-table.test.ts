import { describe, expect, it } from 'vitest'

import type { ProcessUsage, RunRecord } from '@open-mercato/cezar-api-client'
import {
  compareGroups,
  filterRuns,
  finishedRunCount,
  formatCost,
  formatMem,
  githubRepoBase,
  prNumber,
  taskReference,
  taskPrUrl,
  taskIssueUrl,
  usageCells,
  workflowLabel,
} from '@/lib/tasks-table'

let seq = 0

function run(over: Partial<RunRecord> = {}): RunRecord {
  seq += 1
  return {
    id: `r${seq}`,
    title: `Task ${seq}`,
    workflow: 'default',
    task: `task ${seq}`,
    status: 'done',
    createdAt: '2026-07-14T10:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  }
}

const SAMPLE: ProcessUsage = { cpuPct: 38.4, rssBytes: 612 * 1024 ** 2, procCount: 5 }

describe('formatMem', () => {
  const cases: Array<[input: number | undefined, expected: string]> = [
    [undefined, ''],
    [0, ''],
    [512, '1 kB'],
    [800 * 1024, '800 kB'],
    [612 * 1024 ** 2, '612 MB'],
    // Rounds at the MB step, like the legacy fmtBytes.
    [1023.4 * 1024 ** 2, '1023 MB'],
    [1.2 * 1024 ** 3, '1.2 GB'],
  ]
  for (const [input, expected] of cases) {
    it(`${input} → "${expected}"`, () => expect(formatMem(input)).toBe(expected))
  }
})

describe('formatCost', () => {
  const cases: Array<[input: number | undefined, expected: string]> = [
    [undefined, ''],
    [0, ''],
    [0.004, '$0.00'],
    [0.31, '$0.31'],
    [9.999, '$10.00'],
    [12.34, '$12'],
  ]
  for (const [input, expected] of cases) {
    it(`${input} → "${expected}"`, () => expect(formatCost(input)).toBe(expected))
  }
})

describe('workflowLabel', () => {
  it('shows the workflow name as-is', () => {
    expect(workflowLabel(run({ workflow: 'quick-task' }))).toBe('quick-task')
  })

  it('replaces the (planned)/(inbox) placeholders with the first agent step', () => {
    const steps = [
      { id: 's1', name: 'lint', kind: 'check' as const, status: 'done' as const, iterations: 1, tokensUsed: 0 },
      { id: 's2', name: 'om-fix', kind: 'agent' as const, status: 'done' as const, iterations: 1, tokensUsed: 0 },
    ]
    expect(workflowLabel(run({ workflow: '(planned)', steps }))).toBe('om-fix')
    expect(workflowLabel(run({ workflow: '(inbox)', steps }))).toBe('om-fix')
  })

  it('keeps the placeholder when no agent step names itself', () => {
    expect(workflowLabel(run({ workflow: '(planned)', steps: [] }))).toBe('(planned)')
  })
})

describe('filterRuns', () => {
  const runs = [
    run({ id: 'a', title: 'Bump zod to v4', branch: 'cez/99aa11bb', workflow: 'quick-task' }),
    run({ id: 'b', title: 'README tagline', branch: 'cez/e5f6a7b8', workflow: 'plan-then-do' }),
    run({
      id: 'c',
      title: 'Inbox follow-up',
      workflow: '(inbox)',
      steps: [{ id: 's', name: 'om-fix', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0 }],
    }),
  ]
  const ids = (query: string) => filterRuns(runs, query).map((r) => r.id)

  it('returns everything for an empty or whitespace query', () => {
    expect(ids('')).toEqual(['a', 'b', 'c'])
    expect(ids('   ')).toEqual(['a', 'b', 'c'])
  })

  it('matches the title, case-insensitively', () => {
    expect(ids('ZOD')).toEqual(['a'])
  })

  it('searches the DISPLAYED title: the auto-summary when set, and not the raw title it hides', () => {
    const summarized = [
      run({ id: 's', title: 'fix the login bug plz', titleSummary: 'Catch AuthError in the handler' }),
    ]
    expect(filterRuns(summarized, 'autherror').map((r) => r.id)).toEqual(['s'])
    // The raw title is not on screen — matching it would surface a row for no visible reason.
    expect(filterRuns(summarized, 'plz')).toEqual([])
  })

  it('searches the same fallback title shown for a malformed legacy summary', () => {
    const malformed = [
      run({
        id: 'legacy',
        title: '476: verifying pr ui',
        titleSummary: 'Reading the handoff file for context.The task is UI QA verification of PR #476',
      }),
    ]
    expect(filterRuns(malformed, 'verifying pr ui').map((r) => r.id)).toEqual(['legacy'])
    expect(filterRuns(malformed, 'handoff')).toEqual([])
  })

  it('matches the branch', () => {
    expect(ids('e5f6')).toEqual(['b'])
  })

  it('matches the workflow — including the label the column actually prints', () => {
    expect(ids('plan-then')).toEqual(['b'])
    // '(inbox)' renders as its agent step's name, so that name must be searchable.
    expect(ids('om-fix')).toEqual(['c'])
  })

  it('answers nothing for a query nothing matches', () => {
    expect(ids('quaternion')).toEqual([])
  })

  it('does not match on the task prompt — text the table never shows', () => {
    expect(filterRuns([run({ task: 'secret prompt words' })], 'secret')).toEqual([])
  })
})

describe('finishedRunCount', () => {
  it('counts unarchived done/failed/cancelled only', () => {
    expect(
      finishedRunCount([
        run({ status: 'done' }),
        run({ status: 'failed' }),
        run({ status: 'cancelled' }),
        // Still wants a human or still working — not sweepable.
        run({ status: 'review' }),
        run({ status: 'waiting' }),
        run({ status: 'running' }),
        run({ status: 'queued' }),
        // Already archived — nothing to archive again.
        run({ status: 'done', archived: true }),
      ]),
    ).toBe(3)
  })
})

describe('taskPrUrl', () => {
  it('prefers the PR the task created over the one it referenced', () => {
    const r = run({
      pullRequestUrl: 'https://github.com/o/r/pull/7',
      referencedPullRequestUrl: 'https://github.com/o/r/pull/4170',
    })
    expect(taskPrUrl(r)).toBe('https://github.com/o/r/pull/7')
  })

  it('falls back to the referenced PR (#407 — review tasks never create one)', () => {
    const r = run({ referencedPullRequestUrl: 'https://github.com/o/r/pull/4170' })
    expect(taskPrUrl(r)).toBe('https://github.com/o/r/pull/4170')
  })

  it('is undefined when the task has no PR association at all', () => {
    expect(taskPrUrl(run())).toBeUndefined()
  })

  it('does not adopt an incidental PR for an issue-subject run that declared no PR (#526)', () => {
    // om-prepare-issue for #524: CEZ:ISSUE declared, no CEZ:PR — #454 was only incidental
    // transcript text and must never surface as "the run's PR".
    const r = run({
      markerRefs: { issue: 524 },
      referencedPullRequestUrl: 'https://github.com/o/r/pull/454',
      referencedPrCandidates: ['https://github.com/o/r/pull/454'],
    })
    expect(taskPrUrl(r)).toBeUndefined()
  })

  it('still shows the referenced PR when the run also declared a PR marker (#526)', () => {
    const r = run({
      markerRefs: { issue: 524, pr: 454 },
      referencedPullRequestUrl: 'https://github.com/o/r/pull/454',
    })
    expect(taskPrUrl(r)).toBe('https://github.com/o/r/pull/454')
  })

  it('a created PR always wins, even for an issue-subject run (#526)', () => {
    const r = run({
      markerRefs: { issue: 524 },
      pullRequestUrl: 'https://github.com/o/r/pull/900',
      referencedPullRequestUrl: 'https://github.com/o/r/pull/454',
    })
    expect(taskPrUrl(r)).toBe('https://github.com/o/r/pull/900')
  })
})

describe('taskIssueUrl', () => {
  it('returns the discovered issue URL for display', () => {
    expect(taskIssueUrl(run({ referencedIssueUrl: 'https://github.com/o/r/issues/544' }))).toBe(
      'https://github.com/o/r/issues/544',
    )
  })

  it('is undefined when the task has no issue URL and no repo to synthesize from', () => {
    expect(taskIssueUrl(run({ issueNumber: 544 }))).toBeUndefined()
  })

  it('synthesizes the issue link from the CEZ:ISSUE marker + the project repo (#526)', () => {
    // The om-prepare-issue #524 record: issue known via the marker, but no `…/issues/524`
    // link was ever scanned. The cockpit's own repo makes the created issue reachable.
    const r = run({
      markerRefs: { issue: 524 },
      referencedPullRequestUrl: 'https://github.com/o/r/pull/454',
    })
    expect(taskIssueUrl(r, 'https://github.com/o/r')).toBe('https://github.com/o/r/issues/524')
  })

  it('synthesizes from the project repo, never from a foreign transcript URL (#526)', () => {
    // The regression the candidates-based synthesis had: an incidental PR from ANOTHER repo
    // would have produced `https://github.com/other/repo/issues/524` — #526's wrong link with
    // an issue URL instead of a PR one. The project repo is the only authority.
    const r = run({
      markerRefs: { issue: 524 },
      referencedPullRequestUrl: 'https://github.com/other/repo/pull/1',
      referencedPrCandidates: ['https://github.com/other/repo/pull/1'],
      referencedIssueCandidates: ['https://github.com/third/repo/issues/9'],
    })
    expect(taskIssueUrl(r, 'https://github.com/o/r')).toBe('https://github.com/o/r/issues/524')
    // …and with no project repo known (health in flight, no remote, non-GitHub forge), no link
    // at all: no chip beats a wrong chip.
    expect(taskIssueUrl(r)).toBeUndefined()
  })

  it('prefers a real discovered issue URL over the synthesized one (#526)', () => {
    const r = run({
      markerRefs: { issue: 524 },
      referencedIssueUrl: 'https://github.com/o/r/issues/524',
      referencedPullRequestUrl: 'https://github.com/other/repo/pull/1',
      referencedPrCandidates: ['https://github.com/other/repo/pull/1'],
    })
    expect(taskIssueUrl(r, 'https://github.com/elsewhere/x')).toBe('https://github.com/o/r/issues/524')
  })
})

describe('githubRepoBase', () => {
  it.each([
    ['https://github.com/open-mercato/cezar.git', 'https://github.com/open-mercato/cezar'],
    ['https://github.com/open-mercato/cezar', 'https://github.com/open-mercato/cezar'],
    ['https://user:token@github.com/open-mercato/cezar.git', 'https://github.com/open-mercato/cezar'],
    ['git@github.com:open-mercato/cezar.git', 'https://github.com/open-mercato/cezar'],
    ['ssh://git@github.com:22/open-mercato/cezar.git', 'https://github.com/open-mercato/cezar'],
    ['https://github.com/open-mercato/cezar/', 'https://github.com/open-mercato/cezar'],
  ])('normalizes %s', (remote, expected) => {
    expect(githubRepoBase(remote)).toBe(expected)
  })

  it.each([
    ['undefined remote', undefined],
    ['no remote configured', ''],
    ['a GitLab remote', 'git@gitlab.com:o/r.git'],
    ['a self-hosted forge', 'https://git.example.com/o/r.git'],
    ['a local path', '/srv/git/repo.git'],
    ['a bare host with no owner', 'https://github.com/cezar'],
  ])('has no GitHub base for %s', (_name, remote) => {
    expect(githubRepoBase(remote)).toBeUndefined()
  })
})

describe('taskReference', () => {
  it('shows the known issue while an issue-driven task is queued', () => {
    expect(taskReference(run({ status: 'queued', issueNumber: 554 }))).toEqual({
      kind: 'Issue',
      number: 554,
    })
  })

  it('prefers a pull request once the task has one', () => {
    expect(
      taskReference(
        run({
          issueNumber: 554,
          referencedIssueUrl: 'https://github.com/o/r/issues/554',
          pullRequestUrl: 'https://github.com/o/r/pull/600',
        })
      )
    ).toEqual({ kind: 'PR', number: 600, url: 'https://github.com/o/r/pull/600' })
  })
})

describe('prNumber', () => {
  it('reads the trailing number off a forge URL', () => {
    expect(prNumber('https://github.com/o/r/pull/402')).toBe('402')
  })

  it('answers null when the last segment is not a number', () => {
    expect(prNumber('https://example.com/merge_requests/new')).toBeNull()
    expect(prNumber('')).toBeNull()
  })
})

describe('usageCells', () => {
  it('reports a live sample for a running run, emphasized', () => {
    expect(usageCells(run({ status: 'running' }), SAMPLE)).toEqual({
      cpu: { text: '38%', kind: 'live' },
      mem: { text: '612 MB', kind: 'live' },
    })
  })

  it('believes a sample for a waiting run too — the CLI process is still alive', () => {
    expect(usageCells(run({ status: 'waiting' }), SAMPLE).cpu.kind).toBe('live')
  })

  it('ignores a sample that raced a run into a terminal status', () => {
    const cells = usageCells(run({ status: 'done' }), SAMPLE)
    expect(cells.cpu).toEqual({ text: '', kind: 'none' })
    expect(cells.mem).toEqual({ text: '', kind: 'none' })
  })

  it('falls back to the persisted peak, dimmed, when there is no live sample', () => {
    const cells = usageCells(run({ status: 'done', peakRssBytes: 401 * 1024 ** 2, peakProcCount: 7 }), undefined)
    expect(cells.cpu).toEqual({ text: '', kind: 'none' }) // no persisted peak CPU exists
    expect(cells.mem).toEqual({
      text: 'peak 401 MB',
      kind: 'peak',
      title: 'peak — run finished · 7 procs',
    })
  })

  it('drops the proc count from the tooltip when none was recorded', () => {
    expect(usageCells(run({ status: 'done', peakRssBytes: 1024 ** 2 }), undefined).mem.title).toBe(
      'peak — run finished',
    )
  })

  it('shows a running run without a sample yet as empty, not as zero', () => {
    const cells = usageCells(run({ status: 'running' }), undefined)
    expect(cells.cpu).toEqual({ text: '', kind: 'none' })
    expect(cells.mem).toEqual({ text: '', kind: 'none' })
  })
})

describe('compareGroups', () => {
  const finishedPair = (groupId: string, status: RunRecord['status'] = 'review'): [RunRecord, RunRecord] => [
    run({ groupId, variant: 'A', title: 'Add autocomplete (A)', status }),
    run({ groupId, variant: 'B', title: 'Add autocomplete (B)', status }),
  ]

  it('offers a strip for a group whose variants are all terminal', () => {
    expect(compareGroups(finishedPair('g1'), 'active')).toEqual([
      { groupId: 'g1', title: 'Add autocomplete', count: 2 },
    ])
  })

  it('counts review/failed/cancelled as terminal, matching the legacy compare gate', () => {
    const [a, b] = finishedPair('g1')
    expect(compareGroups([a, { ...b, status: 'failed' }], 'active')).toHaveLength(1)
    expect(compareGroups([a, { ...b, status: 'cancelled' }], 'active')).toHaveLength(1)
  })

  it('withholds the strip while any variant is still in flight', () => {
    const [a, b] = finishedPair('g1')
    for (const status of ['running', 'queued', 'waiting'] as const) {
      expect(compareGroups([a, { ...b, status }], 'active')).toEqual([])
    }
  })

  it('is not a comparison with one member left in view', () => {
    const [a, b] = finishedPair('g1')
    expect(compareGroups([a, { ...b, archived: true }], 'active')).toEqual([])
  })

  it('scopes to the view — an archived group belongs to the Archived tab', () => {
    const archivedPair = finishedPair('g2', 'done').map((r) => ({ ...r, archived: true }))
    expect(compareGroups(archivedPair, 'active')).toEqual([])
    expect(compareGroups(archivedPair, 'archived')).toEqual([{ groupId: 'g2', title: 'Add autocomplete', count: 2 }])
  })

  it('ignores ungrouped runs entirely', () => {
    expect(compareGroups([run(), run()], 'active')).toEqual([])
  })
})
