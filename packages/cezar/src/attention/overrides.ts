import { readFile } from 'node:fs/promises';
import { attentionOverrideSchema, type AttentionOverride, type AttentionOverrideInput } from '@open-mercato/cezar-contract';
import { attentionOverridesPath } from '../paths.ts';
import { atomicWriteJson, serializedByPath } from '../workspace/config.ts';

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

async function readEntries(path: string): Promise<AttentionOverride[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return [];
  }
  const rows = (raw as { overrides?: unknown } | null)?.overrides;
  if (!Array.isArray(rows)) return [];
  // Per-entry salvage: one bad row never drops the rest.
  return rows.flatMap((row) => {
    const parsed = attentionOverrideSchema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

export function createAttentionOverrideStore(path: () => string = attentionOverridesPath): AttentionOverrideStore {
  let cache: AttentionOverride[] | undefined;
  const load = async () => (cache ??= await readEntries(path()));
  const write = (mutate: (entries: AttentionOverride[], now: number) => AttentionOverride[], now: number) => {
    const file = path();
    return serializedByPath(file, async () => {
      // Another process may have written since: re-read before every write.
      const next = activeOverrides(mutate(await readEntries(file), now), now).slice(-OVERRIDES_MAX);
      cache = next;
      try {
        await atomicWriteJson(file, { overrides: next });
      } catch {
        // A read-only home: the choice lasts this process.
      }
      return next;
    });
  };
  return {
    async list(now = Date.now()) {
      return activeOverrides(await load(), now);
    },
    set(input, now = Date.now()) {
      return write((entries, at) => [
        ...entries.filter((entry) => entry.key !== input.key),
        { key: input.key, mode: input.mode, at: new Date(at).toISOString(), ...(input.mode === 'dismiss' && input.until ? { until: input.until } : {}) },
      ], now);
    },
    clear(key, now = Date.now()) {
      return write((entries) => entries.filter((entry) => entry.key !== key), now);
    },
  };
}
