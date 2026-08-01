import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { workspaceConfigPath, workspaceUiStatePath } from '../paths.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp, type WorkspaceConfigResponse } from './server.ts';

/**
 * The workspace settings API (multi-project spec, step 2.7):
 * `GET/PUT /api/v1/workspace/config` — the settings slice of `~/.cezar/config.json`
 * with the `projectsDir` writability probe and the semaphore `refresh()` hook —
 * and `GET/PUT /api/v1/workspace/ui-state`, the global GUI state with the same
 * merge/key-cap semantics as the per-repo ui-state route. All workspace-level:
 * single-mount, never under `/api/v1/p/`.
 */
describe('the workspace settings API (step 2.7)', () => {
  const savedHome = process.env.CEZ_HOME;
  const savedBrowseRoot = process.env.CEZ_BROWSE_ROOT;
  const savedProjectsDir = process.env.CEZ_PROJECTS_DIR;
  const savedSkillsAutoUpdate = process.env.CEZ_SKILLS_AUTO_UPDATE;
  const savedAutonomousDefault = process.env.CEZ_AUTONOMOUS_DEFAULT;
  const savedWorktreeDefault = process.env.CEZ_WORKTREE_DEFAULT;
  let home: string;
  let repoRoot: string;
  let store: RunStore;
  let semaphore: WorkspaceSemaphore;
  let app: Hono;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-workspace-api-'));
    process.env.CEZ_HOME = home; // paths.ts sends all workspace paths here
    delete process.env.CEZ_BROWSE_ROOT;
    delete process.env.CEZ_PROJECTS_DIR;
    delete process.env.CEZ_SKILLS_AUTO_UPDATE;
    delete process.env.CEZ_AUTONOMOUS_DEFAULT;
    delete process.env.CEZ_WORKTREE_DEFAULT;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-workspace-api-repo-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    // The REAL semaphore with its production loader (which reads the CEZ_HOME
    // config), so the PUT → refresh() → cached-limits chain is observed end to
    // end. The routes never touch the manager — an empty stub is honest.
    semaphore = new WorkspaceSemaphore();
    app = createApp({
      repoRoot,
      store,
      manager: {} as RunManager,
      version: '0.0.0-test',
      semaphore,
    });
  });

  afterEach(() => {
    store.flush();
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    if (savedBrowseRoot === undefined) delete process.env.CEZ_BROWSE_ROOT;
    else process.env.CEZ_BROWSE_ROOT = savedBrowseRoot;
    if (savedProjectsDir === undefined) delete process.env.CEZ_PROJECTS_DIR;
    else process.env.CEZ_PROJECTS_DIR = savedProjectsDir;
    if (savedSkillsAutoUpdate === undefined) delete process.env.CEZ_SKILLS_AUTO_UPDATE;
    else process.env.CEZ_SKILLS_AUTO_UPDATE = savedSkillsAutoUpdate;
    if (savedAutonomousDefault === undefined) delete process.env.CEZ_AUTONOMOUS_DEFAULT;
    else process.env.CEZ_AUTONOMOUS_DEFAULT = savedAutonomousDefault;
    if (savedWorktreeDefault === undefined) delete process.env.CEZ_WORKTREE_DEFAULT;
    else process.env.CEZ_WORKTREE_DEFAULT = savedWorktreeDefault;
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
  });

  const rawConfig = () => JSON.parse(readFileSync(workspaceConfigPath(), 'utf8')) as Record<string, unknown>;

  const getConfig = () => apiRequest(app, '/api/v1/workspace/config');
  const putConfig = (body: unknown) =>
    apiRequest(app, '/api/v1/workspace/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  // ---- GET/PUT /api/v1/workspace/config ---------------------------------------

  it('GET answers the zero-config defaults when no file exists — and never the registry', async () => {
    const res = await getConfig();
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorkspaceConfigResponse & Record<string, unknown>;
    expect(body).toEqual({
      browseRoot: '~/',
      projectsDir: '~/cezar/projects',
      skillsAutoUpdate: null,
      effectiveSkillsAutoUpdate: true,
      composerDefaults: {
        autonomous: null,
        worktree: null,
        inheritedAutonomous: 'source-dependent',
        inheritedWorktree: true,
      },
      resources: {
        maxParallel: 2,
        maxMonitoringSessions: 2,
        monitoringWakeIntervalMinutes: null,
        memoryLimitMb: null,
        worktreeRetentionDefault: 10,
      },
      // Machine-wide agent defaults (spec 2026-07-29-agent-profiles). EMPTY, not populated: absent
      // keys mean "this machine has no opinion", which is what makes them defaults a repo can be
      // silent about rather than settings every checkout inherits a value from.
      agentDefaults: {},
    });
    // Absolute project roots belong on /api/v1/projects; schemaVersion is a
    // migration cursor, not a setting.
    expect(body.projects).toBeUndefined();
    expect(body.schemaVersion).toBeUndefined();
  });

  it('GET resolves both zero-config roots from the environment', async () => {
    process.env.CEZ_BROWSE_ROOT = '~/source';
    process.env.CEZ_PROJECTS_DIR = '~/clones';
    const body = (await (await getConfig()).json()) as WorkspaceConfigResponse;
    expect(body).toMatchObject({ browseRoot: '~/source', projectsDir: '~/clones' });
  });

  it('PUT resources round-trips, persists to disk, and refreshes the semaphore cache', async () => {
    expect(semaphore.maxParallel()).toBe(2); // the pre-PUT snapshot
    const res = await putConfig({
      resources: { maxParallel: 5, maxMonitoringSessions: 3, monitoringWakeIntervalMinutes: 5, memoryLimitMb: 2048 },
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as WorkspaceConfigResponse).toEqual({
      browseRoot: '~/',
      projectsDir: '~/cezar/projects',
      skillsAutoUpdate: null,
      effectiveSkillsAutoUpdate: true,
      composerDefaults: {
        autonomous: null,
        worktree: null,
        inheritedAutonomous: 'source-dependent',
        inheritedWorktree: true,
      },
      resources: {
        maxParallel: 5,
        maxMonitoringSessions: 3,
        monitoringWakeIntervalMinutes: 5,
        memoryLimitMb: 2048,
        worktreeRetentionDefault: 10,
      },
      // Untouched by a resources write, and still empty — the two live in the same file but answer
      // unrelated questions, so one must never materialize the other.
      agentDefaults: {},
    });
    // Round-trip through GET and the raw file.
    expect(((await (await getConfig()).json()) as WorkspaceConfigResponse).resources.maxParallel).toBe(5);
    expect((rawConfig().resources as Record<string, unknown>).maxParallel).toBe(5);
    // The step-2.5 hook fired: the new cap applies WITHOUT a restart.
    expect(semaphore.maxParallel()).toBe(5);
    expect(semaphore.maxMonitoringSessions()).toBe(3);
    expect(semaphore.monitoringWakeIntervalMinutes()).toBe(5);
    expect(semaphore.memoryLimitMb()).toBe(2048);
  });

  it('partial updates leave the other keys untouched', async () => {
    await putConfig({ resources: { maxParallel: 5 } });
    await putConfig({ resources: { worktreeRetentionDefault: 3 } });
    expect(((await (await getConfig()).json()) as WorkspaceConfigResponse).resources).toEqual({
      maxParallel: 5,
      maxMonitoringSessions: 2,
      monitoringWakeIntervalMinutes: null,
      memoryLimitMb: null,
      worktreeRetentionDefault: 3,
    });
  });

  it('PUT stores explicit auto-update values and null clears back to the inherited env value', async () => {
    process.env.CEZ_SKILLS_AUTO_UPDATE = '0';
    expect((await (await getConfig()).json()) as WorkspaceConfigResponse).toMatchObject({
      skillsAutoUpdate: null,
      effectiveSkillsAutoUpdate: false,
    });

    const explicit = (await (await putConfig({ skillsAutoUpdate: true })).json()) as WorkspaceConfigResponse;
    expect(explicit).toMatchObject({ skillsAutoUpdate: true, effectiveSkillsAutoUpdate: true });
    expect(rawConfig().skillsAutoUpdate).toBe(true);

    const inherited = (await (await putConfig({ skillsAutoUpdate: null })).json()) as WorkspaceConfigResponse;
    expect(inherited).toMatchObject({ skillsAutoUpdate: null, effectiveSkillsAutoUpdate: false });
    expect(rawConfig().skillsAutoUpdate).toBeUndefined();
  });

  it('PUT stores and independently clears composer defaults while exposing env inheritance', async () => {
    process.env.CEZ_AUTONOMOUS_DEFAULT = '1';
    process.env.CEZ_WORKTREE_DEFAULT = '0';
    const inherited = (await (await getConfig()).json()) as WorkspaceConfigResponse;
    expect(inherited.composerDefaults).toEqual({
      autonomous: null,
      worktree: null,
      inheritedAutonomous: true,
      inheritedWorktree: false,
    });

    const explicit = (await (await putConfig({
      composerDefaults: { autonomous: false, worktree: true },
    })).json()) as WorkspaceConfigResponse;
    expect(explicit.composerDefaults).toMatchObject({ autonomous: false, worktree: true });
    expect(rawConfig().composerDefaults).toMatchObject({ autonomous: false, worktree: true });

    await putConfig({ composerDefaults: { worktree: null } });
    expect(rawConfig().composerDefaults).toEqual({ autonomous: false });
  });

  it('rejects invalid auto-update values without writing', async () => {
    expect((await putConfig({ skillsAutoUpdate: 'false' })).status).toBe(400);
    expect(() => readFileSync(workspaceConfigPath(), 'utf8')).toThrow();
  });

  it('rejects out-of-bounds resources with 400 and writes nothing', async () => {
    for (const resources of [{ maxParallel: 0 }, { maxParallel: 17 }, { memoryLimitMb: -1 }]) {
      const res = await putConfig({ resources });
      expect(res.status, JSON.stringify(resources)).toBe(400);
      expect((await res.json()) as { error: string }).toHaveProperty('error');
    }
    expect(() => readFileSync(workspaceConfigPath(), 'utf8')).toThrow(); // never created
    expect(semaphore.maxParallel()).toBe(2);
  });

  it('a merge-written PUT never clobbers the registry or unknown keys (passthrough)', async () => {
    writeFileSync(
      workspaceConfigPath(),
      JSON.stringify({
        projects: [{ id: 'cezar', root: '/tmp/projects/cezar' }],
        futureKey: true,
      }),
      'utf8',
    );
    await putConfig({ resources: { maxParallel: 4 } });
    const raw = rawConfig();
    // The merge-write materializes the entry's schema defaults (name, dates…) —
    // what matters is the registration itself survives a settings PUT.
    expect(raw.projects).toMatchObject([{ id: 'cezar', root: '/tmp/projects/cezar' }]);
    expect(raw.futureKey).toBe(true);
    expect((raw.resources as Record<string, unknown>).maxParallel).toBe(4);
  });

  it('PUT projectsDir creates the directory, probes it, and stores the path as written', async () => {
    const dir = join(home, 'checkouts');
    const res = await putConfig({ projectsDir: dir });
    expect(res.status).toBe(200);
    expect(((await res.json()) as WorkspaceConfigResponse).projectsDir).toBe(dir);
    expect(rawConfig().projectsDir).toBe(dir);
    // mkdir -p happened; the probe file was cleaned up.
    expect(readdirSync(dir)).toEqual([]);
  });

  it('PUT browseRoot accepts and persists an existing independent browse directory', async () => {
    const browseRoot = join(home, 'source', 'repos');
    mkdirSync(browseRoot, { recursive: true });
    const res = await putConfig({ browseRoot });
    expect(res.status).toBe(200);
    expect(((await res.json()) as WorkspaceConfigResponse).browseRoot).toBe(browseRoot);
    expect(rawConfig().browseRoot).toBe(browseRoot);
    expect(readdirSync(browseRoot)).toEqual([]);
    expect(((await (await getConfig()).json()) as WorkspaceConfigResponse).projectsDir).toBe(
      '~/cezar/projects',
    );
  });

  it('PUT browseRoot warns for a missing directory without creating or persisting it', async () => {
    const existing = join(home, 'existing-source');
    mkdirSync(existing);
    expect((await putConfig({ browseRoot: existing })).status).toBe(200);

    const missing = join(home, 'missing', 'source');
    const res = await putConfig({ browseRoot: missing });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({
      error: `browse folder does not exist: ${missing}`,
    });
    expect(existsSync(missing)).toBe(false);
    expect(rawConfig().browseRoot).toBe(existing);
  });

  it('an unwritable projectsDir answers 400 "not writable: …" and persists NO change', async () => {
    await putConfig({ projectsDir: join(home, 'checkouts') }); // a known-good value first
    // A path under a regular file can never be created — fails on every
    // platform and uid (unlike a chmod 0500 dir, which root would ignore).
    writeFileSync(join(home, 'blocker'), 'not a directory', 'utf8');
    const res = await putConfig({ projectsDir: join(home, 'blocker', 'sub') });
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toMatch(/^not writable: /);
    // The config on disk still holds the previous value.
    expect(rawConfig().projectsDir).toBe(join(home, 'checkouts'));
  });

  it('a relative projectsDir is refused before any probe touches the filesystem', async () => {
    const res = await putConfig({ projectsDir: 'relative/path' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/^not writable: /);
  });

  it('a relative browseRoot is refused before any probe touches the filesystem', async () => {
    const res = await putConfig({ browseRoot: 'relative/path' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/^not writable: /);
  });

  it('a malformed body answers 400 {error}', async () => {
    const res = await apiRequest(app, '/api/v1/workspace/config', {
      method: 'PUT',
      body: 'nonsense',
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toHaveProperty('error');
  });

  // ---- GET/PUT /api/v1/workspace/ui-state -------------------------------------

  const getUiState = () => apiRequest(app, '/api/v1/workspace/ui-state');
  const putUiState = (body: unknown) =>
    apiRequest(app, '/api/v1/workspace/ui-state', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const rawUiState = () => JSON.parse(readFileSync(workspaceUiStatePath(), 'utf8')) as Record<string, unknown>;

  it('GET answers {} when no file exists yet', async () => {
    const res = await getUiState();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it('PUT merges shallowly into ~/.cezar/ui-state.json — later keys never drop earlier ones', async () => {
    expect((await putUiState({ appearance: { accent: 'violet' } })).status).toBe(200);
    const res = await putUiState({ sidebar: { collapsed: { cezar: true } } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      appearance: { accent: 'violet' },
      sidebar: { collapsed: { cezar: true } },
    });
    expect(rawUiState()).toEqual({
      appearance: { accent: 'violet' },
      sidebar: { collapsed: { cezar: true } },
    });
    // The workspace file, not the boot repo's — the per-repo twin stays empty.
    expect(await (await apiRequest(app, '/api/v1/ui-state')).json()).toEqual({});
  });

  it('round-trips a bounded last project location including query and hash', async () => {
    const lastLocation = {
      projectId: 'storefront',
      pathname: '/p/storefront/runs/run-123',
      search: '?tab=events',
      hash: '#tool-call-9',
    };

    const res = await putUiState({ lastLocation });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ lastLocation });
    expect(await (await getUiState()).json()).toMatchObject({ lastLocation });
    expect(rawUiState()).toMatchObject({ lastLocation });
  });

  it.each([
    ['an empty project id', { projectId: '', pathname: '/p/storefront/' }],
    ['an overlong project id', { projectId: 'p'.repeat(65), pathname: '/p/storefront/' }],
    ['a non-project pathname', { projectId: 'storefront', pathname: '/settings/global' }],
    ['an overlong pathname', { projectId: 'storefront', pathname: `/p/storefront/${'x'.repeat(2035)}` }],
    ['a search without its prefix', { projectId: 'storefront', pathname: '/p/storefront/', search: 'tab=runs' }],
    [
      'an overlong search',
      { projectId: 'storefront', pathname: '/p/storefront/', search: `?${'x'.repeat(4096)}` },
    ],
    ['a hash without its prefix', { projectId: 'storefront', pathname: '/p/storefront/', hash: 'run-1' }],
    [
      'an overlong hash',
      { projectId: 'storefront', pathname: '/p/storefront/', hash: `#${'x'.repeat(2048)}` },
    ],
    ['a non-string field', { projectId: 'storefront', pathname: 42 }],
    ['an unknown field', { projectId: 'storefront', pathname: '/p/storefront/', extra: true }],
  ])('rejects lastLocation with %s without writing state', async (_case, lastLocation) => {
    const res = await putUiState({ lastLocation });

    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toHaveProperty('error');
    expect(() => readFileSync(workspaceUiStatePath(), 'utf8')).toThrow();
  });

  // Every Settings → Appearance preference has to be listed in `appearanceSchema`: the top-level
  // `.passthrough()` does NOT reach inside `appearance`, so an unlisted key is stripped here and
  // then wiped from the file by the shallow merge. The cockpit adopts this response as
  // authoritative, so a stripped key visibly reverts the control the user just touched — which is
  // exactly what happened to `width` before it was added. The client-side settings test stubs
  // `fetch` with an echo, so this route-level round-trip is the only place that can catch it.
  it('round-trips every appearance preference — accent, density AND reading width', async () => {
    const res = await putUiState({ appearance: { accent: 'violet', density: 'compact', width: 'wide' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      appearance: { accent: 'violet', density: 'compact', width: 'wide' },
    });
    expect(rawUiState()).toEqual({
      appearance: { accent: 'violet', density: 'compact', width: 'wide' },
    });
  });

  it('rejects an out-of-enum reading width instead of silently dropping it', async () => {
    const res = await putUiState({ appearance: { width: 'ultrawide' } });
    expect(res.status).toBe(400);
    expect(() => readFileSync(workspaceUiStatePath(), 'utf8')).toThrow();
  });

  it('accepts bounded provider auth failure dismissals', async () => {
    const response = await putUiState({
      dismissedProviderAuthFailures: {
        claude: 'incident-1',
        opencode: 'incident-9',
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      dismissedProviderAuthFailures: {
        claude: 'incident-1',
        opencode: 'incident-9',
      },
    });
  });

  it.each([
    ['an unknown provider', { future: 'incident-1' }],
    ['an empty incident ID', { claude: '' }],
    ['a non-string incident ID', { claude: 1 }],
    ['an overlong incident ID', { claude: 'a'.repeat(129) }],
  ])('rejects provider auth failure dismissals with %s without writing state', async (_case, dismissals) => {
    const response = await putUiState({ dismissedProviderAuthFailures: dismissals });
    expect(response.status).toBe(400);
    expect(() => readFileSync(workspaceUiStatePath(), 'utf8')).toThrow();
  });

  it('unknown keys pass through and survive later PUTs (additive, like the per-repo route)', async () => {
    await putUiState({ futurePref: { nested: 1 } });
    await putUiState({ notifications: { enabled: true } });
    expect(rawUiState()).toEqual({
      futurePref: { nested: 1 },
      notifications: { enabled: true },
    });
  });

  it('rejects a malformed known key instead of writing garbage', async () => {
    const res = await putUiState({ sidebar: { collapsed: { cezar: 'yes' } } });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toHaveProperty('error');
    expect(() => readFileSync(workspaceUiStatePath(), 'utf8')).toThrow(); // nothing written
  });

  it('caps the top-level key count at 200, same as the per-repo route', async () => {
    const keysOf = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`pref-${i}`, true]));
    expect((await putUiState(keysOf(200))).status).toBe(200);
    const over = await putUiState(keysOf(201));
    expect(over.status).toBe(400);
    expect(((await over.json()) as { error: string }).error).toContain('too many keys');
    // The at-cap state from the previous PUT still stands.
    expect(Object.keys(rawUiState())).toHaveLength(200);
  });
});
