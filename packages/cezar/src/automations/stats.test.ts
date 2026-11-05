import { describe, expect, it } from 'vitest';
import type { RunRecord } from '../runs/store.ts';
import { automationStats, weekStart } from './stats.ts';
import type { AutomationDefinition, AutomationLogRecord } from './types.ts';

// Wednesday 2026-09-16 10:24 in Europe/Warsaw (CEST, +2) — the design's demo clock.
const NOW = Date.parse('2026-09-16T08:24:00Z');
const WARSAW = 'Europe/Warsaw';
const iso = (ms: number) => new Date(ms).toISOString();
const H = 3_600_000;

const definitions = [
  { id: 'a1', name: 'Nightly', kind: 'schedule' },
  { id: 'a2', name: 'Triage', kind: 'github' },
] as unknown as AutomationDefinition[];

function run(over: Partial<RunRecord> & { id: string }): RunRecord {
  return { title: over.id, status: 'done', workflow: 'quick-task', task: '', steps: [], createdAt: over.startedAt ?? iso(NOW), tokensUsed: 0, ...over } as unknown as RunRecord;
}

const runs: RunRecord[] = [
  // Monday 04:00 Warsaw, done in 20 min, $0.33, launched by the schedule.
  run({ id: 'r1', startedAt: iso(Date.parse('2026-09-14T02:00:00Z')), finishedAt: iso(Date.parse('2026-09-14T02:20:00Z')), costUsd: 0.33, automationTrigger: { automationId: 'a1', automationRevision: 1, receiptId: 'x1', trigger: 'schedule', occurrenceAt: iso(Date.parse('2026-09-14T02:00:00Z')) } }),
  // Tuesday, failed, $0.61, GitHub launch.
  run({ id: 'r2', status: 'failed', startedAt: iso(Date.parse('2026-09-15T05:30:00Z')), finishedAt: iso(Date.parse('2026-09-15T05:40:00Z')), costUsd: 0.61, automation: { automationId: 'a2', automationRevision: 1, receiptId: 'x2', event: 'issue.opened', githubUrl: 'https://github.com/acme/demo/issues/1' } }),
  // Last week's Friday: outside this week, inside 7d? No — 2026-09-11 is 5 days ago, so inside 7d but outside the week.
  run({ id: 'r3', startedAt: iso(Date.parse('2026-09-11T14:00:00Z')), finishedAt: iso(Date.parse('2026-09-11T15:00:00Z')), costUsd: 1.12, automationTrigger: { automationId: 'a1', automationRevision: 1, receiptId: 'x3', trigger: 'schedule', occurrenceAt: iso(Date.parse('2026-09-11T14:00:00Z')) } }),
  // Still running, started an hour ago, no cost yet.
  run({ id: 'r4', status: 'running', startedAt: iso(NOW - H), automation: { automationId: 'a2', automationRevision: 1, receiptId: 'x4', event: 'issue.opened', githubUrl: 'https://github.com/acme/demo/issues/2' } }),
  // A plain task with no provenance — never counted.
  run({ id: 'r5', startedAt: iso(NOW - H), finishedAt: iso(NOW), costUsd: 9 }),
];

const logs: AutomationLogRecord[] = [
  { seq: 1, ts: iso(Date.parse('2026-09-11T14:00:00Z')), automationId: 'a1', revision: 1, result: 'launched', runId: 'r3' },
  { seq: 2, ts: iso(Date.parse('2026-09-14T02:00:00Z')), automationId: 'a1', revision: 1, result: 'launched', runId: 'r1' },
  { seq: 3, ts: iso(Date.parse('2026-09-15T05:30:00Z')), automationId: 'a2', revision: 1, result: 'launched', runId: 'r2' },
  { seq: 4, ts: iso(NOW - H), automationId: 'a2', revision: 1, result: 'launched', runId: 'r4' },
  { seq: 5, ts: iso(NOW - 10 * 60_000), automationId: 'a2', revision: 1, result: 'no-match' },
  // Older than 7 days: not in runs7d.
  { seq: 0, ts: iso(NOW - 8 * 24 * H), automationId: 'a1', revision: 1, result: 'launched', runId: 'r0' },
];

describe('weekStart', () => {
  it('is Monday 00:00 in the zone', () => {
    expect(iso(weekStart(NOW, WARSAW))).toBe('2026-09-13T22:00:00.000Z');
    // Sunday 23:30 Warsaw still belongs to the week that began the Monday before.
    expect(iso(weekStart(Date.parse('2026-09-20T21:30:00Z'), WARSAW))).toBe('2026-09-13T22:00:00.000Z');
  });

  it('falls back to a rolling week for an unknown zone', () => {
    expect(weekStart(NOW, 'Mars/Olympus')).toBe(NOW - 7 * 24 * H);
  });
});

describe('automationStats', () => {
  it('sums this week from provenance-linked runs and rolls 7 days per row', () => {
    const result = automationStats({ definitions, logs, runs, now: NOW, timeZone: WARSAW, costMetrics: true });
    // This week: r1 (20 min), r2 (10 min, failed), r4 (60 min so far). r3 is last week, r5 is nobody's.
    expect(result.week).toEqual({ runs: 3, failed: 1, agentSeconds: 90 * 60, costUsd: 0.94 });
    expect(result.rows.get('a1')).toEqual({
      runs7d: 2,
      costUsd7d: 1.45,
      lastRun: { runId: 'r1', status: 'done', ts: iso(Date.parse('2026-09-14T02:00:00Z')), costUsd: 0.33 },
    });
    expect(result.rows.get('a2')).toEqual({
      runs7d: 2,
      costUsd7d: 0.61,
      lastRun: { runId: 'r4', status: 'running', ts: iso(NOW - H) },
    });
  });

  it('drops every dollar figure when cost metrics are off', () => {
    const result = automationStats({ definitions, logs, runs, now: NOW, timeZone: WARSAW, costMetrics: false });
    expect(result.week).toEqual({ runs: 3, failed: 1, agentSeconds: 90 * 60 });
    expect(result.rows.get('a1')).toEqual({ runs7d: 2, lastRun: { runId: 'r1', status: 'done', ts: iso(Date.parse('2026-09-14T02:00:00Z')) } });
  });

  describe('agent time and retained history (#1957)', () => {
    const trigger = (automationId: string) => ({
      automationTrigger: { automationId, automationRevision: 1, receiptId: `x-${automationId}`, trigger: 'schedule', occurrenceAt: iso(NOW - 2 * H) },
    }) as Partial<RunRecord>;
    const week = (only: RunRecord[], defs: AutomationDefinition[] = definitions) =>
      automationStats({ definitions: defs, logs: [], runs: only, now: NOW, timeZone: WARSAW, costMetrics: false }).week;

    it('counts a queued run that never started, but adds no agent time', () => {
      expect(week([run({ id: 'q', status: 'queued', createdAt: iso(NOW - 2 * H), ...trigger('a1') })]))
        .toEqual({ runs: 1, failed: 0, agentSeconds: 0 });
    });

    it('never goes backwards when queued work starts', () => {
      const queued = week([run({ id: 'q', status: 'queued', createdAt: iso(NOW - 2 * H), ...trigger('a1') })]);
      const admitted = week([run({ id: 'q', status: 'running', createdAt: iso(NOW - 2 * H), startedAt: iso(NOW - 30 * 60_000), ...trigger('a1') })]);
      expect(admitted.agentSeconds).toBe(30 * 60);
      expect(admitted.agentSeconds).toBeGreaterThanOrEqual(queued.agentSeconds);
    });

    it('adds no agent time for a run cancelled before it started', () => {
      expect(week([run({ id: 'c', status: 'cancelled', createdAt: iso(NOW - 2 * H), finishedAt: iso(NOW), ...trigger('a1') })]))
        .toEqual({ runs: 1, failed: 0, agentSeconds: 0 });
    });

    it('keeps the measured time of a run cancelled after it started', () => {
      const cancelled = run({ id: 'c', status: 'cancelled', createdAt: iso(NOW - 2 * H), startedAt: iso(NOW - H), finishedAt: iso(NOW - 50 * 60_000), ...trigger('a1') });
      expect(week([cancelled]).agentSeconds).toBe(10 * 60);
    });

    it('still places a never-started run in the week it was created', () => {
      expect(week([run({ id: 'old', status: 'queued', createdAt: iso(Date.parse('2026-09-11T14:00:00Z')), ...trigger('a1') })]).runs).toBe(0);
    });

    it('keeps the history of a removed or replaced automation in the week total', () => {
      const retired = run({ id: 'r', status: 'done', startedAt: iso(NOW - 2 * H), finishedAt: iso(NOW - 90 * 60_000), costUsd: 0.5, ...trigger('gone') });
      expect(week([retired], [])).toEqual({ runs: 1, failed: 0, agentSeconds: 30 * 60 });
      const result = automationStats({ definitions: [], logs: [], runs: [retired], now: NOW, timeZone: WARSAW, costMetrics: true });
      expect(result.week.costUsd).toBe(0.5);
      expect(result.rows.size).toBe(0); // no row for a definition that no longer exists
    });
  });

  it('answers zeros for an automation that never launched', () => {
    const result = automationStats({ definitions: [{ id: 'new' } as AutomationDefinition], logs: [], runs: [], now: NOW, timeZone: WARSAW, costMetrics: true });
    expect(result.week).toEqual({ runs: 0, failed: 0, agentSeconds: 0, costUsd: 0 });
    expect(result.rows.get('new')).toEqual({ runs7d: 0, costUsd7d: 0 });
  });
});
