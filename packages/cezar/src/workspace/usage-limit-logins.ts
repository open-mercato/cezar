import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { accountLoginFingerprint } from '../agent-config/account-identity.ts';
import type { ProviderId } from '../core/provider-auth.ts';
import { assertCezarHomeWriteIsSandboxed, cezarHomeDir } from '../paths.ts';
import { resolveProfileEnvForRoot } from './agent-profiles.ts';
import { atomicWriteJsonSync } from './config.ts';

// Which logins each account key (`runner:profileId`) is limited under, and "Resume now" marks; an
// account's holds lift while its current login has no unexpired limit (spec
// 2026-08-03-auto-resume-after-usage-limit, 2026-11-23 addendum). Every doubt keeps the hold.

/** `limits`: login fingerprint (or `?` = unknown) → epoch ms its newest limit lasts until. */
interface LimitRecord {
  limits: Record<string, number>;
  released?: true;
}

const FILE = 'usage-limit-logins.json';
const UNKNOWN = '?';
/** The login each key holds now, as last read successfully, and when. */
const current = new Map<string, { login: string; readAt: number }>();
/** A login lift is trusted only on a read this recent: an A → B → A switch made outside cezar
 *  must not start work on A off a read from before the switch back. */
export const LOGIN_FRESH_MS = 5_000;
/** Background reads in flight, and when one last failed (backed off for `LOGIN_FRESH_MS`), per account. */
const reading = new Map<string, Promise<string | undefined>>();
const failedAt = new Map<string, number>();
const liftListeners = new Set<() => void>();
/** Per file path, re-stat at most once a second: the hold derivation asks on every pump. */
const cache = new Map<string, { mtimeMs: number; checkedAt: number; records: Map<string, LimitRecord> }>();
/** Lifted keys as `refreshLoginIdentities` last reported them, per file path. */
const lastLifted = new Map<string, string>();

function parse(path: string): Map<string, LimitRecord> {
  const map = new Map<string, LimitRecord>();
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return map;
    for (const [account, value] of Object.entries(raw as Record<string, unknown>).slice(0, 256)) {
      if (!value || typeof value !== 'object') continue;
      const { limits, released } = value as Record<string, unknown>;
      const record: LimitRecord = { limits: {} };
      if (limits && typeof limits === 'object') {
        for (const [login, until] of Object.entries(limits as Record<string, unknown>).slice(0, 16)) {
          if (login.length > 0 && login.length <= 128 && typeof until === 'number' && Number.isFinite(until)) record.limits[login] = until;
        }
      }
      if (released === true) record.released = true;
      map.set(account, record);
    }
  } catch { /* absent or corrupt: nothing lifts, every hold binds until its deadline */ }
  return map;
}

function mtimeOf(path: string): number {
  try { return statSync(path).mtimeMs; } catch { return -1; }
}

function records(): Map<string, LimitRecord> {
  const path = join(cezarHomeDir(), FILE);
  const cached = cache.get(path);
  const now = Date.now();
  if (cached && now - cached.checkedAt < 1_000) return cached.records;
  const mtimeMs = mtimeOf(path);
  if (cached && cached.mtimeMs === mtimeMs) {
    cached.checkedAt = now;
    return cached.records;
  }
  const fresh = parse(path);
  cache.set(path, { mtimeMs, checkedAt: now, records: fresh });
  return fresh;
}

/** Read-modify-write of ONE key from a fresh parse, so another process's records survive. */
function update(account: string, change: (previous: LimitRecord | undefined) => LimitRecord | undefined): void {
  const path = join(cezarHomeDir(), FILE);
  const map = parse(path);
  const next = change(map.get(account));
  if (next === undefined) {
    // Nothing to write, but what was just read is newer than the cache.
    cache.set(path, { mtimeMs: mtimeOf(path), checkedAt: Date.now(), records: map });
    return;
  }
  map.set(account, next);
  cache.set(path, { mtimeMs: Number.NaN, checkedAt: Date.now(), records: map });
  try {
    assertCezarHomeWriteIsSandboxed(path);
    atomicWriteJsonSync(path, Object.fromEntries(map));
    cache.set(path, { mtimeMs: mtimeOf(path), checkedAt: Date.now(), records: map });
  } catch { /* kept in memory; a read-only home only loses it across a restart */ }
}

/** Fingerprint the login in `profilePath` for `account`, remembered as its current one. */
export async function readLoginIdentityAt(account: string, runner: 'claude' | 'codex', profilePath: string): Promise<string | undefined> {
  const identity = await accountLoginFingerprint(runner, profilePath).catch(() => undefined);
  // A read failing mid-rewrite keeps the last answer, but never refreshes its age.
  if (identity !== undefined) current.set(account, { login: identity, readAt: Date.now() });
  return identity ?? current.get(account)?.login;
}

/** The login `account` (Claude or Codex only) holds right now; undefined when unreadable. */
export async function readLoginIdentity(account: string): Promise<string | undefined> {
  const split = account.indexOf(':');
  const runner = account.slice(0, split);
  const profileId = account.slice(split + 1);
  if (split <= 0 || (runner !== 'claude' && runner !== 'codex')) return undefined;
  try {
    const { profile } = await resolveProfileEnvForRoot(undefined, runner as ProviderId, profileId);
    // A deleted account resolves to the default one, whose login says nothing about it.
    if (profile.id !== profileId) return undefined;
    return await readLoginIdentityAt(account, runner, profile.path);
  } catch {
    return current.get(account)?.login;
  }
}

/** Wake `listener` when a login read a lift was waiting on lands with the lift standing. */
export function onLoginLiftReady(listener: () => void): () => void {
  liftListeners.add(listener);
  return () => { liftListeners.delete(listener); };
}

/** Read `account`'s login in the background — one read at a time, none for `LOGIN_FRESH_MS` after
 *  one failed — and wake the queues when it lands with the lift standing. */
function requestLoginRead(account: string): void {
  if (reading.has(account) || Date.now() - (failedAt.get(account) ?? -Infinity) < LOGIN_FRESH_MS) return;
  const before = current.get(account)?.readAt;
  const read = readLoginIdentity(account).finally(() => {
    reading.delete(account);
    if (current.get(account)?.readAt === before) {
      failedAt.set(account, Date.now());
      return;
    }
    failedAt.delete(account);
    if (liftOf(account, Date.now(), false) !== 'login') return;
    for (const listener of liftListeners) { try { listener(); } catch { /* one listener never blocks another */ } }
  });
  reading.set(account, read);
}

/**
 * `account` hit a limit lasting `until` in a session started under `login`. Synchronous: it lands
 * before the deadline is published. A login other than the folder's current one is filed as
 * unknown, which blocks every login lift until it expires. Never throws.
 */
export function recordUsageLimit(account: string, login: string | undefined, until: number): void {
  const now = current.get(account)?.login;
  const key = login !== undefined && (now === undefined || now === login) ? login : UNKNOWN;
  update(account, (previous) => {
    if (previous && !previous.released && (previous.limits[key] ?? 0) >= until) return undefined;
    const limits = Object.fromEntries(Object.entries(previous?.limits ?? {}).filter(([, at]) => at > Date.now()));
    limits[key] = Math.max(limits[key] ?? 0, until);
    return { limits };
  });
}

/** "Resume now": lift `account`'s holds until its next limit. Never throws. */
export function releaseUsageLimit(account: string): void {
  update(account, (previous) => ({ limits: previous?.limits ?? {}, released: true }));
}

/** Why `account`'s holds no longer bind: "Resume now", or a current login — read in the last
 *  `LOGIN_FRESH_MS` — with no unexpired limit while an unknown login has none either. A stale read
 *  keeps the hold and asks for a fresh one, which wakes the queues (`onLoginLiftReady`). */
export function usageLimitLift(account: string, now = Date.now()): 'released' | 'login' | undefined {
  return liftOf(account, now, true);
}

/** `usageLimitLift`'s answer; `request` false never starts a read (a read's own completion asks). */
function liftOf(account: string, now: number, request: boolean): 'released' | 'login' | undefined {
  const record = records().get(account);
  if (!record) return undefined;
  if (record.released) return 'released';
  const seen = current.get(account);
  if (seen === undefined || Object.keys(record.limits).length === 0) return undefined;
  if ((record.limits[UNKNOWN] ?? 0) > now) return undefined;
  if (Date.now() - seen.readAt > LOGIN_FRESH_MS) {
    if (request) requestLoginRead(account);
    return undefined;
  }
  return (record.limits[seen.login] ?? 0) > now ? undefined : 'login';
}

export function usageLimitLifted(account: string): boolean {
  return usageLimitLift(account) !== undefined;
}

/** Re-read the login of every recorded account. True only when the lifted set changed. */
export async function refreshLoginIdentities(): Promise<boolean> {
  const all = records();
  await Promise.all([...all.keys()].map((account) => readLoginIdentity(account)));
  // It has just read every login itself: asking must not start more reads.
  const lifted = [...all.keys()].filter((account) => liftOf(account, Date.now(), false) !== undefined).sort().join('\n');
  const path = join(cezarHomeDir(), FILE);
  if (lifted === (lastLifted.get(path) ?? '')) return false;
  lastLifted.set(path, lifted);
  return lifted !== '';
}

/** Test seam: forget every remembered login and record. */
export function resetUsageLimitLoginsForTests(): void {
  current.clear();
  cache.clear();
  lastLifted.clear();
  reading.clear();
  failedAt.clear();
}
