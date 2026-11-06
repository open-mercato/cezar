import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/** Workspace configuration-bundle routes (spec 2026-11-04-automations-and-config-export-import, Phase 2). */
describe('configuration bundle API', () => {
  const temps: string[] = [];
  const saved = { home: process.env.CEZ_HOME, remote: process.env.CEZ_REMOTE };
  let home: string;
  let root: string;
  const temp = (prefix: string) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    temps.push(dir);
    return dir;
  };
  beforeEach(() => {
    home = temp('cezar-bundle-api-home-');
    root = temp('cezar-bundle-api-root-');
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    process.env.CEZ_HOME = home;
    delete process.env.CEZ_REMOTE;
    writeFileSync(join(home, 'config.json'), JSON.stringify({ systemPrompt: 'Be brief', projects: [{ id: 'app', root, name: 'app', addedAt: '' }] }));
    writeFileSync(join(root, '.ai/cezar/config.json'), JSON.stringify({ plannerModel: 'opus' }));
  });
  afterEach(() => {
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
    process.env.CEZ_HOME = saved.home;
    if (saved.remote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = saved.remote;
  });
  const app = () => createApp({ repoRoot: root, store: RunStore.open(join(root, '.ai/cezar')), manager: {} as RunManager, version: 'test' });
  const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('exports, previews and imports with a mapping, writing only after apply', async () => {
    const exported = await apiRequest(app(), '/api/v1/workspace/config-bundle');
    expect(exported.status).toBe(200);
    expect(exported.headers.get('content-disposition')).toMatch(/^attachment; filename="cezar-config-.+\.json"$/);
    const bundle = (await exported.json()) as any;
    expect(bundle).toMatchObject({ format: 'cezar-config-bundle', workspace: { systemPrompt: 'Be brief' }, projects: [{ name: 'app', config: { plannerModel: 'opus' } }] });
    expect(JSON.stringify(bundle)).not.toContain(root);

    bundle.projects[0].config = { plannerModel: 'haiku', namerModel: 'sonnet' };
    const mapping = { 0: 'app' };
    const preview = (await (await apiRequest(app(), '/api/v1/workspace/config-bundle/preview', post({ bundle, mapping }))).json()) as any;
    expect(preview.importAllowed).toBe(true);
    const config = preview.sections.find((section: { id: string }) => section.id === 'project:0:config');
    expect(config.changes).toEqual([
      { key: 'plannerModel', from: 'opus', to: 'haiku', action: 'keep', conflict: true },
      { key: 'namerModel', to: 'sonnet', action: 'take', conflict: false },
    ]);
    expect(JSON.parse(readFileSync(join(root, '.ai/cezar/config.json'), 'utf8'))).toEqual({ plannerModel: 'opus' });

    const applied = await apiRequest(app(), '/api/v1/workspace/config-bundle/import', post({ bundle, mapping, planDigest: preview.planDigest }));
    expect(applied.status).toBe(200);
    expect(((await applied.json()) as any).applied).toContain('project:0:config');
    expect(JSON.parse(readFileSync(join(root, '.ai/cezar/config.json'), 'utf8'))).toEqual({ plannerModel: 'opus', namerModel: 'sonnet' });
  });

  it('exports the workspace alone for an empty project list', async () => {
    const bundle = (await (await apiRequest(app(), '/api/v1/workspace/config-bundle?projects=')).json()) as any;
    expect(bundle.projects).toEqual([]);
    expect(bundle.workspace).toEqual({ systemPrompt: 'Be brief' });
  });

  it('refuses a stale preview and a newer bundle', async () => {
    const bundle = (await (await apiRequest(app(), '/api/v1/workspace/config-bundle')).json()) as any;
    const stale = await apiRequest(app(), '/api/v1/workspace/config-bundle/import', post({ bundle, planDigest: 'not-the-digest' }));
    expect(stale.status).toBe(409);
    const newer = await apiRequest(app(), '/api/v1/workspace/config-bundle/preview', post({ bundle: { ...bundle, version: 2 } }));
    expect(newer.status).toBe(400);
    expect(((await newer.json()) as any).error).toMatch(/newer cezar \(version 2\)/);
  });

  it('is local-only on import', async () => {
    const bundle = (await (await apiRequest(app(), '/api/v1/workspace/config-bundle')).json()) as any;
    process.env.CEZ_REMOTE = '1';
    const preview = (await (await apiRequest(app(), '/api/v1/workspace/config-bundle/preview', post({ bundle }))).json()) as any;
    expect(preview.importAllowed).toBe(false);
    const refused = await apiRequest(app(), '/api/v1/workspace/config-bundle/import', post({ bundle, planDigest: preview.planDigest }));
    expect(refused.status).toBe(409);
  });
});
