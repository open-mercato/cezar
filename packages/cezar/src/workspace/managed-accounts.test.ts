import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentHomesDir } from '../paths.ts';
import { loadAgentAccounts, mergeWriteAgentAccounts, type AgentAccount } from './agent-accounts.ts';
import {
  createManagedAccountDir,
  isInsideAgentHomes,
  isManagedAccountDir,
  logoutManagedAccount,
  markAccountSignedIn,
  PENDING_ACCOUNT_MAX_AGE_MS,
  removeManagedAccountDir,
  sweepPendingAccounts,
} from './managed-accounts.ts';

describe('managed account folders (spec 2026-11-24-add-account-in-cockpit)', () => {
  const savedHome = process.env.CEZ_HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-managed-'));
    process.env.CEZ_HOME = home;
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
  });

  const row = (over: Partial<AgentAccount>): AgentAccount => ({
    id: 'work',
    provider: 'claude',
    configDir: join(agentHomesDir(), 'claude', 'work'),
    label: 'Work',
    addedAt: new Date().toISOString(),
    managed: true,
    pending: true,
    ...over,
  });

  it('creates a private folder per account under agent-homes', async () => {
    const dir = await createManagedAccountDir('codex', 'client');
    expect(dir).toBe(join(home, 'agent-homes', 'codex', 'client'));
    if (process.platform !== 'win32') {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(agentHomesDir()).mode & 0o777).toBe(0o700);
    }
  });

  it('deletes only folders inside agent-homes, symlinks resolved', async () => {
    const inside = await createManagedAccountDir('claude', 'work');
    const outside = join(home, 'precious');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep'), 'x');
    const link = join(agentHomesDir(), 'claude', 'escape');
    symlinkSync(outside, link);

    expect(await isInsideAgentHomes(inside)).toBe(true);
    expect(await isInsideAgentHomes(agentHomesDir())).toBe(false);
    expect(await isInsideAgentHomes(outside)).toBe(false);
    expect(await isInsideAgentHomes(link)).toBe(false);

    expect(await removeManagedAccountDir(outside)).toBe(false);
    expect(await removeManagedAccountDir(link)).toBe(false);
    expect(existsSync(join(outside, 'keep'))).toBe(true);
    expect(await removeManagedAccountDir(inside)).toBe(true);
    expect(existsSync(inside)).toBe(false);
    expect(await removeManagedAccountDir(inside)).toBe(false);
  });

  it('treats only its own agent-homes/<provider>/<id> as managed, gone ones by their stored path', async () => {
    const inside = await createManagedAccountDir('claude', 'work');
    const outside = join(home, 'own-claude');
    mkdirSync(outside);
    symlinkSync(outside, join(agentHomesDir(), 'claude', 'escape'));
    const acct = (id: string, configDir: string) => ({ provider: 'claude' as const, id, configDir });

    expect(await isManagedAccountDir(acct('work', inside))).toBe(true);
    expect(await isManagedAccountDir(acct('gone', join(agentHomesDir(), 'claude', 'gone')))).toBe(true);
    expect(await isManagedAccountDir(acct('own', outside))).toBe(false);
    expect(await isManagedAccountDir(acct('escape', join(agentHomesDir(), 'claude', 'escape')))).toBe(false);
    // A hand-edited row naming the provider folder, or another account's folder, is not its own.
    expect(await isManagedAccountDir(acct('work', join(agentHomesDir(), 'claude')))).toBe(false);
    expect(await isManagedAccountDir(acct('other', inside))).toBe(false);
  });

  it('never adopts a folder that is already there', async () => {
    const dir = await createManagedAccountDir('claude', 'work');
    writeFileSync(join(dir, '.credentials.json'), 'x');
    await expect(createManagedAccountDir('claude', 'work')).rejects.toMatchObject({ code: 'EEXIST' });
  });

  it('keeps the folder of a row that signed in while the sweep was writing', async () => {
    const dir = await createManagedAccountDir('claude', 'work');
    await mergeWriteAgentAccounts((s) => { s.accounts.push(row({ addedAt: new Date(0).toISOString() })); });
    let calls = 0;
    // Stale when listed, live by the time the write re-checks it.
    const removed = await sweepPendingAccounts({ isLive: () => ++calls > 1 });
    expect(removed).toEqual([]);
    expect(existsSync(dir)).toBe(true);
    expect((await loadAgentAccounts()).accounts.map((a) => a.id)).toEqual(['work']);
  });

  it('logs out through the CLI with the account folder in its env', async () => {
    const runLogout = vi.fn(async () => {});
    await logoutManagedAccount({ provider: 'claude', configDir: '/x/claude/work' }, runLogout);
    expect(runLogout).toHaveBeenCalledTimes(1);
    const [, args, env] = runLogout.mock.calls[0] as unknown as [string, string[], NodeJS.ProcessEnv];
    expect(args).toEqual(['auth', 'logout']);
    expect(env.CLAUDE_CONFIG_DIR).toBe('/x/claude/work');

    await logoutManagedAccount({ provider: 'kimi', configDir: '/x/kimi/a' }, runLogout);
    expect(runLogout).toHaveBeenCalledTimes(1);
  });

  it('clears pending on the first confirmed sign-in only', async () => {
    await mergeWriteAgentAccounts((store) => { store.accounts.push(row({})); });
    expect(await markAccountSignedIn('claude', 'work')).toBe(true);
    expect((await loadAgentAccounts()).accounts[0]).not.toHaveProperty('pending');
    expect((await loadAgentAccounts()).accounts[0]?.managed).toBe(true);
    expect(await markAccountSignedIn('claude', 'work')).toBe(false);
    expect(await markAccountSignedIn('codex', 'work')).toBe(false);
  });

  it('sweeps stale pending managed accounts and their folders, keeping live and signed-in ones', async () => {
    const now = Date.now();
    const old = new Date(now - PENDING_ACCOUNT_MAX_AGE_MS - 1000).toISOString();
    const dirs = await Promise.all(['stale', 'live', 'fresh', 'done'].map((id) => createManagedAccountDir('claude', id)));
    const hand = join(home, 'hand');
    mkdirSync(hand);
    await mergeWriteAgentAccounts((store) => {
      store.accounts.push(
        row({ id: 'stale', configDir: dirs[0]!, addedAt: old }),
        row({ id: 'live', configDir: dirs[1]!, addedAt: old }),
        row({ id: 'fresh', configDir: dirs[2]! }),
        row({ id: 'done', configDir: dirs[3]!, addedAt: old, pending: undefined }),
        // Not managed: never swept, whatever its flags say.
        row({ id: 'hand', configDir: hand, addedAt: old, managed: undefined }),
      );
    });

    const swept = await sweepPendingAccounts({ now, isLive: (_p, id) => id === 'live' });
    expect(swept).toEqual(['stale']);
    expect((await loadAgentAccounts()).accounts.map((a) => a.id)).toEqual(['live', 'fresh', 'done', 'hand']);
    expect(existsSync(dirs[0]!)).toBe(false);
    expect(existsSync(dirs[1]!)).toBe(true);
    expect(existsSync(hand)).toBe(true);
  });

  it('sweeps nothing, and writes nothing, when there is nothing stale', async () => {
    expect(await sweepPendingAccounts()).toEqual([]);
    expect(existsSync(join(home, 'agent-accounts.json'))).toBe(false);
  });
});
