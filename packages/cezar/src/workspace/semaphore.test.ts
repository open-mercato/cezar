import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceSemaphore, type SemaphoreParticipant } from './semaphore.ts';

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
