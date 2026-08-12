import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentProfilesResponse, AgentProfileResponse } from '@open-mercato/cezar-contract';
import { agentAccountsPath } from '../paths.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { loadAgentAccounts, mergeWriteAgentAccounts } from '../workspace/agent-accounts.ts';
import { clearProjectProbeCache, registerProject } from '../workspace/projects.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { ProviderAuthService } from '../core/provider-auth.ts';
import { createApp, type ServerDeps } from './server.ts';

/**
 * `/api/v1/workspace/agent-profiles` (spec 2026-07-29-agent-profiles): extra config dirs for a
 * second login of the same agent CLI.
 *
 * Workspace-level and single-mount — an account belongs to the person and the machine. Writing is
 * a local-machine capability on the same terms as `PUT /api/v1/agent-config/:id`.
 */
describe('agent profiles API', () => {
  const saved = {
    home: process.env.CEZ_HOME,
    remote: process.env.CEZ_REMOTE,
    dryRun: process.env.CEZ_DRY_RUN,
  };
  let home: string;
  let repoRoot: string;
  let store: RunStore;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-profiles-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-profiles-repo-'));
    process.env.CEZ_HOME = home;
    delete process.env.CEZ_REMOTE;
    // Deterministic on any machine: no real agent CLIs are probed.
    process.env.CEZ_DRY_RUN = '1';
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    clearProjectProbeCache();
  });

  afterEach(() => {
    store.flush();
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of [
      ['CEZ_HOME', saved.home],
      ['CEZ_REMOTE', saved.remote],
      ['CEZ_DRY_RUN', saved.dryRun],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const makeApp = (over: Partial<ServerDeps> = {}) =>
    createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', ...over });

  const list = async (): Promise<AgentProfilesResponse> => {
    const res = await apiRequest(makeApp(), '/api/v1/workspace/agent-profiles');
    expect(res.status).toBe(200);
    return (await res.json()) as AgentProfilesResponse;
  };

  const send = async (method: string, path: string, body?: unknown) => {
    const res = await apiRequest(makeApp(), path, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as AgentProfileResponse & { error?: string } };
  };

  /** A directory that looks like a real Claude config dir, so `looksValid` is true. */
  const claudeDir = (name: string): string => {
    const dir = join(home, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), '{}', 'utf8');
    return dir;
  };

  describe('GET', () => {
    it('lists only the discovered defaults out of the box — the zero-config state', async () => {
      const body = await list();
      expect(body.editable).toBe(true);
      expect(body.profiles.every((p) => p.isDefault)).toBe(true);
      expect(body.profiles.map((p) => p.provider)).toEqual(['claude', 'codex', 'opencode']);
      expect(body.profiles.every((p) => p.id === 'default')).toBe(true);
    });

    it('names the providers that can carry an account at all — OpenCode cannot', async () => {
      expect((await list()).profileCapableProviders).toEqual(['claude', 'codex']);
    });

    it('reports each account\'s folder state, and does not refuse one that is missing', async () => {
      const real = claudeDir('claude-klaudiusz');
      await send('POST', '/api/v1/workspace/agent-profiles', { provider: 'claude', configDir: real });
      await send('POST', '/api/v1/workspace/agent-profiles', {
        provider: 'claude',
        label: 'not yet',
        configDir: join(home, 'claude-later'),
      });
      const stored = (await list()).profiles.filter((p) => !p.isDefault);
      expect(stored.find((p) => p.path === real)).toMatchObject({ exists: true, looksValid: true });
      // "Add account → Connect → the CLI creates the folder" is the real first-run flow, so a
      // dir that is not there yet is listed honestly rather than rejected.
      expect(stored.find((p) => p.label === 'not yet')).toMatchObject({ exists: false, looksValid: false });
    });

    it('never spawns a CLI for the listing — auth arrives from the per-account route', async () => {
      const { body: created } = await send('POST', '/api/v1/workspace/agent-profiles', {
        provider: 'claude',
        configDir: claudeDir('claude-klaudiusz'),
      });
      // Under CEZ_DRY_RUN the peek answers from its own short-circuit, so assert the SHAPE
      // contract instead: whatever the listing carries, the dedicated route is what probes.
      const res = await apiRequest(
        makeApp(),
        `/api/v1/workspace/agent-profiles/${created.profile.id}/status`,
      );
      expect(res.status).toBe(200);
      const { status } = (await res.json()) as { status: { provider: string; profileId?: string } };
      expect(status.provider).toBe('claude');
      expect(status.profileId).toBe(created.profile.id);
    });
  });

  describe('POST', () => {
    it('allocates a slug from the label, echoing the folder as written', async () => {
      const { status, body } = await send('POST', '/api/v1/workspace/agent-profiles', {
        provider: 'claude',
        label: 'Work account',
        configDir: '~/.claude-klaudiusz',
      });
      expect(status).toBe(201);
      expect(body.profile).toMatchObject({
        id: 'work-account',
        provider: 'claude',
        label: 'Work account',
        configDir: '~/.claude-klaudiusz',
        isDefault: false,
      });
      // `~` is stored as written and expanded only for `path`.
      expect(body.profile.path.startsWith('~')).toBe(false);
    });

    it('falls back to the folder name when no label is given', async () => {
      const { body } = await send('POST', '/api/v1/workspace/agent-profiles', {
        provider: 'claude',
        configDir: '~/.claude-klaudiusz',
      });
      expect(body.profile.id).toBe('claude-klaudiusz');
    });

    it('never allocates the reserved `default` id', async () => {
      const { body } = await send('POST', '/api/v1/workspace/agent-profiles', {
        provider: 'claude',
        label: 'default',
        configDir: claudeDir('somewhere'),
      });
      expect(body.profile.id).not.toBe('default');
    });

    it('refuses OpenCode — its credentials do not follow its config dir', async () => {
      const { status, body } = await send('POST', '/api/v1/workspace/agent-profiles', {
        provider: 'opencode',
        configDir: claudeDir('oc'),
      });
      expect(status).toBe(400);
      expect(body.error).toContain('more than one account');
      expect((await loadAgentAccounts()).accounts).toEqual([]);
    });

    it('refuses a relative folder — it would resolve against a throwaway worktree', async () => {
      const { status, body } = await send('POST', '/api/v1/workspace/agent-profiles', {
        provider: 'claude',
        configDir: 'relative/dir',
      });
      expect(status).toBe(400);
      expect(body.error).toContain('absolute');
    });

    it('refuses the agent\'s own default folder — that is not a second account', async () => {
      const { status, body } = await send('POST', '/api/v1/workspace/agent-profiles', {
        provider: 'claude',
        configDir: (await list()).profiles.find((p) => p.provider === 'claude')!.path,
      });
      expect(status).toBe(409);
      expect(body.error).toContain('default folder');
    });

    it('refuses a folder another account already uses, seeing through the spelling', async () => {
      const dir = claudeDir('claude-klaudiusz');
      await send('POST', '/api/v1/workspace/agent-profiles', {
        provider: 'claude',
        label: 'Work',
        configDir: dir,
      });
      // Same directory, different string — two accounts sharing one session store would make
      // "which account am I on?" unanswerable.
      const { status, body } = await send('POST', '/api/v1/workspace/agent-profiles', {
        provider: 'claude',
        label: 'Also work',
        configDir: `${dir}/`,
      });
      expect(status).toBe(409);
      expect(body.error).toContain('already used by "Work"');
    });

    it('lets two DIFFERENT providers be added independently', async () => {
      expect((await send('POST', '/api/v1/workspace/agent-profiles', {
        provider: 'claude',
        configDir: claudeDir('claude-klaudiusz'),
      })).status).toBe(201);
      expect((await send('POST', '/api/v1/workspace/agent-profiles', {
        provider: 'codex',
        configDir: claudeDir('codex-klaudiusz'),
      })).status).toBe(201);
      expect((await loadAgentAccounts()).accounts).toHaveLength(2);
    });

    it('400s an unknown key rather than dropping it silently', async () => {
      const { status } = await send('POST', '/api/v1/workspace/agent-profiles', {
        provider: 'claude',
        configDir: '/tmp/x',
        totalNonsense: 12345,
      });
      expect(status).toBe(400);
    });
  });

  describe('PATCH', () => {
    const create = async (label: string, dir: string) => {
      const { body } = await send('POST', '/api/v1/workspace/agent-profiles', {
        provider: 'claude',
        label,
        configDir: dir,
      });
      return body.profile;
    };

    it('renames without touching the folder', async () => {
      const profile = await create('Work', claudeDir('claude-klaudiusz'));
      const { status, body } = await send('PATCH', `/api/v1/workspace/agent-profiles/${profile.id}`, {
        label: 'Client A',
      });
      expect(status).toBe(200);
      expect(body.profile).toMatchObject({ id: profile.id, label: 'Client A', configDir: profile.configDir });
    });

    it('repoints the folder', async () => {
      const profile = await create('Work', claudeDir('claude-klaudiusz'));
      const moved = claudeDir('claude-moved');
      const { status, body } = await send('PATCH', `/api/v1/workspace/agent-profiles/${profile.id}`, {
        configDir: moved,
      });
      expect(status).toBe(200);
      expect(body.profile.path).toBe(moved);
    });

    it('refuses a folder another account already uses', async () => {
      await create('Work', claudeDir('claude-klaudiusz'));
      const second = await create('Client', claudeDir('claude-client'));
      const { status } = await send('PATCH', `/api/v1/workspace/agent-profiles/${second.id}`, {
        configDir: join(home, 'claude-klaudiusz'),
      });
      expect(status).toBe(409);
    });

    it('allows a no-op repoint of an account onto its OWN folder', async () => {
      const dir = claudeDir('claude-klaudiusz');
      const profile = await create('Work', dir);
      const { status } = await send('PATCH', `/api/v1/workspace/agent-profiles/${profile.id}`, {
        configDir: dir,
      });
      expect(status).toBe(200);
    });

    it('404s an unknown id and rewrites nothing (read-first)', async () => {
      await create('Work', claudeDir('claude-klaudiusz'));
      const before = readFileSync(agentAccountsPath(), 'utf8');
      const { status, body } = await send('PATCH', '/api/v1/workspace/agent-profiles/nope', { label: 'x' });
      expect(status).toBe(404);
      expect(body.error).toContain('unknown account');
      expect(readFileSync(agentAccountsPath(), 'utf8')).toBe(before);
    });

    it('400s an empty body', async () => {
      const profile = await create('Work', claudeDir('claude-klaudiusz'));
      expect((await send('PATCH', `/api/v1/workspace/agent-profiles/${profile.id}`, {})).status).toBe(400);
    });
  });

  describe('DELETE', () => {
    it('deregisters, leaving the folder untouched', async () => {
      const dir = claudeDir('claude-klaudiusz');
      const { body: created } = await send('POST', '/api/v1/workspace/agent-profiles', {
        provider: 'claude',
        configDir: dir,
      });
      const { status, body } = await send('DELETE', `/api/v1/workspace/agent-profiles/${created.profile.id}`);
      expect(status).toBe(200);
      expect(body).toEqual({ removed: true, id: created.profile.id });
      expect((await loadAgentAccounts()).accounts).toEqual([]);
      expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe('{}');
    });

    it('scrubs every project reference in the SAME write, so no dangling id is observable', async () => {
      const first = await registerProject(repoRoot);
      const { body: created } = await send('POST', '/api/v1/workspace/agent-profiles', {
        provider: 'claude',
        configDir: claudeDir('claude-klaudiusz'),
      });
      await mergeWriteAgentAccounts((s) => {
        s.selections[first.root] = { claude: created.profile.id, codex: 'kept' };
      });

      await send('DELETE', `/api/v1/workspace/agent-profiles/${created.profile.id}`);

      expect((await loadAgentAccounts()).selections[first.root]).toEqual({ codex: 'kept' });
    });

    it('drops the whole selection object when the deleted account was its only key', async () => {
      const first = await registerProject(repoRoot);
      const { body: created } = await send('POST', '/api/v1/workspace/agent-profiles', {
        provider: 'claude',
        configDir: claudeDir('claude-klaudiusz'),
      });
      await mergeWriteAgentAccounts((store) => {
        store.selections[first.root] = { claude: created.profile.id };
      });
      await send('DELETE', `/api/v1/workspace/agent-profiles/${created.profile.id}`);
      const raw = JSON.parse(readFileSync(agentAccountsPath(), 'utf8')) as {
        selections: Record<string, unknown>;
      };
      // The whole row goes when its last account does — no empty object left behind.
      expect(raw.selections[first.root]).toBeUndefined();
    });

    it('404s an unknown id', async () => {
      expect((await send('DELETE', '/api/v1/workspace/agent-profiles/nope')).status).toBe(404);
    });
  });

  describe('PUT selection — which account a project uses', () => {
    const create = async (label: string) => {
      const { body } = await send('POST', '/api/v1/workspace/agent-profiles', {
        provider: 'claude',
        label,
        configDir: claudeDir(`claude-${label}`),
      });
      return body.profile;
    };
    const select = (projectId: string, provider: string, profileId: string | null) =>
      send('PUT', '/api/v1/workspace/agent-profiles/selection', { projectId, provider, profileId });

    it('stores the choice keyed by the project\'s ROOT, not its slug', async () => {
      const project = await registerProject(repoRoot);
      const account = await create('work');

      const { status, body } = await select(project.id, 'claude', account.id);
      expect(status).toBe(200);
      // Keyed by root, so the selection survives the registry being rebuilt under a new slug.
      expect((body as unknown as { selections: Record<string, unknown> }).selections).toEqual({
        [project.root]: { claude: account.id },
      });
      expect((await loadAgentAccounts()).selections[project.root]).toEqual({ claude: account.id });
    });

    it('is carried back by the listing, so one query serves every account surface', async () => {
      const project = await registerProject(repoRoot);
      const account = await create('work');
      await select(project.id, 'claude', account.id);
      expect((await list()).selections).toEqual({ [project.root]: { claude: account.id } });
    });

    it('clears to the discovered account on null, storing absence rather than "default"', async () => {
      const project = await registerProject(repoRoot);
      const account = await create('work');
      await select(project.id, 'claude', account.id);

      await select(project.id, 'claude', null);
      const raw = JSON.parse(readFileSync(agentAccountsPath(), 'utf8')) as {
        selections: Record<string, unknown>;
      };
      // The row goes entirely when its last provider is cleared — never `{"claude":"default"}`.
      expect(raw.selections[project.root]).toBeUndefined();
    });

    it('treats the reserved `default` id as "clear" too', async () => {
      const project = await registerProject(repoRoot);
      const account = await create('work');
      await select(project.id, 'claude', account.id);
      await select(project.id, 'claude', 'default');
      expect((await loadAgentAccounts()).selections[project.root]).toBeUndefined();
    });

    it('leaves the other providers alone — one key per write', async () => {
      const project = await registerProject(repoRoot);
      const claude = await create('work');
      const { body: codex } = await send('POST', '/api/v1/workspace/agent-profiles', {
        provider: 'codex',
        label: 'cx',
        configDir: claudeDir('codex-klaudiusz'),
      });
      await select(project.id, 'claude', claude.id);
      await select(project.id, 'codex', codex.profile.id);
      await select(project.id, 'claude', null);
      expect((await loadAgentAccounts()).selections[project.root]).toEqual({ codex: codex.profile.id });
    });

    it('accepts the reserved `default` boot alias as the project', async () => {
      const project = await registerProject(repoRoot);
      const account = await create('work');
      const { status } = await select('default', 'claude', account.id);
      expect(status).toBe(200);
      expect((await loadAgentAccounts()).selections[project.root]).toEqual({ claude: account.id });
    });

    it('404s an unknown project rather than storing an orphan row', async () => {
      await create('work');
      const { status, body } = await select('nope', 'claude', 'work');
      expect(status).toBe(404);
      expect(body.error).toContain('unknown project');
      expect((await loadAgentAccounts()).selections).toEqual({});
    });

    it('400s an unknown account rather than silently degrading to the default', async () => {
      const project = await registerProject(repoRoot);
      const { status, body } = await select(project.id, 'claude', 'never-added');
      expect(status).toBe(400);
      expect(body.error).toContain('unknown claude account');
      expect((await loadAgentAccounts()).selections).toEqual({});
    });

    it('400s an account belonging to a DIFFERENT provider', async () => {
      const project = await registerProject(repoRoot);
      const account = await create('work');
      expect((await select(project.id, 'codex', account.id)).status).toBe(400);
    });
  });

  describe('the listing never pays a CLI spawn (perf contract)', () => {
    // Dry-run short-circuits provider auth entirely, which would make "no spawns" true for the
    // wrong reason. These two cases need the real probe path, with an injected command runner.
    beforeEach(() => {
      delete process.env.CEZ_DRY_RUN;
    });

    it('probes NOTHING while building the listing', async () => {
      // The regression this guards: auth used to be probed inline, costing one shell-out per
      // provider PLUS one per account on every cold load — 2.5s on a real machine with 4 accounts.
      const spawns: string[] = [];
      const app = makeApp({
        providerAuth: new ProviderAuthService({
          runCommand: async (executable) => {
            spawns.push(executable);
            return { stdout: '{"loggedIn":true}', stderr: '', exitCode: 0 };
          },
        }),
      });
      await send('POST', '/api/v1/workspace/agent-profiles', {
        provider: 'claude',
        configDir: claudeDir('claude-klaudiusz'),
      });

      const res = await apiRequest(app, '/api/v1/workspace/agent-profiles');
      expect(res.status).toBe(200);
      expect(spawns).toEqual([]);
      // …and it says so honestly: no row claims a status it never checked.
      const body = (await res.json()) as { profiles: Array<{ status?: unknown }> };
      expect(body.profiles.every((p) => p.status === undefined)).toBe(true);
    });

    it('the per-account status route is what actually probes', async () => {
      const spawns: string[] = [];
      const app = makeApp({
        providerAuth: new ProviderAuthService({
          runCommand: async (executable) => {
            spawns.push(executable);
            return { stdout: '{"loggedIn":true}', stderr: '', exitCode: 0 };
          },
        }),
      });
      const res = await apiRequest(app, '/api/v1/workspace/agent-profiles/default:claude/status');
      expect(res.status).toBe(200);
      expect(((await res.json()) as { status: { status: string } }).status.status).toBe('connected');
      expect(spawns.length).toBeGreaterThan(0);
    });

    /**
     * …and the reason the listing may serve cache-only is that the cache is WARM by then.
     *
     * The live-server path pre-warms every account at boot — the same `socketHub` gate
     * `refreshHealth` uses, which is why no other suite here spawns anything. Without this the
     * first reader of each row still paid a shell-out; it had only moved off the listing.
     */
    it('warms every account at boot, extra accounts included, so the FIRST listing is complete', async () => {
      await send('POST', '/api/v1/workspace/agent-profiles', {
        provider: 'claude',
        label: 'work',
        configDir: claudeDir('claude-klaudiusz'),
      });
      const spawns: string[] = [];
      const app = makeApp({
        socketHub: { registerTopic: () => undefined, attach: () => undefined, close: () => undefined },
        providerAuth: new ProviderAuthService({
          runCommand: async (executable) => {
            spawns.push(executable);
            return { stdout: '{"loggedIn":true}', stderr: '', exitCode: 0 };
          },
        }),
      });

      // The warm is fire-and-forget, so wait for the account row — the last thing it learns.
      let body: AgentProfilesResponse | undefined;
      await vi.waitFor(async () => {
        const res = await apiRequest(app, '/api/v1/workspace/agent-profiles');
        body = (await res.json()) as AgentProfilesResponse;
        expect(body.profiles.every((p) => p.status !== undefined)).toBe(true);
      });
      // Including the extra account, which `providerAuth.status()` alone would never have covered.
      expect(body!.profiles.find((p) => p.label === 'work')?.status).toMatchObject({
        status: 'connected',
        profileId: 'work',
      });

      // And the listings that follow are served from memory: no further spawn, ever.
      const after = spawns.length;
      for (let i = 0; i < 3; i += 1) await apiRequest(app, '/api/v1/workspace/agent-profiles');
      expect(spawns.length).toBe(after);
    });

    it('re-checking one account does not throw away what it knows about the others', async () => {
      // The regression: a single `forgetProfileStatus()` cleared the whole per-account cache, so
      // "Check again" on one row — or repointing it — made every other account cold again.
      for (const label of ['work', 'other']) {
        await send('POST', '/api/v1/workspace/agent-profiles', {
          provider: 'claude',
          label,
          configDir: claudeDir(`claude-${label}`),
        });
      }
      const spawns: string[] = [];
      const app = makeApp({
        providerAuth: new ProviderAuthService({
          runCommand: async (executable) => {
            spawns.push(executable);
            return { stdout: '{"loggedIn":true}', stderr: '', exitCode: 0 };
          },
        }),
      });
      for (const id of ['work', 'other']) {
        expect((await apiRequest(app, `/api/v1/workspace/agent-profiles/${id}/status`)).status).toBe(200);
      }
      const warmed = spawns.length;

      // Force a re-probe of `work` only.
      await apiRequest(app, '/api/v1/workspace/agent-profiles/work/status?refresh=1');
      expect(spawns.length).toBe(warmed + 1);
      // `other` is still known, so it costs nothing.
      await apiRequest(app, '/api/v1/workspace/agent-profiles/other/status');
      expect(spawns.length).toBe(warmed + 1);
    });
  });

  describe('per-account details and files', () => {
    /** A Claude account dir signed in as someone, with a settings.json beside it. */
    const signedIn = (name: string): string => {
      const dir = claudeDir(name);
      writeFileSync(join(dir, '.claude.json'), JSON.stringify({
        oauthAccount: { emailAddress: 'me@example.com', organizationName: 'Acme' },
        primaryApiKey: 'sk-should-not-surface',
      }), 'utf8');
      return dir;
    };
    const create = async (label: string, dir: string) => {
      const { body } = await send('POST', '/api/v1/workspace/agent-profiles', {
        provider: 'claude',
        label,
        configDir: dir,
      });
      return body.profile;
    };

    it('lists each account\'s OWN user-scope config files', async () => {
      const account = await create('work', signedIn('claude-klaudiusz'));
      const row = (await list()).profiles.find((p) => p.id === account.id)!;
      // Resolved inside THIS account's folder, not the default one's.
      const settings = row.files.find((f) => f.label === 'settings.json');
      expect(settings?.path.startsWith(row.path)).toBe(true);
      expect(settings?.exists).toBe(true);
      // A file the agent has not written yet is listed honestly rather than omitted.
      expect(row.files.find((f) => f.label === 'CLAUDE.md')?.exists).toBe(false);
    });

    it('answers the identity on demand, and only the named fields', async () => {
      const account = await create('work', signedIn('claude-klaudiusz'));
      const res = await apiRequest(makeApp(), `/api/v1/workspace/agent-profiles/${account.id}/details`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('me@example.com');
      expect(body).toContain('Acme');
      // The same file holds an api key; it must not ride along.
      expect(body).not.toContain('sk-should-not-surface');
    });

    it('addresses the DISCOVERED account as `default:<provider>`', async () => {
      const res = await apiRequest(makeApp(), '/api/v1/workspace/agent-profiles/default:claude/details');
      expect(res.status).toBe(200);
      // A bare `default` cannot say WHICH agent, so it is not an account.
      const bare = await apiRequest(makeApp(), '/api/v1/workspace/agent-profiles/default/details');
      expect(bare.status).toBe(404);
    });

    it('404s an unknown account', async () => {
      const res = await apiRequest(makeApp(), '/api/v1/workspace/agent-profiles/nope/details');
      expect(res.status).toBe(404);
    });

    it('opens a file named by its catalog id, never by a path', async () => {
      const opened: string[] = [];
      const account = await create('work', signedIn('claude-klaudiusz'));
      const app = makeApp({ openFile: async (path) => { opened.push(path); return true; } });
      const res = await apiRequest(app, `/api/v1/workspace/agent-profiles/${account.id}/open`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: 'claude.user.settings' }),
      });
      expect(res.status).toBe(200);
      expect(opened).toEqual([join(account.path, 'settings.json')]);
    });

    it('opens the account folder itself', async () => {
      const opened: string[] = [];
      const account = await create('work', signedIn('claude-klaudiusz'));
      const app = makeApp({ openFile: async (path) => { opened.push(path); return true; } });
      await apiRequest(app, `/api/v1/workspace/agent-profiles/${account.id}/open`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: 'folder' }),
      });
      expect(opened).toEqual([account.path]);
    });

    it('404s a file id this account does not have — the only addressing the route accepts', async () => {
      const account = await create('work', signedIn('claude-klaudiusz'));
      for (const file of ['codex.user.config', '../../../etc/passwd', '/etc/passwd']) {
        const res = await apiRequest(makeApp(), `/api/v1/workspace/agent-profiles/${account.id}/open`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ file }),
        });
        expect(res.status, file).toBe(404);
      }
    });

    it('refuses a target that cannot act on what is being opened', async () => {
      const account = await create('work', signedIn('claude-klaudiusz'));
      const cases = [
        // A terminal runs `cd <path>`, which is meaningless for a file…
        [{ file: 'claude.user.settings', target: 'terminal' }, 'a terminal opens a folder'],
        // …an agent CLI opens a task worktree, never a config folder…
        [{ file: 'folder', target: 'cli:claude' }, 'agent CLIs open a task worktree'],
        // …and an app this machine does not have cannot be launched.
        [{ file: 'folder', target: 'not-installed-editor' }, 'no such app on this machine'],
      ] as const;
      for (const [body, reason] of cases) {
        const res = await apiRequest(makeApp(), `/api/v1/workspace/agent-profiles/${account.id}/open`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(((await res.json()) as { error: string }).error).toContain(reason);
      }
    });

    it('allows a terminal for the FOLDER, which is the case it does apply to', async () => {
      const account = await create('work', signedIn('claude-klaudiusz'));
      // `openInApp` is the real thing here, so assert only that the target passed validation:
      // a 400 would mean it was refused, and anything else means it reached the launcher.
      const res = await apiRequest(makeApp(), `/api/v1/workspace/agent-profiles/${account.id}/open`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: 'folder', target: 'terminal' }),
      });
      expect(res.status).not.toBe(400);
    });

    it('409s a file the agent has not written yet rather than reporting a false success', async () => {
      const account = await create('work', signedIn('claude-klaudiusz'));
      const res = await apiRequest(makeApp(), `/api/v1/workspace/agent-profiles/${account.id}/open`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: 'claude.user.memory' }),
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('CLAUDE.md');
    });
  });

  describe('hosted mode (CEZ_REMOTE)', () => {
    beforeEach(() => {
      process.env.CEZ_REMOTE = '1';
    });

    it('withholds the listing — the absolute paths are the host disclosure', async () => {
      const body = await list();
      expect(body).toMatchObject({ editable: false, profiles: [] });
    });

    it('refuses the identity read — an email is host state a hosted client is not trusted with', async () => {
      const res = await apiRequest(makeApp(), '/api/v1/workspace/agent-profiles/default:claude/details');
      expect(res.status).toBe(409);
    });

    it('409s every mutator and persists nothing', async () => {
      for (const [method, path, payload] of [
        ['POST', '/api/v1/workspace/agent-profiles', { provider: 'claude', configDir: '/tmp/x' }],
        ['PATCH', '/api/v1/workspace/agent-profiles/work', { label: 'x' }],
        ['DELETE', '/api/v1/workspace/agent-profiles/work', undefined],
        ['PUT', '/api/v1/workspace/agent-profiles/selection',
          { projectId: 'default', provider: 'claude', profileId: null }],
        ['POST', '/api/v1/workspace/agent-profiles/default:claude/open', { file: 'folder' }],
      ] as const) {
        const { status, body } = await send(method, path, payload);
        expect(status, `${method} ${path}`).toBe(409);
        expect(body.error).toContain('hosted mode');
      }
      expect((await loadAgentAccounts()).accounts).toEqual([]);
    });
  });

  /**
   * The machine-wide default account (spec 2026-07-29-agent-profiles): `projectId: null` on the
   * selection route, so a second login is set up once instead of per checkout.
   */
  describe('PUT selection — the machine-wide default', () => {
    const put = (body: unknown) =>
      send('PUT', '/api/v1/workspace/agent-profiles/selection', body);

    it('writes a default with no project involved, and lists it back', async () => {
      const { body: created } = await send('POST', '/api/v1/workspace/agent-profiles', {
        provider: 'claude',
        configDir: claudeDir('claude-klaudiusz'),
      });
      const { status, body } = await put({
        projectId: null,
        provider: 'claude',
        profileId: created.profile.id,
      });
      expect(status).toBe(200);
      expect((body as unknown as { defaults: Record<string, string> }).defaults)
        .toEqual({ claude: created.profile.id });
      // …and it rides on the listing every reader already fetches.
      expect((await list()).defaults).toEqual({ claude: created.profile.id });
      // It is a DEFAULT, so it must not have invented a per-repo selection on the way.
      expect((await list()).selections).toEqual({});
    });

    it('stores a cleared default as ABSENCE, never the reserved id', async () => {
      await send('POST', '/api/v1/workspace/agent-profiles', {
        provider: 'claude',
        configDir: claudeDir('claude-klaudiusz'),
      });
      await put({ projectId: null, provider: 'claude', profileId: 'claude-klaudiusz' });
      const { body } = await put({ projectId: null, provider: 'claude', profileId: null });
      expect((body as unknown as { defaults: Record<string, string> }).defaults).toEqual({});
      expect(JSON.stringify(await loadAgentAccounts())).not.toContain('"claude":"default"');
    });

    it('refuses an account that does not exist, exactly as the per-repo write does', async () => {
      const { status, body } = await put({
        projectId: null,
        provider: 'claude',
        profileId: 'nope',
      });
      expect(status).toBe(400);
      expect(body.error).toContain('unknown claude account');
    });

    it('leaves a repo that has chosen alone — a default never overrules a choice', async () => {
      const { body: work } = await send('POST', '/api/v1/workspace/agent-profiles', {
        provider: 'claude',
        configDir: claudeDir('claude-klaudiusz'),
      });
      const { body: other } = await send('POST', '/api/v1/workspace/agent-profiles', {
        provider: 'claude',
        label: 'Client',
        configDir: claudeDir('claude-client'),
      });
      const project = await registerProject(repoRoot);
      await put({ projectId: project.id, provider: 'claude', profileId: other.profile.id });
      await put({ projectId: null, provider: 'claude', profileId: work.profile.id });

      const listed = await list();
      expect(listed.defaults).toEqual({ claude: work.profile.id });
      expect(listed.selections[project.root]).toEqual({ claude: other.profile.id });
    });
  });

  /**
   * `POST /api/v1/providers/connect` aimed at a NAMED account — the last mile of "add → Connect →
   * the CLI creates the folder", and the branch the cockpit now calls.
   */
  describe('connect, aimed at one account', () => {
    it('re-probes rather than answering "already connected" from a warm cache', async () => {
      // The trap: `profileStatus` serves the per-account cache, and a CONNECTED answer stands for
      // ten minutes. Without an eviction, Connect after a `claude /logout` opens nothing and says
      // "already connected" — and contradicts this module's own claim that opening a login is an
      // explicit invalidation point rather than something that waits out a window.
      delete process.env.CEZ_DRY_RUN;
      let loggedIn = true;
      let spawns = 0;
      const providerAuth = new ProviderAuthService({
        platform: 'linux',
        runCommand: async (executable) => {
          spawns += 1;
          if (executable !== 'claude') return { stdout: 'unrecognized', stderr: '', exitCode: 0 };
          return loggedIn
            ? { stdout: '{"loggedIn":true}', stderr: '', exitCode: 0 }
            : { stdout: '{"loggedIn":false}', stderr: '', exitCode: 1 };
        },
      });
      const app = makeApp({ providerAuth, openTerminal: async () => true });
      const { body: created } = await send('POST', '/api/v1/workspace/agent-profiles', {
        provider: 'claude',
        configDir: claudeDir('claude-klaudiusz'),
      });
      // Warm the account's cache with the connected answer…
      await providerAuth.profileStatus('claude', {
        id: created.profile.id,
        configDir: claudeDir('claude-klaudiusz'),
      });
      const warmed = spawns;
      loggedIn = false; // …then log out behind cezar's back, as a terminal would.

      const res = await apiRequest(app, '/api/v1/providers/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'claude', profileId: created.profile.id }),
      });
      expect(res.status).toBe(200);
      // Opened a terminal for the logout it actually found — not "already connected".
      expect(await res.json()).toMatchObject({ opened: true });
      expect(spawns).toBeGreaterThan(warmed);
    });

    it('refuses a named account in hosted mode BEFORE resolving it', async () => {
      // Every sibling route gates first. Resolving first would read the store, build a command
      // carrying the account's absolute path — which both the success body and the hosted 409 echo —
      // and answer `unknown account: <id>` for a wrong id, an enumeration oracle for ids the hosted
      // listing deliberately withholds.
      const { body: created } = await send('POST', '/api/v1/workspace/agent-profiles', {
        provider: 'claude',
        configDir: claudeDir('claude-klaudiusz'),
      });
      process.env.CEZ_REMOTE = '1';
      for (const profileId of [created.profile.id, 'no-such-account']) {
        const res = await apiRequest(makeApp(), '/api/v1/providers/connect', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider: 'claude', profileId }),
        });
        expect(res.status).toBe(409);
        const answer = (await res.json()) as { error: string; command?: string };
        // No host path, and the same words whether or not the id exists.
        expect(answer.command).toBeUndefined();
        expect(answer.error).toContain('managed from the machine that owns the checkout');
        expect(JSON.stringify(answer)).not.toContain(home);
      }
    });
  });
});
