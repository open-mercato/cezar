import { mkdtempSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planUsageReportSchema, planUsageConsumersResponseSchema, planUsageTrackingSchema } from '@open-mercato/cezar-contract';
import { PlanUsageTracker, recordUsageObservation } from './recorder.ts';
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
