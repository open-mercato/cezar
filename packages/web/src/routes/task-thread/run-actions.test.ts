import { describe, expect, it } from 'vitest'

import type { RunRecord, RunStatus, StepState } from '@open-mercato/cezar-api-client'

import { isUnread } from '@/lib/read-state'

import {
  cliTargetResumes,
  finishTitle,
  isRunActive,
  lastSessionId,
  queuePosition,
  resolveConflictsPrompt,
  resumeCommand,
  resumeHint,
  runActionFlags,
} from './run-actions'

const step = (extra: Partial<StepState> = {}): StepState => ({
  id: 'task',
  name: 'Do the task',
  kind: 'agent',
  status: 'done',
  iterations: 1,
  tokensUsed: 0,
  ...extra,
})

const run = (status: RunStatus, extra: Partial<RunRecord> = {}): RunRecord => ({
  id: 'r1',
  title: 'Do the thing',
  workflow: 'quick-task',
  task: 'Do the thing',
  status,
  createdAt: '2026-07-14T12:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  steps: [step({ sessionId: 'sess-1' })],
  ...extra,
})

describe('runActionFlags — the visibility matrix, all 7 statuses × archived', () => {
  // The legacy header's rules verbatim (web/app.js `updateDetail`):
  //   active(running|queued|waiting) → cancel, no delete/archive/continue/terminal;
  //   finish only at the waiting/review gates; continue+terminal need a closed run WITH a
  //   session; notes always. `archived` flips nothing here — it only relabels Archive.
  // `markUnread` (#775) is false in every cell of this matrix because the fixture carries no
  // `finishedAt` — a record with no finish instant can never wear the unread marker, whatever
  // its status says. The flag's real matrix is the FINISHED one in its own describe below.
  const matrix: Array<{ status: RunStatus; expected: Omit<ReturnType<typeof runActionFlags>, 'notes'> }> = [
    { status: 'queued', expected: { finish: false, continueRun: false, terminal: false, archive: false, markUnread: false, cancel: true, deleteRun: false } },
    { status: 'running', expected: { finish: false, continueRun: false, terminal: false, archive: false, markUnread: false, cancel: true, deleteRun: false } },
    { status: 'waiting', expected: { finish: true, continueRun: false, terminal: false, archive: false, markUnread: false, cancel: true, deleteRun: false } },
    { status: 'review', expected: { finish: true, continueRun: true, terminal: true, archive: true, markUnread: false, cancel: false, deleteRun: true } },
    { status: 'done', expected: { finish: false, continueRun: true, terminal: true, archive: true, markUnread: false, cancel: false, deleteRun: true } },
    { status: 'failed', expected: { finish: false, continueRun: true, terminal: true, archive: true, markUnread: false, cancel: false, deleteRun: true } },
    { status: 'cancelled', expected: { finish: false, continueRun: true, terminal: true, archive: true, markUnread: false, cancel: false, deleteRun: true } },
  ]

  it.each(matrix)('$status (live)', ({ status, expected }) => {
    expect(runActionFlags(run(status))).toEqual({ ...expected, notes: true })
  })

  it.each(matrix)('$status (archived — same flags, only the Archive label flips)', ({ status, expected }) => {
    expect(runActionFlags(run(status, { archived: true }))).toEqual({ ...expected, notes: true })
  })

  it('cancel and delete are mutually exclusive in every cell', () => {
    for (const { status } of matrix) {
      for (const archived of [false, true]) {
        const flags = runActionFlags(run(status, { archived }))
        expect(flags.cancel && flags.deleteRun).toBe(false)
      }
    }
  })

  it('continue/terminal need a session — a closed run without one offers neither', () => {
    const flags = runActionFlags(run('failed', { steps: [step()] }))
    expect(flags.continueRun).toBe(false)
    expect(flags.terminal).toBe(false)
    expect(flags.deleteRun).toBe(true)
  })
})

describe('runActionFlags.markUnread — the read→unread affordance (#775)', () => {
  const FINISHED_AT = '2026-08-01T10:00:00.000Z'
  const SEEN_AT = '2026-08-01T10:05:00.000Z'

  /** A run that actually finished, so the read/unread rule has an instant to compare against. */
  const finished = (status: RunStatus, extra: Partial<RunRecord> = {}) =>
    run(status, { finishedAt: FINISHED_AT, ...extra })

  const cases: Array<{ name: string; record: RunRecord; expected: boolean }> = [
    // Offered: a finished run you have already read is exactly what you might want back.
    { name: 'read done run', record: finished('done', { seenAt: SEEN_AT }), expected: true },
    { name: 'read failed run', record: finished('failed', { seenAt: SEEN_AT }), expected: true },
    // Not offered: it is already unread, so the action would be a no-op the UI shouldn't advertise.
    { name: 'never-seen done run', record: finished('done'), expected: false },
    { name: 'done run with a stale receipt (resumed and re-finished)', record: finished('done', { seenAt: '2026-08-01T09:00:00.000Z' }), expected: false },
    // Not offered: these can never wear the marker, so unreading them would change nothing visible.
    { name: 'cancelled run — self-initiated, never unread', record: finished('cancelled', { seenAt: SEEN_AT }), expected: false },
    { name: 'archived run — a stronger "handled" than reading', record: finished('done', { seenAt: SEEN_AT, archived: true }), expected: false },
    { name: 'review gate — not a finished done item', record: finished('review', { seenAt: SEEN_AT }), expected: false },
    { name: 'done status caught mid-transition, no finishedAt', record: run('done', { seenAt: SEEN_AT }), expected: false },
    // Not offered: a usage-limit failure with a resume booked is not a done item — it has an
    // appointment to continue, so there is no outcome to push back into the unread list.
    { name: 'failed run waiting out a usage limit', record: finished('failed', { seenAt: SEEN_AT, autoResumeAt: '2026-08-03T19:33:53.000Z' }), expected: false },
  ]

  for (const status of ['queued', 'running', 'waiting'] as RunStatus[]) {
    cases.push({ name: `${status} — still active`, record: run(status, { seenAt: SEEN_AT }), expected: false })
  }

  it.each(cases)('$name → $expected', ({ record, expected }) => {
    expect(runActionFlags(record).markUnread).toBe(expected)
  })

  it('never offers both marker directions at once', () => {
    // The flag is the complement of "already unread" within the eligible set, so a row can
    // never simultaneously wear the violet marker AND offer to be put back into it.
    for (const { record } of cases) {
      expect(runActionFlags(record).markUnread && isUnread(record)).toBe(false)
    }
  })
})

describe('isRunActive', () => {
  it.each([
    ['queued', true],
    ['running', true],
    ['waiting', true],
    ['review', false],
    ['done', false],
    ['failed', false],
    ['cancelled', false],
  ] as Array<[RunStatus, boolean]>)('%s → %s', (status, expected) => {
    expect(isRunActive(status)).toBe(expected)
  })
})

describe('lastSessionId', () => {
  it('takes the LATEST step that carries a session, not the first', () => {
    const record = run('done', {
      steps: [step({ id: 'a', sessionId: 'old' }), step({ id: 'b' }), step({ id: 'c', sessionId: 'new' })],
    })
    expect(lastSessionId(record)).toBe('new')
  })

  it('is undefined when no step ever opened a session', () => {
    expect(lastSessionId(run('done', { steps: [step()] }))).toBeUndefined()
  })
})

describe('resumeCommand — per backend, mirroring the server', () => {
  it.each([
    ['claude', 'claude --resume s1'],
    [undefined, 'claude --resume s1'], // legacy records predate the runner choice
    ['codex', 'codex resume s1'],
    ['opencode', 'opencode --session s1'],
  ] as Array<[RunRecord['runner'], string]>)('%s → %s', (runner, expected) => {
    expect(resumeCommand(runner, 's1')).toBe(expected)
  })

  // #431: the hint is a one-click copy for pasting into a shell, so the id gets the server's
  // validation rather than being trusted — the server refuses these ids too (server.ts).
  it('refuses a hostile-shaped id instead of building a pasteable command', () => {
    expect(resumeCommand('claude', '$(touch /tmp/pwn); rm -rf ~ #')).toBeUndefined()
    expect(resumeCommand('claude', "a'b")).toBeUndefined()
    expect(resumeCommand('codex', 'a && calc.exe')).toBeUndefined()
    expect(resumeCommand('opencode', 'a`id`')).toBeUndefined()
    expect(resumeCommand('claude', 'a b')).toBeUndefined()
    expect(resumeCommand('claude', '')).toBeUndefined()
  })

  it('refuses an option-like id — `--resume -x` would be read as a flag', () => {
    expect(resumeCommand('claude', '-x')).toBeUndefined()
    expect(resumeCommand('claude', '--help')).toBeUndefined()
  })

  it('accepts the shapes the backends actually mint', () => {
    for (const id of ['9f8e7d6c-1234-4abc-9def-0123456789ab', 'ses_01JABCDEF', 'session.2026-07-17']) {
      expect(resumeCommand('claude', id)).toBe(`claude --resume ${id}`)
    }
  })

  it('bounds the id length, like the server', () => {
    expect(resumeCommand('claude', 'a'.repeat(200))).toBe(`claude --resume ${'a'.repeat(200)}`)
    expect(resumeCommand('claude', 'a'.repeat(201))).toBeUndefined()
  })
})

describe('resumeHint', () => {
  it('cd-prefixes into the worktree when the run has one', () => {
    expect(resumeHint(run('failed', { worktreePath: '/tmp/wt', runner: 'codex' }))).toBe(
      'cd /tmp/wt && codex resume sess-1',
    )
  })

  it('is just the resume command for a run without a worktree', () => {
    expect(resumeHint(run('done'))).toBe('claude --resume sess-1')
  })

  it('is absent while the engine still owns the run, and absent without a session', () => {
    expect(resumeHint(run('waiting'))).toBeUndefined()
    expect(resumeHint(run('done', { steps: [step()] }))).toBeUndefined()
  })

  // #431: no copyable line at all beats one that runs an injected command on paste.
  it('is absent for a session id the server would refuse, worktree or not', () => {
    const hostile = { steps: [step({ sessionId: 'x; rm -rf ~ #' })] }
    expect(resumeHint(run('done', hostile))).toBeUndefined()
    expect(resumeHint(run('failed', { ...hostile, worktreePath: '/tmp/wt' }))).toBeUndefined()
  })
})

describe('cliTargetResumes — Open in… menu labeling (#402)', () => {
  it.each([
    ['claude', 'cli:claude'],
    ['codex', 'cli:codex'],
    ['opencode', 'cli:opencode'],
  ] as Array<[RunRecord['runner'], string]>)('%s CLI resumes a %s run with a session', (runner, target) => {
    expect(cliTargetResumes(run('done', { runner }), target)).toBe(true)
  })

  it('a legacy run with no runner recorded resumes as Claude (pre-runner-choice default)', () => {
    expect(cliTargetResumes(run('done', { runner: undefined }), 'cli:claude')).toBe(true)
  })

  it('cross-runner: a CLI that is not the run\'s own never claims to resume', () => {
    expect(cliTargetResumes(run('done', { runner: 'claude' }), 'cli:codex')).toBe(false)
    expect(cliTargetResumes(run('done', { runner: 'opencode' }), 'cli:claude')).toBe(false)
  })

  it('no session yet: even the matching CLI does not claim to resume', () => {
    expect(cliTargetResumes(run('done', { runner: 'codex', steps: [step()] }), 'cli:codex')).toBe(false)
  })

  it('non-CLI targets (editors, Finder, terminal) never resume', () => {
    expect(cliTargetResumes(run('done', { runner: 'claude' }), 'vscode')).toBe(false)
    expect(cliTargetResumes(run('done', { runner: 'claude' }), 'finder')).toBe(false)
    expect(cliTargetResumes(run('done', { runner: 'claude' }), 'terminal')).toBe(false)
  })

  // The engine seeds `sessionId` the moment an agent step starts, so an ACTIVE run carries both
  // a runner and a session — the match check alone would offer to resume the live transcript and
  // attach a second CLI to it.
  it.each(['running', 'queued', 'waiting'] as RunStatus[])(
    'a %s run never resumes — the engine still owns the session',
    (status) => {
      expect(cliTargetResumes(run(status, { runner: 'claude' }), 'cli:claude')).toBe(false)
    },
  )

  it.each(['done', 'failed', 'cancelled', 'review'] as RunStatus[])(
    'a %s run resumes again once the engine has let go',
    (status) => {
      expect(cliTargetResumes(run(status, { runner: 'claude' }), 'cli:claude')).toBe(true)
    },
  )
})

describe('finishTitle', () => {
  it('review reads as accepting, everything else as closing the session', () => {
    expect(finishTitle('review')).toBe('Accept the changes without a PR')
    expect(finishTitle('waiting')).toBe('Close the session')
  })
})

describe('resolveConflictsPrompt', () => {
  it('names the pull request, because a task can point at more than one', () => {
    // The reason the number is in the words at all (#901: the PR a task opened AND the PR it is
    // about both get chips). Told to "resolve the conflicts" with no number, the agent picks one
    // at even odds — and half the time it is not the chip the user pressed.
    expect(resolveConflictsPrompt(534)).toBe('Merge head branch and resolve conflicts in PR number 534')
    expect(resolveConflictsPrompt(902)).toContain('PR number 902')
  })

  it('still reads as a sentence for a reference with no number', () => {
    // `taskPrUrl`'s tolerance: a forge whose PR URLs do not end in a number still gets a chip.
    expect(resolveConflictsPrompt()).toBe('Merge head branch and resolve conflicts in this pull request')
  })
})

describe('queuePosition — the legacy FIFO math (web/app.js), 1-based among queued unarchived runs', () => {
  const queued = (id: string, createdAt: string, extra: Partial<RunRecord> = {}) =>
    run('queued', { id, createdAt, ...extra })

  it('orders by createdAt, skipping non-queued and archived runs', () => {
    const runs = [
      run('running', { id: 'busy' }),
      queued('second', '2026-07-14T12:05:00.000Z'),
      queued('first', '2026-07-14T12:01:00.000Z'),
      queued('parked', '2026-07-14T12:00:00.000Z', { archived: true }),
    ]
    expect(queuePosition(runs, 'first')).toBe(1)
    expect(queuePosition(runs, 'second')).toBe(2)
  })

  it('is undefined for a run the queue does not hold (not queued, or list not loaded yet)', () => {
    expect(queuePosition([run('running', { id: 'busy' })], 'busy')).toBeUndefined()
    expect(queuePosition([], 'anything')).toBeUndefined()
  })
})
