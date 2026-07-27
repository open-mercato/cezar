/**
 * Model readiness probing for harness runs.
 *
 * Why this exists: a council run once reported every reviewer `ready` while the
 * opencode transport 500'd on the first prompt of every session. Three separate
 * layers had said "ready" and not one had called a model — the cockpit picker
 * listed models the CLI was *authenticated* against, the setup skill's probe
 * checked that a credential *existed*, and this driver's preflight hardcoded
 * `readiness: 'ready'`. Presence is not readiness.
 *
 * The contract here: a `ready` verdict means a round-trip COMPLETED on the exact
 * transport the run will use. Anything short of that is `failed`, carrying the
 * concrete reason so the operator can act without reading a server log.
 *
 * This module owns caching and orchestration only; the round-trips themselves
 * live behind the `ProbeTransport` seam (see `probe-transports.ts`) so the
 * policy is testable without spawning a CLI or touching the network.
 */

/** A model bound to a role, addressed by the transport that will run it. */
export interface ProbeRef {
  runner: 'claude' | 'codex' | 'opencode' | 'harness';
  model: string;
  /** Provider family, for `harness` advisors (the diversity axis). */
  family?: string;
}

export interface ProbeVerdict {
  /** `ready` is reserved for a COMPLETED round-trip. `unverified` is the honest
   *  answer when a transport has no cheap round-trip shape (a subscription CLI
   *  whose invocation we don't own): it must never render as green, because
   *  false green is the exact defect this module exists to prevent. */
  status: 'ready' | 'failed' | 'unverified';
  /** Concrete, operator-actionable: the upstream error, or what succeeded. */
  detail: string;
}

/** Performs one live round-trip. Implementations may throw; the prober
 *  converts a throw into a `failed` verdict — a probe must never be the thing
 *  that crashes preflight. */
export type ProbeTransport = (ref: ProbeRef) => Promise<ProbeVerdict>;

export interface ProberOptions {
  transport: ProbeTransport;
  /** How long a `ready` verdict stays fresh. Default 10 min — long enough that
   *  back-to-back runs don't repay the round-trip. */
  ttlMs?: number;
  /** How long a `failed` verdict stays fresh. Deliberately much shorter than
   *  `ttlMs`: once the operator fixes the transport, the next run should see
   *  it, not sit behind a stale failure. */
  failureTtlMs?: number;
  now?: () => number;
  /** Pass a caller-owned map to share verdicts across prober instances — the
   *  driver builds a fresh prober per run but keeps one process-wide cache, so
   *  the second run in a session doesn't repay every round-trip. */
  cache?: Map<string, ProbeCacheEntry>;
}

export interface ProbeCacheEntry {
  verdict: ProbeVerdict;
  expiresAt: number;
}

/** Shared across the start surface and run preflight so one measured binding
 * is paid for at most once per TTL in this Cezar process. */
export const sharedHarnessProbeCache = new Map<string, ProbeCacheEntry>();

export interface ModelProber {
  probe(ref: ProbeRef): Promise<ProbeVerdict>;
  /** Probe a whole roster, once per distinct model, concurrently.
   *  Keyed by `probeKey(ref)`. */
  probeAll(refs: ProbeRef[]): Promise<Map<string, ProbeVerdict>>;
  clearCache(): void;
}

const DEFAULT_TTL_MS = 600_000;
const DEFAULT_FAILURE_TTL_MS = 60_000;

/** Cache/identity key. A model is only interchangeable with itself *on the same
 *  transport* — `opencode/glm-5.2` over the local server and the same model over
 *  the Zen HTTP preset are different code paths that fail independently.
 *
 *  Must stay identical to the driver's `roleRefId`, including the `auto`
 *  fallback for a binding that takes the backend's default model: the driver
 *  looks verdicts up by roster id, so any divergence silently degrades a real
 *  verdict to `unknown`. */
export function probeKey(ref: ProbeRef): string {
  return `${ref.runner}/${ref.model || 'auto'}`;
}

export function createModelProber(opts: ProberOptions): ModelProber {
  const {
    transport,
    ttlMs = DEFAULT_TTL_MS,
    failureTtlMs = DEFAULT_FAILURE_TTL_MS,
    now = () => Date.now(),
  } = opts;

  const cache = opts.cache ?? new Map<string, ProbeCacheEntry>();
  /** Shared in-flight probes — two roles bound to the same model must never
   *  spawn two opencode servers racing for the same port. */
  const inFlight = new Map<string, Promise<ProbeVerdict>>();

  const probe = async (ref: ProbeRef): Promise<ProbeVerdict> => {
    const key = probeKey(ref);
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now()) return hit.verdict;

    const pending = inFlight.get(key);
    if (pending) return pending;

    const attempt = (async (): Promise<ProbeVerdict> => {
      let verdict: ProbeVerdict;
      try {
        verdict = await transport(ref);
      } catch (err) {
        verdict = { status: 'failed', detail: err instanceof Error ? err.message : String(err) };
      }
      cache.set(key, {
        verdict,
        expiresAt: now() + (verdict.status === 'ready' ? ttlMs : failureTtlMs),
      });
      return verdict;
    })();

    inFlight.set(key, attempt);
    try {
      return await attempt;
    } finally {
      inFlight.delete(key);
    }
  };

  return {
    probe,
    async probeAll(refs) {
      const distinct = new Map<string, ProbeRef>();
      for (const ref of refs) if (!distinct.has(probeKey(ref))) distinct.set(probeKey(ref), ref);
      const entries = await Promise.all(
        [...distinct].map(async ([key, ref]) => [key, await probe(ref)] as const),
      );
      return new Map(entries);
    },
    clearCache() {
      cache.clear();
    },
  };
}
