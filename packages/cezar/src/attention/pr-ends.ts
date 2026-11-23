import { z } from 'zod';
import { attentionPrEndsPath } from '../paths.ts';
import { createKeyedStore } from './keyed-store.ts';
import type { PrEnd } from './list.ts';

/**
 * What cezar has seen of pull requests ending (spec 2026-11-23-needs-you-triage, review 2 finding 1).
 * The forge cache forgets a closed PR after 10 minutes, a merged one after a day, and everything on a
 * restart; a Probably done verdict built on it would then undo itself and raise the badges with nothing
 * new. This keeps the end: a merged PR never un-merges, and a closed one is dropped only when a fresh
 * read says it is open again.
 */

const recordSchema = z.object({
  root: z.string(),
  number: z.number().int().positive(),
  state: z.enum(['merged', 'closed']),
  endedAt: z.string(),
});
export type PrEndRecord = z.infer<typeof recordSchema>;

export const PR_ENDS_MAX = 2_000;

export const prEndKey = (root: string, number: number): string => `${root}#${number}`;

export interface PrEndMemory {
  /** The remembered ends, for one attention read. */
  load(): Promise<Map<string, PrEndRecord>>;
  /** What a read learned: ends seen fresh, and PRs a fresh read found open again. */
  note(seen: readonly PrEndRecord[], reopened: readonly string[]): Promise<void>;
}

/** One read's lookups: the fresh cache first, the memory when it has forgotten. */
export function prEndLookup(
  known: ReadonlyMap<string, PrEndRecord>,
  fresh: { end: (root: string, number: number) => PrEnd | undefined; isOpen: (root: string, number: number) => boolean },
): { lookup: (root: string, number: number) => PrEnd | undefined; seen: PrEndRecord[]; reopened: string[] } {
  const seen = new Map<string, PrEndRecord>();
  const reopened = new Set<string>();
  const lookup = (root: string, number: number): PrEnd | undefined => {
    const key = prEndKey(root, number);
    const end = fresh.end(root, number);
    if (end) {
      const kept = known.get(key);
      if (end.endedAt && (kept?.state !== end.state || kept.endedAt !== end.endedAt)) {
        seen.set(key, { root, number, state: end.state, endedAt: end.endedAt });
      }
      return end;
    }
    if (fresh.isOpen(root, number)) {
      if (known.has(key)) reopened.add(key);
      return undefined;
    }
    const kept = known.get(key);
    return kept ? { state: kept.state, endedAt: kept.endedAt } : undefined;
  };
  return { lookup, get seen() { return [...seen.values()]; }, get reopened() { return [...reopened]; } };
}

export function createPrEndMemory(path: () => string = attentionPrEndsPath): PrEndMemory {
  const store = createKeyedStore<PrEndRecord>({
    path,
    decode: (raw) => {
      const out = new Map<string, PrEndRecord>();
      const rows = (raw as { ends?: unknown } | null | undefined)?.ends;
      if (!Array.isArray(rows)) return out;
      for (const row of rows) {
        const parsed = recordSchema.safeParse(row);
        if (parsed.success) out.set(prEndKey(parsed.data.root, parsed.data.number), parsed.data);
      }
      return out;
    },
    encode: (entries) => ({ ends: [...entries.values()] }),
    // Insertion order is the order seen: the oldest go first.
    prune: (entries) => { while (entries.size > PR_ENDS_MAX) entries.delete(entries.keys().next().value!); },
  });
  return {
    load: () => store.load(),
    async note(seen, reopened) {
      if (seen.length === 0 && reopened.length === 0) return;
      await store.update((entries) => {
        for (const record of seen) {
          const key = prEndKey(record.root, record.number);
          entries.delete(key);
          entries.set(key, record);
        }
        for (const key of reopened) entries.delete(key);
      });
    },
  };
}
