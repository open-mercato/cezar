import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAdmissionGovernor, type AdmissionGovernor } from '../core/admission-governor.ts';
import { admissionStatusSnapshot } from '../core/admission-status.ts';
import type { PressureSample } from '../core/cgroup-pressure.ts';
import {
  WorkspaceSemaphore,
  type SemaphoreParticipant,
  type WorkspaceResourceLimits,
} from './semaphore.ts';

/** Unit surface of the shared workspace semaphore (spec 2026-07-20, step 2.5).
 *  The cross-manager scheduling behavior (cap across projects, the #347
 *  waiting-resume exemption, refresh-without-restart) lives in
 *  src/workflows/workspace-semaphore.test.ts against real RunManagers. */
describe('WorkspaceSemaphore', () => {
  const participant = (
    busy: number,
    queuedAt: number | null = null,
  ): SemaphoreParticipant & { pumped: number[] } => {
    const p = {
      pumped: [] as number[],
      busySlots: () => busy,
      oldestQueuedAt: () => queuedAt,
      pump: () => {
        p.pumped.push(Date.now());
      },
    };
    return p;
  };

  it('defaults to the workspace schema defaults before any refresh', () => {
    const sem = new WorkspaceSemaphore();
    expect(sem.maxParallel()).toBe(2);
    expect(sem.memoryLimitMb()).toBeNull();
    expect(sem.monitoringWakeIntervalMinutes()).toBe(5); // #810 — monitoring must self-resume
    expect(sem.busy()).toBe(0);
    expect(sem.dispatchMaxConcurrent()).toBeNull(); // no cap — today's behavior
    expect(sem.dispatchBusy()).toBe(0);
  });

  /**
   * The dispatch admission cap rides the same cache as `maxParallel` (spec
   * 2026-09-20-dispatch-admission-scheduler): additive, answered from the snapshot, and summed
   * across every manager so a fan-out in one project cannot spend another project's budget.
   * Absent and `null` both mean "no cap"; an explicit `0` is the operator having chosen it and
   * must survive as a number rather than collapsing into the absent case.
   */
  it('answers the cached dispatch cap, keeping an explicit 0 distinct from an absent key', () => {
    expect(new WorkspaceSemaphore({ initial: { dispatchMaxConcurrent: 3 } }).dispatchMaxConcurrent()).toBe(3);
    expect(new WorkspaceSemaphore({ initial: { dispatchMaxConcurrent: 0 } }).dispatchMaxConcurrent()).toBe(0);
    expect(new WorkspaceSemaphore({ initial: { dispatchMaxConcurrent: null } }).dispatchMaxConcurrent()).toBeNull();
    // A loader that predates the key (its `WorkspaceResourceLimits` omits it) reads as "no cap".
    expect(new WorkspaceSemaphore({ initial: { maxParallel: 2, memoryLimitMb: null } }).dispatchMaxConcurrent()).toBeNull();
  });

  /**
   * The adaptive admission governor (spec 2026-09-20-adaptive-admission-governor): a REDUCTION
   * layer under the configured dispatch ceiling. `dispatchMaxConcurrent()` keeps answering the
   * CONFIGURED value - the settings API reads the user's own number back - while
   * `dispatchAdmissionCeiling()` is the effective one the per-candidate gate in `workflows/run.ts`
   * enforces, and `admissionStatus()` is the readout the telemetry sampler reports.
   *
   * With no ceiling there is nothing to reduce, so the ceiling and the status both stay absent and
   * the zero-config path does not change. The levels below are produced by the SHIPPED policy
   * (`createAdmissionGovernor`) with an injected sample and clock, so this suite pins the wiring
   * rather than restating the thresholds.
   */
  describe('adaptive admission ceiling (governor wiring)', () => {
    /** The real governor, driven by a mutable sample and clock: `intervalMs: 0` re-evaluates on
     *  every read and `enterStreak: 1` makes a level observable immediately. */
    const governorAt = (
      sample: () => PressureSample | undefined,
      clock: { now: number },
    ): AdmissionGovernor =>
      createAdmissionGovernor({ sample, now: () => clock.now, intervalMs: 0, enterStreak: 1 });

    const governed = (
      initial: Partial<WorkspaceResourceLimits>,
      governor: AdmissionGovernor,
    ): WorkspaceSemaphore => new WorkspaceSemaphore({ initial, governor });

    it('no configured ceiling (absent, null, or the explicit 0): no reduction, no status', () => {
      // Absent key: the zero-config workspace, and any loader that predates the ceiling.
      const bare = new WorkspaceSemaphore();
      expect(bare.dispatchMaxConcurrent()).toBeNull();
      expect(bare.dispatchAdmissionCeiling()).toBeNull();
      expect(bare.admissionStatus()).toBeUndefined();
      expect(admissionStatusSnapshot()).toBeUndefined();

      // `0` is the operator's own "no cap" spelling and must survive as a number here - it also
      // must NOT reach the governor, which would answer a ceiling of 1 for it.
      for (const dispatchMaxConcurrent of [null, 0]) {
        const sem = new WorkspaceSemaphore({ initial: { maxParallel: 4, dispatchMaxConcurrent } });
        expect(sem.dispatchMaxConcurrent()).toBe(dispatchMaxConcurrent);
        expect(sem.dispatchAdmissionCeiling()).toBeNull();
        expect(sem.admissionStatus()).toBeUndefined();
        expect(admissionStatusSnapshot()).toBeUndefined();
      }
    });

    it('reduces the CONFIGURED ceiling by the governor level: 4 -> 4 / 2 / 1, with a status per level', () => {
      const clock = { now: 1_700_000_000_000 };
      let sample: PressureSample | undefined = { memoryUsedRatio: 0.2 };
      const sem = governed(
        { maxParallel: 8, dispatchMaxConcurrent: 4 },
        governorAt(() => sample, clock),
      );

      // Calm: the ceiling is the configured one, and a normal state has no `since`.
      expect(sem.dispatchMaxConcurrent()).toBe(4);
      expect(sem.dispatchAdmissionCeiling()).toBe(4);
      expect(sem.admissionStatus()).toEqual({ state: 'normal', configured: 4, effective: 4 });

      // Elevated (>= 85 % of the memory limit): half the ceiling...
      clock.now += 5_000;
      sample = { memoryUsedRatio: 0.9 };
      expect(sem.dispatchAdmissionCeiling()).toBe(2);
      expect(sem.admissionStatus()).toEqual({
        state: 'elevated',
        configured: 4,
        effective: 2,
        since: new Date(1_700_000_005_000).toISOString(),
      });
      // ...and the telemetry read (the provider registered in the constructor) is the same readout.
      expect(admissionStatusSnapshot()).toEqual(sem.admissionStatus());

      // Critical (>= 95 %): a quarter, floored at one child.
      clock.now += 5_000;
      sample = { memoryUsedRatio: 0.99 };
      expect(sem.dispatchAdmissionCeiling()).toBe(1);
      expect(sem.admissionStatus()).toEqual({
        state: 'critical',
        configured: 4,
        effective: 1,
        since: new Date(1_700_000_010_000).toISOString(),
      });

      // The settings value never moves with the machine - the split #1034's API depends on.
      expect(sem.dispatchMaxConcurrent()).toBe(4);
    });

    it('a ceiling of 1 stays 1 under critical - a dispatch child is never starved to zero', () => {
      const sem = governed(
        { maxParallel: 4, dispatchMaxConcurrent: 1 },
        governorAt(() => ({ memoryUsedRatio: 0.99 }), { now: 1_700_000_000_000 }),
      );
      expect(sem.dispatchMaxConcurrent()).toBe(1);
      expect(sem.dispatchAdmissionCeiling()).toBe(1);
      expect(sem.admissionStatus()).toMatchObject({ state: 'critical', configured: 1, effective: 1 });
    });

    it('a per-manager fallback never blanks the readout of the semaphore that is enforcing', () => {
      const real = governed(
        { maxParallel: 8, dispatchMaxConcurrent: 4 },
        governorAt(() => ({ memoryUsedRatio: 0.99 }), { now: 1_700_000_000_000 }),
      );
      expect(admissionStatusSnapshot()).toMatchObject({ state: 'critical', configured: 4 });

      // `RunManager` without an injected semaphore constructs its own. It has no workspace ceiling
      // to report, and the registration slot is last-writer-wins - so it must not register at all,
      // or the `admission` key would vanish from telemetry while the real governor keeps reducing.
      const fallback = new WorkspaceSemaphore({ registersAdmissionStatus: false });
      expect(fallback.admissionStatus()).toBeUndefined();
      expect(admissionStatusSnapshot()).toMatchObject({ state: 'critical', configured: 4 });
      expect(real.dispatchAdmissionCeiling()).toBe(1);
    });

    it('clearing the ceiling mid-reduction drops the reduction with it; a new ceiling re-bases', async () => {
      const clock = { now: 1_700_000_000_000 };
      let configured: number | null = 4;
      const sem = new WorkspaceSemaphore({
        load: () =>
          Promise.resolve({ maxParallel: 8, memoryLimitMb: null, dispatchMaxConcurrent: configured }),
        initial: { maxParallel: 8, dispatchMaxConcurrent: 4 },
        governor: governorAt(() => ({ memoryUsedRatio: 0.99 }), clock),
      });
      expect(sem.dispatchAdmissionCeiling()).toBe(1); // configured 4, critical

      // The operator clears the ceiling while the governor is still critical (the PUT
      // /workspace/config path): the reduction must be DROPPED, not held without a ceiling.
      configured = null;
      await sem.refresh();
      expect(sem.dispatchMaxConcurrent()).toBeNull();
      expect(sem.dispatchAdmissionCeiling()).toBeNull();
      expect(sem.admissionStatus()).toBeUndefined();
      expect(admissionStatusSnapshot()).toBeUndefined();

      // A new ceiling is the base immediately - still critical, so 8 reduces to 2 - never the old
      // one's effective value.
      configured = 8;
      await sem.refresh();
      expect(sem.dispatchAdmissionCeiling()).toBe(2);
      expect(sem.admissionStatus()).toMatchObject({ state: 'critical', configured: 8, effective: 2 });
    });
  });

  it('sums dispatchBusy across participants and tolerates stubs without the member', () => {
    const sem = new WorkspaceSemaphore({ initial: { dispatchMaxConcurrent: 3 } });
    // A participant from before the key existed — `dispatchBusy` simply absent.
    sem.register(participant(1));
    sem.register({ ...participant(1), dispatchBusy: () => 2 });
    sem.register({ ...participant(1), dispatchBusy: () => 1 });
    expect(sem.dispatchBusy()).toBe(3);
    expect(sem.busy()).toBe(3); // the two counters stay independent
  });

  /** #810 — the getter used to be `?? null`. Flipping the default to 5 made that a trap:
   *  `null ?? 5` is 5, which would have silently overridden every operator who chose
   *  "Park until resumed". Absent and null must therefore answer differently. */
  describe('monitoringWakeIntervalMinutes: absent vs. explicit null (#810)', () => {
    it('falls back to the shipped default only when the key is ABSENT', () => {
      const sem = new WorkspaceSemaphore({ initial: { maxParallel: 2, monitoringWakeIntervalMinutes: undefined } });
      expect(sem.monitoringWakeIntervalMinutes()).toBe(5);
    });

    it('preserves an explicit null (park until resumed)', () => {
      const sem = new WorkspaceSemaphore({ initial: { monitoringWakeIntervalMinutes: null } });
      expect(sem.monitoringWakeIntervalMinutes()).toBeNull();
    });

    it('preserves an explicit cadence', () => {
      const sem = new WorkspaceSemaphore({ initial: { monitoringWakeIntervalMinutes: 12 } });
      expect(sem.monitoringWakeIntervalMinutes()).toBe(12);
    });

    it('a refresh that reports null parks, and one that reports a number re-arms', async () => {
      let wake: number | null = null;
      const sem = new WorkspaceSemaphore({
        load: () => Promise.resolve({ maxParallel: 2, memoryLimitMb: null, monitoringWakeIntervalMinutes: wake }),
      });
      await sem.refresh();
      expect(sem.monitoringWakeIntervalMinutes()).toBeNull();
      wake = 9;
      await sem.refresh();
      expect(sem.monitoringWakeIntervalMinutes()).toBe(9);
    });
  });

  it('honors an initial override (test seam)', () => {
    const sem = new WorkspaceSemaphore({ initial: { maxParallel: 5, memoryLimitMb: 512 } });
    expect(sem.maxParallel()).toBe(5);
    expect(sem.memoryLimitMb()).toBe(512);
  });

  it('accountHolds() unions every participant by kind, and is empty for stubs that hold none', () => {
    // A usage limit closes an ACCOUNT, and one account can drive tasks in several projects, so
    // the hold spans managers the way the parallel cap does (spec
    // 2026-08-03-auto-resume-after-usage-limit). The two kinds bind different work, so they are
    // aggregated separately. `accountHolds` is optional on the participant, so a stub that
    // predates it — like the ones above — simply holds nothing.
    const sem = new WorkspaceSemaphore();
    expect(sem.accountHolds().deadline.size + sem.accountHolds().inFlight.size).toBe(0);

    sem.register(participant(0));
    const offA = sem.register({
      ...participant(0),
      accountHolds: () => ({ deadline: new Set(['claude:default']), inFlight: new Set<string>() }),
    });
    sem.register({
      ...participant(0),
      accountHolds: () => ({
        deadline: new Set(['codex:work']),
        inFlight: new Set(['claude:second']),
      }),
    });
    expect([...sem.accountHolds().deadline].sort()).toEqual(['claude:default', 'codex:work'])
    expect([...sem.accountHolds().inFlight]).toEqual(['claude:second'])

    // A torn-down project stops holding the workspace's queue with it.
    offA()
    expect([...sem.accountHolds().deadline]).toEqual(['codex:work'])
  })


  it('busy() sums every registered participant; unregister stops counting', () => {
    const sem = new WorkspaceSemaphore();
    const a = participant(2);
    const b = participant(1);
    const offA = sem.register(a);
    sem.register(b);
    expect(sem.busy()).toBe(3);
    offA();
    expect(sem.busy()).toBe(1);
  });

  it('refresh() swaps the cached limits and pumps every participant', async () => {
    let limits = { maxParallel: 1, memoryLimitMb: null as number | null };
    const sem = new WorkspaceSemaphore({ load: () => Promise.resolve({ ...limits }) });
    const a = participant(0);
    sem.register(a);
    limits = { maxParallel: 7, memoryLimitMb: 1024 };
    await sem.refresh();
    expect(sem.maxParallel()).toBe(7);
    expect(sem.memoryLimitMb()).toBe(1024);
    expect(a.pumped.length).toBe(1);
  });

  it('release() pumps EVERY participant, not just the one that freed the slot', async () => {
    const sem = new WorkspaceSemaphore();
    const a = participant(1);
    const b = participant(0, 1000);
    sem.register(a);
    sem.register(b);
    await sem.release();
    expect(a.pumped.length).toBe(1);
    expect(b.pumped.length).toBe(1); // the whole point: B's queue hears about A's freed slot
  });

  it('release() pumps the longest-waiting queue first; empty queues go last', async () => {
    const order: string[] = [];
    const named = (name: string, queuedAt: number | null): SemaphoreParticipant => ({
      busySlots: () => 0,
      oldestQueuedAt: () => queuedAt,
      pump: () => {
        order.push(name);
      },
    });
    const sem = new WorkspaceSemaphore();
    sem.register(named('idle', null));
    sem.register(named('newer', 2000));
    sem.register(named('older', 1000));
    await sem.release();
    expect(order).toEqual(['older', 'newer', 'idle']);
  });

  it('a release landing mid-sweep re-runs the sweep instead of being dropped', async () => {
    const sem = new WorkspaceSemaphore();
    let reentered = false;
    const a: SemaphoreParticipant & { pumped: number } = {
      pumped: 0,
      busySlots: () => 0,
      oldestQueuedAt: () => null,
      pump: async () => {
        a.pumped += 1;
        if (!reentered) {
          reentered = true;
          await sem.release(); // a run settles while the sweep is in flight
        }
      },
    };
    sem.register(a);
    await sem.release();
    expect(a.pumped).toBe(2); // the nested release replayed the sweep
  });

  it('projectMaxParallel returns the per-project value when set, else the workspace cap', async () => {
    // Key by realpath'd temp dirs so normalizeRootSync resolves them identically.
    const dirs = mkdtempSync(join(tmpdir(), 'cez-sema-'));
    const capped = join(dirs, 'capped');
    const open = join(dirs, 'open');
    mkdirSync(capped, { recursive: true });
    mkdirSync(open, { recursive: true });
    try {
      let projectLimits = new Map<string, number>([[realpathSync(capped), 1]]);
      const sem = new WorkspaceSemaphore({
        load: () => Promise.resolve({ maxParallel: 4, memoryLimitMb: null, projectLimits }),
      });
      await sem.refresh();
      // The registered project uses its own cap...
      expect(sem.projectMaxParallel(capped)).toBe(1);
      // ...a registered-but-unset project and an unknown root inherit the workspace cap.
      expect(sem.projectMaxParallel(open)).toBe(4);
      expect(sem.projectMaxParallel(join(dirs, 'never-registered'))).toBe(4);
      // A refresh that changes the value is reflected immediately.
      projectLimits = new Map<string, number>([[realpathSync(capped), 3]]);
      await sem.refresh();
      expect(sem.projectMaxParallel(capped)).toBe(3);
    } finally {
      rmSync(dirs, { recursive: true, force: true });
    }
  });

  it('projectMaxParallel inherits the workspace cap when no projectLimits map is provided', () => {
    // An older load stub (resource slice only) → every root inherits.
    const sem = new WorkspaceSemaphore({ initial: { maxParallel: 6 } });
    expect(sem.projectMaxParallel('/tmp/whatever')).toBe(6);
  });

  it('projectMaxParallel resolves a manager keyed by a symlinked root to the registry entry (spec Q7)', async () => {
    // The spec's normalization guard: the registry stores the realpath'd root,
    // but a manager may hold a *symlinked* spelling of the same directory. The
    // lookup must realpath both, or the override silently falls back to the
    // workspace cap. A real symlink is the only way to prove normalizeRootSync
    // actually canonicalizes — an all-`/tmp` test passes even as a no-op.
    const dirs = realpathSync(mkdtempSync(join(tmpdir(), 'cez-sema-link-')));
    const real = join(dirs, 'real-root');
    const link = join(dirs, 'link-root'); // a symlink pointing at real-root
    mkdirSync(real, { recursive: true });
    symlinkSync(real, link);
    try {
      // Registry keys by the realpath'd root (what registerProject stores)…
      const sem = new WorkspaceSemaphore({
        load: () => Promise.resolve({ maxParallel: 4, memoryLimitMb: null, projectLimits: new Map([[real, 1]]) }),
      });
      await sem.refresh();
      // …and a manager holding the symlinked spelling still resolves the cap.
      expect(link).not.toBe(real); // guard: the two spellings really differ
      expect(realpathSync(link)).toBe(real); // guard: the symlink resolves to it
      expect(sem.projectMaxParallel(link)).toBe(1);
      expect(sem.projectMaxParallel(real)).toBe(1);
    } finally {
      rmSync(dirs, { recursive: true, force: true });
    }
  });

  it('a failed load keeps the last good cache (never degrades to defaults) and still pumps', async () => {
    let fail = false;
    const sem = new WorkspaceSemaphore({
      load: () =>
        fail
          ? Promise.reject(new Error('unreadable'))
          : Promise.resolve({ maxParallel: 9, memoryLimitMb: 256 }),
    });
    const a = participant(0);
    sem.register(a);
    await sem.refresh();
    expect(sem.maxParallel()).toBe(9);
    fail = true;
    await sem.refresh();
    expect(sem.maxParallel()).toBe(9); // last good snapshot survives
    expect(sem.memoryLimitMb()).toBe(256);
    expect(a.pumped.length).toBe(2);
  });
});
