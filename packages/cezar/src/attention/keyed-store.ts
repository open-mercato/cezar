import { readFile, stat } from 'node:fs/promises';
import { atomicWriteJson, serializedByPath } from '../workspace/config.ts';

/**
 * A small keyed JSON file in `~/.cezar` that several cezar processes share (spec
 * 2026-11-23-needs-you-triage): re-read when its stamp changes, written read-modify-write. On a home
 * it cannot write, what this process changed is kept in memory and laid over the file on every
 * read, so a later write never drops an earlier one and another writer's entries still show.
 */

export interface KeyedStore<V> {
  load(now?: number): Promise<Map<string, V>>;
  update(mutate: (entries: Map<string, V>) => void, now?: number): Promise<Map<string, V>>;
}

export interface KeyedStoreOptions<V> {
  path: () => string;
  /** The file's body to entries; a bad body or row is dropped, never fatal. */
  decode: (raw: unknown) => Map<string, V>;
  encode: (entries: Map<string, V>) => unknown;
  /** Drops what has expired; runs on every read and write. */
  prune?: (entries: Map<string, V>, now: number) => void;
}

const MISSING = 'missing';
const stampOf = async (file: string): Promise<string> =>
  stat(file).then((info) => `${info.mtimeMs}:${info.size}`, () => MISSING);

async function readBody(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** What a key held on disk, comparable across reads. */
const snapshot = (value: unknown): string => JSON.stringify(value ?? null);

export function createKeyedStore<V>(options: KeyedStoreOptions<V>): KeyedStore<V> {
  let cache: { entries: Map<string, V>; stamp: string } | undefined;
  // Only the keys this process failed to write: the value it wants, and what the file held for that
  // key when it failed. A different value on disk later is a newer change, and it wins (review of #2443).
  let memory: Map<string, { value: V | undefined; disk: string }> | undefined;

  const fromFile = async (file: string, now: number): Promise<{ entries: Map<string, V>; raw: Map<string, V>; stamp: string }> => {
    const stamp = await stampOf(file);
    if (cache && cache.stamp === stamp && !memory) {
      options.prune?.(cache.entries, now);
      return { ...cache, raw: cache.entries };
    }
    const raw = options.decode(await readBody(file));
    const entries = new Map(raw);
    for (const [key, kept] of [...(memory ?? [])]) {
      if (snapshot(raw.get(key)) !== kept.disk) {
        memory!.delete(key);
        continue;
      }
      if (kept.value === undefined) entries.delete(key);
      else entries.set(key, kept.value);
    }
    if (memory?.size === 0) memory = undefined;
    options.prune?.(entries, now);
    return { entries, raw, stamp };
  };

  return {
    async load(now = Date.now()) {
      const read = await fromFile(options.path(), now);
      cache = { entries: read.entries, stamp: read.stamp };
      return new Map(read.entries);
    },
    update(mutate, now = Date.now()) {
      const file = options.path();
      return serializedByPath(file, async () => {
        // Always from the file: another process may have written since our last read.
        cache = undefined;
        const { entries: base, raw } = await fromFile(file, now);
        const next = new Map(base);
        mutate(next);
        options.prune?.(next, now);
        try {
          await atomicWriteJson(file, options.encode(next));
          memory = undefined;
          cache = { entries: next, stamp: await stampOf(file) };
        } catch {
          // A read-only home: keep only what this write changed, against what the file held.
          memory ??= new Map();
          for (const key of new Set([...base.keys(), ...next.keys()])) {
            if (base.get(key) === next.get(key)) continue;
            memory.set(key, { value: next.get(key), disk: memory.get(key)?.disk ?? snapshot(raw.get(key)) });
          }
          cache = { entries: next, stamp: await stampOf(file) };
        }
        return new Map(next);
      });
    },
  };
}
