import { attentionOverrideSchema, type AttentionOverride, type AttentionOverrideInput } from '@open-mercato/cezar-contract';
import { attentionOverridesPath } from '../paths.ts';
import { createKeyedStore } from './keyed-store.ts';

/**
 * The user's dismissals, snoozes and "Still needs me" on attention items (spec
 * 2026-11-23-needs-you-triage), one file per computer so the cockpit, the notch and a phone agree.
 * State that may be deleted: without it every item simply shows again.
 */

/** An entry outlives the item it names by this much at most; keys are never reused, so it is inert. */
export const OVERRIDE_TTL_MS = 30 * 24 * 60 * 60_000;
export const OVERRIDES_MAX = 500;

export interface AttentionOverrideStore {
  /** Active only: an ended snooze and an entry past its TTL are gone. */
  list(now?: number): Promise<AttentionOverride[]>;
  set(input: AttentionOverrideInput, now?: number): Promise<AttentionOverride[]>;
  clear(key: string, now?: number): Promise<AttentionOverride[]>;
}

const msOf = (iso: string | undefined): number => (iso ? Date.parse(iso) : Number.NaN);

/** Live at `now`: a snooze still running, any other entry younger than its TTL. */
export function activeOverrides(entries: readonly AttentionOverride[], now: number): AttentionOverride[] {
  return entries.filter((entry) => {
    const until = msOf(entry.until);
    if (!Number.isNaN(until) && until <= now) return false;
    const at = msOf(entry.at);
    return Number.isNaN(at) || now - at < OVERRIDE_TTL_MS;
  });
}

/** When the list next changes on its own: the soonest snooze end or TTL expiry (review 2, finding 6). */
export function nextOverrideWake(entries: readonly AttentionOverride[]): number | undefined {
  const times = entries.flatMap((entry) => [msOf(entry.until), msOf(entry.at) + OVERRIDE_TTL_MS]).filter((at) => Number.isFinite(at));
  return times.length > 0 ? Math.min(...times) : undefined;
}

function decode(raw: unknown): Map<string, AttentionOverride> {
  const rows = (raw as { overrides?: unknown } | null | undefined)?.overrides;
  const out = new Map<string, AttentionOverride>();
  if (!Array.isArray(rows)) return out;
  // Per-entry salvage: one bad row never drops the rest.
  for (const row of rows) {
    const parsed = attentionOverrideSchema.safeParse(row);
    if (parsed.success) out.set(parsed.data.key, parsed.data);
  }
  return out;
}

export function createAttentionOverrideStore(path: () => string = attentionOverridesPath): AttentionOverrideStore {
  const prune = (entries: Map<string, AttentionOverride>, now: number) => {
    const live = new Set(activeOverrides([...entries.values()], now).map((entry) => entry.key));
    for (const key of [...entries.keys()]) if (!live.has(key)) entries.delete(key);
    // Insertion order is age order: the oldest go first.
    while (entries.size > OVERRIDES_MAX) entries.delete(entries.keys().next().value!);
  };
  const store = createKeyedStore<AttentionOverride>({ path, decode, encode: (entries) => ({ overrides: [...entries.values()] }), prune });
  return {
    list: async (now = Date.now()) => [...(await store.load(now)).values()],
    set: async (input, now = Date.now()) => [...(await store.update((entries) => {
      entries.delete(input.key);
      entries.set(input.key, {
        key: input.key,
        mode: input.mode,
        at: new Date(now).toISOString(),
        ...(input.mode === 'dismiss' && input.until ? { until: input.until } : {}),
        ...(input.projectId && input.runId ? { projectId: input.projectId, runId: input.runId } : {}),
      });
    }, now)).values()],
    clear: async (key, now = Date.now()) => [...(await store.update((entries) => { entries.delete(key); }, now)).values()],
  };
}
