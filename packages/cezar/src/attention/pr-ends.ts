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
  /** When a fresh forge read last confirmed it. A closed end lapses a day after that (it can reopen). */
  seenAt: z.string().optional(),
});
export type PrEndRecord = z.infer<typeof recordSchema>;

export const PR_ENDS_MAX = 2_000;
/** A remembered closed PR can be reopened unseen: it stops counting as ended a day after a fresh read
 *  last confirmed it, so a reopen cannot keep its items Probably done forever (review of #2443). A
 *  merged PR never un-merges and is kept. */
export const CLOSED_END_TTL_MS = 24 * 60 * 60_000;
/** A closed end confirmed again is written back at most this often. */
const CONFIRM_EVERY_MS = 60 * 60_000;

export const prEndKey = (root: string, number: number): string => `${root}#${number}`;

export interface PrEndMemory {
  /** The remembered ends, for one attention read. */
  load(): Promise<Map<string, PrEndRecord>>;
  /** What a read learned: ends seen fresh, and ends to forget (reopened, or a closed one that lapsed). */
  note(seen: readonly PrEndRecord[], dropped: readonly string[]): Promise<void>;
}

/** One read's lookups: the fresh cache first, the memory when it has forgotten. */
export function prEndLookup(
  known: ReadonlyMap<string, PrEndRecord>,
  fresh: { end: (root: string, number: number) => PrEnd | undefined; isOpen: (root: string, number: number) => boolean },
  now: number = Date.now(),
): { lookup: (root: string, number: number) => PrEnd | undefined; seen: PrEndRecord[]; dropped: string[] } {
  const seen = new Map<string, PrEndRecord>();
  const dropped = new Set<string>();
  const confirmedAt = (record: PrEndRecord) => Date.parse(record.seenAt ?? record.endedAt);
  const lookup = (root: string, number: number): PrEnd | undefined => {
    const key = prEndKey(root, number);
    const kept = known.get(key);
    const end = fresh.end(root, number);
    if (end) {
      // A fresh answer without a time keeps the one remembered for the same end.
      const endedAt = end.endedAt ?? (kept?.state === end.state ? kept.endedAt : undefined);
      const stale = kept?.state === 'closed' && now - confirmedAt(kept) > CONFIRM_EVERY_MS;
      if (endedAt && (kept?.state !== end.state || kept.endedAt !== endedAt || stale)) {
        seen.set(key, { root, number, state: end.state, endedAt, seenAt: new Date(now).toISOString() });
      }
      return endedAt ? { state: end.state, endedAt } : end;
    }
    if (fresh.isOpen(root, number)) {
      if (kept) dropped.add(key);
      return undefined;
    }
    if (!kept) return undefined;
    if (kept.state === 'closed' && !(now - confirmedAt(kept) <= CLOSED_END_TTL_MS)) {
      dropped.add(key);
      return undefined;
    }
    return { state: kept.state, endedAt: kept.endedAt };
  };
  return { lookup, get seen() { return [...seen.values()]; }, get dropped() { return [...dropped]; } };
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
    async note(seen, dropped) {
      if (seen.length === 0 && dropped.length === 0) return;
      await store.update((entries) => {
        for (const record of seen) {
          const key = prEndKey(record.root, record.number);
          entries.delete(key);
          entries.set(key, record);
        }
        for (const key of dropped) entries.delete(key);
      });
    },
  };
}
