import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/** Export / preview / import routes (spec 2026-11-04-automations-and-config-export-import). */
describe('automations export and import API', () => {
  const roots: string[] = [];
  let home: string;
  const saved = process.env.CEZ_AUTOMATIONS;
  const project = () => {
    const root = mkdtempSync(join(tmpdir(), 'cezar-transfer-api-'));
    roots.push(root);
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    const store = RunStore.open(join(root, '.ai/cezar'));
    return { root, store, app: createApp({ repoRoot: root, store, manager: {} as RunManager, version: 'test' }) };
  };
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cezar-transfer-home-'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_AUTOMATIONS = '1';
  });
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    delete process.env.CEZ_HOME;
    if (saved === undefined) delete process.env.CEZ_AUTOMATIONS;
    else process.env.CEZ_AUTOMATIONS = saved;
  });

  const input = {
    name: 'Review new issues',
    events: ['issue.opened'],
    intervalSeconds: 300,
    filters: { lookbackDays: 7, maxRecords: 25 },
    task: { prompt: 'Review {{github.url}}' },
  };
  const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('exports from one project and imports paused into another, after a preview', async () => {
    const a = project();
    const created = (await (await apiRequest(a.app, '/api/v1/automations', post({ ...input, enable: true }))).json()) as any;
    expect(created.automation.enabled).toBe(true);

    const exported = await apiRequest(a.app, '/api/v1/automations/export');
    expect(exported.status).toBe(200);
    expect(exported.headers.get('content-disposition')).toMatch(/^attachment; filename="cezar-automations-.+\.json"$/);
    const file = (await exported.json()) as any;
    expect(file).toMatchObject({ format: 'cezar-automations', version: 1, automations: [{ name: input.name }] });
    expect(file.automations[0].id).toBeUndefined();

    const b = project();
    const preview = (await (await apiRequest(b.app, '/api/v1/automations/import/preview', post({ file }))).json()) as any;
    expect(preview.rows).toEqual([expect.objectContaining({ action: 'create', issues: [] })]);
    expect(existsSync(join(b.root, '.ai/cezar/automations.json'))).toBe(false);

    const applied = await apiRequest(b.app, '/api/v1/automations/import', post({ file, planDigest: preview.planDigest }));
    expect(applied.status).toBe(201);
    const result = (await applied.json()) as any;
    expect(result.created).toHaveLength(1);
    expect(result.created[0]).not.toBe(created.automation.id);
    const list = (await (await apiRequest(b.app, '/api/v1/automations')).json()) as any;
    expect(list.automations).toEqual([expect.objectContaining({ name: input.name, enabled: false })]);
  });

  it('refuses a stale preview with 409 and writes nothing', async () => {
    const a = project();
    await apiRequest(a.app, '/api/v1/automations', post(input));
    const file = await (await apiRequest(a.app, '/api/v1/automations/export')).json();
    const b = project();
    const preview = (await (await apiRequest(b.app, '/api/v1/automations/import/preview', post({ file }))).json()) as any;
    await apiRequest(b.app, '/api/v1/automations', post({ ...input, name: 'Other' }));
    const stale = await apiRequest(b.app, '/api/v1/automations/import', post({ file, planDigest: preview.planDigest }));
    expect(stale.status).toBe(409);
    const list = (await (await apiRequest(b.app, '/api/v1/automations')).json()) as any;
    expect(list.automations.map((row: { name: string }) => row.name)).toEqual(['Other']);
  });

  it('rejects a newer-version file with a clear 400', async () => {
    const b = project();
    const response = await apiRequest(b.app, '/api/v1/automations/import/preview',
      post({ file: { format: 'cezar-automations', version: 2, exportedAt: 'x', automations: [] } }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as any).error).toMatch(/newer cezar \(version 2\)/);
  });

  it('is gated by CEZ_AUTOMATIONS=0', async () => {
    process.env.CEZ_AUTOMATIONS = '0';
    const b = project();
    expect((await apiRequest(b.app, '/api/v1/automations/export')).status).toBe(409);
    expect((await apiRequest(b.app, '/api/v1/automations/import/preview', post({}))).status).toBe(409);
  });
});
