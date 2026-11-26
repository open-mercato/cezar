/**
 * How many settled tasks a project's index keeps, per origin. Automation-launched tasks have their
 * own pool so a busy automation cannot evict the tasks a person started by hand.
 *
 * Resolution, per pool: the workspace setting (Settings → Resources → Task history), else the env
 * var, else the default. Process-wide because the setting is workspace-wide; the semaphore's
 * resource loader pushes it here at boot and after every Settings write.
 */

export const DEFAULT_RUNS_KEPT = 300;
export const DEFAULT_AUTOMATION_RUNS_KEPT = 300;
export const DEFAULT_ARCHIVED_RUNS_KEPT = 500;
export const RUNS_KEPT_MAX = 100_000;

export interface RunRetentionLimits {
  regular: number;
  automation: number;
  archived: number;
}

let configured: { regular?: number; automation?: number } = {};

function validLimit(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1;
}

function envLimit(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

/** Record the workspace settings; an absent or invalid value falls back to env/default. */
export function setConfiguredRunRetention(limits: { regular?: number | null; automation?: number | null }): void {
  configured = {
    ...(validLimit(limits.regular) ? { regular: limits.regular } : {}),
    ...(validLimit(limits.automation) ? { automation: limits.automation } : {}),
  };
}

export function runRetentionLimits(): RunRetentionLimits {
  const pools = effectiveHistoryPools({ runsKept: configured.regular, automationRunsKept: configured.automation });
  return { regular: pools.runsKept, automation: pools.automationRunsKept, archived: envLimit('CEZ_ARCHIVED_RUNS_KEEP', DEFAULT_ARCHIVED_RUNS_KEPT) };
}

/** The pool sizes a workspace `resources` slice resolves to — what Settings shows. */
export function effectiveHistoryPools(resources: { runsKept?: number | null; automationRunsKept?: number | null }): {
  runsKept: number;
  automationRunsKept: number;
} {
  return {
    runsKept: validLimit(resources.runsKept) ? resources.runsKept : envLimit('CEZ_RUNS_KEEP', DEFAULT_RUNS_KEPT),
    automationRunsKept: validLimit(resources.automationRunsKept)
      ? resources.automationRunsKept
      : envLimit('CEZ_AUTOMATION_RUNS_KEEP', DEFAULT_AUTOMATION_RUNS_KEPT),
  };
}
