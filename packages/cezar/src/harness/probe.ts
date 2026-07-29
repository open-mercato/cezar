
/** A model bound to a role, addressed by the transport that will run it. */
export interface ProbeRef {
  runner: 'claude' | 'codex' | 'opencode' | 'harness';
  model: string;
  family?: string;
}

export interface ProbeVerdict {
  status: 'ready' | 'failed' | 'unverified';
  detail: string;
}

/** Performs one live round-trip. Implementations may throw; the prober
 *  converts a throw into a `failed` verdict — a probe must never be the thing
 *  that crashes preflight. */
export type ProbeTransport = (ref: ProbeRef) => Promise<ProbeVerdict>;

export interface ProberOptions {
  transport: ProbeTransport;
  ttlMs?: number;
  failureTtlMs?: number;
  now?: () => number;
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
