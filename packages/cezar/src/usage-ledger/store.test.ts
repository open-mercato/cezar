import { mkdtempSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planUsageReportSchema, planUsageConsumersResponseSchema, planUsageTrackingSchema } from '@open-mercato/cezar-contract';
import { PlanUsageTracker, recordUsageObservation } from './recorder.ts';
import { computeWindows } from './compute.ts';
import { ledgerDir, readLedger, resetLedgerCaches, setAccountTracking } from './store.ts';
import { planUsageRoutes } from '../server/plan-usage.ts';

const RESET = Math.ceil(Date.now() / 3_600_000) * 3_600_000 + 3_600_000;
const obs = (used: number, at: number) => ({
  provider: 'claude' as const, source: 'claude-stream' as const, observedAt: at,
  windows: [{ id: 'five_hour', kind: 'five-hour' as const, applicability: 'all' as const, models: [], resetsAt: RESET, durationMinutes: 300, usedPercent: used, status: 'allowed' as const, observedAt: at }],
});

describe('the plan-usage ledger store', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.CEZ_HOME;
    process.env.CEZ_HOME = mkdtempSync(join(tmpdir(), 'cez-ledger-'));
    delete process.env.CEZ_USAGE_LOG;
    resetLedgerCaches();
  });
  afterEach(() => {
    process.env.CEZ_HOME = saved;
    delete process.env.CEZ_USAGE_LOG;
    resetLedgerCaches();
  });

  it('records readings and one span per turn, with the late cost inside its turn', () => {
    const now = Date.now();
    recordUsageObservation({ key: 'claude:default' }, obs(10, now));
    recordUsageObservation({ key: 'claude:default' }, obs(10, now + 1)); // unchanged: thinned
    const t = new PlanUsageTracker('claude', { key: 'claude:default' }, { id: 'run:p/a', kind: 'task', title: 'A' });
    t.ui({ type: 'turn.started' });
    t.ui({ type: 'turn.completed' });
    t.event({ type: 'cost', usd: 0.5 });
    t.ui({ type: 'turn.completed' });
    t.close();
    const records = readLedger(1);
    expect(records.map((r) => r.t)).toEqual(['tracking', 'reading', 'begin', 'end', 'sample']);
    expect(records[0]).toMatchObject({ t: 'tracking', account: 'claude:default', state: 'start' });
    const end = records.find((r) => r.t === 'end')!;
    const sample = records.find((r) => r.t === 'sample')!;
    expect(sample.t === 'sample' && end.t === 'end' && sample.to).toBe(end.t === 'end' ? end.at : -1);
  });

  it('splits a Claude turn’s cost per request by what each request cached and read', () => {
    const t = new PlanUsageTracker('claude', { key: 'claude:default' }, { id: 'run:p/a', kind: 'task', title: 'A' });
    t.ui({ type: 'turn.started' });
    t.event({ type: 'usage-status', status: { contextTokens: 900_000, cacheWriteTokens: 900_000 } });
    t.event({ type: 'usage-status', status: { contextTokens: 905_000, cacheWriteTokens: 5_000 } });
    t.event({ type: 'usage-status', status: { turnTokens: { cacheReadTokens: 900_000, cacheWriteTokens: 905_000, outputTokens: 2_000 } } });
    t.ui({ type: 'turn.completed' });
    t.event({ type: 'cost', usd: 6 });
    const samples = readLedger(1).filter((r) => r.t === 'sample') as Array<Extract<ReturnType<typeof readLedger>[number], { t: 'sample' }>>;
    expect(samples).toHaveLength(2);
    // The re-cache is ~90% of the turn: 900k written vs 5k written + 900k read.
    expect(samples[0]!.usd! / 6).toBeGreaterThan(0.88);
    expect(samples[0]!.usd! + samples[1]!.usd!).toBeCloseTo(6);
    expect(samples[0]!.to).toBeLessThanOrEqual(samples[1]!.from);
  });

  it('ends each request’s sample at its answer, and the 07:11 case then charges the re-cache to its turn', () => {
    const t0 = Date.parse('2026-11-22T06:12:24Z');
    let clock = t0;
    const task = new PlanUsageTracker('claude', { key: 'claude:default' }, { id: 'run:cezar/t', kind: 'task', title: 'T' }, {}, () => clock);
    task.ui({ type: 'turn.started' });
    clock = t0 + 14_000;
    task.event({ type: 'usage-status', status: { contextTokens: 900_000, cacheWriteTokens: 900_000 } });
    clock = t0 + 31_000;
    task.event({ type: 'usage-status', status: { contextTokens: 905_000, cacheWriteTokens: 5_000 } });
    clock = t0 + 221_000;
    task.ui({ type: 'turn.completed' });
    clock = t0 + 222_000;
    task.event({ type: 'cost', usd: 6.11 });
    const records = readLedger(1, t0 + 300_000);
    const samples = records.filter((r) => r.t === 'sample') as Array<Extract<ReturnType<typeof readLedger>[number], { t: 'sample' }>>;
    const end = records.find((r) => r.t === 'end')!;
    expect(samples.map((s) => [s.from - t0, s.to - t0])).toEqual([[0, 14_000], [14_000, 221_000]]);
    expect(samples[0]!.to).toBeLessThan(end.t === 'end' ? end.at : 0);
    // The manager's cheap fresh turn ended just before; Claude read 0% during it, 5% after the task's first answer.
    const reading = (at: number, usedPercent: number) => ({ t: 'reading', at, account: 'claude:default', window: 'five-hour', usedPercent, resetsAt: Date.parse('2026-11-22T11:10:00Z'), status: 'allowed', source: 'claude-stream' }) as const;
    // The 'tracking started' marker carries the real clock; this replay runs on the fake one.
    const windows = computeWindows([
      ...records.filter((r) => r.t !== 'tracking'),
      reading(t0 - 22_000, 0),
      { t: 'begin', at: t0 - 25_000, account: 'claude:default', session: 'm', consumer: { id: 'mgr:mobile', kind: 'manager', title: 'Mobile app creator' }, part: 'chat', messageId: 'msg-0711' },
      { t: 'sample', from: t0 - 25_000, to: t0 - 3_000, session: 'm', usd: 0.314 },
      { t: 'end', at: t0 - 3_000, session: 'm' },
      reading(t0 + 16_000, 5), reading(t0 + 141_000, 6),
    ], { now: t0 + 300_000 });
    const by = Object.fromEntries(windows[0]!.consumers.map((c) => [c.id, c.estimatePp]));
    expect(by['mgr:mobile']).toBeLessThan(0.3);
    expect(by['run:cezar/t']).toBeGreaterThan(5.5);
  });

  it('keeps one sample for a turn whose requests did not say what they cached', () => {
    const t = new PlanUsageTracker('claude', { key: 'claude:default' }, { id: 'run:p/a', kind: 'task', title: 'A' });
    t.ui({ type: 'turn.started' });
    t.event({ type: 'usage-status', status: { contextTokens: 50_000 } });
    t.ui({ type: 'turn.completed' });
    t.event({ type: 'cost', usd: 0.4 });
    expect(readLedger(1).filter((r) => r.t === 'sample').map((r) => r.t === 'sample' && r.usd)).toEqual([0.4]);
  });

  it('writes nothing under CEZ_USAGE_LOG=0 or for an opted-out account', () => {
    process.env.CEZ_USAGE_LOG = '0';
    recordUsageObservation({ key: 'claude:default' }, obs(10, Date.now()));
    expect(readLedger(1)).toEqual([]);
    delete process.env.CEZ_USAGE_LOG;
    setAccountTracking('claude:work', false);
    recordUsageObservation({ key: 'claude:work' }, obs(10, Date.now()));
    new PlanUsageTracker('claude', { key: 'claude:work' }, { id: 'run:p/a', kind: 'task', title: 'A' }).ui({ type: 'turn.started' });
    // Only the switch's own boundary, never usage.
    expect(readLedger(1).map((r) => r.t === 'tracking' && r.state)).toEqual(['off']);
    recordUsageObservation({ key: 'claude:default' }, obs(12, Date.now()));
    expect(readLedger(1).filter((r) => r.t === 'reading')).toHaveLength(1);
  });

  it('drops day files older than 90 days on write and skips a torn line', () => {
    mkdirSync(ledgerDir(), { recursive: true });
    writeFileSync(join(ledgerDir(), '2020-01-01.ndjson'), '{"t":"end","at":1,"session":"x"}\n');
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(join(ledgerDir(), `${today}.ndjson`), '{"t":"end","at":1,"sess');
    recordUsageObservation({ key: 'claude:default' }, obs(20, Date.now()));
    expect(readdirSync(ledgerDir())).toEqual([`${today}.ndjson`]);
    expect(readLedger(1).map((r) => r.t)).toEqual(['tracking', 'reading']);
  });

  it('marks the off/on boundary and a process start, and survives a restart with the account off', () => {
    recordUsageObservation({ key: 'claude:default' }, obs(30, Date.now()));
    setAccountTracking('claude:default', false);
    resetLedgerCaches(); // a restart: the opt-out is read back from disk
    recordUsageObservation({ key: 'claude:default' }, obs(40, Date.now()));
    expect(readLedger(1).filter((r) => r.t === 'reading')).toHaveLength(1);
    setAccountTracking('claude:default', true);
    setAccountTracking('claude:default', true); // idempotent: no second boundary
    recordUsageObservation({ key: 'claude:default' }, obs(41, Date.now()));
    expect(readLedger(1).flatMap((r) => (r.t === 'tracking' ? [r.state] : r.t === 'reading' ? [`r${r.usedPercent}`] : [])))
      .toEqual(['start', 'r30', 'off', 'on', 'start', 'r41']);
  });

  it('serves the contract shapes, and the tracking switch round-trips', async () => {
    const app = planUsageRoutes();
    recordUsageObservation({ key: 'claude:default' }, obs(25, Date.now()));
    const report = await (await app.request('/workspace/plan-usage?kind=five-hour&intervals=1')).json();
    expect(planUsageReportSchema.parse(report).windows[0]?.usedPercent).toEqual({ first: 25, last: 25 });
    planUsageConsumersResponseSchema.parse(await (await app.request('/workspace/plan-usage/consumers?ids=run:p/a')).json());
    const put = await app.request('/workspace/plan-usage/tracking', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: 'claude:default', enabled: false }) });
    expect(planUsageTrackingSchema.parse(await put.json()).accounts).toEqual({ 'claude:default': false });
    expect((await app.request('/workspace/plan-usage/tracking', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"account":"/etc","enabled":false}' })).status).toBe(400);
  });
});
