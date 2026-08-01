import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

/**
 * `GET/PUT /api/v1/config` (R6 Step 1.5 — Settings → Agents). The contract under
 * test: GET answers every Settings-editable knob in one shape; PUT merges into
 * the RAW config.json (user keys survive, defaults never materialize); the R6
 * keys (`systemPrompt`, `defaultModels`) are additive — `null`/`''` clears,
 * per-runner model writes merge instead of clobbering; and the pre-R6 answer
 * fields (`baseBranch`, `defaultRunner`) stay exactly as they were
 * (BACKWARD_COMPATIBILITY.md §2 — additive only).
 */
describe('the config API', () => {
  let repoRoot: string;
  let homeRoot: string;
  const savedHome = process.env.HOME;
  const savedCezHome = process.env.CEZ_HOME;
  const savedCodexHome = process.env.CODEX_HOME;
  const savedXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const savedModelsLocked = process.env.CEZ_AGENT_MODELS_LOCKED;
  let store: RunStore;
  let app: Hono;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-configapi-'));
    homeRoot = mkdtempSync(join(tmpdir(), 'cez-configapi-home-'));
    process.env.HOME = homeRoot;
    process.env.CEZ_HOME = join(homeRoot, '.cezar');
    process.env.CODEX_HOME = join(homeRoot, '.codex');
    process.env.XDG_CONFIG_HOME = join(homeRoot, '.config');
    delete process.env.CEZ_AGENT_MODELS_LOCKED;
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    mkdirSync(join(homeRoot, '.cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    // The config routes never touch the manager — an empty stub is honest.
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(homeRoot, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedCezHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedCezHome;
    if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedCodexHome;
    if (savedXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdgConfigHome;
    if (savedModelsLocked === undefined) delete process.env.CEZ_AGENT_MODELS_LOCKED;
    else process.env.CEZ_AGENT_MODELS_LOCKED = savedModelsLocked;
  });

  const configPath = () => join(repoRoot, '.ai/cezar', 'config.json');
  const rawFile = () => JSON.parse(readFileSync(configPath(), 'utf8')) as Record<string, unknown>;

  const get = () => apiRequest(app, '/api/v1/config');
  const getBody = async () => (await (await get()).json()) as Record<string, unknown>;
  const put = (body: unknown) =>
    apiRequest(app, '/api/v1/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('GET answers the zero-config defaults when no file exists', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      baseBranch: null,
      defaultRunner: 'claude',
      systemPrompt: null,
      defaultModels: {},
      modelsLocked: false,
      maxParallel: 2,
      memoryLimitMb: null,
      worktreeRetention: 10,
      liveTitleUpdates: null,
      reviewGate: null,
    });
  });

  it("uses the coding agents' native model settings as the initial defaults", async () => {
    mkdirSync(join(homeRoot, '.claude'), { recursive: true });
    mkdirSync(join(homeRoot, '.codex'), { recursive: true });
    mkdirSync(join(homeRoot, '.config', 'opencode'), { recursive: true });
    writeFileSync(join(homeRoot, '.claude', 'settings.json'), '{"model":"sonnet"}');
    writeFileSync(join(homeRoot, '.codex', 'config.toml'), 'model = "gpt-5-codex"\n');
    writeFileSync(join(homeRoot, '.config', 'opencode', 'opencode.json'), '{"model":"openai/gpt-5.1"}');

    expect((await getBody()).defaultModels).toEqual({
      claude: 'sonnet',
      codex: 'gpt-5-codex',
      opencode: 'openai/gpt-5.1',
    });
    expect((await getBody()).modelsLocked).toBe(false);
  });

  it('locks native defaults and rejects Cezar model overrides', async () => {
    process.env.CEZ_AGENT_MODELS_LOCKED = '1';
    mkdirSync(join(homeRoot, '.codex'), { recursive: true });
    writeFileSync(join(homeRoot, '.codex', 'config.toml'), 'model = "gpt-5-codex"\n');
    writeFileSync(configPath(), JSON.stringify({ defaultModels: { codex: 'cezar-codex' } }), 'utf8');

    const body = await getBody();
    expect(body.modelsLocked).toBe(true);
    expect(body.defaultModels).toEqual({ codex: 'gpt-5-codex' });

    const res = await put({ defaultModels: { codex: 'other-model' } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('models are locked');
    expect(rawFile().defaultModels).toEqual({ codex: 'cezar-codex' });
  });

  it('supports the same lock through the optional repository config key', async () => {
    mkdirSync(join(homeRoot, '.codex'), { recursive: true });
    writeFileSync(join(homeRoot, '.codex', 'config.toml'), 'model = "native-codex"\n');
    writeFileSync(
      configPath(),
      JSON.stringify({ modelsLocked: true, defaultModels: { codex: 'cezar-codex' } }),
      'utf8',
    );

    const body = await getBody();
    expect(body.modelsLocked).toBe(true);
    expect(body.defaultModels).toEqual({ codex: 'native-codex' });
    expect((await put({ defaultModels: { codex: 'other-model' } })).status).toBe(409);
  });

  it('supports a global workspace config lock across repositories', async () => {
    writeFileSync(
      join(homeRoot, '.cezar', 'config.json'),
      JSON.stringify({ modelsLocked: true }),
      'utf8',
    );

    expect((await getBody()).modelsLocked).toBe(true);
    expect((await put({ defaultModels: { claude: 'opus' } })).status).toBe(409);
  });

  it('PUT systemPrompt trims, persists, and round-trips through GET', async () => {
    const res = await put({ systemPrompt: '  Answer in bullet points.  ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ systemPrompt: 'Answer in bullet points.' });
    expect((await getBody()).systemPrompt).toBe('Answer in bullet points.');
  });

  it('PUT systemPrompt null and "" both clear the raw key', async () => {
    await put({ systemPrompt: 'Be brief.' });
    expect(rawFile().systemPrompt).toBe('Be brief.');
    await put({ systemPrompt: null });
    expect(rawFile().systemPrompt).toBeUndefined();
    await put({ systemPrompt: 'Be brief.' });
    await put({ systemPrompt: '' });
    expect(rawFile().systemPrompt).toBeUndefined();
    expect((await getBody()).systemPrompt).toBeNull();
  });

  it('PUT defaultModels merges per runner instead of clobbering', async () => {
    await put({ defaultModels: { claude: 'opus' } });
    await put({ defaultModels: { codex: 'gpt-5.1-codex' } });
    expect((await getBody()).defaultModels).toEqual({
      claude: 'opus',
      codex: 'gpt-5.1-codex',
    });
    // Clearing one runner leaves the other; clearing the last drops the key.
    await put({ defaultModels: { codex: null } });
    expect(rawFile().defaultModels).toEqual({ claude: 'opus' });
    await put({ defaultModels: { claude: '' } });
    expect(rawFile().defaultModels).toBeUndefined();
  });

  it('PUT merges into the raw file — user keys survive, defaults never materialize', async () => {
    writeFileSync(
      configPath(),
      JSON.stringify({ skillsRepos: [{ repo: 'me/skills' }], maxParallel: 5 }),
      'utf8',
    );
    await put({ systemPrompt: 'Be brief.', defaultModels: { claude: 'opus' }, baseBranch: 'develop' });
    const raw = rawFile();
    expect(raw.skillsRepos).toEqual([{ repo: 'me/skills' }]);
    expect(raw.maxParallel).toBe(5);
    // No schema defaults leaked into the user's file.
    expect(raw.defaultRunner).toBeUndefined();
    expect(raw.plannerModel).toBeUndefined();
    expect(await (await get()).json()).toEqual({
      baseBranch: 'develop',
      defaultRunner: 'claude',
      systemPrompt: 'Be brief.',
      defaultModels: { claude: 'opus' },
      modelsLocked: false,
      maxParallel: 5,
      memoryLimitMb: null,
      worktreeRetention: 10,
      liveTitleUpdates: null,
      reviewGate: null,
    });
  });

  it('PUT worktreeRetention persists, keeps 0 (unlimited), and null clears back to the default', async () => {
    const res = await put({ worktreeRetention: 3 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ worktreeRetention: 3 });
    expect(rawFile().worktreeRetention).toBe(3);
    // 0 is a meaningful value (unlimited) — stored, not treated as "clear".
    await put({ worktreeRetention: 0 });
    expect(rawFile().worktreeRetention).toBe(0);
    expect((await getBody()).worktreeRetention).toBe(0);
    // null drops the key so it degrades to the schema default (10).
    await put({ worktreeRetention: null });
    expect(rawFile().worktreeRetention).toBeUndefined();
    expect((await getBody()).worktreeRetention).toBe(10);
  });

  it('rejects a negative or over-limit worktreeRetention with 400', async () => {
    expect((await put({ worktreeRetention: -1 })).status).toBe(400);
    expect((await put({ worktreeRetention: 1001 })).status).toBe(400);
  });

  it('PUT keeps the pre-R6 answer fields (protected shape) alongside the additive ones', async () => {
    const res = await put({ baseBranch: 'develop', defaultRunner: 'codex' });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.baseBranch).toBe('develop');
    expect(body.defaultRunner).toBe('codex');
  });

  it('rejects an over-limit systemPrompt and a malformed defaultModels with 400 + reason', async () => {
    const tooLong = await put({ systemPrompt: 'x'.repeat(20_001) });
    expect(tooLong.status).toBe(400);
    expect(((await tooLong.json()) as { error: string }).error).toContain('20000');
    const badModels = await put({ defaultModels: { claude: 42 } });
    expect(badModels.status).toBe(400);
  });
});

describe('liveTitleUpdates round-trip (task auto-naming spec)', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-configapi-title-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const put = (body: unknown) =>
    apiRequest(app, '/api/v1/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const rawFile = () =>
    JSON.parse(readFileSync(join(repoRoot, '.ai/cezar', 'config.json'), 'utf8')) as Record<string, unknown>;

  it('sets, answers and clears the key (null → env default decides)', async () => {
    const off = (await (await put({ liveTitleUpdates: false })).json()) as Record<string, unknown>;
    expect(off.liveTitleUpdates).toBe(false);
    expect(rawFile().liveTitleUpdates).toBe(false);

    const cleared = (await (await put({ liveTitleUpdates: null })).json()) as Record<string, unknown>;
    expect(cleared.liveTitleUpdates).toBeNull();
    expect(rawFile().liveTitleUpdates).toBeUndefined();
  });
});

describe('reviewGate round-trip (optional review gate, #489)', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-configapi-gate-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const put = (body: unknown) =>
    apiRequest(app, '/api/v1/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const rawFile = () =>
    JSON.parse(readFileSync(join(repoRoot, '.ai/cezar', 'config.json'), 'utf8')) as Record<string, unknown>;

  it('GET exposes reviewGate; PUT true/false/null round-trips and clears the raw key', async () => {
    // Default (no config key) is null — the CEZ_REVIEW_GATE env (OFF) decides.
    expect(((await (await apiRequest(app, '/api/v1/config')).json()) as Record<string, unknown>).reviewGate).toBeNull();

    const on = (await (await put({ reviewGate: true })).json()) as Record<string, unknown>;
    expect(on.reviewGate).toBe(true);
    expect(rawFile().reviewGate).toBe(true);

    const off = (await (await put({ reviewGate: false })).json()) as Record<string, unknown>;
    expect(off.reviewGate).toBe(false);
    expect(rawFile().reviewGate).toBe(false);

    const cleared = (await (await put({ reviewGate: null })).json()) as Record<string, unknown>;
    expect(cleared.reviewGate).toBeNull();
    expect(rawFile().reviewGate).toBeUndefined();
  });
});
