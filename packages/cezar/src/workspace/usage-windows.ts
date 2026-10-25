import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import lockfile from 'proper-lockfile';
import { usageWindowsSnapshotSchema, type UsageAccountBinding, type UsageWindowsObservation, type UsageWindowsSnapshot, type UsageWindow } from '@open-mercato/cezar-contract';
import { assertCezarHomeWriteIsSandboxed, cezarHomeDir } from '../paths.ts';
import { atomicWriteJsonSync } from './config.ts';

const warned = new Set<string>();
function warn(path: string): void {
  if (warned.has(path)) return;
  warned.add(path);
  console.warn('[cezar] Usage metadata unavailable; continuing without usage reset data.');
}
function read(path: string): UsageWindowsSnapshot[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(raw) || raw.length > 1024) throw new Error('Invalid snapshot store');
    return raw.map((entry) => usageWindowsSnapshotSchema.parse(entry));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warn(path);
    return [];
  }
}
function sameLocation(a: UsageAccountBinding, b: UsageAccountBinding): boolean {
  return a.provider === b.provider && a.accountId === b.accountId && a.profilePath === b.profilePath;
}

/** Exact account/location/identity match. Never falls back to another account or old login. */
export function loadUsageWindows(binding: UsageAccountBinding): UsageWindowsSnapshot | null {
  const path = join(cezarHomeDir(), 'usage-windows.json');
  return read(path).find((s) => sameLocation(s.binding, binding) && s.binding.identity === binding.identity) ?? null;
}

/** Merge partial observations by window id; explicit null resets clear old data. */
export function mergeUsageWindows(previous: UsageWindowsSnapshot | null, incoming: UsageWindowsSnapshot): UsageWindowsSnapshot {
  if (!previous || !sameLocation(previous.binding, incoming.binding)) return incoming;
  if (previous.binding.identity && !incoming.binding.identity) return previous;
  if (previous.binding.identity !== incoming.binding.identity) {
    return previous.observedAt > incoming.observedAt ? previous : incoming;
  }
  const windows = new Map(previous.windows.map((w) => [w.id, w]));
  for (const window of incoming.windows) {
    if ((windows.get(window.id)?.observedAt ?? -1) <= window.observedAt) windows.set(window.id, window);
  }
  const newest = previous.observedAt > incoming.observedAt ? previous : incoming;
  return { ...newest, windows: [...windows.values()].sort((a, b) => b.observedAt - a.observedAt).slice(0, 128) };
}

/** Cross-process read/merge/atomic-write. Resolve CEZ_HOME once, including its sandbox guard. */
export async function saveUsageWindows(binding: UsageAccountBinding, observation: UsageWindowsObservation): Promise<boolean> {
  const path = join(cezarHomeDir(), 'usage-windows.json');
  assertCezarHomeWriteIsSandboxed(path);
  let release: (() => Promise<void>) | undefined;
  try {
    const incoming = usageWindowsSnapshotSchema.parse({ ...observation, binding });
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    let compromised = false;
    release = await lockfile.lock(path, {
      realpath: false, stale: 30_000,
      retries: { retries: 5, minTimeout: 20, maxTimeout: 100 },
      onCompromised: () => { compromised = true; },
    });
    const snapshots = read(path);
    // Unknown identity is not evidence of a new login (or a moved profile).
    // Preserve established holds rather than replacing them with unbound data.
    if (!binding.identity && snapshots.some((s) => s.binding.provider === binding.provider &&
      s.binding.accountId === binding.accountId && s.binding.identity)) return false;
    const previous = snapshots.find((s) => sameLocation(s.binding, binding)) ?? null;
    const merged = mergeUsageWindows(previous, incoming);
    // Active sessions keep their captured location; their later events cannot evict a moved profile.
    const others = snapshots.filter((s) => !sameLocation(s.binding, binding));
    if (compromised) throw new Error('Usage store lease lost');
    atomicWriteJsonSync(path, [...others.slice(-1023), merged]);
    return true;
  } catch {
    warn(path);
    return false;
  } finally {
    try { await release?.(); } catch { warn(path); }
  }
}

/** Known future resets remain usable until they expire. Caller enforces the seven-day selection bound. */
export function futureUsageWindows(snapshot: UsageWindowsSnapshot, now = Date.now()): UsageWindow[] {
  return snapshot.windows.filter((w) => w.resetsAt !== null && w.resetsAt > now);
}

/** Blocking status ages independently of reset knowledge; old percentages are advisory only. */
export function isUsageWindowBlocking(window: UsageWindow, now = Date.now()): boolean {
  return (window.status === 'blocked' || (window.usedPercent ?? 0) >= 100) && window.observedAt <= now &&
    window.resetsAt !== null && window.resetsAt > now;
}
