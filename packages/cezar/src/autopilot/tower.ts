/**
 * Build a Control Tower snapshot from workspace run indexes + live process usage.
 */
import type {
  AutopilotGovernor,
  TowerRunRow,
  TowerSnapshot,
} from '@open-mercato/cezar-contract';
import { allUsage, type ProcessUsage } from '../core/process-usage.ts';
import { decideGovernor, isLiveStatus } from './governor.ts';

export interface TowerRunSource {
  projectId: string;
  projectName: string;
  runId: string;
  title: string;
  status: string;
  costUsd?: number;
  createdAt: string;
  updatedAt?: string;
}

export interface BuildTowerInput {
  governor: AutopilotGovernor;
  maxParallel: number;
  runs: TowerRunSource[];
  now?: Date;
  usage?: Record<string, ProcessUsage>;
  apply?: boolean;
  extraParallel?: number;
  /** Called when apply=true and an action asks to pause a run. Returns true if paused. */
  pauseRun?: (projectId: string, runId: string, reason: string) => boolean;
}

const HOUR_MS = 60 * 60 * 1000;

export function buildTowerSnapshot(input: BuildTowerInput): TowerSnapshot {
  const now = input.now ?? new Date();
  const usage: Record<string, ProcessUsage> = input.usage ?? allUsage();
  const hourAgo = now.getTime() - HOUR_MS;

  const rows: TowerRunRow[] = input.runs.map((run) => {
    const created = Date.parse(run.createdAt);
    const updated = run.updatedAt ? Date.parse(run.updatedAt) : created;
    const ageMinutes = Math.max(0, (now.getTime() - (Number.isFinite(updated) ? updated : created)) / 60_000);
    const sample = usage[run.runId];
    const stuck =
      isLiveStatus(run.status) &&
      ageMinutes >= (input.governor.stuckAfterMinutes ?? Number.POSITIVE_INFINITY);
    return {
      projectId: run.projectId,
      projectName: run.projectName,
      runId: run.runId,
      title: run.title,
      status: run.status,
      ...(run.costUsd !== undefined ? { costUsd: run.costUsd } : {}),
      createdAt: run.createdAt,
      ...(run.updatedAt ? { updatedAt: run.updatedAt } : {}),
      ...(sample ? { usage: sample } : {}),
      ageMinutes,
      stuck,
    };
  });

  // Spend in the last hour: sum costUsd of runs that touched the window (created or still live).
  let spendUsdLastHour = 0;
  for (const run of rows) {
    const created = Date.parse(run.createdAt);
    if (isLiveStatus(run.status) || (Number.isFinite(created) && created >= hourAgo)) {
      spendUsdLastHour += run.costUsd ?? 0;
    }
  }

  let totalRssMb = 0;
  for (const run of rows) {
    if (!isLiveStatus(run.status) || !run.usage) continue;
    totalRssMb += run.usage.rssBytes / (1024 * 1024);
  }

  const decision = decideGovernor({
    governor: input.governor,
    runs: rows,
    spendUsdLastHour,
    totalRssMb,
    maxParallel: input.maxParallel,
    ...(input.extraParallel !== undefined ? { extraParallel: input.extraParallel } : {}),
  });

  const actions = decision.actions.map((action) => {
    if (!input.apply || action.kind !== 'pause' || !action.runId || !action.projectId || !input.pauseRun) {
      return action;
    }
    const applied = input.pauseRun(action.projectId, action.runId, action.reason);
    return { ...action, applied };
  });

  const running = rows.filter((r) => r.status === 'running').length;
  const queued = rows.filter((r) => r.status === 'queued').length;

  return {
    at: now.toISOString(),
    governor: input.governor,
    running,
    queued,
    spendUsdLastHour,
    spendUsdPerHour: decision.spendUsdPerHour,
    totalRssMb,
    maxParallel: input.maxParallel,
    effectiveMaxParallel: decision.effectiveMaxParallel,
    runs: rows.filter((r) => isLiveStatus(r.status) || r.status === 'queued'),
    actions,
    forecast: decision.forecast,
  };
}
