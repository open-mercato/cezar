import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Best-effort JSON bookkeeping under `~/.cache/cez`. The payloads are a
 * handful of timestamps, so a synchronous read/write is bounded work and never
 * touches the run. Every failure is swallowed: a read-only or missing cache dir
 * degrades to in-memory state, which is the only state these callers require
 * (Zero config — written, never required).
 */

export function readJsonCache<T>(path: string): T | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? (parsed as T) : null;
  } catch {
    return null;
  }
}

export function writeJsonCache(path: string, value: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Per-writer tmp: two cezar processes must never stage through one file.
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, path);
  } catch {
    // unwritable cache dir -> in-memory only
  }
}
