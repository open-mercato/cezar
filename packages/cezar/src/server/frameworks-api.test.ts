import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunCard } from '@open-mercato/cezar-contract';
import { CardOperationError } from '../frameworks/card-runtime.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/** The `/frameworks` and `/cards` families (spec 2026-11-15-framework-board § API). */

const CARD: RunCard = {
  framework: 'generic',
  frameworkHash: 'abc123',
  title: 'Card',
  stage: 'plan',
  stages: { plan: 'waiting', build: 'pending', review: 'pending' },
  stageOrder: ['plan', 'build', 'review'],
};

describe('the frameworks and cards API', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let app: Hono;
  let manager: Record<string, ReturnType<typeof vi.fn>>;
  const prevRemote = process.env.CEZ_REMOTE;

  beforeEach(() => {
    delete process.env.CEZ_REMOTE;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-frameworks-api-'));
    dataDir = join(repoRoot, '.ai/cezar');
    mkdirSync(dataDir, { recursive: true });
    store = RunStore.open(dataDir);
    manager = {
      createCard: vi.fn(),
      patchCard: vi.fn(),
      rerunCard: vi.fn(),
      finishStage: vi.fn(),
      approveCardGate: vi.fn(),
      recheckFrameworkState: vi.fn(async () => {}),
    };
    app = createApp({ repoRoot, store, manager: manager as unknown as RunManager, version: '0.0.0-test' });
  });
  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (prevRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = prevRemote;
  });

  const send = (method: string, path: string, body?: unknown) =>
    apiRequest(app, `/api/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const getJson = async <T>(path: string): Promise<T> => (await (await apiRequest(app, `/api/v1${path}`)).json()) as T;

  type List = { frameworks: { id: string; source: string; path?: string; error?: string; availability?: unknown }[]; active: { id: string; source: string; detectedBy?: string } };

  it('lists the built-ins with availability, and Generic as the fallback', async () => {
    const body = await getJson<List>('/frameworks');
    expect(body.frameworks.map((f) => f.id)).toEqual(['open-mercato-sdd', 'openspec', 'spec-kit', 'generic']);
    expect(body.frameworks.every((f) => f.source === 'builtin' && f.availability)).toBe(true);
    expect(body.active).toEqual({ id: 'generic', source: 'fallback' });
  });

  it('detects SDD per request, and lists an invalid project file with its error', async () => {
    mkdirSync(join(repoRoot, '.ai/sdd'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/sdd/sdd.mjs'), '');
    mkdirSync(join(dataDir, 'frameworks'));
    writeFileSync(join(dataDir, 'frameworks/broken.yaml'), 'id: broken\nname: Broken\nstages: []\n');
    const body = await getJson<List>('/frameworks');
    expect(body.active).toEqual({ id: 'open-mercato-sdd', source: 'detected', detectedBy: '.ai/sdd/sdd.mjs' });
    const broken = body.frameworks.find((f) => f.id === 'broken');
    expect(broken).toMatchObject({ source: 'project', path: '.ai/cezar/frameworks/broken.yaml' });
    expect(broken?.error).toBeTruthy();
    expect(broken?.availability).toBeUndefined();
  });

  it('says whether each framework is committed on the ref cards fork from (git repos only)', async () => {
    type Row = { id: string; installedOnBase?: boolean; baseRef?: string; missingOnBase?: string[] };
    const sdd = async () => (await getJson<{ frameworks: Row[] }>('/frameworks')).frameworks;
    // Not a git repo: nothing to check.
    expect((await sdd()).find((f) => f.id === 'open-mercato-sdd')).not.toHaveProperty('installedOnBase');

    const git = (...args: string[]) => execFileSync('git', args, { cwd: repoRoot, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'test');
    git('config', 'user.email', 'test@local');
    writeFileSync(join(repoRoot, '.gitignore'), '.ai/cezar/\n');
    mkdirSync(join(repoRoot, '.ai/sdd'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/sdd/sdd.mjs'), '');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    // Present in the checkout, not committed: still not on the base.
    writeFileSync(join(repoRoot, '.ai/sdd/CONVENTIONS.md'), '');
    const before = await sdd();
    expect(before.find((f) => f.id === 'open-mercato-sdd')).toMatchObject({ installedOnBase: false, baseRef: 'main', missingOnBase: ['.ai/sdd/CONVENTIONS.md'] });
    expect(before.find((f) => f.id === 'generic')).not.toHaveProperty('installedOnBase');

    git('add', '-A');
    git('commit', '-q', '-m', 'conventions');
    expect((await sdd()).find((f) => f.id === 'open-mercato-sdd')).toMatchObject({ installedOnBase: true, baseRef: 'main', missingOnBase: [] });
  });

  it('details a framework with its YAML, stage availability and compiled graph; 404 unknown', async () => {
    const res = await apiRequest(app, '/api/v1/frameworks/generic');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { framework: { id: string }; yaml: string; stages: { stage: string }[]; graph: { nodes: { id: string }[] }; source: string };
    expect(body.framework.id).toBe('generic');
    expect(body.yaml).toMatch(/^id: generic/m);
    expect(body.stages.map((s) => s.stage)).toEqual(['plan', 'build', 'review']);
    expect(body.graph.nodes.some((n) => n.id === 'plan-agent')).toBe(true);
    expect(body.source).toBe('builtin');
    expect((await apiRequest(app, '/api/v1/frameworks/nope')).status).toBe(404);
  });

  it('duplicates into a project file with its id rewritten, and never overwrites', async () => {
    const res = await send('POST', '/frameworks/generic/duplicate', { newId: 'my-flow' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'my-flow', path: '.ai/cezar/frameworks/my-flow.yaml' });
    const written = readFileSync(join(dataDir, 'frameworks/my-flow.yaml'), 'utf8');
    expect(written).toMatch(/^id: my-flow$/m);
    expect((await getJson<List>('/frameworks')).frameworks.find((f) => f.id === 'my-flow')).toMatchObject({ source: 'project' });

    writeFileSync(join(dataDir, 'frameworks/my-flow.yaml'), written + '# mine\n');
    expect((await send('POST', '/frameworks/generic/duplicate', { newId: 'my-flow' })).status).toBe(409);
    expect(readFileSync(join(dataDir, 'frameworks/my-flow.yaml'), 'utf8')).toContain('# mine');
    expect((await send('POST', '/frameworks/openspec/duplicate', { newId: 'generic' })).status).toBe(409);
    expect((await send('POST', '/frameworks/generic/duplicate', { newId: 'bad.id' })).status).toBe(400);
    expect((await send('POST', '/frameworks/nope/duplicate', { newId: 'x' })).status).toBe(404);
  });

  it('PUT /project/framework: explicit, explicit generic beats detected SDD, null back to automatic', async () => {
    mkdirSync(join(repoRoot, '.ai/sdd'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/sdd/sdd.mjs'), '');
    writeFileSync(join(dataDir, 'config.json'), '{"skillsRepos": []}\n');

    let res = await send('PUT', '/project/framework', { framework: 'openspec' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ active: { id: 'openspec', source: 'explicit' } });

    res = await send('PUT', '/project/framework', { framework: 'generic' });
    expect(await res.json()).toEqual({ active: { id: 'generic', source: 'explicit' } });
    expect((await getJson<List>('/frameworks')).active).toEqual({ id: 'generic', source: 'explicit' });
    const config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>;
    expect(config).toMatchObject({ framework: 'generic', skillsRepos: [] });

    res = await send('PUT', '/project/framework', { framework: null });
    expect(await res.json()).toEqual({ active: { id: 'open-mercato-sdd', source: 'detected', detectedBy: '.ai/sdd/sdd.mjs' } });
    expect(JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'))).not.toHaveProperty('framework');

    expect((await send('PUT', '/project/framework', { framework: 'nope' })).status).toBe(400);
  });

  describe('POST /frameworks/:id/install', () => {
    const withInstaller = (result: Awaited<ReturnType<NonNullable<Parameters<typeof createApp>[0]['frameworkInstaller']>>>) => {
      const installer = vi.fn(async () => result);
      app = createApp({ repoRoot, store, manager: manager as unknown as RunManager, version: '0.0.0-test', frameworkInstaller: installer });
      return installer;
    };

    it('lists SDD as installable with what it writes; the others are not', async () => {
      const body = await getJson<{ frameworks: { id: string; availability?: { installable: boolean }; install?: Record<string, unknown> }[] }>('/frameworks');
      const sdd = body.frameworks.find((f) => f.id === 'open-mercato-sdd')!;
      expect(sdd.availability?.installable).toBe(true);
      expect(sdd.install).toMatchObject({ source: 'open-mercato/sdd', ref: '04ba2cc', writes: ['.claude/skills/om-sdd*/', '.ai/sdd/', '.ai/agentic.config.json'] });
      for (const id of ['generic', 'openspec', 'spec-kit']) {
        const f = body.frameworks.find((x) => x.id === id)!;
        expect(f.availability?.installable).toBe(false);
        expect(f).not.toHaveProperty('install');
      }
    });

    it('404 unknown, 400 without an installer, never reaching it', async () => {
      const installer = withInstaller({ ok: true, output: '', changedPaths: [], committed: false });
      expect((await send('POST', '/frameworks/nope/install', {})).status).toBe(404);
      const res = await send('POST', '/frameworks/spec-kit/install', {});
      expect(res.status).toBe(400);
      expect(installer).not.toHaveBeenCalled();
    });

    it('is local-only: 409 in hosted mode before the installer runs', async () => {
      const installer = withInstaller({ ok: true, output: '', changedPaths: [], committed: false });
      process.env.CEZ_REMOTE = '1';
      const res = await send('POST', '/frameworks/open-mercato-sdd/install', { commit: true });
      expect(res.status).toBe(409);
      expect(installer).not.toHaveBeenCalled();
    });

    it('answers the installer result, passing commit and the pinned source', async () => {
      const installer = withInstaller({ ok: true, output: 'Skills installed', changedPaths: ['.ai/sdd/sdd.mjs'], committed: true, note: 'Committed on main.' });
      const res = await send('POST', '/frameworks/open-mercato-sdd/install', { commit: true });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, changedPaths: ['.ai/sdd/sdd.mjs'], committed: true, note: 'Committed on main.', output: 'Skills installed' });
      expect(installer).toHaveBeenCalledWith(
        repoRoot,
        'open-mercato-sdd',
        expect.objectContaining({ ref: '04ba2cc1102a1157f55091c8941544bb721e0253', installer: 'install.mjs' }),
        { commit: true },
      );
    });

    it('maps a conflict to 409 and a download or installer failure to 502', async () => {
      withInstaller({ ok: false, code: 'conflict', error: 'commit or discard local changes first' });
      let res = await send('POST', '/frameworks/open-mercato-sdd/install', {});
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'commit or discard local changes first' });
      withInstaller({ ok: false, code: 'failed', error: 'could not download open-mercato/sdd at 04ba2cc: offline' });
      res = await send('POST', '/frameworks/open-mercato-sdd/install', {});
      expect(res.status).toBe(502);
    });

    it('CEZ_DRY_RUN=1 writes nothing and reaches no network', async () => {
      const prev = process.env.CEZ_DRY_RUN;
      process.env.CEZ_DRY_RUN = '1';
      try {
        const res = await send('POST', '/frameworks/open-mercato-sdd/install', { commit: true });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ ok: true, changedPaths: [], committed: false });
      } finally {
        if (prev === undefined) delete process.env.CEZ_DRY_RUN;
        else process.env.CEZ_DRY_RUN = prev;
      }
    });
  });

  it('card routes 404 for an unknown run and for an ad-hoc run (no card)', async () => {
    const adHoc = store.createRun({ title: 'ad-hoc', workflow: 'quick-task', task: 'ad-hoc', steps: [] }).id;
    for (const id of [adHoc, 'no-such-run']) {
      expect((await send('PATCH', `/cards/${id}`, { held: false })).status).toBe(404);
      expect((await send('POST', `/cards/${id}/rerun`, { fromStage: 'plan' })).status).toBe(404);
      expect((await send('POST', `/cards/${id}/finish-stage`, {})).status).toBe(404);
      expect((await send('POST', `/cards/${id}/approve`, {})).status).toBe(404);
    }
    for (const fn of Object.values(manager)) expect(fn).not.toHaveBeenCalled();
  });

  it('card routes reach the manager; state errors are 409, a failed approve is 422', async () => {
    const run = store.createRun({ title: 'card', workflow: 'framework:generic', task: 'card', steps: [] });
    store.updateRun(run.id, { card: CARD });
    const record = store.getRun(run.id)!;
    manager.createCard!.mockResolvedValue(record);
    manager.patchCard!.mockReturnValue(record);
    manager.rerunCard!.mockImplementation(() => {
      throw new Error('card is running');
    });
    manager.approveCardGate!.mockResolvedValue({ ok: false, error: 'sdd approve refused' });

    const created = await send('POST', '/cards', { title: 'card' });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { run: { id: string } }).run.id).toBe(run.id);
    expect((await send('POST', '/cards', {})).status).toBe(400);

    const patched = await send('PATCH', `/cards/${run.id}`, { held: false });
    expect(patched.status).toBe(200);
    expect(manager.patchCard).toHaveBeenCalledWith(run.id, { held: false });

    const rerun = await send('POST', `/cards/${run.id}/rerun`, { fromStage: 'plan' });
    expect(rerun.status).toBe(409);
    expect(await rerun.json()).toEqual({ error: 'card is running' });

    expect(await (await send('POST', `/cards/${run.id}/finish-stage`)).json()).toEqual({ ok: true });

    const approve = await send('POST', `/cards/${run.id}/approve`, {});
    expect(approve.status).toBe(422);
    expect(await approve.json()).toEqual({ error: 'sdd approve refused' });
    expect(manager.approveCardGate).toHaveBeenCalledWith(run.id, expect.any(String));

    expect(await (await send('POST', '/cards/recheck')).json()).toEqual({ ok: true });
    await vi.waitFor(() => expect(manager.recheckFrameworkState).toHaveBeenCalled());
  });

  it('a refused card operation answers its own status; anything else keeps the route default', async () => {
    const run = store.createRun({ title: 'card', workflow: 'framework:generic', task: 'card', steps: [] });
    store.updateRun(run.id, { card: CARD });
    manager.createCard!.mockRejectedValueOnce(new CardOperationError('no framework "nope"', 404));
    expect((await send('POST', '/cards', { title: 'x', framework: 'nope' })).status).toBe(404);
    manager.createCard!.mockRejectedValueOnce(new CardOperationError('every stage is skipped', 422));
    expect((await send('POST', '/cards', { title: 'x' })).status).toBe(422);
    manager.createCard!.mockRejectedValueOnce(new Error('boom'));
    expect((await send('POST', '/cards', { title: 'x' })).status).toBe(400);
    manager.patchCard!.mockImplementationOnce(() => {
      throw new CardOperationError('Slug "x" does not match', 422);
    });
    expect((await send('PATCH', `/cards/${run.id}`, { fields: { slug: 'x' } })).status).toBe(422);
    manager.rerunCard!.mockRejectedValueOnce(new CardOperationError('"zzz" is not a stage this card runs', 422));
    expect((await send('POST', `/cards/${run.id}/rerun`, { fromStage: 'zzz' })).status).toBe(422);
    manager.finishStage!.mockImplementationOnce(() => {
      throw new CardOperationError('the card is not in a conversation stage', 409);
    });
    expect((await send('POST', `/cards/${run.id}/finish-stage`, {})).status).toBe(409);
  });

  it('approve is local-only: 409 in hosted mode, before the manager is reached', async () => {
    const run = store.createRun({ title: 'card', workflow: 'framework:generic', task: 'card', steps: [] });
    store.updateRun(run.id, { card: CARD });
    process.env.CEZ_REMOTE = '1';
    const res = await send('POST', `/cards/${run.id}/approve`, {});
    expect(res.status).toBe(409);
    expect(manager.approveCardGate).not.toHaveBeenCalled();
  });
});
