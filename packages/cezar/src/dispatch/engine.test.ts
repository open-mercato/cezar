import { describe, expect, it } from 'vitest';
import type { RunRecord } from '../runs/store.ts';
import {
  MAX_CHILDREN_IN_FLIGHT,
  MAX_PENDING_REPORTS,
  childSettleReport,
  childTaskEnvelope,
  childrenOf,
  handoffSectionExcerpt,
  inFlightChildren,
  isTerminalStatus,
  pendingReportsBlock,
  remainingBudgetUsd,
  withPendingReport,
} from './engine.ts';

/**
 * The arithmetic and the prose behind task dispatch (spec 2026-09-10-dispatch). Pure
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

describe('the settled statuses', () => {
  it('counts every settled status as terminal — a cancelled child still owes a report', () => {
    for (const status of ['done', 'review', 'failed', 'cancelled']) expect(isTerminalStatus(status)).toBe(true);
    for (const status of ['queued', 'running', 'waiting']) expect(isTerminalStatus(status)).toBe(false);
    expect(MAX_CHILDREN_IN_FLIGHT).toBe(4);
  });
});

describe('remainingBudgetUsd', () => {
  const parent = (budgetUsd: number | undefined, costUsd?: number): RunRecord =>
    record({ id: 'p', costUsd, dispatch: budgetUsd === undefined ? { rootRunId: 'm' } : { rootRunId: 'm', budgetUsd } });

  it('is undefined for an uncapped commander — no ceiling is the pre-existing behaviour', () => {
    expect(remainingBudgetUsd(parent(undefined), [])).toBeUndefined();
  });

  it('subtracts what is spent AND what is already promised to children', () => {
    const children = [
      record({ id: 'c1', dispatch: { rootRunId: 'm', parentRunId: 'p', budgetUsd: 3 } }),
      record({ id: 'c2', dispatch: { rootRunId: 'm', parentRunId: 'p', budgetUsd: 2 } }),
    ];
    expect(remainingBudgetUsd(parent(10, 1.5), children)).toBeCloseTo(3.5);
  });

  it('goes negative rather than clamping — an overspent commander must read as overspent', () => {
    expect(remainingBudgetUsd(parent(1, 4), [])).toBeCloseTo(-3);
  });

  it('counts a child with no ceiling of its own as promising nothing', () => {
    const children = [record({ id: 'c1', dispatch: { rootRunId: 'm', parentRunId: 'p' } })];
    expect(remainingBudgetUsd(parent(5, 1), children)).toBeCloseTo(4);
  });

  /**
   * Audit R3: three commanders lost their final child to a refusal that fired while real budget
   * remained, because a settled child's reservation was never released. A settled child is charged
   * what it spent; one still in flight keeps reserving its ceiling.
   */
  it('releases a settled child’s unspent reservation and keeps an in-flight child’s whole ceiling', () => {
    const children = [
      record({ id: 'done', status: 'done', costUsd: 1.6, dispatch: { rootRunId: 'm', parentRunId: 'p', budgetUsd: 2.5 } }),
      record({ id: 'live', status: 'running', costUsd: 0.4, dispatch: { rootRunId: 'm', parentRunId: 'p', budgetUsd: 2.5 } }),
    ];
    // 10 − 1 (own) − 1.6 (settled, actual) − 2.5 (in flight, reserved)
    expect(remainingBudgetUsd(parent(10, 1), children)).toBeCloseTo(4.9);
  });

  it('charges a settled child with no recorded cost its full ceiling — a data gap never under-charges', () => {
    const children = [record({ id: 'c1', status: 'failed', dispatch: { rootRunId: 'm', parentRunId: 'p', budgetUsd: 2 } })];
    expect(remainingBudgetUsd(parent(5, 0), children)).toBeCloseTo(3);
  });
});

describe('childTaskEnvelope', () => {
  it('spells out a review task’s kind and what it reviews', () => {
    const text = childTaskEnvelope(
      { title: 'Review the left flank', objective: 'judge it', kind: 'review', review_of: ['cez/abcd1234'] },
      { id: 'p' },
    );
    expect(text).toContain('- Kind: review');
    expect(text).toContain('you do not implement it');
    expect(text).toContain('- Review of: cez/abcd1234');
    // an implementer's order says nothing about kind — the pre-existing envelope
    expect(childTaskEnvelope({ title: 't', objective: 'o' }, { id: 'p' })).not.toContain('Kind:');
  });


  it('lists only the fields the order actually carries, plus the fork point and the commander', () => {
    const text = childTaskEnvelope(
      { title: 'Left flank', objective: 'take the left half', scope: 'src/left/**', max_cost: 2.5 },
      { id: 'p1', branch: 'cez/abc12345' },
    );
    expect(text.startsWith('take the left half')).toBe(true);
    expect(text).toContain('## Task order');
    expect(text).toContain('- Scope: src/left/**');
    expect(text).toContain('- Max cost: $2.50');
    expect(text).toContain('- Parent branch (your fork point): cez/abc12345');
    expect(text).toContain('- Ordered by: run p1');
    // Nothing invented for the keys the commander left out.
    expect(text).not.toContain('Success criteria');
    expect(text).not.toContain('Retry limit');
  });

  it('omits the fork point for a commander running in the repository working tree', () => {
    const text = childTaskEnvelope({ title: 't', objective: 'o' }, { id: 'p1' });
    expect(text).not.toContain('Parent branch');
    expect(text).toContain('- Ordered by: run p1');
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
      dispatch: {
        rootRunId: 'm',
        parentRunId: 'p',
        report: {
          status: 'partial',
          result: 'half of it landed',
          evidence: ['npm test → 4 passed'],
          side_effects: [],
          errors: ['the other half needs a decision'],
          suggestions: [],
        },
      },
    });
    const { text, report } = childSettleReport(child);
    expect(report.status).toBe('partial'); // the child's own words, not cezar's status
    expect(text).toContain('Report from task "Left flank"');
    expect(text).toContain('branch cez/9999 off cez/parent');
    expect(text).toContain('status partial (cezar: done)');
    expect(text).toContain('evidence: npm test → 4 passed');
    expect(text).toContain('errors: the other half needs a decision');
    expect(text).toContain('cost $0.42');
    expect(text).toContain('diff 2 files, +12 -3');
  });

  it('still reports for a child that never emitted one — silence is indistinguishable from working', () => {
    const cancelled = childSettleReport(record({ status: 'cancelled', branch: 'cez/1' }), {
      resumeNotes: 'was halfway through the migration',
    });
    expect(cancelled.report.status).toBe('blocked'); // stopped, not failed
    expect(cancelled.report.result).toBe('was halfway through the migration');

    const failed = childSettleReport(record({ status: 'failed', error: 'engine crashed' }));
    expect(failed.report.status).toBe('failed');
    expect(failed.report.errors).toEqual(['engine crashed']);
    expect(failed.text).toContain('no branch — it ran in the repository working tree');

    const silent = childSettleReport(record({ status: 'done' }));
    expect(silent.report.result).toContain('no structured report');
  });

  /**
   * The Guard's premise (spec Q4): a run that settled while parked on its own question was
   * BLOCKED, whatever cezar's terminal status says — a restart force-settles `waiting` as `done`,
   * and reporting that upward as success is exactly the lie the pending question exists to stop.
   */
  it('reports an unanswered question as blocked, naming it — even when cezar says done', () => {
    const asking = childSettleReport(
      record({
        status: 'done',
        dispatch: {
        rootRunId: 'm',
          parentRunId: 'p',
          pendingAsk: { questions: ['Delete the old migration?'], askedAt: '2026-09-09T10:00:00.000Z' },
        },
      }),
      { resumeNotes: 'about to clean up' },
    );
    expect(asking.report.status).toBe('blocked');
    expect(asking.report.result).toContain('Delete the old migration?');
    expect(asking.report.result).toContain('before a reply arrived');
    expect(asking.text).toContain('status blocked (cezar: done)');
  });

  it('lets the child’s own report win over a stale pending question', () => {
    const own = childSettleReport(
      record({
        status: 'done',
        dispatch: {
        rootRunId: 'm',
          parentRunId: 'p',
          pendingAsk: { questions: ['old?'], askedAt: '2026-09-09T10:00:00.000Z' },
          report: { status: 'done', result: 'answered and finished', evidence: [], side_effects: [], errors: [], suggestions: [] },
        },
      }));
    expect(own.report.status).toBe('done');
  });
});

describe('pending reports', () => {
  const entry = (n: number) => ({
    fromRunId: `c${n}`,
    title: `child ${n}`,
    report: { status: 'done' as const, result: `r${n}`, evidence: [], side_effects: [], errors: [], suggestions: [] },
    at: '2026-09-08T10:00:00.000Z',
  });

  it('keeps the newest, bounded — the list is flushed into a prompt, not a log', () => {
    const unit = { rootRunId: 'm' };
    let carrier: ReturnType<typeof withPendingReport> = unit;
    for (let i = 0; i < MAX_PENDING_REPORTS + 3; i += 1) carrier = withPendingReport(carrier, entry(i));
    expect(carrier.pendingReports).toHaveLength(MAX_PENDING_REPORTS);
    expect(carrier.pendingReports?.[0]?.fromRunId).toBe('c3'); // the three oldest fell off
  });

  it('renders as prose a commander reads, and nothing at all when there is none', () => {
    expect(pendingReportsBlock([])).toBeUndefined();
    const block = pendingReportsBlock([entry(1)]);
    expect(block).toContain('## Reports from your dispatched tasks');
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
