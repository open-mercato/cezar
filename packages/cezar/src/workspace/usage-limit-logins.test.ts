import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LOGIN_FRESH_MS,
  onLoginLiftReady,
  readLoginIdentity,
  recordUsageLimit,
  refreshLoginIdentities,
  releaseUsageLimit,
  resetUsageLimitLoginsForTests,
  usageLimitLift,
} from './usage-limit-logins.ts';

/** Login reads, counted: a stale lift must never spin on an unreadable login. */
const loginReads = vi.hoisted(() => ({ count: 0 }));
vi.mock('../agent-config/account-identity.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent-config/account-identity.ts')>();
  return {
    ...actual,
    accountLoginFingerprint: (...args: Parameters<typeof actual.accountLoginFingerprint>) => {
      loginReads.count += 1;
      return actual.accountLoginFingerprint(...args);
    },
  };
});

/** When an account's holds stop binding early (spec 2026-08-03-auto-resume-after-usage-limit,
 *  2026-11-23 addendum). Every doubt has to land on the hold binding until its deadline. */
describe('usage-limit logins', () => {
  const saved: Record<string, string | undefined> = {};
  let home: string;
  let claude: string;
  const account = 'claude:default';
  const signIn = (uuid: string) =>
    writeFileSync(join(claude, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: uuid, organizationUuid: 'org' } }));

  beforeEach(() => {
    for (const key of ['CEZ_HOME', 'CLAUDE_CONFIG_DIR']) saved[key] = process.env[key];
    home = mkdtempSync(join(tmpdir(), 'cez-logins-home-'));
    claude = mkdtempSync(join(tmpdir(), 'cez-logins-claude-'));
    process.env.CEZ_HOME = home;
    process.env.CLAUDE_CONFIG_DIR = claude;
    resetUsageLimitLoginsForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(claude, { recursive: true, force: true });
  });

  const later = () => Date.now() + 3_600_000;

  it('lifts once the folder holds another login, and only then', async () => {
    signIn('a');
    recordUsageLimit(account, await readLoginIdentity(account), later());
    expect(usageLimitLift(account)).toBeUndefined();
    signIn('b');
    expect(await refreshLoginIdentities()).toBe(true);
    expect(usageLimitLift(account)).toBe('login');
    // Already reported: the next tick does not wake every queue again.
    expect(await refreshLoginIdentities()).toBe(false);
  });

  it('switching back to a login whose limit has not reset holds again (A → B → A)', async () => {
    signIn('a');
    recordUsageLimit(account, await readLoginIdentity(account), later());
    signIn('b');
    recordUsageLimit(account, await readLoginIdentity(account), later()); // B is limited too
    signIn('a');
    await refreshLoginIdentities();
    expect(usageLimitLift(account)).toBeUndefined();
  });

  it('a late limit from a session started before the re-login never lifts the new login\'s limit', async () => {
    signIn('a');
    const a = await readLoginIdentity(account);
    signIn('b');
    recordUsageLimit(account, await readLoginIdentity(account), later()); // B is limited
    recordUsageLimit(account, a, later()); // …then a session spawned under A meets a limit too
    await refreshLoginIdentities();
    expect(usageLimitLift(account)).toBeUndefined();
  });

  it('an unknown login on either side is not a change', async () => {
    recordUsageLimit(account, undefined, later());
    signIn('b');
    await refreshLoginIdentities();
    expect(usageLimitLift(account)).toBeUndefined();
  });

  it('Resume now lifts until the next limit, also one another process recorded', async () => {
    writeFileSync(join(home, 'usage-limit-logins.json'), JSON.stringify({ 'codex:work': { limits: {}, released: true } }));
    releaseUsageLimit(account);
    expect(usageLimitLift(account)).toBe('released');
    expect(JSON.parse(readFileSync(join(home, 'usage-limit-logins.json'), 'utf8'))).toMatchObject({ 'codex:work': { released: true } });
    // Another process records a new limit; this one's cache must not keep the release alive.
    writeFileSync(join(home, 'usage-limit-logins.json'), JSON.stringify({ [account]: { limits: { '?': later() } } }));
    recordUsageLimit(account, undefined, later());
    expect(usageLimitLift(account)).toBeUndefined();
  });

  it('trusts a login lift only on a fresh read: a stale one holds, reads again, and wakes the queues', async () => {
    signIn('a');
    recordUsageLimit(account, await readLoginIdentity(account), later());
    signIn('b');
    await readLoginIdentity(account);
    expect(usageLimitLift(account)).toBe('login');
    const real = Date.now.bind(Date);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => real() + LOGIN_FRESH_MS + 1_000);
    const woke = vi.fn();
    const off = onLoginLiftReady(woke);
    try {
      // A is back in the folder; the B read is too old to act on.
      signIn('a');
      expect(usageLimitLift(account)).toBeUndefined();
      await vi.waitFor(() => expect(usageLimitLift(account)).toBeUndefined());
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(woke).not.toHaveBeenCalled();
      // B again, read stale once more: the fresh read lands, the lift stands, the queues wake.
      signIn('b');
      clock.mockImplementation(() => real() + 2 * (LOGIN_FRESH_MS + 1_000));
      expect(usageLimitLift(account)).toBeUndefined();
      await vi.waitFor(() => expect(woke).toHaveBeenCalledTimes(1));
      expect(usageLimitLift(account)).toBe('login');
      // A read that fails never refreshes the age of the last answer.
      rmSync(join(claude, '.claude.json'));
      clock.mockImplementation(() => real() + 3 * (LOGIN_FRESH_MS + 1_000));
      expect(usageLimitLift(account)).toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(usageLimitLift(account)).toBeUndefined();
    } finally {
      off();
    }
  });

  it('an unreadable login is read at most once per backoff, however often the lift is asked', async () => {
    signIn('a');
    recordUsageLimit(account, await readLoginIdentity(account), later());
    signIn('b');
    await readLoginIdentity(account);
    rmSync(join(claude, '.claude.json')); // signed out, or caught mid-rewrite
    const real = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => real() + LOGIN_FRESH_MS + 1_000);
    loginReads.count = 0;
    const deadline = real() + 200;
    while (real() < deadline) {
      expect(usageLimitLift(account)).toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(loginReads.count).toBeLessThanOrEqual(2);
  });
});
