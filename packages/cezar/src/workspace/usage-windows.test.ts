import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { futureUsageWindows, isUsageWindowBlocking, loadUsageWindows, mergeUsageWindows, saveUsageWindows } from './usage-windows.ts';
import { normalizeClaudeUsageWindows, normalizeCodexUsageWindows } from '../core/usage-windows.ts';

const binding = { provider: 'codex' as const, accountId: 'work', profilePath: '/resolved/profile' };
const observation = (time = 1) => normalizeCodexUsageWindows({ rateLimits: {
  primary: { usedPercent: 100, resetsAt: 100000, windowDurationMins: 300 },
} }, 'codex-read', time);
afterEach(() => vi.unstubAllEnvs());

it('writes account-bound 0600 snapshots and merges concurrent accounts', async () => {
  vi.stubEnv('CEZ_HOME', mkdtempSync(join(tmpdir(), 'usage-store-')));
  expect(await Promise.all([
    saveUsageWindows(binding, observation()),
    saveUsageWindows({ ...binding, accountId: 'personal' }, observation()),
  ])).toEqual([true, true]);
  expect(loadUsageWindows(binding)?.windows).toHaveLength(1);
  expect(loadUsageWindows({ ...binding, accountId: 'personal' })?.windows).toHaveLength(1);
  expect(loadUsageWindows({ ...binding, profilePath: '/other' })).toBeNull();
  const file = join(process.env.CEZ_HOME!, 'usage-windows.json');
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readFileSync(file, 'utf8')).not.toContain('credentials');
});
it('merges partial updates, clears explicit null, ignores older windows and invalidates identity', async () => {
  vi.stubEnv('CEZ_HOME', mkdtempSync(join(tmpdir(), 'usage-store-')));
  await saveUsageWindows(binding, observation(10));
  await saveUsageWindows(binding, normalizeCodexUsageWindows({ rateLimits: { secondary: { resetsAt: 200000 } } }, 'codex-read', 20));
  expect(loadUsageWindows(binding)?.windows).toHaveLength(2);
  await saveUsageWindows(binding, normalizeCodexUsageWindows({ rateLimits: { primary: null } }, 'codex-read', 30));
  await saveUsageWindows(binding, observation(1));
  expect(loadUsageWindows(binding)?.windows.find((w) => w.kind === 'primary')?.resetsAt).toBeNull();
  const next = { ...binding, identity: 'a'.repeat(64) };
  await saveUsageWindows(next, observation(40));
  expect(loadUsageWindows(binding)).toBeNull();
  expect(loadUsageWindows(next)?.windows).toHaveLength(1);
});
it('keeps observed blocking windows until reset without an arbitrary observation-age cutoff', () => {
  const snapshot = { ...observation(), binding };
  expect(futureUsageWindows(snapshot, 90_000_000)).toHaveLength(1);
  expect(isUsageWindowBlocking(snapshot.windows[0]!, 2)).toBe(true);
  expect(isUsageWindowBlocking(snapshot.windows[0]!, 100000)).toBe(true);
  expect(futureUsageWindows(snapshot, 100_000_000)).toHaveLength(0);
  expect(mergeUsageWindows(snapshot, { ...observation(2), binding }).observedAt).toBe(2);
});
it('corrupt and unwritable stores degrade with one redacted warning', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-store-'));
  vi.stubEnv('CEZ_HOME', dir);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  writeFileSync(join(dir, 'usage-windows.json'), 'not JSON');
  expect(loadUsageWindows(binding)).toBeNull();
  expect(loadUsageWindows(binding)).toBeNull();
  expect(warning).toHaveBeenCalledTimes(1);
  const blocked = join(dir, 'file');
  writeFileSync(blocked, 'not a directory');
  vi.stubEnv('CEZ_HOME', blocked);
  expect(await saveUsageWindows(binding, observation())).toBe(false);
  expect(warning).toHaveBeenCalledTimes(2);
  warning.mockRestore();
});

it('the existing sandbox guard rejects real-home writes before filesystem I/O', async () => {
  vi.stubEnv('CEZ_HOME', join(homedir(), '.cezar'));
  await expect(saveUsageWindows(binding, observation())).rejects.toThrow('refusing to write');
});

it.each(['/resolved/profile', '/changed/profile'])('unidentified observations cannot erase identified state at %s', async (profilePath) => {
  vi.stubEnv('CEZ_HOME', mkdtempSync(join(tmpdir(), 'usage-store-')));
  const identified = { ...binding, identity: 'a'.repeat(64) };
  await saveUsageWindows(identified, observation(10));
  await saveUsageWindows({ ...binding, profilePath }, observation(20));
  expect(loadUsageWindows(identified)?.observedAt).toBe(10);
  expect(loadUsageWindows({ ...binding, profilePath })).toBeNull();
});
it('a verified new login replaces the old identity without merging its windows', async () => {
  vi.stubEnv('CEZ_HOME', mkdtempSync(join(tmpdir(), 'usage-store-')));
  const first = { ...binding, identity: 'a'.repeat(64) };
  const second = { ...binding, identity: 'b'.repeat(64) };
  await saveUsageWindows(first, observation(10));
  await saveUsageWindows(second, observation(20));
  expect(loadUsageWindows(first)).toBeNull();
  expect(loadUsageWindows(second)?.observedAt).toBe(20);
});

it.each([9, 11])('preserves current location when an old session reports at %s', async time => {
  vi.stubEnv('CEZ_HOME', mkdtempSync(join(tmpdir(), 'usage-store-')));
  const current = { ...binding, identity: 'a'.repeat(64) };
  const old = { ...current, profilePath: '/old/profile', identity: 'b'.repeat(64) };
  expect(await saveUsageWindows(current, observation(10))).toBe(true);
  expect(await saveUsageWindows(old, observation(time))).toBe(true);
  expect(loadUsageWindows(current)?.observedAt).toBe(10);
  expect(loadUsageWindows(old)?.observedAt).toBe(time);
  expect(loadUsageWindows({ ...current, identity: old.identity })).toBeNull();
  expect(loadUsageWindows({ ...current, accountId: 'other' })).toBeNull();
});
it('unknown resets and expired blocks do not become permanent ordinary holds', () => {
  const w = observation(10).windows[0]!;
  expect(isUsageWindowBlocking({ ...w, resetsAt: null }, 20)).toBe(false);
  expect(isUsageWindowBlocking({ ...w, resetsAt: 20 }, 20)).toBe(false);
  expect(isUsageWindowBlocking({ ...w, observedAt: 21 }, 20)).toBe(false);
});
it('retains the snapshot store bound across profile locations', async () => {
  const home = mkdtempSync(join(tmpdir(), 'usage-store-'));
  vi.stubEnv('CEZ_HOME', home);
  writeFileSync(join(home, 'usage-windows.json'), JSON.stringify(Array.from({ length: 1024 }, (_, i) => ({
    ...observation(), binding: { ...binding, profilePath: `/profile/${i}` },
  }))));
  expect(await saveUsageWindows(binding, observation(10))).toBe(true);
  expect(JSON.parse(readFileSync(join(home, 'usage-windows.json'), 'utf8'))).toHaveLength(1024);
  expect(loadUsageWindows(binding)?.observedAt).toBe(10);
});

it.each([9, 11])('preserves Claude location while an old session reports at %s', async time => {
  vi.stubEnv('CEZ_HOME', mkdtempSync(join(tmpdir(), 'usage-store-')));
  const current = { provider: 'claude' as const, accountId: 'work', profilePath: '/new/profile' };
  const old = { ...current, profilePath: '/old/profile' };
  const observed = (observedAt: number) => normalizeClaudeUsageWindows({ type: 'rate_limit_event', rate_limit_info: {
    rateLimitType: 'five_hour', status: 'rejected', resetsAt: 100000,
  } }, observedAt)!;
  expect(await saveUsageWindows(current, observed(10))).toBe(true);
  expect(await saveUsageWindows(old, observed(time))).toBe(true);
  expect(loadUsageWindows(current)?.observedAt).toBe(10);
  expect(loadUsageWindows(old)?.observedAt).toBe(time);
});
it('checks every retained location before admitting unidentified account data', async () => {
  vi.stubEnv('CEZ_HOME', mkdtempSync(join(tmpdir(), 'usage-store-')));
  await saveUsageWindows(binding, observation(10));
  const identified = { ...binding, profilePath: '/identified', identity: 'a'.repeat(64) };
  await saveUsageWindows(identified, observation(20));
  expect(await saveUsageWindows({ ...binding, profilePath: '/unknown' }, observation(30))).toBe(false);
  expect(loadUsageWindows(identified)?.observedAt).toBe(20);
});
