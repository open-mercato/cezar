import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { SkillsUpdateConflictError, SkillsUpdateService } from '../skills-update.ts';
import { mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

describe('workspace skills update API', () => {
  const savedHome = process.env.CEZ_HOME;
  const savedAutoUpdate = process.env.CEZ_SKILLS_AUTO_UPDATE;
  let home: string;
  let repoRoot: string;
  let missingRoot: string;
  let store: RunStore;
  let service: SkillsUpdateService;
  let app: Hono;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cez-skills-update-api-'));
    process.env.CEZ_HOME = home;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-skills-update-repo-'));
    missingRoot = join(home, 'gone');
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    await mergeWriteWorkspaceConfig((config) => {
      config.projects = [
        { id: 'repo', name: 'Repo', root: repoRoot, addedAt: '', lastOpenedAt: '', source: 'local' },
        { id: 'gone', name: 'Gone', root: missingRoot, addedAt: '', lastOpenedAt: '', source: 'local' },
      ];
    });
    service = new SkillsUpdateService({ homeDir: home, resolveNpx: async () => null });
    app = createApp({ repoRoot, bootProjectId: 'repo', store, manager: {} as RunManager,
      version: 'test', skillsUpdate: service });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.flush();
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    if (savedAutoUpdate === undefined) delete process.env.CEZ_SKILLS_AUTO_UPDATE;
    else process.env.CEZ_SKILLS_AUTO_UPDATE = savedAutoUpdate;
    rmSync(home, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('returns the cached snapshot immediately and schedules a detection-only check', async () => {
    const snapshot = vi.spyOn(service, 'snapshot');
    const check = vi.spyOn(service, 'check');
    const response = await apiRequest(app, '/api/v1/workspace/skills-update?projectId=repo');
    expect(response.status).toBe(200);
    expect((await response.json()) as { status: string }).toMatchObject({ status: 'idle' });
    expect(snapshot).toHaveBeenCalledWith(repoRoot);
    expect(check).toHaveBeenCalledWith(repoRoot);
  });

  it('forces a check using only the registered project root', async () => {
    const check = vi.spyOn(service, 'check');
    const response = await apiRequest(app, '/api/v1/workspace/skills-update/check', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'repo' }),
    });
    expect(response.status).toBe(200);
    expect(check).toHaveBeenCalledWith(repoRoot, true);
  });

  it('rejects executable input and invalid bodies without checking', async () => {
    const check = vi.spyOn(service, 'check');
    for (const body of [{}, { projectId: 'repo', command: 'rm' }, { projectId: 'repo', skills: ['x'] }]) {
      const response = await apiRequest(app, '/api/v1/workspace/skills-update/check', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    expect(check).not.toHaveBeenCalled();
  });

  it('uses the existing unknown and gone project contract', async () => {
    expect((await apiRequest(app, '/api/v1/workspace/skills-update?projectId=unknown')).status).toBe(404);
    expect((await apiRequest(app, '/api/v1/workspace/skills-update?projectId=gone')).status).toBe(409);
    expect((await apiRequest(app, '/api/v1/workspace/skills-update')).status).toBe(400);
  });

  it('applies using only the registered project identity and returns final safe state', async () => {
    const final = { ...service.snapshot(repoRoot), status: 'current' as const, updatedAt: '2026-07-22T00:00:00.000Z' };
    const update = vi.spyOn(service, 'update').mockResolvedValue(final);
    const response = await apiRequest(app, '/api/v1/workspace/skills-update/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'repo' }) });
    expect(response.status).toBe(200); expect(update).toHaveBeenCalledWith(repoRoot, true);
    expect(await response.json()).toMatchObject({ status: 'current', autoUpdateEnabled: true, inherited: true });
  });

  it('rejects executable apply input and preserves unknown/gone behavior', async () => {
    const update = vi.spyOn(service, 'update');
    for (const body of [null, {}, { projectId: 'repo', path: '/tmp' }, { projectId: 'repo', names: ['x'] }, { projectId: 'repo', scope: 'global' }, { projectId: 'repo', source: 'evil/repo' }]) {
      expect((await apiRequest(app, '/api/v1/workspace/skills-update/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status).toBe(400);
    }
    for (const [projectId, status] of [['unknown', 404], ['gone', 409]] as const) {
      expect((await apiRequest(app, '/api/v1/workspace/skills-update/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId }) })).status).toBe(status);
    }
    expect(update).not.toHaveBeenCalled();
  });

  it('returns 409 and latest safe state when another operation owns mutation', async () => {
    vi.spyOn(service, 'update').mockRejectedValue(new SkillsUpdateConflictError());
    const response = await apiRequest(app, '/api/v1/workspace/skills-update/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'repo' }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'another skills update operation is running', state: { status: 'idle', autoUpdateEnabled: true, inherited: true } });
  });

  it('reports inherited and explicit off without disabling manual apply', async () => {
    process.env.CEZ_SKILLS_AUTO_UPDATE = '0';
    let response = await apiRequest(app, '/api/v1/workspace/skills-update/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'repo' }) });
    expect(await response.json()).toMatchObject({ autoUpdateEnabled: false, inherited: true, status: 'unavailable' });
    process.env.CEZ_SKILLS_AUTO_UPDATE = '1';
    await mergeWriteWorkspaceConfig((config) => { config.skillsAutoUpdate = false; });
    response = await apiRequest(app, '/api/v1/workspace/skills-update/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'repo' }) });
    expect(await response.json()).toMatchObject({ autoUpdateEnabled: false, inherited: false });
  });

  it('keeps apply behind the origin/CSRF guard', async () => {
    const update = vi.spyOn(service, 'update');
    const response = await app.request('/api/v1/workspace/skills-update/apply', { method: 'POST', headers: { host: '127.0.0.1:4321', origin: 'https://evil.test', 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'repo' }) });
    expect(response.status).toBe(403); expect(update).not.toHaveBeenCalled();
  });
});
