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
    expect(by['mgr:rel']!.messages).toEqual([{ messageId: 'msg1', part: 'chat', at: '2026-11-19T10:40:00.000Z', estimatePp: 1.33, aloneInferredPp: 0, sharedEstimatePp: 1.33 }]);
    expect(invariant(w)).toBeCloseTo(19, 5);
  });

  it('carries a manager turn’s stats and its cost onto the message (spec 2026-11-21 § 2.3)', () => {
    const turn = {
      requests: 5, contextFirst: 928_533, contextPeak: 942_220, toolResultChars: 13_185,
      tools: { route: 2, look: 1, own: 1, write: 0 }, fresh: false, sessionTurn: 118, idleMs: 34_000_000,
    };
    const w = only([
      reading('10:40', 10),
      { t: 'begin', at: T('10:40'), account: ACC, session: 'm', consumer: { id: 'mgr:rel', kind: 'manager', title: 'Release manager' }, part: 'chat', messageId: 'msg1' },
      sample('m', '10:40', '10:45', 8.36),
      { t: 'end', at: T('10:45'), session: 'm', turn },
      reading('10:45', 15),
    ]);
    expect(w.consumers[0]!.messages).toEqual([{
      messageId: 'msg1', part: 'chat', at: new Date(T('10:40')).toISOString(), estimatePp: 5, aloneInferredPp: 5, sharedEstimatePp: 0,
      turn: { ...turn, usd: 8.36 },
    }]);
  });

  it('gives a retried reply the answering attempt’s shape before any reading has split it', () => {
    const shape = (requests: number) => ({
      requests, contextFirst: 30_000, contextPeak: 30_000, toolResultChars: 0,
      tools: { route: 0, look: 0, own: 0, write: 0 }, fresh: false, sessionTurn: 4,
    });
    const begin = (session: string, at: string): LedgerRecord => ({ t: 'begin', at: T(at), account: ACC, session, consumer: { id: 'mgr:rel', kind: 'manager', title: 'Release manager' }, part: 'chat', messageId: 'msg1' });
    const w = only([
      reading('10:40', 10),
      begin('a1', '10:40'), sample('a1', '10:40', '10:41', 0.5), { t: 'end', at: T('10:41'), session: 'a1', turn: shape(1) },
      reading('10:42', 11),
      // The retry answered after the last reading: no share of its own yet.
      begin('a2', '10:43'), sample('a2', '10:43', '10:45', 1.5), { t: 'end', at: T('10:45'), session: 'a2', turn: shape(3) },
    ]);
    expect(w.consumers[0]!.messages![0]!.turn).toEqual({ ...shape(3), usd: 2 });
  });

  it('gives a retried reply its last attempt’s shape and the cost of both attempts', () => {
    const shape = (requests: number) => ({
      requests, contextFirst: 30_000, contextPeak: 30_000, toolResultChars: 0,
      tools: { route: 0, look: 0, own: 0, write: 0 }, fresh: false, sessionTurn: 4,
    });
    const begin = (session: string, at: string): LedgerRecord => ({ t: 'begin', at: T(at), account: ACC, session, consumer: { id: 'mgr:rel', kind: 'manager', title: 'Release manager' }, part: 'chat', messageId: 'msg1' });
    const w = only([
      reading('10:40', 10),
      begin('a1', '10:40'), sample('a1', '10:40', '10:41', 0.5), { t: 'end', at: T('10:41'), session: 'a1', turn: shape(1) },
      begin('a2', '10:42'), sample('a2', '10:42', '10:45', 1.5), { t: 'end', at: T('10:45'), session: 'a2', turn: shape(3) },
      reading('10:45', 12),
    ]);
    expect(w.consumers[0]!.messages).toHaveLength(1);
    expect(w.consumers[0]!.messages![0]!.turn).toEqual({ ...shape(3), usd: 2 });
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
    // Each turn keeps its own figure, start and alone share: what the popover's largest turns debug.
    expect(c.messages?.map((m) => [m.messageId, m.at, m.aloneInferredPp, m.sharedEstimatePp])).toEqual([
      ['x0', '2026-11-19T10:01:00.000Z', 0.2, 0], ['x1', '2026-11-19T10:16:00.000Z', 0.2, 0], ['x2', '2026-11-19T10:31:00.000Z', 0.2, 0],
    ]);
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

describe('recording gaps (QA F1)', () => {
  const mark = (at: string, state: 'off' | 'on' | 'start'): LedgerRecord => ({ t: 'tracking', at: T(at), account: ACC, state });
  const watch = (session: string, at: string, to: string): LedgerRecord[] => [
    { t: 'begin', at: T(at), account: ACC, session, consumer: { id: 'mgr:m', kind: 'manager', title: 'QA Manager', managerId: 'm' }, part: 'watch' },
    sample(session, at, to, 0.01), end(session, to, true),
  ];

  it('keeps usage spent while tracking was off as untracked, never on the last turn before it', () => {
    // The QA repro: a quiet watch check, tracking off, untracked work, tracking on, a task turn.
    const w = only([
      reading('10:00', 30), ...watch('w', '10:00', '10:01'),
      mark('10:02', 'off'), mark('10:09', 'on'), mark('10:09', 'start'),
      task('a', 'run:p/a', '10:10'), reading('10:10', 38), sample('a', '10:10', '10:12', 1), end('a', '10:12'),
      reading('10:13', 40),
    ]);
    expect(w.untrackedPp).toBe(8);
    expect(w.consumers.map((c) => [c.id, c.estimatePp])).toEqual([['run:p/a', 2]]);
    expect(w.trackingGaps).toEqual([{ from: new Date(T('10:02')).toISOString(), to: new Date(T('10:09')).toISOString(), reason: 'tracking-off' }]);
    expect(w.intervals?.[0]).toMatchObject({ outcome: 'untracked', reason: 'tracking-off', deltaPp: 8, allocations: [] });
    expect(w.beforeTrackingPp + 2 + w.untrackedPp + w.outsideCezarPp + w.unsplitPp - w.correctionPp).toBe(40);
  });

  it('treats a restart (or CEZ_USAGE_LOG=0 in between) as a gap from the last record', () => {
    // No turn spans the start marker here, so nothing proves anyone was recording.
    const w = only([
      reading('10:00', 30), task('a', 'run:p/a', '10:00'), sample('a', '10:00', '10:05', 1),
      // no end: the process stopped mid-turn; the next one starts recording at 11:00
      mark('11:00', 'start'), task('b', 'run:p/b', '11:00'), reading('11:00', 50),
      sample('b', '11:00', '11:05', 1), end('b', '11:05'), reading('11:06', 53),
    ]);
    expect(w.untrackedPp).toBe(20);
    expect(w.trackingGaps[0]).toMatchObject({ reason: 'recording-started', from: new Date(T('10:05')).toISOString() });
    // The crashed pre-gap turn is not a candidate after the restart, open cap or not.
    expect(w.consumers.map((c) => [c.id, c.estimatePp])).toEqual([['run:p/b', 3]]);
  });

  it('waits for the first usable reading: turns before it are re-baselined, not charged', () => {
    const w = only([
      reading('10:00', 30), mark('10:02', 'off'), mark('10:20', 'on'),
      // A turn after resuming that produced no reading of its own (a failed request).
      task('a', 'run:p/a', '10:21'), end('a', '10:22'),
      task('b', 'run:p/b', '10:30'), reading('10:30', 45), sample('b', '10:30', '10:32', 1), end('b', '10:32'), reading('10:33', 47),
    ]);
    expect(w.untrackedPp).toBe(15);
    expect(w.consumers.map((c) => [c.id, c.estimatePp])).toEqual([['run:p/b', 2]]);
  });

  it('a window that resets during the gap starts on its own baseline', () => {
    const windows = computeWindows([
      reading('09:00', 60, { resetsAt: T('10:00') }), mark('09:10', 'off'), mark('10:30', 'on'),
      reading('10:31', 7), task('a', 'run:p/a', '10:31'), sample('a', '10:31', '10:40', 1), end('a', '10:40'), reading('10:41', 9),
    ], { now: T('10:50') });
    const [current, previous] = windows;
    expect(previous).toMatchObject({ current: false, untrackedPp: 0, usedPercent: { first: 60, last: 60 } });
    // It opened while tracking was off: that usage is not tracked, not "before tracking" (QA R4).
    expect(current).toMatchObject({ current: true, beforeTrackingPp: 0, untrackedPp: 7 });
    expect(current!.consumers.map((c) => c.estimatePp)).toEqual([2]);
  });

  it('a long idle stretch after a short turn is unknown, not the turn\'s alone', () => {
    const w = only([
      reading('10:00', 10), ...watch('w', '10:00', '10:01'),
      // 2h of your own Claude Code use, then the next cezar turn reads the account.
      task('b', 'run:p/b', '12:00'), reading('12:00', 30), end('b', '12:01'),
    ]);
    const watchShare = w.consumers.find((c) => c.id === 'mgr:m')?.estimatePp ?? 0;
    // Covered: the turn plus 15 minutes of grace out of 120 minutes.
    expect(watchShare).toBeCloseTo(20 * 16 / 120, 1);
    expect(w.unsplitPp).toBeCloseTo(20 - 20 * 16 / 120, 1);
  });
});

describe('a second process starting up', () => {
  it('does not cut off a turn that kept recording in the first one, nor call it a gap', () => {
    const w = only([
      reading('10:00', 10), task('a', 'run:p/a', '10:00'), reading('10:05', 12),
      { t: 'tracking', at: T('10:06'), account: ACC, state: 'start' }, // `cezar run` elsewhere
      sample('a', '10:00', '10:20', 1), end('a', '10:20'), reading('10:21', 15),
    ]);
    // The turn recorded on both sides of the start: the account was being recorded all along,
    // so there is no gap and no "not recording" label (QA R2).
    expect(w.untrackedPp).toBe(0);
    expect(w.trackingGaps).toEqual([]);
    expect(w.consumers.map((c) => [c.id, c.estimatePp])).toEqual([['run:p/a', 5]]);
    const later = only([
      reading('10:00', 10), task('a', 'run:p/a', '10:00'), reading('10:05', 12),
      { t: 'tracking', at: T('10:06'), account: ACC, state: 'start' }, reading('10:07', 12),
      sample('a', '10:00', '10:20', 1), end('a', '10:20'), reading('10:21', 15),
    ]);
    expect(later.untrackedPp).toBe(0);
    expect(later.consumers.map((c) => [c.id, c.estimatePp])).toEqual([['run:p/a', 5]]);
  });
});

describe('the human view of a recording gap', () => {
  it('prints the untracked share with its reason and time, the same number as the JSON', () => {
    const records: LedgerRecord[] = [
      reading('10:00', 30), { t: 'tracking', at: T('10:02'), account: ACC, state: 'off' },
      { t: 'tracking', at: T('10:09'), account: ACC, state: 'on' }, reading('10:10', 38),
    ];
    const report = buildPlanUsageReport({ window: 'current' }, { records, now: T('10:20'), timeZone: 'UTC' });
    expect(report.windows[0]!.untrackedPp).toBe(8);
    expect(formatPlanUsageReport(report, T('10:20'), 'UTC')).toContain('  8%  not tracked (10:02–10:09 tracking off)');
  });
});

describe('the parts always add up to the provider reading (QA R1)', () => {
  const sum = (w: PlanUsageWindow) => w.beforeTrackingPp + w.consumers.reduce((n, c) => n + c.estimatePp, 0)
    + w.outsideCezarPp + w.unsplitPp + w.untrackedPp - w.correctionPp;

  it('keeps the idle share when two turns share a slice after 30 quiet minutes', () => {
    const w = only([
      reading('10:00', 10), task('a', 'run:p/a', '10:30'), task('b', 'run:p/b', '10:30'),
      sample('a', '10:30', '10:40', 0.1), sample('b', '10:30', '10:40', 0.1), end('a', '10:40'), end('b', '10:40'),
      reading('10:41', 14),
    ]);
    expect(w.unsplitPp).toBeGreaterThan(0);
    expect(sum(w)).toBeCloseTo(14, 1);
  });

  it('holds for random ledgers: parallel turns, idle stretches, gaps, corrections', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let round = 0; round < 200; round++) {
      const records: LedgerRecord[] = [];
      let used = Math.floor(rnd() * 20);
      let t = T('10:00');
      records.push({ ...reading('10:00', used), at: t } as LedgerRecord);
      for (let step = 0; step < 8; step++) {
        t += Math.floor(rnd() * 40 + 1) * 60_000;
        const turns = Math.floor(rnd() * 3);
        for (let k = 0; k < turns; k++) {
          const id = `s${round}-${step}-${k}`;
          const from = t + Math.floor(rnd() * 5) * 60_000;
          const to = from + Math.floor(rnd() * 10 + 1) * 60_000;
          records.push({ t: 'begin', at: from, account: ACC, session: id, consumer: { id: `run:p/${k}`, kind: 'task', title: `${k}` } });
          if (rnd() > 0.2) records.push({ t: 'sample', session: id, from, to, usd: rnd() });
          if (rnd() > 0.1) records.push({ t: 'end', session: id, at: to });
        }
        if (rnd() < 0.1) records.push({ t: 'tracking', at: t + 60_000, account: ACC, state: rnd() < 0.5 ? 'start' : 'off' });
        if (rnd() < 0.05) records.push({ t: 'tracking', at: t + 120_000, account: ACC, state: 'on' });
        t += 15 * 60_000;
        used = Math.max(0, Math.min(100, used + Math.floor(rnd() * 8) - (rnd() < 0.1 ? 3 : 0)));
        records.push({ ...reading('10:00', used), at: t } as LedgerRecord);
      }
      for (const w of computeWindows(records, { now: t + 60_000 })) {
        expect(sum(w)).toBeCloseTo(w.usedPercent!.last, 1);
      }
    }
  });
});

describe('quiet time under the grace (QA R3)', () => {
  it('a short lead before a lone turn stays the turn\'s', () => {
    const w = only([reading('10:00', 10), task('a', 'run:p/a', '10:10'), sample('a', '10:10', '10:20', 1), end('a', '10:20'), reading('10:21', 14)]);
    expect(w.unsplitPp).toBe(0);
    expect(w.consumers).toMatchObject([{ id: 'run:p/a', estimatePp: 4 }]);
  });
});

describe('a turn that re-cached its history (the 2026-11-22 07:11 report, spec 2026-11-21 § 1.3)', () => {
  // Real ledger, 2026-11-22, shifted five hours into this fixture's window: a fresh manager turn ($0.31) ended at 06:12:21; a task resumed a
  // long session at 06:12:24 and its first request re-cached it ($5.90); Claude read 0% at 06:12:02
  // and 5% at 06:12:40, from the task's own stream after that first answer.
  const at = (hhmmss: string) => Date.parse(`2026-11-19T${hhmmss}Z`);
  const begin = (session: string, id: string, hhmmss: string, extra: Partial<Extract<LedgerRecord, { t: 'begin' }>> = {}): LedgerRecord =>
    ({ t: 'begin', at: at(hhmmss), account: ACC, session, consumer: { id, kind: id.startsWith('mgr:') ? 'manager' : 'task', title: id }, ...extra });
  const span = (session: string, from: string, to: string, usd: number): LedgerRecord => ({ t: 'sample', session, from: at(from), to: at(to), usd });
  const read = (hhmmss: string, used: number): LedgerRecord => ({ ...reading('11:00', used), at: at(hhmmss) } as LedgerRecord);
  const window = (task: LedgerRecord[]) => only([
    read('11:12:02', 0),
    begin('m', 'mgr:mobile', '11:11:59', { part: 'chat', messageId: 'msg-0711' }), span('m', '11:11:59', '11:12:21', 0.314), { t: 'end', at: at('11:12:21'), session: 'm' },
    begin('t', 'run:cezar/605750b7', '11:12:24'), ...task, { t: 'end', at: at('11:16:05'), session: 't' },
    read('11:12:40', 5), read('11:14:45', 6),
  ]);
  const manager = (w: ReturnType<typeof only>) => w.consumers.find((c) => c.id === 'mgr:mobile')!;

  it('before: one sample for the whole task turn hands the 5% jump to the manager', () => {
    const w = window([span('t', '11:12:24', '11:16:05', 6.11)]);
    expect(manager(w).estimatePp).toBe(5);
    expect(manager(w).aloneInferredPp).toBe(5);
  });

  it('a non-Claude reading keeps the 20-second rule, per-request spans or not', () => {
    const codex = (hhmmss: string, used: number): LedgerRecord => ({ ...read(hhmmss, used), source: 'codex-notification' } as LedgerRecord);
    const w = only([
      codex('11:12:02', 0),
      begin('m', 'mgr:mobile', '11:11:59', { part: 'chat', messageId: 'msg-0711' }), span('m', '11:11:59', '11:12:21', 0.314), { t: 'end', at: at('11:12:21'), session: 'm' },
      begin('t', 'run:cezar/605750b7', '11:12:24'), span('t', '11:12:24', '11:12:38', 5.9), span('t', '11:12:38', '11:12:55', 0.05), span('t', '11:12:55', '11:16:05', 0.16), { t: 'end', at: at('11:16:05'), session: 't' },
      codex('11:12:40', 5), codex('11:14:45', 6),
    ]);
    expect(manager(w).estimatePp).toBe(5);
  });

  it('after: per-request samples put the jump on the turn that re-cached', () => {
    const w = window([span('t', '11:12:24', '11:12:38', 5.9), span('t', '11:12:38', '11:12:55', 0.05), span('t', '11:12:55', '11:16:05', 0.16)]);
    expect(manager(w).estimatePp).toBeLessThan(0.3);
    expect(manager(w).messages?.[0]?.estimatePp).toBeLessThan(0.3);
    expect(w.consumers.find((c) => c.id === 'run:cezar/605750b7')!.estimatePp).toBeGreaterThan(5.5);
  });
});
