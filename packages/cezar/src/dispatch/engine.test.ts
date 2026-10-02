import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStore, type RunRecord } from '../runs/store.ts';
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
  scopeVerdict,
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

  it('keeps the reservation when a stored zero aggregate includes an unreported executed step', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-dispatch-cost-'));
    const store = RunStore.open(dir);
    try {
      const child = store.createRun({
        title: 'Partial costs', task: 't', workflow: 'build',
        steps: [
          { id: 'a', name: 'A', kind: 'agent' },
          { id: 'b', name: 'B', kind: 'agent' },
          { id: 'unused', name: 'Unused', kind: 'agent' },
        ],
      });
      child.status = 'done';
      child.dispatch = { rootRunId: 'p', parentRunId: 'p', budgetUsd: 2 };
      store.updateStep(child.id, 'a', { iterations: 1, costUsd: 0 });
      store.updateStep(child.id, 'b', { iterations: 1, tokensUsed: 10000 });
      expect(child.costUsd).toBe(0); // Keep the dashboard's reported amount truthful.
      expect(remainingBudgetUsd(parent(5, 0), [child])).toBe(3);
      store.flush();
      expect(remainingBudgetUsd(parent(5, 0), [RunStore.open(dir).getRun(child.id)!])).toBe(3);
      store.updateStep(child.id, 'b', { costUsd: 0 });
      expect(remainingBudgetUsd(parent(5, 0), [child])).toBe(3);
      child.status = 'running';
      expect(remainingBudgetUsd(parent(5, 0), [child])).toBe(3);
    } finally {
      store.flush();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a settled child’s reservation for zero reports with unknown completeness', () => {
    const child = record({ id: 'c1', status: 'done', dispatch: { rootRunId: 'm', parentRunId: 'p', budgetUsd: 2 } });
    expect(remainingBudgetUsd(parent(5, 0), [child])).toBe(3);
    expect(remainingBudgetUsd(parent(5, 0), [{ ...child, costUsd: 0 }])).toBe(3);
    expect(remainingBudgetUsd(parent(5, 0), [{ ...child, status: 'running', costUsd: 0 }])).toBe(3);
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

  it('says what a retry limit means, since the engine enforces it', () => {
    const text = childTaskEnvelope({ objective: 'x', retry_limit: 1 }, { id: 'p1' });
    expect(text).toContain('- Retry limit: 1 (cezar continues you after an unfinished turn at most 1 time, then parks you)');
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
    expect(text).not.toContain('scope check');
  });

  it('attaches the engine’s scope verdict to the report the parent reads', () => {
    const { text } = childSettleReport(
      record({ dispatch: { rootRunId: 'm', parentRunId: 'p', scope: 'src/', scopeCheck: 'scope check: 1 of 2 changed files outside the declared scope: x.ts' } }),
    );
    expect(text.endsWith('; scope check: 1 of 2 changed files outside the declared scope: x.ts')).toBe(true);
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

  /**
   * The retry cap parks a run `waiting`; the idle timeout then settles it. Before this, the
   * fallback report read `done` and the parent was invited to merge work nobody finished.
   */
  it('reports a retry-cap park as partial, never as the success the ceiling is not', () => {
    const limited = childSettleReport(
      record({
        status: 'failed',
        error: 'the retry limit stopped cezar auto-continuing before the task finished — continue it to keep going',
        dispatch: { rootRunId: 'm', parentRunId: 'p', retryLimit: 1, retryLimitReached: true },
      }),
      { resumeNotes: 'half the migration done' },
    );
    expect(limited.report.status).toBe('partial');
    expect(limited.report.result).toContain('retry limit stopped cezar');
    expect(limited.text).toContain('status partial (cezar: failed)');
  });

  it('leaves a child that names a retry limit without hitting it on the ordinary status mapping', () => {
    const completed = childSettleReport(
      record({ status: 'done', dispatch: { rootRunId: 'm', parentRunId: 'p', retryLimit: 1 } }),
    );
    expect(completed.report.status).toBe('done');
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
    expect(carrier.droppedReports).toBe(3);
  });

  it('never counts a drop while the list is within its bound', () => {
    let carrier: ReturnType<typeof withPendingReport> = { rootRunId: 'm' };
    for (let i = 0; i < MAX_PENDING_REPORTS; i += 1) carrier = withPendingReport(carrier, entry(i));
    expect(carrier).not.toHaveProperty('droppedReports');
  });

  it('rolls the dropped reports into one pointer line instead of losing them silently', () => {
    const block = pendingReportsBlock([entry(1)], 3);
    expect(block).toContain('- 3 older reports are not repeated here — read units/*/report.md in the tree directory');
    expect(pendingReportsBlock([entry(1)], 0)).not.toContain('older report');
  });

  it('carries a child’s scope verdict into the block', () => {
    expect(pendingReportsBlock([{ ...entry(1), scopeCheck: 'scope check: no changed files' }])).toContain('r1; scope check: no changed files');
  });

  it('renders as prose a commander reads, and nothing at all when there is none', () => {
    expect(pendingReportsBlock([])).toBeUndefined();
    const block = pendingReportsBlock([entry(1)]);
    expect(block).toContain('## Reports from your dispatched tasks');
    expect(block).toContain('"child 1" (c1');
    expect(block).toContain('status done; r1');
  });
});

describe('scopeVerdict', () => {
  it('matches directories, files and globs by prefix, and lists what fell outside', () => {
    expect(scopeVerdict('src/left/', ['src/left/a.ts', 'src/left/b/c.ts'])).toBe('scope check: all 2 changed files inside the declared scope');
    expect(scopeVerdict('src/left/', ['src/left/a.ts', 'src/leftover.ts'])).toBe(
      'scope check: 1 of 2 changed files outside the declared scope: src/leftover.ts',
    );
    expect(scopeVerdict('src/left/**, README.md', ['src/left/x.ts', 'README.md', 'src/right/y.ts'])).toBe(
      'scope check: 1 of 3 changed files outside the declared scope: src/right/y.ts',
    );
    expect(scopeVerdict('`./packages/web/src/*.tsx`', ['packages/web/src/app.tsx'])).toContain('all 1 changed file inside');
  });

  it('only ever errs towards inside: a glob is matched by its literal prefix', () => {
    expect(scopeVerdict('src/**/auth.ts', ['src/billing/other.ts'])).toContain('inside');
    expect(scopeVerdict('**/*.md', ['anything/at/all.ts'])).toContain('inside');
  });

  it('reads a repository root, a leading slash and sentence punctuation the way the author meant them', () => {
    const files = ['src/auth/login.ts', 'src/auth/index.ts', 'notes.md'];
    const oneOutside = 'scope check: 1 of 3 changed files outside the declared scope: notes.md';
    expect(scopeVerdict('/', files)).toBe('scope check: all 3 changed files inside the declared scope');
    expect(scopeVerdict('.', files)).toBe('scope check: all 3 changed files inside the declared scope');
    expect(scopeVerdict('*', files)).toBe('scope check: all 3 changed files inside the declared scope');
    expect(scopeVerdict('src/auth/.', files)).toBe(oneOutside);
    expect(scopeVerdict('/src/auth/', files)).toBe(oneOutside);
    expect(scopeVerdict('src/auth/, plus tests.', files)).toBe(oneOutside);
    expect(scopeVerdict('`src/auth/`: login only', files)).toBe(oneOutside);
  });

  it('does not read prose as paths, and says so', () => {
    expect(scopeVerdict('only the login module', ['src/a.ts'])).toBe(
      'scope check: not checked — the declared scope names no unambiguous paths',
    );
    expect(scopeVerdict('src/a/', [])).toBe('scope check: no changed files');
  });

  it('keeps a bare directory token, so a mixed scope does not lose half of itself', () => {
    expect(scopeVerdict('docs, packages/web/src/', ['docs/readme.md', 'packages/web/src/a.ts'])).toBe(
      'scope check: all 2 changed files inside the declared scope',
    );
    expect(scopeVerdict('docs', ['docs/readme.md'])).toBe('scope check: all 1 changed file inside the declared scope');
  });

  it('refuses an outside verdict when no token clearly names a path — a correct change is never flagged', () => {
    // "and/or" parses as a slash token, and none of the words names a real path: every file reading
    // outside is a parse failure, not a finding.
    expect(scopeVerdict('and/or the auth module', ['src/auth/login.ts'])).toBe(
      'scope check: not checked — the declared scope names no unambiguous paths',
    );
    expect(scopeVerdict('docs', ['src/a.ts'])).toBe('scope check: not checked — the declared scope names no unambiguous paths');
  });

  it('refuses an outside verdict from an ambiguous partial match too', () => {
    // A bare word that happens to match one changed path ("docs") does not make the paths it did
    // not match a trustworthy finding: there is still no unambiguous token to justify "outside".
    expect(scopeVerdict('docs and the auth module', ['docs/readme.md', 'src/auth/login.ts'])).toBe(
      'scope check: not checked — the declared scope names no unambiguous paths',
    );
    // Same for a directory without a trailing slash: it matches leniently, but is not clear enough
    // to underwrite an outside verdict — one matched file does not promote it.
    expect(scopeVerdict('src/left', ['src/left/a.ts', 'src/leftover.ts'])).toBe(
      'scope check: not checked — the declared scope names no unambiguous paths',
    );
    // It still matches inside: a scope that covers every changed file is all-inside, not unchecked.
    expect(scopeVerdict('src/left', ['src/left/a.ts', 'src/left/b.ts'])).toBe(
      'scope check: all 2 changed files inside the declared scope',
    );
  });

  it('still reports an unambiguous all-outside verdict', () => {
    expect(scopeVerdict('src/', ['other/a.ts', 'other/b.ts'])).toBe(
      'scope check: 2 of 2 changed files outside the declared scope: other/a.ts, other/b.ts',
    );
    // Singular when one file is in play — "1 of 1 changed files" reads as a bug of its own.
    expect(scopeVerdict('src/', ['other/a.ts'])).toBe(
      'scope check: 1 of 1 changed file outside the declared scope: other/a.ts',
    );
  });

  it('bounds the listing', () => {
    const files = Array.from({ length: 8 }, (_, i) => `other/${i}.ts`);
    expect(scopeVerdict('src/', files)).toBe(
      'scope check: 8 of 8 changed files outside the declared scope: other/0.ts, other/1.ts, other/2.ts, other/3.ts, other/4.ts and 3 more',
    );
  });
});

describe('handoffSectionExcerpt', () => {
  it('reads one section and stops at the next header', () => {
    const text = '# Handoff\n\n## Progress log\n- did a thing\n\n## Resume notes\nhalf done\nnext: the other half\n\n## Later\nignored';
    expect(handoffSectionExcerpt(text, '## Resume notes')).toBe('half done\nnext: the other half');
    expect(handoffSectionExcerpt(text, '## Missing')).toBe('');
  });
});
