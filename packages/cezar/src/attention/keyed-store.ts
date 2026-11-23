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

export function createKeyedStore<V>(options: KeyedStoreOptions<V>): KeyedStore<V> {
  let cache: { entries: Map<string, V>; stamp: string } | undefined;
  // Set once a write failed: the keys this process changed, and their values (absent = deleted).
  let memory: Map<string, V | undefined> | undefined;

  const fromFile = async (file: string, now: number): Promise<{ entries: Map<string, V>; stamp: string }> => {
    const stamp = await stampOf(file);
    if (cache && cache.stamp === stamp && !memory) {
      options.prune?.(cache.entries, now);
      return cache;
    }
    const entries = options.decode(await readBody(file));
    for (const [key, value] of memory ?? []) {
      if (value === undefined) entries.delete(key);
      else entries.set(key, value);
    }
    options.prune?.(entries, now);
    return { entries, stamp };
  };

  return {
    async load(now = Date.now()) {
      cache = await fromFile(options.path(), now);
      return new Map(cache.entries);
    },
    update(mutate, now = Date.now()) {
      const file = options.path();
      return serializedByPath(file, async () => {
        // Always from the file: another process may have written since our last read.
        cache = undefined;
        const base = (await fromFile(file, now)).entries;
        const next = new Map(base);
        mutate(next);
        options.prune?.(next, now);
        try {
          await atomicWriteJson(file, options.encode(next));
          memory = undefined;
          cache = { entries: next, stamp: await stampOf(file) };
        } catch {
          // A read-only home: keep every change this process made, laid over the file from now on.
          memory ??= new Map();
          for (const key of new Set([...base.keys(), ...next.keys()])) {
            if (base.get(key) !== next.get(key)) memory.set(key, next.get(key));
          }
          cache = { entries: next, stamp: await stampOf(file) };
        }
        return new Map(next);
      });
    },
  };
}
