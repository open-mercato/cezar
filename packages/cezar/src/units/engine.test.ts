import { describe, expect, it } from 'vitest';
import type { RunRecord } from '../runs/store.ts';
import {
  CHILD_ROLE,
  MAX_PENDING_REPORTS,
  childSettleReport,
  childTaskEnvelope,
  handoffSectionExcerpt,
  isTerminalStatus,
  pendingReportsBlock,
  remainingBudgetUsd,
  unitSubagentTools,
  withPendingReport,
} from './engine.ts';

/**
 * The arithmetic and the prose behind the unit engine (spec 2026-09-08-units-hierarchy). Pure
 * functions, so these run in milliseconds and pin the decisions the end-to-end suite
 * (`workflows/units-engine.test.ts`) can only observe through a whole dry run.
 */
const record = (over: Partial<RunRecord> = {}): RunRecord =>
  ({
    id: 'run-1',
    title: 'flank left',
    workflow: '(planned)',
    task: 't',
    status: 'done',
    createdAt: '2026-09-08T10:00:00.000Z',
    steps: [],
    ...over,
  }) as RunRecord;

describe('the ranks', () => {
  it('hands work exactly one rung down, and stops at the centurion', () => {
    expect(CHILD_ROLE.caesar).toBe('legate');
    expect(CHILD_ROLE.legate).toBe('centurion');
    // Not "another centurion", not "a legionary run" — the hierarchy ends here on purpose (Q2).
    expect(CHILD_ROLE.centurion).toBeUndefined();
  });

  it('counts every settled status as terminal — a cancelled child still owes a report', () => {
    for (const status of ['done', 'review', 'failed', 'cancelled']) {
      expect(isTerminalStatus(status)).toBe(true);
    }
    for (const status of ['queued', 'running', 'waiting']) expect(isTerminalStatus(status)).toBe(false);
  });
});

describe('remainingBudgetUsd', () => {
  const parent = (budgetUsd: number | undefined, costUsd?: number): RunRecord =>
    record({ id: 'p', costUsd, unit: budgetUsd === undefined ? { role: 'caesar', missionId: 'm' } : { role: 'caesar', missionId: 'm', budgetUsd } });

  it('is undefined for an uncapped commander — no ceiling is the pre-existing behaviour', () => {
    expect(remainingBudgetUsd(parent(undefined), [])).toBeUndefined();
  });

  it('subtracts what is spent AND what is already promised to children', () => {
    const children = [
      record({ id: 'c1', unit: { role: 'legate', missionId: 'm', parentRunId: 'p', budgetUsd: 3 } }),
      record({ id: 'c2', unit: { role: 'legate', missionId: 'm', parentRunId: 'p', budgetUsd: 2 } }),
    ];
    expect(remainingBudgetUsd(parent(10, 1.5), children)).toBeCloseTo(3.5);
  });

  it('goes negative rather than clamping — an overspent commander must read as overspent', () => {
    expect(remainingBudgetUsd(parent(1, 4), [])).toBeCloseTo(-3);
  });

  it('counts a child with no ceiling of its own as promising nothing', () => {
    const children = [record({ id: 'c1', unit: { role: 'legate', missionId: 'm', parentRunId: 'p' } })];
    expect(remainingBudgetUsd(parent(5, 1), children)).toBeCloseTo(4);
  });
});

describe('childTaskEnvelope', () => {
  it('lists only the fields the order actually carries, plus the fork point and the commander', () => {
    const text = childTaskEnvelope(
      { title: 'Left flank', objective: 'take the left half', scope: 'src/left/**', max_cost: 2.5 },
      { id: 'p1', branch: 'cez/abc12345', role: 'caesar' },
    );
    expect(text.startsWith('take the left half')).toBe(true);
    expect(text).toContain('## Task order');
    expect(text).toContain('- Scope: src/left/**');
    expect(text).toContain('- Max cost: $2.50');
    expect(text).toContain('- Parent branch (your fork point): cez/abc12345');
    expect(text).toContain('- Ordered by: the caesar on run p1');
    // Nothing invented for the keys the commander left out.
    expect(text).not.toContain('Success criteria');
    expect(text).not.toContain('Retry limit');
  });

  it('omits the fork point for a commander running in the repository working tree', () => {
    const text = childTaskEnvelope({ title: 't', objective: 'o' }, { id: 'p1', role: 'legate' });
    expect(text).not.toContain('Parent branch');
    expect(text).toContain('- Ordered by: the legate on run p1');
  });
});

describe('unitSubagentTools', () => {
  it('gives a claude centurion its century and leaves the list alone otherwise', () => {
    expect(unitSubagentTools(['Read'], 'centurion', 'claude')).toEqual(['Read', 'Task', 'Agent']);
    expect(unitSubagentTools(['Read', 'Task'], 'centurion', 'claude')).toEqual(['Read', 'Task', 'Agent']);
    // Commanders delegate through CEZ:SPAWN, not through sub-agents.
    expect(unitSubagentTools(['Read'], 'caesar', 'claude')).toEqual(['Read']);
    // Other backends have no sub-agent tool and ignore allowedTools entirely (#430).
    expect(unitSubagentTools(['Read'], 'centurion', 'codex')).toEqual(['Read']);
    // And a run with no unit is untouched — the whole feature is inert for it.
    expect(unitSubagentTools(['Read'], undefined, 'claude')).toEqual(['Read']);
  });
});

describe('childSettleReport', () => {
  it('reports what the child said, with the branch its parent has to merge', () => {
    const child = record({
      id: 'c9',
      title: 'Left flank',
      status: 'done',
      branch: 'cez/9999',
      baseBranch: 'cez/parent',
      costUsd: 0.42,
      diffStat: { files: 2, adds: 12, dels: 3 },
      unit: {
        role: 'legate',
        missionId: 'm',
        parentRunId: 'p',
        report: {
          status: 'partial',
          result: 'half of it landed',
          evidence: ['npm test → 4 passed'],
          side_effects: [],
          errors: ['the other half needs a decision'],
        },
      },
    });
    const { text, report } = childSettleReport(child, { role: 'legate' });
    expect(report.status).toBe('partial'); // the child's own words, not cezar's status
    expect(text).toContain('Report from legate "Left flank"');
    expect(text).toContain('branch cez/9999 off cez/parent');
    expect(text).toContain('status partial (cezar: done)');
    expect(text).toContain('evidence: npm test → 4 passed');
    expect(text).toContain('errors: the other half needs a decision');
    expect(text).toContain('cost $0.42');
    expect(text).toContain('diff 2 files, +12 -3');
  });

  it('still reports for a child that never emitted one — silence is indistinguishable from working', () => {
    const cancelled = childSettleReport(record({ status: 'cancelled', branch: 'cez/1' }), {
      role: 'centurion',
      resumeNotes: 'was halfway through the migration',
    });
    expect(cancelled.report.status).toBe('blocked'); // stopped, not failed
    expect(cancelled.report.result).toBe('was halfway through the migration');

    const failed = childSettleReport(record({ status: 'failed', error: 'engine crashed' }), { role: 'centurion' });
    expect(failed.report.status).toBe('failed');
    expect(failed.report.errors).toEqual(['engine crashed']);
    expect(failed.text).toContain('no branch — it ran in the repository working tree');

    const silent = childSettleReport(record({ status: 'done' }), { role: 'centurion' });
    expect(silent.report.result).toContain('no structured report');
  });
});

describe('pending reports', () => {
  const entry = (n: number) => ({
    fromRunId: `c${n}`,
    title: `child ${n}`,
    report: { status: 'done' as const, result: `r${n}`, evidence: [], side_effects: [], errors: [] },
    at: '2026-09-08T10:00:00.000Z',
  });

  it('keeps the newest, bounded — the list is flushed into a prompt, not a log', () => {
    let unit = { role: 'caesar' as const, missionId: 'm' };
    let carrier: ReturnType<typeof withPendingReport> = unit;
    for (let i = 0; i < MAX_PENDING_REPORTS + 3; i += 1) carrier = withPendingReport(carrier, entry(i));
    expect(carrier.pendingReports).toHaveLength(MAX_PENDING_REPORTS);
    expect(carrier.pendingReports?.[0]?.fromRunId).toBe('c3'); // the three oldest fell off
  });

  it('renders as prose a commander reads, and nothing at all when there is none', () => {
    expect(pendingReportsBlock([])).toBeUndefined();
    const block = pendingReportsBlock([entry(1)]);
    expect(block).toContain('## Reports from your units');
    expect(block).toContain('"child 1" (c1');
    expect(block).toContain('status done; r1');
  });
});

describe('handoffSectionExcerpt', () => {
  it('reads one section and stops at the next header', () => {
    const text = '# Handoff\n\n## Progress log\n- did a thing\n\n## Resume notes\nhalf done\nnext: the other half\n\n## Later\nignored';
    expect(handoffSectionExcerpt(text, '## Resume notes')).toBe('half done\nnext: the other half');
    expect(handoffSectionExcerpt(text, '## Missing')).toBe('');
  });
});
