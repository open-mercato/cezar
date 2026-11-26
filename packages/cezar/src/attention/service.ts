import type { AttentionResponse } from '@open-mercato/cezar-contract';

/** A burst of run, manager and question events is one recount. */
export const ATTENTION_SETTLE_MS = 2_000;
/**
 * How long a read is reused with no poke in between. Health is polled and every phone's push counts,
 * and a read parses each cold project's `runs.json`; only another process changes those, so a short
 * age bounds how late they show. Such unpoked changes reach a phone's icon only with the next poke.
 */
export const ATTENTION_MAX_AGE_MS = 10_000;

export interface AttentionService {
  list(): Promise<AttentionResponse>;
  /** Something that may change the list happened; listeners hear only a real change. */
  poke(): void;
  onChange(listener: (list: AttentionResponse) => void): () => void;
  /** Tests wait on this. */
  idle(): Promise<void>;
  dispose(): void;
}

export function createAttentionService(deps: {
  read: () => Promise<AttentionResponse>;
  /** Someone would hear a change; without one a poke only drops the cache and nothing recounts. */
  wanted?: () => boolean;
  settleMs?: number;
  maxAgeMs?: number;
  now?: () => number;
}): AttentionService {
  const listeners = new Set<(list: AttentionResponse) => void>();
  const now = deps.now ?? Date.now;
  let revision: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let disposed = false;
  // A poke bumps the generation: a read started before it is never cached or shared after it.
  let generation = 0;
  let cached: { list: AttentionResponse; at: number; generation: number } | undefined;
  let inflight: { promise: Promise<AttentionResponse>; generation: number } | undefined;

  const fresh = (): Promise<AttentionResponse> => {
    if (inflight && inflight.generation === generation) return inflight.promise;
    const started = generation;
    const promise = deps.read().then((list) => {
      if (started === generation) cached = { list, at: now(), generation: started };
      return list;
    }).finally(() => {
      if (inflight?.promise === promise) inflight = undefined;
    });
    inflight = { promise, generation: started };
    return promise;
  };

  const recount = async () => {
    const list = await fresh().catch(() => undefined);
    if (!list || disposed) return;
    // The first recount after a restart is news too: a phone may hold a count from before it.
    const changed = list.revision !== revision;
    revision = list.revision;
    if (changed) for (const listener of listeners) listener(list);
  };

  return {
    async list() {
      if (cached && cached.generation === generation && now() - cached.at < (deps.maxAgeMs ?? ATTENTION_MAX_AGE_MS)) return cached.list;
      return fresh();
    },
    poke() {
      if (disposed) return;
      generation += 1;
      // Demand-driven: a recount exists only for its listeners, and only while one of them can act on it.
      if (timer || listeners.size === 0 || deps.wanted?.() === false) return;
      timer = setTimeout(() => {
        timer = undefined;
        running = recount().finally(() => { running = undefined; });
      }, deps.settleMs ?? ATTENTION_SETTLE_MS);
      timer.unref?.();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    idle: () => running ?? Promise.resolve(),
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      listeners.clear();
    },
  };
}

/**
 * One `attention-change` per change (spec 2026-11-23-needs-you-triage): sent when the change happens,
 * whether or not a phone listens. The recount a poke starts drives only the phone's push, gated on its
 * revision; the cockpit never waits on it, since a read can fail and a change (a re-snooze that only
 * moves `until`) can leave the revision alone.
 */
export function createAttentionAnnouncer(deps: { poke: () => void; announce: () => void }): { changed: () => void } {
  return {
    changed() {
      deps.poke();
      deps.announce();
    },
  };
}
