import { describe, expect, it } from 'vitest'

import type { LandingCheck, RunEvent } from '@open-mercato/cezar-api-client'

import {
  humanizeLandingReason,
  landingCheckChip,
  landingCheckNotRun,
  landingCheckRows,
  landingSubjectFacts,
} from './landing-check'

function check(over: Partial<LandingCheck> = {}): LandingCheck {
  return {
    ofRunId: 'parent',
    subject: {
      baseRef: 'cez/parent',
      baseSha: 'a'.repeat(40),
      sources: [{ ref: 'cez/child', sha: 'b'.repeat(40) }],
      order: 'ledger',
    },
    ...over,
  }
}

let seq = 0
function output(over: Record<string, unknown>): RunEvent {
  seq += 1
  return { seq, ts: '2026-09-29T10:00:00.000Z', type: 'check-output', ...over }
}

describe('landingCheckChip — every state the record can produce', () => {
  it('renders nothing for a run that is not a check', () => {
    expect(landingCheckChip({ landingCheck: undefined })).toBeUndefined()
  })

  it('a subject-only record on a live run is `checking`, pulsing and pending', () => {
    const chip = landingCheckChip({ status: 'running', landingCheck: check() })
    expect(chip).toMatchObject({ state: 'checking', tone: 'pending', pulse: true, stale: false })
    expect(chip?.verdict).toBeUndefined()
  })

  it('a subject-only record on a QUEUED run is still `checking` — it has not even started', () => {
    expect(landingCheckChip({ status: 'queued', landingCheck: check() })?.state).toBe('checking')
  })

  it('a terminal run with no verdict never pulses `checking` forever — it could not run', () => {
    const chip = landingCheckChip({ status: 'failed', landingCheck: check() })
    expect(chip).toMatchObject({ state: 'could-not-run', pulse: false })
    expect(chip?.title).toContain('without a verdict')
  })

  it('only a passed verdict is green; nothing-to-check is neutral and could-not-run is pending', () => {
    const states = [
      ['passed', 'success'],
      ['failed', 'danger'],
      ['conflict', 'danger'],
      ['nothing-to-check', 'neutral'],
      ['could-not-run', 'pending'],
    ] as const
    for (const [verdict, tone] of states) {
      const chip = landingCheckChip({ status: 'done', landingCheck: check({ verdict }) })
      expect(chip).toMatchObject({ state: verdict, verdict, tone, stale: false })
    }
    for (const verdict of ['nothing-to-check', 'could-not-run'] as const) {
      expect(landingCheckChip({ status: 'done', landingCheck: check({ verdict }) })?.tone).not.toBe('success')
    }
  })

  it('a stale verdict keeps its label and reports the read-time marker', () => {
    const chip = landingCheckChip({
      status: 'done',
      landingCheck: check({ verdict: 'passed' }),
      landingCheckStale: true,
    })
    expect(chip).toMatchObject({ state: 'stale', verdict: 'passed', label: 'passed', stale: true, tone: 'success' })
    expect(chip?.title).toContain('passed')
    expect(chip?.title).toContain('moved since')
  })

  it('carries the reason, humanized, in the tooltip', () => {
    const chip = landingCheckChip({
      status: 'done',
      landingCheck: check({ verdict: 'nothing-to-check', reason: 'commands-changed-vs-base' }),
    })
    expect(chip?.title).toContain('commands changed vs base')
  })
})

describe('landingCheckRows — install, then the gate commands, in execution order', () => {
  it('joins each row to its own check-output tail, matched by command and consumed in order', () => {
    const rows = landingCheckRows(
      check({
        install: { argv: ['npm', 'ci'], exitCode: 0, outcome: 'passed' },
        results: [
          { command: 'npm test', exitCode: 0, outcome: 'passed', startedAt: 't1' },
          { command: 'npm run lint', exitCode: 2, outcome: 'failed', startedAt: 't2' },
        ],
      }),
      [
        output({ command: 'npm ci', exitCode: 0, text: 'added 476 packages', status: 'passed' }),
        output({ command: 'npm test', exitCode: 0, text: '72 passing', status: 'passed' }),
        output({ command: 'npm run lint', exitCode: 2, text: '2 problems', status: 'failed' }),
      ],
    )
    expect(rows.map((row) => [row.kind, row.command, row.outcome, row.exitCode, row.output])).toEqual([
      ['install', 'npm ci', 'passed', 0, 'added 476 packages'],
      ['command', 'npm test', 'passed', 0, '72 passing'],
      ['command', 'npm run lint', 'failed', 2, '2 problems'],
    ])
  })

  it('a command that ran twice takes the two events in order, never the same tail twice', () => {
    const rows = landingCheckRows(
      check({
        results: [
          { command: 'npm test', exitCode: 1, outcome: 'failed', startedAt: 't1' },
          { command: 'npm test', exitCode: 0, outcome: 'passed', startedAt: 't2' },
        ],
      }),
      [
        output({ command: 'npm test', exitCode: 1, text: 'first run failed' }),
        output({ command: 'npm test', exitCode: 0, text: 'second run green' }),
      ],
    )
    expect(rows.map((row) => row.output)).toEqual(['first run failed', 'second run green'])
  })

  it('a row with no matching event keeps its exit code and outcome — the tail is simply absent', () => {
    const rows = landingCheckRows(
      check({
        results: [
          { command: 'npm test', exitCode: 0, outcome: 'passed', startedAt: 't1' },
          { command: 'npm run lint', exitCode: null, outcome: 'not-run', startedAt: 't2' },
        ],
      }),
      [output({ command: 'npm test', exitCode: 0, text: 'ok' })],
    )
    expect(rows[1]).toMatchObject({ command: 'npm run lint', outcome: 'not-run', exitCode: null })
    expect(rows[1]!.output).toBeUndefined()
  })

  it('a conflict at merge time has no install and no results — no rows at all', () => {
    expect(landingCheckRows(check({ verdict: 'conflict', reason: 'merge-conflict' }), [])).toEqual([])
  })

  it('drops non check-output events and events without a command', () => {
    const rows = landingCheckRows(check({ results: [{ command: 'npm test', exitCode: 0, outcome: 'passed', startedAt: 't' }] }), [
      { seq: 1, ts: 't', type: 'note', message: 'subject frozen' },
      { seq: 2, ts: 't', type: 'check-output', text: 'no command key' },
      output({ command: 'npm test', exitCode: 0, text: 'ok' }),
    ])
    expect(rows[0]!.output).toBe('ok')
  })
})

describe('landingCheckNotRun — commands the engine stopped before running', () => {
  const steps = [
    { id: 'check-1', name: 'npm test', kind: 'check' as const, status: 'failed' as const, iterations: 1, tokensUsed: 0 },
    { id: 'check-2', name: 'npm run lint', kind: 'check' as const, status: 'pending' as const, iterations: 0, tokensUsed: 0 },
    { id: 'install', name: 'install (npm ci)', kind: 'check' as const, status: 'done' as const, iterations: 1, tokensUsed: 0 },
  ]

  it('counts pending gate steps on a terminal run, never the install step', () => {
    expect(landingCheckNotRun({ status: 'failed', steps })).toBe(1)
  })

  it('is zero while the run is still live — pending there means "not yet"', () => {
    expect(landingCheckNotRun({ status: 'running', steps })).toBe(0)
  })
})

describe('landingSubjectFacts', () => {
  it('names the base, the sources, the tree and every exclusion', () => {
    const facts = landingSubjectFacts(
      check({
        subject: {
          baseRef: 'cez/parent',
          baseSha: 'a'.repeat(40),
          sources: [
            { ref: 'cez/one', sha: 'b'.repeat(40) },
            { ref: 'cez/two', sha: 'c'.repeat(40) },
          ],
          order: 'ledger',
          treeSha: 'd'.repeat(40),
          excluded: [
            { runId: '12345678-aaaa-bbbb-cccc-ddddeeeeffff', reason: 'empty' },
            { runId: '87654321-aaaa-bbbb-cccc-ddddeeeeffff', reason: 'review' },
          ],
        },
      }),
    )
    expect(facts).toMatchObject({ baseRef: 'cez/parent', sourceCount: 2, treeSha: 'd'.repeat(40) })
    expect(facts.sourceRefs).toEqual(['cez/one', 'cez/two'])
    expect(facts.excluded).toEqual(['12345678 (empty)', '87654321 (review)'])
  })

  it('humanizes reason slugs', () => {
    expect(humanizeLandingReason('commands-changed-vs-base')).toBe('commands changed vs base')
    expect(humanizeLandingReason('dry-run')).toBe('dry run')
  })
})
