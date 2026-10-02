/**
 * Stale-while-revalidate holder for host facts that change on a human timescale — which agent
 * CLIs are installed, `gh` auth, the repo's root and remote — so a reader on a seconds-long
 * cadence (the health tick) gets them without spawning anything. Same posture as
 * `ProviderAuthService.status`: a cold cache waits, a warm one answers immediately and an
 * expired one is refreshed BEHIND the answer. `invalidate` is for an explicit "check again":
 * the next read waits for a fresh compute.
 */
export interface HostProbeCache<T> {
  get(): Promise<T>;
  /** Adopt a compute already running elsewhere (the boot probe) instead of starting a second. */
  seed(pending: Promise<T>): void;
  invalidate(): void;
}

export interface HostProbeCacheOptions {
  /** Clock injection for tests. */
  now?: () => number;
  /**
   * Hard ceiling on staleness, a different job from the TTL. The TTL decides how often a
   * revalidation is kicked off; on its own it bounds nothing, because that revalidation is
   * fire-and-forget. A reader that arrives after a long idle gap — the normal state of a
   * background server is that nothing calls `get()` — would be answered from the last compute
   * however old it is. Past this age `get()` waits for the recompute instead, so the FIRST
   * read after hours of idling is already fresh rather than one read behind. Must be `>= ttlMs`;
   * the gap between them is the window in which stale is served while a refresh runs.
   */
  maxStaleMs: number;
}

export function createHostProbeCache<T>(
  compute: () => Promise<T>,
  ttlMs: number,
  options: HostProbeCacheOptions,
): HostProbeCache<T> {
  const now = options.now ?? Date.now;
  const { maxStaleMs } = options;
  let completed: { at: number; value: T } | undefined;
  let inFlight: Promise<T> | undefined;
  let generation = 0;

  const track = (pending: Promise<T>): Promise<T> => {
    const mine = ++generation;
    const settled = pending.then(
      (value) => {
        if (mine === generation) {
          completed = { at: now(), value };
          inFlight = undefined;
        }
        return value;
      },
      (err: unknown) => {
        if (mine === generation) {
          // Keep serving the last good value, but push the next attempt out by a full TTL:
          // a persistently failing probe must not restart on every read of a warm cache.
          if (completed) completed = { at: now(), value: completed.value };
          inFlight = undefined;
        }
        throw err;
      },
    );
    inFlight = settled;
    return settled;
  };

  return {
    get() {
      if (!completed) return inFlight ?? track(compute());
      const stale = completed.value;
      const age = now() - completed.at;
      if (age >= ttlMs && !inFlight) void track(compute()).catch(() => {});
      if (age >= maxStaleMs) {
        // Past the ceiling, correctness beats latency: wait for the recompute — but never
        // let a failing probe turn a health read into an error, so fall back to the old value.
        return (inFlight ?? track(compute())).catch(() => stale);
      }
      return Promise.resolve(stale);
    },
    seed(pending) {
      if (completed || inFlight) return;
      void track(pending).catch(() => {});
    },
    invalidate() {
      completed = undefined;
      inFlight = undefined;
      generation++;
    },
  };
}

/** The same seam with no cache: every read computes. For callers with no tick to amortize over. */
export function passthroughProbe<T>(compute: () => Promise<T>): HostProbeCache<T> {
  return { get: compute, seed: () => {}, invalidate: () => {} };
}
