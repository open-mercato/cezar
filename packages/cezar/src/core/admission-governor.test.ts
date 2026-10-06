import { describe, expect, it } from 'vitest';

import {
  createAdmissionGovernor,
  DEFAULT_GOVERNOR_THRESHOLDS,
  levelForSample,
  reducedCeiling,
  reductionFactor,
  type AdmissionGovernor,
  type AdmissionLevel,
} from './admission-governor.ts';
import type { PressureSample } from './cgroup-pressure.ts';

/**
 * The adaptive admission governor (spec `.ai/specs/2026-09-20-adaptive-admission-governor.md`).
 *
 * The policy is pure on purpose - a pressure sample and a clock in, a level and a ceiling out - so
 * every row of the spec's threshold table, both streaks and the bounded hold are pinned here
 * without a cgroup. Two claims get repeated attention because the spec calls them structural: a
 * reduction only ever goes DOWN (never above the configured ceiling, never below one child) and an
 * unreadable machine fails OPEN to `normal`.
 */

interface Harness {
  governor: AdmissionGovernor;
  /** The fake clock the governor reads; `step()` advances it by one interval. */
  clock: { now: number };
  source: { current: PressureSample | undefined; reads: number; throws: boolean };
  /** Set the next sample, advance one interval, evaluate - the ordinary cadence. */
  step(sample: PressureSample | undefined): AdmissionLevel;
}

/** A governor over a hand-driven clock and sample: no cgroup, no timer, no wall time. */
function harness(options: { intervalMs?: number; maxHoldMs?: number } = {}): Harness {
  const intervalMs = options.intervalMs ?? 1_000;
  const clock = { now: 0 };
  const source = { current: undefined as PressureSample | undefined, reads: 0, throws: false };
  const governor = createAdmissionGovernor({
    sample: () => {
      source.reads += 1;
      if (source.throws) throw new Error('unreadable cgroup');
      return source.current;
    },
    now: () => clock.now,
    intervalMs,
    maxHoldMs: options.maxHoldMs,
  });
  const step = (sample: PressureSample | undefined): AdmissionLevel => {
    source.current = sample;
    clock.now += intervalMs;
    return governor.level();
  };
  return { governor, clock, source, step };
}

describe('levelForSample', () => {
  it('ships the spec threshold table as its default', () => {
    expect(DEFAULT_GOVERNOR_THRESHOLDS).toEqual({
      memoryRatioElevated: 0.85,
      memoryRatioCritical: 0.95,
      memoryPressureElevated: 20,
      memoryPressureCritical: 50,
      cpuPressureElevated: 80,
    });
  });

  it('raises the memory ratio at >= 0.85 (elevated) and >= 0.95 (critical)', () => {
    const rows: [number, AdmissionLevel][] = [
      [0, 'normal'],
      [0.84, 'normal'],
      [0.849_999, 'normal'],
      [0.85, 'elevated'],
      [0.94, 'elevated'],
      [0.949_999, 'elevated'],
      [0.95, 'critical'],
      [0.99, 'critical'],
      [1, 'critical'],
    ];
    for (const [ratio, expected] of rows) {
      expect(levelForSample({ memoryUsedRatio: ratio }), `ratio ${ratio}`).toBe(expected);
    }
  });

  it('raises the PSI rows at 20/50 (memory) and 80 (cpu)', () => {
    const rows: { sample: PressureSample; expected: AdmissionLevel }[] = [
      { sample: { memoryPressureAvg10: 19.99 }, expected: 'normal' },
      { sample: { memoryPressureAvg10: 20 }, expected: 'elevated' },
      { sample: { memoryPressureAvg10: 49.99 }, expected: 'elevated' },
      { sample: { memoryPressureAvg10: 50 }, expected: 'critical' },
      { sample: { memoryPressureAvg10: 100 }, expected: 'critical' },
      { sample: { cpuPressureAvg10: 79.99 }, expected: 'normal' },
      { sample: { cpuPressureAvg10: 80 }, expected: 'elevated' },
      // The CPU row has no `critical`: 100 % stall still lowers the ceiling, it never stops it.
      { sample: { cpuPressureAvg10: 100 }, expected: 'elevated' },
    ];
    for (const { sample, expected } of rows) {
      expect(levelForSample(sample)).toBe(expected);
    }
  });

  it('treats a positive events delta as pressure and a zero delta as none', () => {
    expect(levelForSample({ highEventsDelta: 0 })).toBe('normal');
    expect(levelForSample({ highEventsDelta: 1 })).toBe('elevated');
    expect(levelForSample({ oomKillDelta: 0 })).toBe('normal');
    expect(levelForSample({ oomKillDelta: 1 })).toBe('critical');
    expect(levelForSample({ highEventsDelta: 1, oomKillDelta: 1 })).toBe('critical');
  });

  it('abstains on missing rows and fails open on an unreadable machine', () => {
    expect(levelForSample(undefined)).toBe('normal');
    expect(levelForSample({})).toBe('normal');
    expect(
      levelForSample({
        memoryUsedRatio: undefined,
        highEventsDelta: undefined,
        oomKillDelta: undefined,
        memoryPressureAvg10: undefined,
        cpuPressureAvg10: undefined,
      }),
    ).toBe('normal');
    // A non-finite row is an unreadable row - it must not become pressure.
    expect(levelForSample({ memoryUsedRatio: Number.NaN })).toBe('normal');
  });

  it('lets the worst row win', () => {
    expect(levelForSample({ memoryUsedRatio: 0.86, cpuPressureAvg10: 90 })).toBe('elevated');
    expect(levelForSample({ memoryUsedRatio: 0.86, memoryPressureAvg10: 50 })).toBe('critical');
    expect(levelForSample({ highEventsDelta: 3, memoryUsedRatio: 0.1 })).toBe('elevated');
    expect(levelForSample({ cpuPressureAvg10: 95, memoryPressureAvg10: 21 })).toBe('elevated');
  });

  it('reads the thresholds it is given', () => {
    const thresholds = {
      memoryRatioElevated: 0.5,
      memoryRatioCritical: 0.6,
      memoryPressureElevated: 1,
      memoryPressureCritical: 2,
      cpuPressureElevated: 3,
    };
    expect(levelForSample({ memoryUsedRatio: 0.49 }, thresholds)).toBe('normal');
    expect(levelForSample({ memoryUsedRatio: 0.5 }, thresholds)).toBe('elevated');
    expect(levelForSample({ memoryUsedRatio: 0.6 }, thresholds)).toBe('critical');
    expect(levelForSample({ memoryPressureAvg10: 1 }, thresholds)).toBe('elevated');
    expect(levelForSample({ memoryPressureAvg10: 2 }, thresholds)).toBe('critical');
    expect(levelForSample({ cpuPressureAvg10: 2.9 }, thresholds)).toBe('normal');
    expect(levelForSample({ cpuPressureAvg10: 3 }, thresholds)).toBe('elevated');
  });
});

describe('reductionFactor / reducedCeiling', () => {
  it('leaves normal alone, halves at elevated and quarters at critical', () => {
    expect(reductionFactor('normal')).toBe(1);
    expect(reductionFactor('elevated')).toBe(0.5);
    expect(reductionFactor('critical')).toBe(0.25);
  });

  it('rounds the reduction UP, so a ceiling of 4 means 2 and never 3.5', () => {
    expect(reducedCeiling(4, 'elevated')).toBe(2);
    expect(reducedCeiling(4, 'critical')).toBe(1);
    expect(reducedCeiling(3, 'elevated')).toBe(2); // ceil(1.5)
    expect(reducedCeiling(5, 'critical')).toBe(2); // ceil(1.25)
    expect(reducedCeiling(8, 'elevated')).toBe(4);
    expect(reducedCeiling(8, 'critical')).toBe(2);
    expect(reducedCeiling(7, 'normal')).toBe(7);
  });

  it('never reduces a ceiling below one child', () => {
    expect(reducedCeiling(1, 'elevated')).toBe(1);
    expect(reducedCeiling(1, 'critical')).toBe(1);
    expect(reducedCeiling(2, 'critical')).toBe(1);
    expect(reducedCeiling(3, 'critical')).toBe(1);
  });

  it('answers 1 when the ceiling is not a finite positive number', () => {
    expect(reducedCeiling(0, 'normal')).toBe(1);
    expect(reducedCeiling(0, 'elevated')).toBe(1);
    expect(reducedCeiling(-4, 'critical')).toBe(1);
    expect(reducedCeiling(Number.NaN, 'elevated')).toBe(1);
    expect(reducedCeiling(Number.POSITIVE_INFINITY, 'elevated')).toBe(1);
  });
});

describe('createAdmissionGovernor', () => {
  it('enters elevated on the second consecutive worse sample, not the first', () => {
    const h = harness();
    expect(h.step({ memoryUsedRatio: 0.9 })).toBe('normal');
    expect(h.step({ memoryUsedRatio: 0.9 })).toBe('elevated');
    expect(h.governor.since()).toBe(2_000);
  });

  it('requires the entry streak to be consecutive: an intermittent sample does not enter', () => {
    const h = harness();
    expect(h.step({ memoryUsedRatio: 0.9 })).toBe('normal');
    expect(h.step({})).toBe('normal');
    expect(h.step({ memoryUsedRatio: 0.9 })).toBe('normal');
    expect(h.step({ memoryUsedRatio: 0.9 })).toBe('elevated');
  });

  it('treats oom_kill as critical on the very first sample', () => {
    const h = harness();
    expect(h.step({ oomKillDelta: 1 })).toBe('critical');
    expect(h.governor.since()).toBe(1_000);
    expect(h.governor.effectiveCeiling(8)).toBe(2);
  });

  it('exits to normal after six calm samples, not after five', () => {
    const h = harness();
    h.step({ memoryUsedRatio: 0.9 });
    h.step({ memoryUsedRatio: 0.9 });
    expect(h.governor.level()).toBe('elevated');

    for (let calm = 1; calm <= 5; calm += 1) {
      expect(h.step({}), `calm sample ${calm}`).toBe('elevated');
    }
    expect(h.step({})).toBe('normal');
    expect(h.governor.since()).toBeUndefined();
  });

  it('steps critical down to the level the machine is still at, never straight to normal', () => {
    const h = harness();
    expect(h.step({ oomKillDelta: 1 })).toBe('critical'); // immediate, t=1000
    for (let lower = 1; lower <= 5; lower += 1) {
      expect(h.step({ memoryUsedRatio: 0.9 }), `still-elevated sample ${lower}`).toBe('critical');
    }

    // The sixth merely-lower sample lands on `elevated` - still under pressure, still halved -
    // rather than restoring the full configured ceiling on a machine that never went calm.
    expect(h.step({ memoryUsedRatio: 0.9 })).toBe('elevated');
    expect(h.governor.effectiveCeiling(4)).toBe(2);

    // And the calm exit from there is unchanged: six calm samples restore the ceiling.
    for (let calm = 1; calm <= 5; calm += 1) {
      expect(h.step({}), `calm sample ${calm}`).toBe('elevated');
    }
    expect(h.step({})).toBe('normal');
    expect(h.governor.effectiveCeiling(4)).toBe(4);
  });

  it('samples at most once per intervalMs', () => {
    const h = harness({ intervalMs: 1_000 });
    h.source.current = { memoryUsedRatio: 0.9 };

    expect(h.governor.level()).toBe('normal');
    expect(h.source.reads).toBe(1);
    expect(h.governor.level()).toBe('normal'); // inside the interval: no second read
    expect(h.source.reads).toBe(1);

    h.clock.now += 999;
    expect(h.governor.level()).toBe('normal');
    expect(h.source.reads).toBe(1);

    h.clock.now += 1; // exactly one interval later
    expect(h.governor.level()).toBe('elevated');
    expect(h.source.reads).toBe(2);
  });

  it('lifts a reduction when the hold expires, even short of the exit streak', () => {
    const h = harness({ intervalMs: 1_000, maxHoldMs: 3_000 });
    expect(h.step({ memoryUsedRatio: 0.9 })).toBe('normal');
    expect(h.step({ memoryUsedRatio: 0.9 })).toBe('elevated'); // held since t=2000
    expect(h.step({})).toBe('elevated'); // one calm sample
    expect(h.step({})).toBe('elevated'); // two - far from the six the streak wants
    expect(h.step({})).toBe('normal'); // t=5000: the bounded hold lifts it, not the streak
    expect(h.governor.since()).toBeUndefined();
  });

  it('keeps the reduction while the machine is still pressured past the hold', () => {
    const h = harness({ intervalMs: 1_000, maxHoldMs: 3_000 });
    h.step({ memoryUsedRatio: 0.9 });
    h.step({ memoryUsedRatio: 0.9 });
    for (let pressured = 1; pressured <= 8; pressured += 1) {
      // The hold re-arms instead of forcing `normal`: a still-pressured machine stays reduced.
      expect(h.step({ memoryUsedRatio: 0.9 }), `pressured sample ${pressured}`).toBe('elevated');
    }
  });

  it('fails open when the source returns nothing or throws', () => {
    const quiet = harness();
    expect(quiet.step(undefined)).toBe('normal');
    expect(quiet.governor.effectiveCeiling(4)).toBe(4); // nothing readable, nothing reduced

    const broken = harness();
    broken.source.throws = true;
    expect(() => broken.governor.level()).not.toThrow();
    expect(broken.step(undefined)).toBe('normal');
    expect(broken.governor.effectiveCeiling(4)).toBe(4);
  });

  it('counts unreadable samples toward the exit, so a broken source cannot hold a reduction', () => {
    const h = harness();
    h.step({ memoryUsedRatio: 0.9 });
    h.step({ memoryUsedRatio: 0.9 });
    h.source.throws = true;
    for (let unreadable = 1; unreadable <= 5; unreadable += 1) {
      expect(h.step(undefined), `unreadable sample ${unreadable}`).toBe('elevated');
    }
    expect(h.step(undefined)).toBe('normal');
  });

  it('reset() returns to normal, clears since() and the interval throttle', () => {
    const h = harness();
    expect(h.step({ oomKillDelta: 1 })).toBe('critical');
    expect(h.governor.since()).toBe(1_000);

    h.governor.reset();
    expect(h.governor.since()).toBeUndefined();

    const readsBefore = h.source.reads;
    h.source.current = {};
    expect(h.governor.level()).toBe('normal');
    expect(h.source.reads).toBe(readsBefore + 1);
    expect(h.governor.since()).toBeUndefined();
  });

  it('is the identity at normal and applies the held level to any ceiling it is given', () => {
    const h = harness();
    // With no ceiling set the caller (WorkspaceSemaphore.dispatchAdmissionCeiling) answers null and
    // never asks: `configured` is always a real number here, and normal must answer it unchanged.
    expect(h.governor.effectiveCeiling(8)).toBe(8);

    h.step({ memoryUsedRatio: 0.9 });
    expect(h.governor.effectiveCeiling(8)).toBe(8); // one sample is not a reduction
    h.step({ memoryUsedRatio: 0.9 });
    expect(h.governor.effectiveCeiling(8)).toBe(4);
    // A ceiling lowered while reduced is the new base immediately.
    expect(h.governor.effectiveCeiling(3)).toBe(2);
    expect(h.governor.effectiveCeiling(2)).toBe(1);
    expect(h.governor.effectiveCeiling(1)).toBe(1);

    h.step({ oomKillDelta: 1 });
    expect(h.governor.effectiveCeiling(8)).toBe(2);
    expect(h.governor.effectiveCeiling(4)).toBe(1);
  });

  it('answers exactly the spec formula, never above the ceiling and never below 1', () => {
    const at = (level: AdmissionLevel): AdmissionGovernor => {
      const h = harness();
      if (level === 'elevated') {
        h.step({ memoryUsedRatio: 0.9 });
        h.step({ memoryUsedRatio: 0.9 });
      }
      if (level === 'critical') h.step({ oomKillDelta: 1 });
      return h.governor;
    };

    for (const level of ['normal', 'elevated', 'critical'] as const) {
      const governor = at(level);
      expect(governor.level()).toBe(level);
      for (const configured of [1, 2, 3, 4, 5, 8, 16]) {
        const effective = governor.effectiveCeiling(configured);
        expect(effective, `${level} of ${configured}`).toBe(reducedCeiling(configured, level));
        expect(effective).toBeGreaterThanOrEqual(1);
        expect(effective).toBeLessThanOrEqual(configured);
      }
    }
  });
});
