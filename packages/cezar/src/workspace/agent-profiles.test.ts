import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentAccountsPath } from '../paths.ts';
import {
  defaultAgentProfile,
  listAgentProfiles,
  profileDirState,
  profilesForProvider,
  resolveProfileEnvForRoot,
  sameProfileDir,
  selectProfile,
} from './agent-profiles.ts';
import { DEFAULT_AGENT_ACCOUNT_ID, loadAgentAccounts } from './agent-accounts.ts';

/**
 * Resolution rules from spec 2026-07-29-agent-profiles. The pair worth reading closely is the two
 * degradation cases: an UNKNOWN id falls back to the default, a KNOWN id with a MISSING directory
 * does not. They differ on purpose — see the assertions.
 */
describe('agent profile resolution', () => {
  const originalHome = process.env.CEZ_HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-profiles-'));
    process.env.CEZ_HOME = home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  const env = { HOME: '/home/u' } as NodeJS.ProcessEnv;
  const write = (value: unknown) => writeFileSync(agentAccountsPath(), JSON.stringify(value), 'utf8');
  const klaudiuszProfile = {
    id: 'klaudiusz',
    provider: 'claude' as const,
    configDir: '~/.claude-klaudiusz',
    label: 'Klaudiusz',
    addedAt: '',
  };

  describe('defaultAgentProfile', () => {
    it('is whatever agentHomePaths discovers, per provider', () => {
      expect(defaultAgentProfile('claude', env).path).toBe('/home/u/.claude');
      expect(defaultAgentProfile('codex', env).path).toBe('/home/u/.codex');
      expect(defaultAgentProfile('opencode', env).path).toBe('/home/u/.config/opencode');
    });

    it('follows the vendor env vars, so setting one moves the DEFAULT profile', () => {
      const relocated = { HOME: '/home/u', CLAUDE_CONFIG_DIR: '/opt/claude' } as NodeJS.ProcessEnv;
      expect(defaultAgentProfile('claude', relocated).path).toBe('/opt/claude');
    });

    it('is marked default so the UI can refuse to edit or delete it', () => {
      expect(defaultAgentProfile('claude', env)).toMatchObject({ id: 'default', isDefault: true });
    });
  });

  describe('listing', () => {
    it('puts the discovered profile first, then the stored extras in file order', async () => {
      write({ accounts: [klaudiuszProfile, { ...klaudiuszProfile, id: 'client', configDir: '~/.claude-client' }] });
      const store = await loadAgentAccounts();
      expect(profilesForProvider(store, 'claude', env).map((p) => p.id)).toEqual([
        'default',
        'klaudiusz',
        'client',
      ]);
    });

    it('never mixes providers', async () => {
      write({ accounts: [klaudiuszProfile, { ...klaudiuszProfile, id: 'cx', provider: 'codex' }] });
      const store = await loadAgentAccounts();
      expect(profilesForProvider(store, 'codex', env).map((p) => p.id)).toEqual(['default', 'cx']);
      expect(listAgentProfiles(store, ['claude', 'codex'], env)).toHaveLength(4);
    });

    it('expands a stored `~` while keeping what the user typed', async () => {
      write({ accounts: [klaudiuszProfile] });
      const [, stored] = profilesForProvider(await loadAgentAccounts(), 'claude', env);
      expect(stored?.configDir).toBe('~/.claude-klaudiusz');
      expect(stored?.path.endsWith('/.claude-klaudiusz')).toBe(true);
      expect(stored?.path.startsWith('~')).toBe(false);
    });
  });

  describe('selectProfile', () => {
    it('uses the project\'s stored selection', async () => {
      write({
        accounts: [klaudiuszProfile],
        selections: { '/tmp/projects/a': { claude: 'klaudiusz' } },
      });
      const store = await loadAgentAccounts();
      expect(selectProfile(store, { provider: 'claude', repoRoot: '/tmp/projects/a', env }).id).toBe('klaudiusz');
    });

    it('lets an explicit profileId (a run\'s recorded account) win over the project', async () => {
      write({
        accounts: [klaudiuszProfile],
        selections: { '/tmp/projects/a': { claude: 'klaudiusz' } },
      });
      const store = await loadAgentAccounts();
      expect(
        selectProfile(store, { provider: 'claude', repoRoot: '/tmp/projects/a', profileId: 'default', env }).id,
      ).toBe('default');
    });

    it('degrades an UNKNOWN id to the default — a dangling reference names no account', async () => {
      write({ selections: { '/tmp/projects/a': { claude: 'deleted-yesterday' } } });
      const store = await loadAgentAccounts();
      expect(selectProfile(store, { provider: 'claude', repoRoot: '/tmp/projects/a', env }).isDefault).toBe(true);
    });

    it('will not hand one provider another provider\'s profile', async () => {
      write({
        accounts: [klaudiuszProfile],
        selections: { '/tmp/projects/a': { codex: 'klaudiusz' } },
      });
      const store = await loadAgentAccounts();
      expect(selectProfile(store, { provider: 'codex', repoRoot: '/tmp/projects/a', env }).isDefault).toBe(true);
    });

    it('defaults for an unregistered root — headless runs and task worktrees', async () => {
      write({ accounts: [klaudiuszProfile] });
      const store = await loadAgentAccounts();
      expect(selectProfile(store, { provider: 'claude', repoRoot: '/somewhere/else', env }).isDefault).toBe(true);
      expect(selectProfile(store, { provider: 'claude', env }).isDefault).toBe(true);
    });
  });

  describe('resolveProfileEnvForRoot', () => {
    it('adds NOTHING for the default profile', async () => {
      write({});
      const resolved = await resolveProfileEnvForRoot('/tmp/projects/a', 'claude');
      expect(resolved.env).toEqual({});
      expect(resolved.profile.isDefault).toBe(true);
    });

    it('points the CLI at the selected account', async () => {
      write({
        accounts: [{ ...klaudiuszProfile, configDir: '/opt/claude-klaudiusz' }],
        selections: { '/tmp/projects/a': { claude: 'klaudiusz' } },
      });
      const resolved = await resolveProfileEnvForRoot('/tmp/projects/a', 'claude');
      expect(resolved.env).toEqual({ CLAUDE_CONFIG_DIR: '/opt/claude-klaudiusz' });
    });

    it('uses CODEX_HOME for a codex step in the same project', async () => {
      write({
        accounts: [
          { ...klaudiuszProfile, id: 'cx', provider: 'codex', configDir: '/opt/codex-klaudiusz' },
        ],
        selections: { '/tmp/projects/a': { codex: 'cx' } },
      });
      const resolved = await resolveProfileEnvForRoot('/tmp/projects/a', 'codex');
      expect(resolved.env).toEqual({ CODEX_HOME: '/opt/codex-klaudiusz' });
    });

    it('degrades to the default when the accounts file is unreadable', async () => {
      writeFileSync(agentAccountsPath(), '{ not json', 'utf8');
      const resolved = await resolveProfileEnvForRoot('/tmp/projects/a', 'claude');
      expect(resolved.env).toEqual({});
    });
  });

  describe('profileDirState', () => {
    it('reports a real config dir as existing and valid', async () => {
      const dir = join(home, 'claude-klaudiusz');
      mkdirSync(dir);
      writeFileSync(join(dir, 'settings.json'), '{}', 'utf8');
      expect(await profileDirState('claude', dir)).toEqual({ exists: true, looksValid: true });
    });

    it('accepts a dir that is not there YET — Connect creates it on first login', async () => {
      expect(await profileDirState('claude', join(home, 'not-created-yet'))).toEqual({
        exists: false,
        looksValid: false,
      });
    });

    it('reports an existing but unrecognised dir honestly, without refusing it', async () => {
      const dir = join(home, 'random');
      mkdirSync(dir);
      expect(await profileDirState('claude', dir)).toEqual({ exists: true, looksValid: false });
    });
  });

  describe('sameProfileDir', () => {
    it('sees through a trailing slash and a symlink spelling of one directory', async () => {
      const dir = join(home, 'claude-klaudiusz');
      mkdirSync(dir);
      expect(await sameProfileDir(dir, `${dir}/`)).toBe(true);
      expect(await sameProfileDir(dir, join(home, 'other'))).toBe(false);
    });
  });

  /**
   * The machine-wide default account (spec 2026-07-29-agent-profiles): what a repo that has chosen
   * nothing uses, so a second login is set up once instead of per checkout.
   */
  describe('the machine-wide default account', () => {
    it('is used by a repo that has chosen nothing', async () => {
      write({ accounts: [klaudiuszProfile], defaults: { claude: 'klaudiusz' } });
      const store = await loadAgentAccounts();
      expect(selectProfile(store, { provider: 'claude', repoRoot: '/tmp/projects/a', env }).id)
        .toBe('klaudiusz');
    });

    it('NEVER overrules a repo that has chosen — that is what makes it a default', async () => {
      // The failure this forbids: changing the machine default silently re-points work someone
      // already configured, onto another subscription.
      write({
        accounts: [klaudiuszProfile, { ...klaudiuszProfile, id: 'client', configDir: '~/.claude-client' }],
        defaults: { claude: 'klaudiusz' },
        selections: { '/tmp/projects/a': { claude: 'client' } },
      });
      const store = await loadAgentAccounts();
      expect(selectProfile(store, { provider: 'claude', repoRoot: '/tmp/projects/a', env }).id)
        .toBe('client');
    });

    it('loses to a per-task override, which is the most specific answer there is', async () => {
      write({ accounts: [klaudiuszProfile], defaults: { claude: 'klaudiusz' } });
      const store = await loadAgentAccounts();
      expect(selectProfile(store, {
        provider: 'claude',
        repoRoot: '/tmp/projects/a',
        profileId: DEFAULT_AGENT_ACCOUNT_ID,
        env,
      }).isDefault).toBe(true);
    });

    it('is per provider — a claude default says nothing about codex', async () => {
      write({ accounts: [klaudiuszProfile], defaults: { claude: 'klaudiusz' } });
      const store = await loadAgentAccounts();
      expect(selectProfile(store, { provider: 'codex', repoRoot: '/tmp/projects/a', env }).isDefault)
        .toBe(true);
    });

    it('degrades to the discovered account when it names an account that is gone', async () => {
      write({ accounts: [], defaults: { claude: 'deleted-account' } });
      const store = await loadAgentAccounts();
      expect(selectProfile(store, { provider: 'claude', repoRoot: '/tmp/projects/a', env }).isDefault)
        .toBe(true);
    });
  });
});
