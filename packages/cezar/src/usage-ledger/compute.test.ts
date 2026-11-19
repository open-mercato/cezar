import { describe, expect, it } from 'vitest';
import type { PlanUsageWindow } from '@open-mercato/cezar-contract';
import { computeWindows } from './compute.ts';
import { buildPlanUsageReport } from './report.ts';
import { formatPlanUsageReport } from './format.ts';
import type { LedgerRecord } from './store.ts';

const T = (hhmm: string) => Date.parse(`2026-11-19T${hhmm}:00Z`);
const RESET = T('15:00');
const ACC = 'claude:default';

function reading(at: string, usedPercent: number, extra: Partial<Extract<LedgerRecord, { t: 'reading' }>> = {}): LedgerRecord {
  return { t: 'reading', at: T(at), account: ACC, window: 'five-hour', usedPercent, resetsAt: RESET, status: usedPercent >= 100 ? 'blocked' : 'allowed', source: 'claude-stream', ...extra };
}
function task(session: string, id: string, at: string, extra: Partial<Extract<LedgerRecord, { t: 'begin' }>> = {}): LedgerRecord {
  return { t: 'begin', at: T(at), account: ACC, session, consumer: { id, kind: 'task', title: id }, ...extra };
}
const sample = (session: string, from: string, to: string, usd: number): LedgerRecord => ({ t: 'sample', session, from: T(from), to: T(to), usd });
const end = (session: string, at: string, quiet?: boolean): LedgerRecord => ({ t: 'end', session, at: T(at), ...(quiet === undefined ? {} : { quiet }) });

function invariant(w: PlanUsageWindow): number {
  const consumers = w.consumers.reduce((s, c) => s + c.estimatePp, 0);
  return w.beforeTrackingPp + consumers + w.outsideCezarPp + w.unsplitPp - w.correctionPp;
}
const only = (records: LedgerRecord[]) => {
  const windows = computeWindows(records, { now: T('14:00'), intervals: true });
  expect(windows).toHaveLength(1);
  return windows[0]!;
};

describe('plan usage attribution', () => {
  it('gives a reading delta to the one task that ran alone, marked alone', () => {
    const w = only([
      reading('11:50', 38), task('s1', 'run:p/a', '11:45'), sample('s1', '11:45', '12:10', 3), end('s1', '12:10'),
      reading('12:05', 42),
    ]);
    expect(w.consumers).toMatchObject([{ id: 'run:p/a', estimatePp: 4, aloneInferredPp: 4, sharedEstimatePp: 0 }]);
    expect(w.beforeTrackingPp).toBe(38);
    expect(invariant(w)).toBeCloseTo(42, 5);
  });

  it('counts a delta with no cezar consumer running as outside cezar, never as zero', () => {
    const w = only([reading('12:05', 42), reading('12:20', 47)]);
    expect(w.consumers).toEqual([]);
    expect(w.outsideCezarPp).toBe(5);
    expect(w.intervals?.[0]?.outcome).toBe('outside');
  });

  it('splits parallel activity by reported cost (the design example 2.80/2.40/0.90 → 4.1/3.6/1.3)', () => {
    const w = only([
      reading('10:40', 10),
      task('a', 'run:p/a', '10:40'), task('b', 'run:p/b', '10:40'),
      { t: 'begin', at: T('10:40'), account: ACC, session: 'm', consumer: { id: 'mgr:rel', kind: 'manager', title: 'Release manager' }, part: 'chat', messageId: 'msg1' },
      sample('a', '10:40', '11:05', 2.8), sample('b', '10:40', '11:05', 2.4), sample('m', '10:40', '11:05', 0.9),
      end('a', '11:05'), end('b', '11:05'), end('m', '11:05'),
      reading('11:05', 19),
    ]);
    const by = Object.fromEntries(w.consumers.map((c) => [c.id, c]));
    expect(by['run:p/a']!.estimatePp).toBeCloseTo(4.13, 1);
    expect(by['run:p/b']!.estimatePp).toBeCloseTo(3.54, 1);
    expect(by['mgr:rel']!.estimatePp).toBeCloseTo(1.33, 1);
    expect(by['run:p/a']!.aloneInferredPp).toBe(0);
    expect(by['run:p/a']!.ranTogetherWith).toEqual({ tasks: 1, managers: 1, internal: 0 });
    expect(by['mgr:rel']!.parts).toEqual({ chat: 1.33, watch: 0, job: 0 });
    expect(by['mgr:rel']!.messages).toEqual([{ messageId: 'msg1', part: 'chat', estimatePp: 1.33 }]);
    expect(invariant(w)).toBeCloseTo(19, 5);
  });

  it('leaves time no cost report covers unsplit instead of guessing (a task stopped mid-reply)', () => {
    const w = only([
      reading('13:50', 60),
      task('a', 'run:p/a', '13:50'), task('b', 'run:p/b', '13:50'),
      sample('a', '13:50', '14:05', 1),
      end('a', '14:05'), end('b', '14:05'),
      reading('14:05', 68),
    ]);
    expect(w.unsplitPp).toBe(4);
    expect(w.consumers).toMatchObject([{ id: 'run:p/a', estimatePp: 4 }]);
    expect(invariant(w)).toBeCloseTo(68, 5);
  });

  it('counts each delta once when parallel sessions repeat and interleave readings', () => {
    const w = only([
      task('a', 'run:p/a', '10:00'), task('b', 'run:p/b', '10:00'),
      reading('10:00', 10), reading('10:00', 10), reading('10:10', 15), reading('10:11', 15), reading('10:20', 20),
      sample('a', '10:00', '10:20', 1), sample('b', '10:00', '10:20', 1), end('a', '10:20'), end('b', '10:20'),
    ]);
    expect(w.consumers.reduce((s, c) => s + c.estimatePp, 0)).toBeCloseTo(10, 5);
    expect(invariant(w)).toBeCloseTo(20, 5);
  });

  it('splits a rise across everyone who ran since the reading last rose, not only since the last flat one', () => {
    const w = only([
      reading('10:00', 10), task('a', 'run:p/a', '10:00'), sample('a', '10:00', '10:20', 3), end('a', '10:20'),
      reading('10:21', 10), task('b', 'run:p/b', '10:21'), sample('b', '10:21', '10:40', 3), end('b', '10:40'),
      reading('10:41', 11),
    ]);
    const by = Object.fromEntries(w.consumers.map((c) => [c.id, c.estimatePp]));
    expect(by['run:p/a']).toBeCloseTo(0.5, 5);
    expect(by['run:p/b']).toBeCloseTo(0.5, 5);
    expect(invariant(w)).toBeCloseTo(11, 5);
  });

  it('shows a provider correction instead of re-counting the climb back', () => {
    const w = only([reading('10:00', 10), reading('10:10', 20), reading('10:20', 18), reading('10:30', 19)]);
    expect(w.outsideCezarPp).toBe(10);
    expect(w.correctionPp).toBe(1);
    expect(invariant(w)).toBeCloseTo(19, 5);
  });

  it('starts a new window at a reset and never carries activity across it', () => {
    const windows = computeWindows([
      reading('09:00', 90, { resetsAt: T('10:00') }), task('a', 'run:p/a', '09:00'), sample('a', '09:00', '10:30', 2),
      reading('09:30', 96, { resetsAt: T('10:00') }), reading('10:05', 1), reading('10:30', 6), end('a', '10:30'),
    ], { now: T('10:40') });
    expect(windows).toHaveLength(2);
    const [current, previous] = windows;
    expect(current!.current).toBe(true);
    expect(previous!.current).toBe(false);
    expect(previous!.consumers[0]!.estimatePp).toBe(6);
    expect(current!.consumers[0]!.estimatePp).toBe(5);
    expect(current!.beforeTrackingPp).toBe(1);
  });

  it('flags the share spent on an attempt that later failed a check step', () => {
    const w = only([
      reading('10:00', 0), task('a', 'run:p/a', '10:00'),
      sample('a', '10:00', '10:30', 1), { t: 'attempt-failed', at: T('10:31'), consumerId: 'run:p/a', since: T('10:00') },
      sample('a', '10:31', '11:00', 1), end('a', '11:00'),
      reading('10:30', 6), reading('11:00', 10),
    ]);
    expect(w.consumers[0]).toMatchObject({ estimatePp: 10, retryWasteEstimatePp: 6 });
  });

  it('with one reading there is nothing to split: the reading is "before tracking", never a 0% task', () => {
    const w = only([task('a', 'run:p/a', '10:00'), reading('10:05', 30), sample('a', '10:00', '10:10', 1), end('a', '10:10')]);
    expect(w.consumers).toEqual([]);
    expect(w.beforeTrackingPp).toBe(30);
  });

  it('keeps accounts apart', () => {
    const windows = computeWindows([
      reading('10:00', 10), reading('10:10', 20),
      { ...reading('10:00', 50), account: 'claude:klod' } as LedgerRecord, { ...reading('10:10', 55), account: 'claude:klod' } as LedgerRecord,
      task('a', 'run:p/a', '10:00'), sample('a', '10:00', '10:10', 1), end('a', '10:10'),
    ], { now: T('10:20') });
    const klod = windows.find((w) => w.account.key === 'claude:klod')!;
    const def = windows.find((w) => w.account.key === ACC)!;
    expect(klod.consumers).toEqual([]);
    expect(klod.outsideCezarPp).toBe(5);
    expect(def.consumers[0]!.estimatePp).toBe(10);
  });

  it('counts manager watch turns and quiet ones, and hints when every watch found nothing', () => {
    const records: LedgerRecord[] = [reading('10:00', 10)];
    for (let i = 0; i < 3; i++) {
      const at = `10:${String(i * 15 + 1).padStart(2, '0')}`;
      const to = `10:${String(i * 15 + 3).padStart(2, '0')}`;
      records.push({ t: 'begin', at: T(at), account: ACC, session: `w${i}`, consumer: { id: 'mgr:m', kind: 'manager', title: 'Release manager', managerId: 'm' }, part: 'watch', messageId: `x${i}` },
        sample(`w${i}`, at, to, 0.1), end(`w${i}`, to, true), reading(to, 10 + (i + 1) * 0.2));
    }
    const report = buildPlanUsageReport({ window: 'current' }, { records, now: T('11:00'), timeZone: 'UTC' });
    const c = report.windows[0]!.consumers[0]!;
    expect(c.turns).toEqual({ chat: 0, watch: 3, job: 0 });
    expect(c.quietWatchTurns).toBe(3);
    expect(report.hints.map((h) => h.kind)).toEqual(['quiet-watch']);
  });
});

describe('the parallel-limit hint and the human view', () => {
  const records: LedgerRecord[] = [
    reading('10:00', 50), task('a', 'run:p/a', '10:00', { consumer: { id: 'run:p/a', kind: 'task', title: 'Retry temp-repo removal' } }),
    task('b', 'run:p/b', '10:00', { consumer: { id: 'run:p/b', kind: 'task', title: 'Drop waiting dot' } }),
    sample('a', '10:00', '14:20', 6), sample('b', '10:00', '14:20', 4), end('a', '14:20'), end('b', '14:20'),
    reading('14:20', 100),
    { ...reading('10:00', 18), account: 'claude:klod', label: 'klod' } as LedgerRecord,
  ];
  const report = buildPlanUsageReport({ window: 'current' }, { records, now: T('14:21'), timeZone: 'UTC' });

  it('suggests spreading tasks to an idle account of the same tool, with its evidence', () => {
    const hint = report.hints.find((h) => h.kind === 'parallel-limit')!;
    expect(hint.text).toContain('hit the limit at 14:20 while Claude · klod sat at 18%');
    expect(hint.text).toContain('40-minute pause');
    expect(hint.evidence).toMatchObject({ otherUsedPercent: 18 });
  });

  it('prints every JSON number the same way in the human view', () => {
    const text = formatPlanUsageReport(report, T('14:21'), 'UTC');
    const def = report.windows.find((w) => w.account.key === ACC)!;
    expect(text).toContain('Claude · default · 5-hour window 10:00–15:00 (resets in 39m) · 100% used');
    for (const c of def.consumers) expect(text).toContain(`≈${c.estimatePp}%  ${c.title}`);
    expect(def.consumers.map((c) => c.estimatePp)).toEqual([30, 20]);
  });
});

describe('readings that arrive when a turn starts', () => {
  it('never hands the usage before a turn to the turn whose start produced the reading', () => {
    const w = only([
      reading('10:00', 10),
      // Two idle hours (your own Claude Code use), then a task turn starts and Claude reads 30%.
      task('a', 'run:p/a', '12:00'), { ...reading('12:00', 30), at: T('12:00') + 2_000 } as LedgerRecord,
      sample('a', '12:00', '12:10', 1), end('a', '12:10'), reading('12:10', 33),
    ]);
    expect(w.outsideCezarPp).toBe(20);
    expect(w.consumers).toMatchObject([{ id: 'run:p/a', estimatePp: 3, aloneInferredPp: 3 }]);
  });
});

describe('account identity and cezar internal calls', () => {
  it('keeps a re-login in the same account folder apart, even with the same reset hour', () => {
    const windows = computeWindows([
      { ...reading('10:00', 30), identity: 'aaaa' } as LedgerRecord, { ...reading('10:10', 35), identity: 'aaaa' } as LedgerRecord,
      { ...task('a', 'run:p/a', '10:00'), identity: 'aaaa' } as LedgerRecord, sample('a', '10:00', '10:10', 1), end('a', '10:10'),
      // The user signs in to another org in the same folder: its 80% must not read as +45%.
      { ...reading('10:20', 80), identity: 'bbbb' } as LedgerRecord, { ...reading('10:30', 82), identity: 'bbbb' } as LedgerRecord,
      { ...task('b', 'run:p/b', '10:20'), identity: 'bbbb' } as LedgerRecord, sample('b', '10:20', '10:30', 1), end('b', '10:30'),
    ], { now: T('10:40') });
    expect(windows).toHaveLength(2);
    const old = windows.find((w) => w.account.identity === 'aaaa')!;
    const now = windows.find((w) => w.account.identity === 'bbbb')!;
    expect(old).toMatchObject({ current: false, account: { earlierLogin: true, label: 'Claude · default (earlier login)' } });
    expect(old.consumers).toMatchObject([{ id: 'run:p/a', estimatePp: 5 }]);
    expect(now).toMatchObject({ current: true, beforeTrackingPp: 80, correctionPp: 0 });
    expect(now.consumers).toMatchObject([{ id: 'run:p/b', estimatePp: 2 }]);
    expect(old.id).not.toBe(now.id);
  });

  it('gives auto-naming its own share instead of inflating the task that ran beside it', () => {
    const w = only([
      reading('10:00', 10), task('a', 'run:p/a', '10:00'),
      { t: 'begin', at: T('10:01'), account: ACC, session: 'n', consumer: { id: 'internal:auto-naming', kind: 'internal', title: 'Auto-naming' } },
      sample('n', '10:01', '10:01', 0.01), end('n', '10:01'),
      sample('a', '10:00', '10:10', 0.99), end('a', '10:10'), reading('10:10', 20),
    ]);
    const by = Object.fromEntries(w.consumers.map((c) => [c.id, c.estimatePp]));
    expect(by['internal:auto-naming']).toBeCloseTo(0.1, 5);
    expect(by['run:p/a']).toBeCloseTo(9.9, 5);
  });
});
