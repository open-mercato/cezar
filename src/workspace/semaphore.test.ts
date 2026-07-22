import { describe, expect, it } from 'vitest';
import { WorkspaceSemaphore, type SemaphoreParticipant } from './semaphore.js';

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
    expect(sem.busy()).toBe(0);
  });

  it('honors an initial override (test seam)', () => {
    const sem = new WorkspaceSemaphore({ initial: { maxParallel: 5, memoryLimitMb: 512 } });
    expect(sem.maxParallel()).toBe(5);
    expect(sem.memoryLimitMb()).toBe(512);
  });

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
