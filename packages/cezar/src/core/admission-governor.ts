import type { PressureSample, PressureSource } from './cgroup-pressure.ts';

/**
 * The adaptive admission governor (spec
 * `.ai/specs/2026-09-20-adaptive-admission-governor.md`): a REDUCTION layer under the user's own
 * `dispatchMaxConcurrent` ceiling.
 *
 * This module is the whole policy, and it is pure: pressure sample in, level out. Everything that
 * makes it safe is therefore testable without a cgroup, and everything that makes it unsafe is
 * visible in one file:
 *
 * 1. **Reduction only.** The factor is 1, 1/2 or 1/4 applied to the CONFIGURED ceiling - never a
 *    ceiling of its own, never above it, and never below one child (`ceil` + a floor of 1).
 * 2. **Fail-open.** An unreadable machine (`undefined` sample) is `normal`. Admission must not
 *    depend on telemetry being available.
 * 3. **Hysteresis with a bounded hold.** Entering a worse level needs consecutive agreement (except
 *    `oom_kill`, which is critical at once); leaving needs more calm samples than entering did; and
 *    any reduction lifts after at most `maxHoldMs` if the machine is calm by then - a governor that
 *    cannot lift is a new cap, which is the failure this rule forbids.
 * 4. **Lazy.** Evaluated on demand, at most once per interval. No timer, no daemon, no cost while
 *    nothing dispatches.
 */

export type AdmissionLevel = 'normal' | 'elevated' | 'critical';

export interface GovernorThresholds {
  memoryRatioElevated: number;
  memoryRatioCritical: number;
  memoryPressureElevated: number;
  memoryPressureCritical: number;
  cpuPressureElevated: number;
}

/** Deliberately conservative: half the ceiling at 85 % of a memory limit is already a big step. */
export const DEFAULT_GOVERNOR_THRESHOLDS: GovernorThresholds = {
  memoryRatioElevated: 0.85,
  memoryRatioCritical: 0.95,
  memoryPressureElevated: 20,
  memoryPressureCritical: 50,
  cpuPressureElevated: 80,
};

/** Lazy evaluation cadence - two seconds, the same order as the telemetry sampler. */
export const GOVERNOR_SAMPLE_INTERVAL_MS = 2_000;
/** A reduction lifts by itself after this long, if the machine is calm by then. */
export const GOVERNOR_MAX_HOLD_MS = 10 * 60_000;
export const GOVERNOR_ENTER_STREAK = 2;
export const GOVERNOR_EXIT_STREAK = 6;

const RANK: Record<AdmissionLevel, number> = { normal: 0, elevated: 1, critical: 2 };

/** The level a single sample argues for. Missing rows abstain; no sample is `normal` (fail-open). */
export function levelForSample(
  sample: PressureSample | undefined,
  thresholds: GovernorThresholds = DEFAULT_GOVERNOR_THRESHOLDS,
): AdmissionLevel {
  if (sample === undefined) return 'normal';
  let level: AdmissionLevel = 'normal';
  const raise = (next: AdmissionLevel): void => {
    if (RANK[next] > RANK[level]) level = next;
  };

  if (sample.memoryUsedRatio !== undefined) {
    if (sample.memoryUsedRatio >= thresholds.memoryRatioCritical) raise('critical');
    else if (sample.memoryUsedRatio >= thresholds.memoryRatioElevated) raise('elevated');
  }
  // A throttle event is pressure by definition; a kill is already an outcome.
  if (sample.highEventsDelta !== undefined && sample.highEventsDelta > 0) raise('elevated');
  if (sample.oomKillDelta !== undefined && sample.oomKillDelta > 0) raise('critical');
  if (sample.memoryPressureAvg10 !== undefined) {
    if (sample.memoryPressureAvg10 >= thresholds.memoryPressureCritical) raise('critical');
    else if (sample.memoryPressureAvg10 >= thresholds.memoryPressureElevated) raise('elevated');
  }
  if (sample.cpuPressureAvg10 !== undefined && sample.cpuPressureAvg10 >= thresholds.cpuPressureElevated) {
    raise('elevated');
  }
  return level;
}

/** The reduction factor for a level: 1, 1/2 or 1/4. */
export function reductionFactor(level: AdmissionLevel): number {
  return level === 'elevated' ? 0.5 : level === 'critical' ? 0.25 : 1;
}

/** `ceil(configured * factor)`, never below 1: a ceiling of 4 must mean 2, not 3.5 and never 0. */
export function reducedCeiling(configured: number, level: AdmissionLevel): number {
  if (!Number.isFinite(configured) || configured <= 0) return 1;
  return Math.max(1, Math.ceil(configured * reductionFactor(level)));
}

export interface AdmissionGovernorOptions {
  sample: PressureSource;
  now?: () => number;
  thresholds?: GovernorThresholds;
  intervalMs?: number;
  maxHoldMs?: number;
  enterStreak?: number;
  exitStreak?: number;
}

export interface AdmissionGovernor {
  /** Advance lazily and answer the level. */
  level(): AdmissionLevel;
  /** When the current non-normal level began, in ms since epoch. */
  since(): number | undefined;
  /** The ceiling to enforce for a configured one. */
  effectiveCeiling(configured: number): number;
  /** For tests and restarts: back to `normal` with no history. */
  reset(): void;
}

export function createAdmissionGovernor(options: AdmissionGovernorOptions): AdmissionGovernor {
  const now = options.now ?? Date.now;
  const thresholds = options.thresholds ?? DEFAULT_GOVERNOR_THRESHOLDS;
  const intervalMs = options.intervalMs ?? GOVERNOR_SAMPLE_INTERVAL_MS;
  const maxHoldMs = options.maxHoldMs ?? GOVERNOR_MAX_HOLD_MS;
  const enterStreak = options.enterStreak ?? GOVERNOR_ENTER_STREAK;
  const exitStreak = options.exitStreak ?? GOVERNOR_EXIT_STREAK;

  let level: AdmissionLevel = 'normal';
  let since: number | undefined;
  let heldSince: number | undefined;
  let checkedAt: number | undefined;
  let upStreak = 0;
  let downStreak = 0;

  const apply = (next: AdmissionLevel, at: number): void => {
    if (next === level) return;
    level = next;
    upStreak = 0;
    downStreak = 0;
    if (next === 'normal') {
      since = undefined;
      heldSince = undefined;
    } else {
      since = at;
      heldSince = at;
    }
  };

  const refresh = (): void => {
    const at = now();
    if (checkedAt !== undefined && at - checkedAt < intervalMs) return;
    checkedAt = at;

    let sample: PressureSample | undefined;
    try {
      sample = options.sample();
    } catch {
      sample = undefined; // fail-open: a throwing source is an unreadable machine
    }
    const target = levelForSample(sample, thresholds);
    const immediate = sample?.oomKillDelta !== undefined && sample.oomKillDelta > 0;

    // The bounded hold: once it expires, the hysteresis is skipped for one evaluation, so a calm
    // machine lifts immediately and a still-pressured one simply stays where it is (with a fresh
    // hold window).
    const holdExpired =
      level !== 'normal' && heldSince !== undefined && at - heldSince >= maxHoldMs;
    if (holdExpired) {
      upStreak = 0;
      downStreak = 0;
      apply(target, at);
      if (level !== 'normal') heldSince = at;
      return;
    }

    if (target === level) {
      upStreak = 0;
      downStreak = 0;
      return;
    }
    if (RANK[target] > RANK[level]) {
      downStreak = 0;
      upStreak += 1;
      if (immediate || upStreak >= enterStreak) apply(target, at);
      return;
    }
    upStreak = 0;
    downStreak += 1;
    // Step down to where the machine actually is, never past it: `critical` leaving needs six
    // merely-lower samples to reach `elevated`, not to restore the full ceiling outright. The
    // bounded-hold exit above already does this.
    if (downStreak >= exitStreak) apply(target, at);
  };

  return {
    level() {
      refresh();
      return level;
    },
    since: () => since,
    effectiveCeiling(configured: number) {
      refresh();
      return reducedCeiling(configured, level);
    },
    reset() {
      level = 'normal';
      since = undefined;
      heldSince = undefined;
      checkedAt = undefined;
      upStreak = 0;
      downStreak = 0;
    },
  };
}
