import { zonedParts, zonedWallTimeToUtc } from '@open-mercato/cezar-contract';
import type { RunRecord } from '../runs/store.ts';
import type { AutomationDefinition, AutomationLogRecord } from './types.ts';

/**
 * The Automations list's numbers (spec 2026-09-14-automations-redesign § API), derived — never
 * stored — from the execution log and the run records an automation launched. Two windows:
 *
 *  - the header strip is THIS WEEK: Monday 00:00 in the cockpit's zone up to now;
 *  - each row's `runs7d` / `costUsd7d` is a rolling 7 × 24 h.
 *
 * A run belongs to an automation through its provenance: `automation` (a GitHub launch) or
 * `automationTrigger` (a scheduled one). `costMetrics` off drops every dollar figure from the
 * answer rather than answering 0 — absent means "not shown", 0 would be a claim.
 */

const LAUNCH_RESULTS = new Set<AutomationLogRecord['result']>(['launched', 'manual', 'catch-up']);
const WEEK_MS = 7 * 24 * 60 * 60_000;

export interface AutomationStatsInput {
  definitions: readonly AutomationDefinition[];
  /** Every log row of the project the caller could read (the store caps a read at 100 per call,
   *  so pass the per-automation reads concatenated). */
  logs: readonly AutomationLogRecord[];
  runs: readonly RunRecord[];
  now: number;
  timeZone: string;
  costMetrics: boolean;
}

export interface AutomationRowStats {
  runs7d: number;
  costUsd7d?: number;
  lastRun?: { runId: string; status: RunRecord['status']; ts: string; costUsd?: number };
}

export interface AutomationStatsResult {
  week: { runs: number; failed: number; agentSeconds: number; costUsd?: number };
  rows: Map<string, AutomationRowStats>;
}

function automationIdOf(run: RunRecord): string | undefined {
  return run.automation?.automationId ?? run.automationTrigger?.automationId;
}

/** Monday 00:00 of the current week in the zone; falls back to a rolling 7 days for an unknown zone. */
export function weekStart(now: number, timeZone: string): number {
  const parts = zonedParts(now, timeZone);
  if (!parts) return now - WEEK_MS;
  const monday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day - (parts.weekday - 1)));
  return zonedWallTimeToUtc(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate(), 0, 0, timeZone) ?? now - WEEK_MS;
}

export function automationStats(input: AutomationStatsInput): AutomationStatsResult {
  const { now, costMetrics } = input;
  const ids = new Set(input.definitions.map((definition) => definition.id));
  const runsById = new Map(input.runs.map((run) => [run.id, run] as const));
  const since7d = now - WEEK_MS;
  const sinceWeek = weekStart(now, input.timeZone);

  // The header strip: every run launched by one of this project's automations this week.
  let runs = 0;
  let failed = 0;
  let agentMs = 0;
  let cost = 0;
  for (const run of input.runs) {
    const automationId = automationIdOf(run);
    if (!automationId || !ids.has(automationId)) continue;
    const startedAt = Date.parse(run.startedAt ?? run.createdAt);
    if (!Number.isFinite(startedAt) || startedAt < sinceWeek) continue;
    runs += 1;
    if (run.status === 'failed') failed += 1;
    const finishedAt = run.finishedAt ? Date.parse(run.finishedAt) : now;
    if (Number.isFinite(finishedAt) && finishedAt > startedAt) agentMs += finishedAt - startedAt;
    if (typeof run.costUsd === 'number') cost += run.costUsd;
  }

  // Per row: launches from the log in the last 7 days, joined to their runs for cost and status.
  const rows = new Map<string, AutomationRowStats>();
  for (const definition of input.definitions) {
    const launches = input.logs
      .filter((row) => row.automationId === definition.id && LAUNCH_RESULTS.has(row.result) && row.runId)
      .sort((a, b) => b.seq - a.seq);
    const recent = launches.filter((row) => Date.parse(row.ts) >= since7d);
    let cost7d = 0;
    for (const row of recent) {
      const run = runsById.get(row.runId!);
      if (run && typeof run.costUsd === 'number') cost7d += run.costUsd;
    }
    const newest = launches[0];
    const newestRun = newest ? runsById.get(newest.runId!) : undefined;
    rows.set(definition.id, {
      runs7d: recent.length,
      ...(costMetrics ? { costUsd7d: round(cost7d) } : {}),
      ...(newest && newestRun
        ? {
            lastRun: {
              runId: newestRun.id,
              status: newestRun.status,
              ts: newest.ts,
              ...(costMetrics && typeof newestRun.costUsd === 'number' ? { costUsd: newestRun.costUsd } : {}),
            },
          }
        : {}),
    });
  }

  return {
    week: {
      runs,
      failed,
      agentSeconds: Math.round(agentMs / 1_000),
      ...(costMetrics ? { costUsd: round(cost) } : {}),
    },
    rows,
  };
}

function round(usd: number): number {
  return Math.round(usd * 100) / 100;
}
