import { describe, expect, it } from 'vitest'

import type { RunRecord, RunStatus } from '@open-mercato/cezar-api-client'
import {
  BUCKET_ORDER,
  bucketOf,
  groupRuns,
  groupTitle,
  listCounts,
  queuePositions,
  refPrefixMatches,
  runTitle,
  sortRuns,
  splitRefPrefix,
  type QuickListBucket,
} from '@/lib/task-groups'

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

/** Flatten to `Bucket: id, id` lines — the assertions are about placement and order, and a
 *  structural `toEqual` of whole records buries that in noise. */
function shape(buckets: QuickListBucket[]): string[] {
  return buckets.map(
    (bucket) =>
      `${bucket.label}: ${bucket.rows
        .map((row) => (row.kind === 'group' ? `[${row.members.map((m) => m.variant).join('')}]` : row.run.id))
        .join(', ')}`
  )
}

/** `groupRuns(...)` rows for one bucket, asserted to exist — the tests are about their content,
 *  and `noUncheckedIndexedAccess` would otherwise put a `?.` on every line of that. */
function rowsOf(buckets: QuickListBucket[], index = 0) {
  const bucket = buckets[index]
  if (!bucket) throw new Error(`no bucket at ${index}`)
  return bucket.rows
}

/** The one group row a test expects, narrowed. */
function groupRow(buckets: QuickListBucket[], index = 0) {
  const row = rowsOf(buckets)[index]
  if (!row || row.kind !== 'group') throw new Error('expected a group row')
  return row
}

describe('bucketOf', () => {
  const cases: ReadonlyArray<[RunStatus, string]> = [
    ['waiting', 'Needs you'],
    ['review', 'Needs you'],
    ['running', 'Working'],
    ['queued', 'Working'],
    ['done', 'Recent'],
    ['failed', 'Recent'],
    ['cancelled', 'Recent'],
  ]

  it.each(cases)('%s → %s in the active view', (status, label) => {
    expect(bucketOf(run({ status }), 'active')).toBe(label)
  })

  it.each(cases)('%s → Archived in the archived view', (status) => {
    expect(bucketOf(run({ status, archived: true }), 'archived')).toBe('Archived')
  })

  it("a monitoring run stays in Working, not Needs you (#490)", () => {
    expect(bucketOf(run({ status: 'running', activity: 'monitoring' }), 'active')).toBe('Working')
  })

  it('a run waiting out a usage limit is Working, not Recent', () => {
    // Failed on the record, but it has an appointment to resume itself (spec
    // 2026-08-03-auto-resume-after-usage-limit) — it is work in flight, not an outcome. And it
    // asks for nothing, so never "Needs you".
    const scheduled = run({ status: 'failed', autoResumeAt: '2026-08-03T19:33:53.000Z' })
    expect(bucketOf(scheduled, 'active')).toBe('Working')
    expect(bucketOf(run({ status: 'failed' }), 'active')).toBe('Recent')
    // Archived still collapses everything, schedule or not.
    expect(bucketOf({ ...scheduled, archived: true }, 'archived')).toBe('Archived')
  })
})

describe('sortRuns', () => {
  it('orders by status priority, then newest first', () => {
    const runs = [
      run({ id: 'done-old', status: 'done', createdAt: '2026-07-14T09:00:00.000Z' }),
      run({ id: 'running', status: 'running', createdAt: '2026-07-14T08:00:00.000Z' }),
      run({ id: 'done-new', status: 'done', createdAt: '2026-07-14T11:00:00.000Z' }),
      run({ id: 'review', status: 'review', createdAt: '2026-07-14T07:00:00.000Z' }),
      run({ id: 'queued', status: 'queued', createdAt: '2026-07-14T12:00:00.000Z' }),
      run({ id: 'waiting', status: 'waiting', createdAt: '2026-07-14T06:00:00.000Z' }),
    ]
    // Needs-you first even though it is the oldest run in the list; a fresh `done` never
    // outranks a run that is blocked on you.
    expect(sortRuns(runs, 'active').map((r) => r.id)).toEqual([
      'waiting',
      'review',
      'running',
      'queued',
      'done-new',
      'done-old',
    ])
  })

  it('orders scheduled runs by their appointment — soonest on top, not newest', () => {
    // "What happens next" has to hold INSIDE the rank too: a task resuming at 11:14 sits above
    // one resuming at 11:40 however old each is (spec 2026-08-03-auto-resume-after-usage-limit).
    // Creation order is deliberately the inverse of appointment order here.
    const runs = [
      run({ id: 'late', status: 'failed', autoResumeAt: '2026-08-03T11:40:00.000Z', createdAt: '2026-07-14T12:00:00.000Z' }),
      run({ id: 'soon', status: 'failed', autoResumeAt: '2026-08-03T11:14:00.000Z', createdAt: '2026-07-14T08:00:00.000Z' }),
      run({ id: 'mid', status: 'failed', autoResumeAt: '2026-08-03T11:20:00.000Z', createdAt: '2026-07-14T10:00:00.000Z' }),
    ]
    expect(sortRuns(runs, 'active').map((r) => r.id)).toEqual(['soon', 'mid', 'late'])
  })

  it('orders queued runs FIFO, so the row order matches the #N positions they print', () => {
    const runs = [
      run({ id: 'third', status: 'queued', createdAt: '2026-07-14T12:00:00.000Z' }),
      run({ id: 'first', status: 'queued', createdAt: '2026-07-14T10:00:00.000Z' }),
      run({ id: 'second', status: 'queued', createdAt: '2026-07-14T11:00:00.000Z' }),
    ]
    const sorted = sortRuns(runs, 'active')
    expect(sorted.map((r) => r.id)).toEqual(['first', 'second', 'third'])
    // …which is exactly the order `queuePositions` numbers them in.
    const positions = queuePositions(runs)
    expect(sorted.map((r) => positions.get(r.id))).toEqual([1, 2, 3])
  })

  it('ranks the outcomes done → failed → cancelled, recency within each', () => {
    const runs = [
      run({ id: 'cancelled', status: 'cancelled', createdAt: '2026-07-14T09:00:00.000Z' }),
      run({ id: 'failed', status: 'failed', createdAt: '2026-07-14T10:00:00.000Z' }),
      run({ id: 'done', status: 'done', createdAt: '2026-07-14T08:00:00.000Z' }),
      run({ id: 'done-newer', status: 'done', createdAt: '2026-07-14T11:00:00.000Z' }),
    ]
    expect(sortRuns(runs, 'active').map((r) => r.id)).toEqual([
      'done-newer',
      'done',
      'failed',
      'cancelled',
    ])
  })

  it('puts a scheduled run between running and queued — the pipeline in the order it happens', () => {
    // A usage-limit wait is work with an appointment, not an outcome (spec
    // 2026-08-03-auto-resume-after-usage-limit), so it must never sink into the terminal block
    // with the plain failures. Reading top-down answers "what happens next".
    const runs = [
      run({ id: 'failed', status: 'failed', createdAt: '2026-07-14T12:00:00.000Z' }),
      run({ id: 'queued', status: 'queued', createdAt: '2026-07-14T11:00:00.000Z' }),
      run({
        id: 'scheduled',
        status: 'failed',
        autoResumeAt: '2026-08-03T19:33:53.000Z',
        createdAt: '2026-07-14T08:00:00.000Z',
      }),
      run({ id: 'running', status: 'running', createdAt: '2026-07-14T07:00:00.000Z' }),
      run({ id: 'waiting', status: 'waiting', createdAt: '2026-07-14T06:00:00.000Z' }),
    ]
    expect(sortRuns(runs, 'active').map((r) => r.id)).toEqual([
      'waiting',
      'running',
      'scheduled',
      'queued',
      'failed',
    ])
  })

  it('filters to the view', () => {
    const runs = [run({ id: 'a' }), run({ id: 'b', archived: true })]
    expect(sortRuns(runs, 'active').map((r) => r.id)).toEqual(['a'])
    expect(sortRuns(runs, 'archived').map((r) => r.id)).toEqual(['b'])
  })

  it('does not reorder its input', () => {
    const runs = [run({ id: 'done', status: 'done' }), run({ id: 'waiting', status: 'waiting' })]
    sortRuns(runs, 'active')
    expect(runs.map((r) => r.id)).toEqual(['done', 'waiting'])
  })
})

describe('queuePositions', () => {
  it('numbers queued runs 1..n by creation order, not list order', () => {
    const runs = [
      run({ id: 'third', status: 'queued', createdAt: '2026-07-14T12:00:00.000Z' }),
      run({ id: 'first', status: 'queued', createdAt: '2026-07-14T10:00:00.000Z' }),
      run({ id: 'second', status: 'queued', createdAt: '2026-07-14T11:00:00.000Z' }),
    ]
    expect(queuePositions(runs)).toEqual(
      new Map([
        ['first', 1],
        ['second', 2],
        ['third', 3],
      ])
    )
  })

  it('counts only active queued runs', () => {
    const runs = [
      run({ id: 'running', status: 'running' }),
      run({ id: 'archived-queued', status: 'queued', archived: true, createdAt: '2026-07-14T09:00:00.000Z' }),
      run({ id: 'queued', status: 'queued', createdAt: '2026-07-14T10:00:00.000Z' }),
    ]
    // The archived one is not in the engine's queue, so it must not push the real one to #2.
    expect(queuePositions(runs)).toEqual(new Map([['queued', 1]]))
  })
})

describe('splitRefPrefix', () => {
  it.each([
    // Exactly what `postValidateTitle` writes.
    ['775: implementing comment threads', 775, 'implementing comment threads'],
    ['1: a', 1, 'a'],
    ['123456789: nine digits still parse', 123_456_789, 'nine digits still parse'],
    // Not the shape: no space, no digits, nothing after the colon, or a colon that is prose.
    ['775:implementing comment threads', null, '775:implementing comment threads'],
    ['fix: the login bug', null, 'fix: the login bug'],
    ['775: ', null, '775: '],
    ['775', null, '775'],
    ['#775: hash-prefixed is not our shape', null, '#775: hash-prefixed is not our shape'],
    [' 775: leading space is not our shape', null, ' 775: leading space is not our shape'],
    ['1234567890: ten digits is not a tracker number', null, '1234567890: ten digits is not a tracker number'],
    // A second `NNN: ` inside the rest is left alone — only the leading one is the prefix.
    ['775: 776: nested', 775, '776: nested'],
  ])('%s → %s / %s', (title, ref, rest) => {
    expect(splitRefPrefix(title)).toEqual({ ref, rest })
  })
})

describe('refPrefixMatches', () => {
  it('agrees only when the prefix IS the reference the chip will show', () => {
    expect(refPrefixMatches('775: implementing comment threads', 775)).toBe(true)
    // Opened on issue #788, shipped as PR #790 — two numbers, two facts. Neither may be hidden.
    expect(refPrefixMatches('788: implementing comment threads', 790)).toBe(false)
    // A title that legitimately begins with a number is never mistaken for a reference.
    expect(refPrefixMatches('2026: the year in review', 2026)).toBe(true)
    expect(refPrefixMatches('2026: the year in review', 790)).toBe(false)
    // Nothing to match against, or nothing to strip.
    expect(refPrefixMatches('775: implementing comment threads', undefined)).toBe(false)
    expect(refPrefixMatches('implementing comment threads', 775)).toBe(false)
  })
})

describe('groupTitle', () => {
  it.each([
    ['Add skills autocomplete (A)', 'Add skills autocomplete'],
    ['Add skills autocomplete (C)', 'Add skills autocomplete'],
    ['Add skills autocomplete', 'Add skills autocomplete'],
    // Only the server's own ` (A)`…` (C)` suffix — a title that happens to end in parentheses
    // keeps them.
    ['Bump zod to v4 (draft)', 'Bump zod to v4 (draft)'],
    ['Rename the (D) flag', 'Rename the (D) flag'],
  ])('%s → %s', (title, expected) => {
    expect(groupTitle(run({ title }))).toBe(expected)
  })
})

describe('groupRuns', () => {
  it('emits the buckets in the mockup order, and omits empty ones', () => {
    const runs = [
      run({ id: 'done', status: 'done' }),
      run({ id: 'waiting', status: 'waiting' }),
      run({ id: 'running', status: 'running' }),
    ]
    expect(shape(groupRuns(runs, 'active'))).toEqual(['Needs you: waiting', 'Working: running', 'Recent: done'])

    // Nothing waiting → no "Needs you" header at all.
    expect(shape(groupRuns([run({ id: 'done', status: 'done' })], 'active'))).toEqual(['Recent: done'])
  })

  it('declares the bucket order it renders in', () => {
    expect(BUCKET_ORDER).toEqual(['Needs you', 'Working', 'Recent', 'Archived'])
  })

  it('puts every archived run under one Archived bucket regardless of status', () => {
    const runs = [
      run({ id: 'w', status: 'waiting', archived: true }),
      run({ id: 'd', status: 'done', archived: true, createdAt: '2026-07-14T11:00:00.000Z' }),
      run({ id: 'active', status: 'running' }),
    ]
    expect(shape(groupRuns(runs, 'archived'))).toEqual(['Archived: w, d'])
  })

  it('carries queue positions onto the rows', () => {
    const runs = [
      run({ id: 'q2', status: 'queued', createdAt: '2026-07-14T11:00:00.000Z' }),
      run({ id: 'q1', status: 'queued', createdAt: '2026-07-14T10:00:00.000Z' }),
      run({ id: 'r', status: 'running' }),
    ]
    const rows = rowsOf(groupRuns(runs, 'active'))
    expect(
      rows.map((row) => (row.kind === 'run' ? [row.run.id, row.queuePosition] : null))
    ).toEqual([
      // FIFO now (the sort), so the rows run in the same order as the numbers they carry —
      // the engine's start order, top to bottom.
      ['r', null],
      ['q1', 1],
      ['q2', 2],
    ])
  })

  describe('variant groups (spec 010)', () => {
    const group = (over: Partial<RunRecord>[]): RunRecord[] =>
      over.map((o) => run({ groupId: 'g1', title: 'Add autocomplete (X)', ...o }))

    it('collapses a groupId into one tile, members ordered by letter', () => {
      const runs = group([
        { id: 'b', variant: 'B', status: 'running', title: 'Add autocomplete (B)' },
        { id: 'c', variant: 'C', status: 'running', title: 'Add autocomplete (C)' },
        { id: 'a', variant: 'A', status: 'running', title: 'Add autocomplete (A)' },
      ])
      const buckets = groupRuns(runs, 'active')
      expect(shape(buckets)).toEqual(['Working: [ABC]'])

      const row = groupRow(buckets)
      expect(row.groupId).toBe('g1')
      // The shared title, without any variant's suffix.
      expect(row.title).toBe('Add autocomplete')
      expect(row.members).toHaveLength(3)
    })

    it('places the tile where its best-ranked member would sit — the group moves as a unit', () => {
      const runs = [
        ...group([
          { id: 'a', variant: 'A', status: 'running', title: 'Add autocomplete (A)' },
          { id: 'b', variant: 'B', status: 'waiting', title: 'Add autocomplete (B)' },
        ]),
        run({ id: 'other', status: 'running' }),
      ]
      // B is waiting, so the whole tile is under "Needs you" — it does not tear in half with A
      // left behind under Working.
      expect(shape(groupRuns(runs, 'active'))).toEqual(['Needs you: [AB]', 'Working: other'])
    })

    it('renders a lone survivor as a plain row, not a one-member group', () => {
      // What the "pick a winner" flow leaves behind: the winner keeps its groupId forever.
      const runs = group([{ id: 'winner', variant: 'A', status: 'done', title: 'Add autocomplete (A)' }])
      expect(shape(groupRuns(runs, 'active'))).toEqual(['Recent: winner'])
    })

    it('does not pull members across the view filter', () => {
      const runs = group([
        { id: 'a', variant: 'A', status: 'done', title: 'Add autocomplete (A)' },
        { id: 'b', variant: 'B', status: 'done', title: 'Add autocomplete (B)', archived: true },
      ])
      // One active member left → a plain row, and the archived one is not smuggled into its tile.
      expect(shape(groupRuns(runs, 'active'))).toEqual(['Recent: a'])
      expect(shape(groupRuns(runs, 'archived'))).toEqual(['Archived: b'])
    })

    it('emits each group once, however many members it has', () => {
      const runs = [
        ...group([
          { id: 'a', variant: 'A', status: 'done', title: 'Add autocomplete (A)' },
          { id: 'b', variant: 'B', status: 'done', title: 'Add autocomplete (B)' },
          { id: 'c', variant: 'C', status: 'done', title: 'Add autocomplete (C)' },
        ]),
      ]
      expect(rowsOf(groupRuns(runs, 'active'))).toHaveLength(1)
    })

    it('keeps separate groups separate', () => {
      const runs = [
        run({ id: 'a1', groupId: 'g1', variant: 'A', status: 'running', title: 'One (A)' }),
        run({ id: 'a2', groupId: 'g1', variant: 'B', status: 'running', title: 'One (B)' }),
        run({ id: 'b1', groupId: 'g2', variant: 'A', status: 'running', title: 'Two (A)' }),
        run({ id: 'b2', groupId: 'g2', variant: 'B', status: 'running', title: 'Two (B)' }),
      ]
      const rows = rowsOf(groupRuns(runs, 'active'))
      expect(rows).toHaveLength(2)
      expect(rows.map((row) => (row.kind === 'group' ? row.title : row.run.id))).toEqual(['One', 'Two'])
    })
  })

  it('handles an empty list', () => {
    expect(groupRuns([], 'active')).toEqual([])
    expect(groupRuns([], 'archived')).toEqual([])
  })
})

describe('runTitle — the one name every surface shows', () => {
  it.each([
    {
      label: 'the auto-summary wins over the raw title once a turn produced one',
      over: { title: 'fix the login bug plz', titleSummary: 'Catch AuthError in the login handler' },
      expected: 'Catch AuthError in the login handler',
    },
    {
      label: 'no summary yet (or a pre-R2 record) → the raw title, honestly',
      over: { title: 'fix the login bug plz' },
      expected: 'fix the login bug plz',
    },
    {
      label: 'a user edit set BOTH fields (PATCH /api/v1/runs/:id), so the edit is what shows',
      over: { title: 'Login 500 fix', titleSummary: 'Login 500 fix' },
      expected: 'Login 500 fix',
    },
    {
      label: 'legacy concatenated narration falls back without rewriting persisted state',
      over: {
        title: '469: /om-auto-review-pr',
        titleSummary: 'Loading the pipeline config and tracker descriptor, then claim PR #469.Config loaded',
      },
      expected: '469: /om-auto-review-pr',
    },
    {
      label: 'user-owned titles preserve punctuation byte-for-byte',
      over: {
        title: 'Release v2.Config migration',
        titleSummary: 'Release v2.Config migration',
        titleOrigin: 'user' as const,
      },
      expected: 'Release v2.Config migration',
    },
    {
      label: 'marker-owned titles preserve punctuation byte-for-byte',
      over: {
        title: 'raw task',
        titleSummary: 'Testing SDK.Config support',
        titleOrigin: 'marker' as const,
      },
      expected: 'Testing SDK.Config support',
    },
    {
      label: 'well-formed identifiers and acronyms remain untouched',
      over: { title: 'raw task', titleSummary: 'updating README.md for OAuth2' },
      expected: 'updating README.md for OAuth2',
    },
  ])('$label', ({ over, expected }) => {
    expect(runTitle(run(over))).toBe(expected)
  })
})

describe('listCounts', () => {
  it('counts active, archived, and the runs that want you', () => {
    const runs = [
      run({ status: 'running' }),
      run({ status: 'waiting' }),
      run({ status: 'review' }),
      run({ status: 'failed' }),
      run({ status: 'done', archived: true }),
      run({ status: 'waiting', archived: true }),
    ]
    // The archived `waiting` counts as archived only — an archived run is not asking for you.
    expect(listCounts(runs)).toEqual({ active: 4, archived: 2, waiting: 2 })
  })

  it('is all zeroes for an empty list', () => {
    expect(listCounts([])).toEqual({ active: 0, archived: 0, waiting: 0 })
  })
})
