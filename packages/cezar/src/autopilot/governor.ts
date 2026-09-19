/**
 * Autopilot governor — pure decisions over a tower snapshot of live runs.
 * Side effects (pause, soft-cap) live in the route / RunManager layer.
 */
import type {
  AutopilotGovernor,
  TowerAction,
  TowerForecast,
  TowerRunRow,
} from '@open-mercato/cezar-contract';

export interface GovernorInput {
  governor: AutopilotGovernor;
  runs: TowerRunRow[];
  spendUsdLastHour: number;
  totalRssMb: number;
  maxParallel: number;
  extraParallel?: number;
}

export interface GovernorDecision {
  actions: TowerAction[];
  effectiveMaxParallel: number;
  spendUsdPerHour: number;
  forecast: TowerForecast;
}

/** Running statuses the tower treats as live cost / memory pressure. */
export const LIVE_STATUSES = new Set(['running', 'monitoring', 'waiting']);

export function isLiveStatus(status: string): boolean {
  return LIVE_STATUSES.has(status);
}

export function decideGovernor(input: GovernorInput): GovernorDecision {
  const { governor, runs, spendUsdLastHour, totalRssMb, maxParallel } = input;
  const spendUsdPerHour = spendUsdLastHour;
  const actions: TowerAction[] = [];
  let effectiveMaxParallel = maxParallel;

  const live = runs.filter((r) => isLiveStatus(r.status));

  if (governor.maxSpendUsdPerHour != null && spendUsdPerHour > governor.maxSpendUsdPerHour) {
    actions.push({
      kind: 'warn',
      reason: `spend $${spendUsdPerHour.toFixed(2)}/h exceeds cap $${governor.maxSpendUsdPerHour.toFixed(2)}/h`,
      applied: false,
    });
    if (governor.softMaxParallel != null) {
      effectiveMaxParallel = Math.min(maxParallel, governor.softMaxParallel);
      actions.push({
        kind: 'soft-cap',
        reason: `soft-cap maxParallel → ${effectiveMaxParallel} while over spend`,
        applied: false,
      });
    }
    // Pause the most expensive live run first.
    const heaviest = [...live].sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0))[0];
    if (heaviest) {
      actions.push({
        kind: 'pause',
        runId: heaviest.runId,
        projectId: heaviest.projectId,
        reason: `pause heaviest live run to enforce spend cap`,
        applied: false,
      });
    }
  }

  if (governor.maxRssMbTotal != null && totalRssMb > governor.maxRssMbTotal) {
    actions.push({
      kind: 'warn',
      reason: `RSS ${Math.round(totalRssMb)} MiB exceeds cap ${governor.maxRssMbTotal} MiB`,
      applied: false,
    });
    const fattest = [...live].sort((a, b) => (b.usage?.rssBytes ?? 0) - (a.usage?.rssBytes ?? 0))[0];
    if (fattest) {
      actions.push({
        kind: 'pause',
        runId: fattest.runId,
        projectId: fattest.projectId,
        reason: `pause highest-RSS run to enforce memory cap`,
        applied: false,
      });
    }
  }

  if (governor.stuckAfterMinutes != null) {
    for (const run of live) {
      if (run.ageMinutes >= governor.stuckAfterMinutes || run.stuck) {
        actions.push({
          kind: 'pause',
          runId: run.runId,
          projectId: run.projectId,
          reason: `stuck ≥ ${governor.stuckAfterMinutes} min (age ${Math.round(run.ageMinutes)} min)`,
          applied: false,
        });
      }
    }
  }

  const extraParallel = input.extraParallel ?? 4;
  const liveCount = live.length || 1;
  const avgCostPerRun = spendUsdPerHour / liveCount;
  const avgRssPerRun = totalRssMb / liveCount;
  const projectedUsdPerHour = spendUsdPerHour + avgCostPerRun * extraParallel;
  const projectedRssMb = totalRssMb + avgRssPerRun * extraParallel;

  const forecast: TowerForecast = {
    extraParallel,
    projectedUsdPerHour: Number.isFinite(projectedUsdPerHour) ? projectedUsdPerHour : null,
    projectedRssMb: Number.isFinite(projectedRssMb) ? projectedRssMb : null,
    wouldExceedSpend:
      governor.maxSpendUsdPerHour != null && projectedUsdPerHour > governor.maxSpendUsdPerHour,
    wouldExceedRss: governor.maxRssMbTotal != null && projectedRssMb > governor.maxRssMbTotal,
  };

  return { actions, effectiveMaxParallel, spendUsdPerHour, forecast };
}
