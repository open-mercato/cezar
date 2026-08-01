import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentAccountsPath, workspaceConfigPath } from '../paths.ts';
import { loadWorkspaceConfig, mergeWriteWorkspaceConfig } from './config.ts';
import {
  defaultAgentAccountStore,
  isAbsoluteConfigDir,
  loadAgentAccounts,
  mergeWriteAgentAccounts,
  selectionFor,
} from './agent-accounts.ts';

/**
 * `~/.cezar/agent-accounts.json` (spec 2026-07-29-agent-profiles).
 *
 * The first describe block is the reason this file exists at all: accounts used to live in
 * `config.json`, where surviving a cezar downgrade depended on a `.passthrough()` in the other
 * version's schema. Here they cannot be touched by a version that does not know about them.
 */
describe('agent accounts store', () => {
  const originalHome = process.env.CEZ_HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-accounts-'));
    process.env.CEZ_HOME = home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const write = (value: unknown) =>
    writeFileSync(agentAccountsPath(), typeof value === 'string' ? value : JSON.stringify(value), 'utf8');

  const account = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    provider: 'claude' as const,
    configDir: `~/.claude-${id}`,
    label: id,
    addedAt: '2026-07-29T10:00:00Z',
    ...over,
  });

  describe('isolation from config.json (the reason for this file)', () => {
    it('survives a cezar that rewrites config.json without knowing accounts exist', async () => {
      await mergeWriteAgentAccounts((store) => {
        store.accounts.push(account('work'));
        store.selections['/repo'] = { claude: 'work' };
      });

      // An older cezar boots: it reads and rewrites config.json (registering a project, bumping
      // lastOpenedAt, saving a setting). It has never heard of accounts, so it never opens their
      // file — and no `.passthrough()` in ITS schema has to hold for them to survive.
      await mergeWriteWorkspaceConfig((config) => {
        config.projects.push({
          id: 'repo',
          root: '/repo',
          name: 'repo',
          addedAt: '',
          lastOpenedAt: '',
          source: 'local',
        });
      });

      const store = await loadAgentAccounts();
      expect(store.accounts.map((a) => a.id)).toEqual(['work']);
      expect(store.selections['/repo']).toEqual({ claude: 'work' });
    });

    it('survives even a config.json so corrupt that the other cezar rewrote it from defaults', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await mergeWriteAgentAccounts((store) => {
        store.accounts.push(account('work'));
        store.selections['/repo'] = { claude: 'work' };
      });
      // THE case passthrough could never cover: an unparseable config.json degrades to in-memory
      // defaults, and the next merge-write persists those — wiping anything it did not understand.
      writeFileSync(workspaceConfigPath(), '{ not json', 'utf8');
      await mergeWriteWorkspaceConfig((config) => {
        config.resources.maxParallel = 3;
      });
      expect((await loadWorkspaceConfig()).projects).toEqual([]); // config.json really was reset

      const store = await loadAgentAccounts();
      expect(store.accounts.map((a) => a.id)).toEqual(['work']);
      expect(store.selections['/repo']).toEqual({ claude: 'work' });
    });

    it('writes no file at all when there are no accounts — nothing to lose, nothing to keep', async () => {
      expect(await loadAgentAccounts()).toEqual(defaultAgentAccountStore());
      expect(existsSync(agentAccountsPath())).toBe(false);
    });
  });

  describe('legacy import from config.json', () => {
    it('carries accounts and selections across, once, without touching config.json', async () => {
      const legacy = {
        schemaVersion: 1,
        agentProfiles: [account('work')],
        projects: [
          { id: 'p', root: '/repo', name: 'p', addedAt: '', lastOpenedAt: '', source: 'local',
            agentProfile: { claude: 'work' } },
        ],
      };
      writeFileSync(workspaceConfigPath(), JSON.stringify(legacy), 'utf8');

      const store = await loadAgentAccounts();
      expect(store.accounts.map((a) => a.id)).toEqual(['work']);
      expect(store.selections['/repo']).toEqual({ claude: 'work' });
      // Persisted, so the next read does not depend on config.json any more…
      expect(existsSync(agentAccountsPath())).toBe(true);
      // …and config.json keeps what it had: an older cezar sharing this home reads it unchanged.
      const raw = JSON.parse(readFileSync(workspaceConfigPath(), 'utf8')) as Record<string, unknown>;
      expect(raw.agentProfiles).toEqual([account('work')]);
    });

    it('does not re-import once the file exists, so a deleted account stays deleted', async () => {
      writeFileSync(
        workspaceConfigPath(),
        JSON.stringify({ agentProfiles: [account('work')] }),
        'utf8',
      );
      await loadAgentAccounts(); // imports
      await mergeWriteAgentAccounts((store) => {
        store.accounts = [];
      });
      expect((await loadAgentAccounts()).accounts).toEqual([]);
    });

    it('imports nothing from a config.json that has no accounts', async () => {
      writeFileSync(workspaceConfigPath(), JSON.stringify({ schemaVersion: 1 }), 'utf8');
      expect((await loadAgentAccounts()).accounts).toEqual([]);
      expect(existsSync(agentAccountsPath())).toBe(false);
    });
  });

  describe('house rules', () => {
    it('a missing file is the zero-config default, silently', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect((await loadAgentAccounts()).accounts).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('a corrupt file warns once and is left on disk for the user to repair', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      write('{not json');
      expect((await loadAgentAccounts()).accounts).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(readFileSync(agentAccountsPath(), 'utf8')).toBe('{not json');
    });

    it('drops a corrupt row but keeps the rest (per-entry salvage)', async () => {
      write({
        accounts: [
          account('work'),
          { id: 'no-provider', configDir: '~/x' },
          { id: 'no-dir', provider: 'claude' },
          account('side', { provider: 'codex' }),
        ],
      });
      expect((await loadAgentAccounts()).accounts.map((a) => a.id)).toEqual(['work', 'side']);
    });

    it('refuses the reserved `default` id — the discovered account is never stored', async () => {
      write({ accounts: [account('default'), account('work')] });
      expect((await loadAgentAccounts()).accounts.map((a) => a.id)).toEqual(['work']);
    });

    it('refuses an agent that cannot carry a second account — it would resolve to a lie', async () => {
      // `PROFILE_ENV_VAR.opencode` is null, so `profileEnv` returns `{}` for it: the step would
      // record this account, the UI would name it, and the CLI would run on the DEFAULT login
      // anyway — the exact "says Work, bills personal" failure this feature exists to prevent. The
      // route already refuses it, but this file is designed to survive hand edits, foreign writers
      // and the legacy import, so the schema has to refuse it too.
      write({ accounts: [account('oc', { provider: 'opencode' }), account('work')] });
      expect((await loadAgentAccounts()).accounts.map((a) => a.id)).toEqual(['work']);
    });

    it('refuses a configDir carrying control characters (it reaches a shell command)', async () => {
      write({ accounts: [account('work', { configDir: `~/.claude${String.fromCharCode(10)}evil` })] });
      expect((await loadAgentAccounts()).accounts).toEqual([]);
    });

    it('dedupes ids first-wins, so two consumers never resolve one id differently', async () => {
      write({
        accounts: [account('work', { configDir: '~/first' }), account('work', { configDir: '~/second' })],
      });
      const { accounts } = await loadAgentAccounts();
      expect(accounts).toHaveLength(1);
      expect(accounts[0]?.configDir).toBe('~/first');
    });

    it('degrades display fields per key rather than dropping the row', async () => {
      write({ accounts: [account('work', { label: 42, addedAt: [] })] });
      const [row] = (await loadAgentAccounts()).accounts;
      expect(row).toMatchObject({ id: 'work', label: '', addedAt: '' });
    });

    it('preserves a NEWER cezar\'s unknown keys at every level (.passthrough)', async () => {
      write({
        futureTopLevel: { keep: true },
        accounts: [{ ...account('work'), futureRowKey: 1 }],
      });
      await mergeWriteAgentAccounts((store) => {
        store.selections['/repo'] = { claude: 'work' };
      });
      const raw = JSON.parse(readFileSync(agentAccountsPath(), 'utf8')) as Record<string, any>;
      expect(raw.futureTopLevel).toEqual({ keep: true });
      expect(raw.accounts[0].futureRowKey).toBe(1);
    });

    it('salvages selections per entry and drops a malformed one', async () => {
      write({
        accounts: [account('work')],
        selections: { '/a': { claude: 'work' }, '/b': 'nonsense', '/c': { claude: 12345 } },
      });
      const store = await loadAgentAccounts();
      expect(store.selections['/a']).toEqual({ claude: 'work' });
      expect(store.selections['/b']).toBeUndefined();
      // A bad per-provider value degrades to "inherit the default", never evicting the row.
      expect(store.selections['/c']).toEqual({});
    });

    it('writes at mode 0600, like every other file in ~/.cezar', async () => {
      await mergeWriteAgentAccounts((store) => {
        store.accounts.push(account('work'));
      });
      expect(statSync(agentAccountsPath()).mode & 0o777).toBe(0o600);
    });

    it('converges two concurrent writers instead of dropping one', async () => {
      await mergeWriteAgentAccounts((store) => {
        store.accounts.push(account('work'));
      });
      await Promise.all([
        mergeWriteAgentAccounts((store) => {
          store.selections['/a'] = { claude: 'work' };
        }),
        mergeWriteAgentAccounts((store) => {
          store.accounts.push(account('client'));
        }),
      ]);
      const store = await loadAgentAccounts();
      // Last-writer-wins only inside the read→rename window; neither write is lost outright.
      expect(store.accounts.length + Object.keys(store.selections).length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('selectionFor', () => {
    it('answers the project\'s choice, keyed by repo root', async () => {
      write({ accounts: [account('work')], selections: { '/repo': { claude: 'work' } } });
      const store = await loadAgentAccounts();
      expect(selectionFor(store, '/repo', 'claude')).toBe('work');
      expect(selectionFor(store, '/repo', 'codex')).toBeUndefined();
      expect(selectionFor(store, '/elsewhere', 'claude')).toBeUndefined();
      expect(selectionFor(store, undefined, 'claude')).toBeUndefined();
    });

    // The keys come from the REGISTRY, which realpath-normalizes every root it stores; the readers
    // hold whatever spelling their caller had (`RunManager` gets `repoInfo?.root ?? cwd` for the
    // boot project, not the registry entry). A raw string compare drops the selection silently and
    // the run bills the discovered account instead — the one failure this feature exists to
    // prevent. `workspace/semaphore.ts` normalizes at lookup for the same reason; a real symlink is
    // the only way to prove it.
    it('resolves a symlinked spelling of the root the registry stored', async () => {
      const real = join(home, 'real-repo');
      const link = join(home, 'linked-repo');
      mkdirSync(real);
      symlinkSync(real, link);
      write({ accounts: [account('work')], selections: { [realpathSync(real)]: { claude: 'work' } } });
      const store = await loadAgentAccounts();

      expect(selectionFor(store, realpathSync(real), 'claude')).toBe('work');
      expect(selectionFor(store, link, 'claude')).toBe('work');
    });

    it('still answers the machine-wide default for a root nobody chose', async () => {
      write({ accounts: [account('work')], defaults: { claude: 'work' } });
      const store = await loadAgentAccounts();
      expect(selectionFor(store, '/never-registered', 'claude')).toBe('work');
    });
  });

  /**
   * The account routes' only path rule. It was a leading-`/` test, which refuses every real Windows
   * path — while `core/shell-env.ts` renders `set "VAR=v"` for `cmd.exe` specifically so an account
   * survives a Windows terminal handoff, and the Add-account dialog delegates all path validation to
   * the server. Both platforms are asserted here so neither can regress from the other's machine.
   */
  describe('isAbsoluteConfigDir', () => {
    it('accepts a Windows drive path on Windows, where it is the only spelling there is', () => {
      expect(isAbsoluteConfigDir('C:\\Users\\me\\.claude-work', 'win32')).toBe(true);
      expect(isAbsoluteConfigDir('\\\\server\\share\\claude', 'win32')).toBe(true);
    });

    it('accepts a POSIX path on POSIX', () => {
      expect(isAbsoluteConfigDir('/home/me/.claude-work', 'linux')).toBe(true);
      expect(isAbsoluteConfigDir('/Users/me/.claude-work', 'darwin')).toBe(true);
    });

    it('still refuses a relative dir on either platform — it would resolve against a throwaway worktree', () => {
      expect(isAbsoluteConfigDir('.claude-work', 'win32')).toBe(false);
      expect(isAbsoluteConfigDir('.claude-work', 'darwin')).toBe(false);
      expect(isAbsoluteConfigDir('~/.claude-work', 'darwin')).toBe(false);
    });

    it('does not accept a Windows path on POSIX, where it really is relative', () => {
      expect(isAbsoluteConfigDir('C:\\Users\\me\\.claude-work', 'darwin')).toBe(false);
    });
  });
});
