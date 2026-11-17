import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/**
 * Placements over HTTP (spec `.ai/specs/2026-11-07-extension-placements.md`):
 * `GET /extensions/placements?location=` is a READ that degrades to `{ available: false }`
 * instead of 409, and a task-located panel/command call names its run through a validated
 * `runId` that is resolved in THIS project's store — an unknown run is a 404 before any worker
 * is called.
 */
describe('extension placements and task-located calls over HTTP', () => {
  const prevRemote = process.env.CEZ_REMOTE;
  const prevFlag = process.env.CEZ_EXTENSIONS;
  let root: string;
  let runs: RunStore;
  let app: Hono;

  beforeEach(() => {
    delete process.env.CEZ_REMOTE;
    delete process.env.CEZ_EXTENSIONS;
    root = mkdtempSync(join(tmpdir(), 'cez-ext-placements-'));
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    const ext = join(root, 'placed');
    mkdirSync(ext);
    writeFileSync(join(ext, 'cezar-extension.json'), JSON.stringify({
      id: 'placed.test', name: 'Placed', version: '1.0.0', apiVersion: '0.1', entry: 'index.mjs', capabilities: ['commands', 'panels'], permissions: ['project.read'],
      contributes: {
        panels: [{ id: 'side', title: 'Side', location: 'sidebar' }, { id: 'tp', title: 'Task panel', location: 'task' }],
        commands: [{ id: 'pal', label: 'Palette', location: 'palette' }, { id: 'tc', label: 'Task command', location: 'task' }],
      },
    }));
    writeFileSync(join(ext, 'index.mjs'), `export function activate(c) {
      c.panels.register('tp', async ctx => ({ id: 'tp', title: JSON.stringify([ctx, await c.tasks.get(ctx.runId)]) }));
      c.panels.register('side', (...args) => ({ id: 'side', title: JSON.stringify(args) }));
      c.commands.register('tc', input => ({ message: JSON.stringify(input) }));
      c.commands.register('pal', input => ({ message: JSON.stringify(input ?? null) }));
    }`);
    runs = RunStore.open(join(root, '.ai/cezar'));
    app = createApp({ repoRoot: root, store: runs, manager: {} as RunManager, version: '0.0.0-test' });
  });
  afterEach(async () => {
    await apiRequest(app, '/api/v1/extensions/placed.test', { method: 'DELETE' });
    runs.flush();
    rmSync(root, { recursive: true, force: true });
    if (prevRemote === undefined) delete process.env.CEZ_REMOTE; else process.env.CEZ_REMOTE = prevRemote;
    if (prevFlag === undefined) delete process.env.CEZ_EXTENSIONS; else process.env.CEZ_EXTENSIONS = prevFlag;
  });

  const post = (path: string, body: unknown = {}) => apiRequest(app, path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const installAndEnable = async () => {
    const prepared = await (await post('/api/v1/extensions/prepare-install', { source: join(root, 'placed') })).json() as { preparedId: string };
    const installed = await (await post('/api/v1/extensions/commit-install', { preparedId: prepared.preparedId })).json() as { integrity: string };
    expect((await post('/api/v1/extensions/placed.test/enable', { integrity: installed.integrity })).status).toBe(200);
  };

  it('answers { available: false, extensions: [] } with 200 when hosted or turned off — never 409', async () => {
    process.env.CEZ_REMOTE = '1';
    const hosted = await apiRequest(app, '/api/v1/extensions/placements?location=palette');
    expect(hosted.status).toBe(200);
    expect(await hosted.json()).toEqual({ available: false, extensions: [] });
    delete process.env.CEZ_REMOTE;
    process.env.CEZ_EXTENSIONS = '0';
    const off = await apiRequest(app, '/api/v1/extensions/placements?location=sidebar');
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ available: false, extensions: [] });
  });

  it('validates the location as middleware', async () => {
    expect((await apiRequest(app, '/api/v1/extensions/placements')).status).toBe(400);
    expect((await apiRequest(app, '/api/v1/extensions/placements?location=toolbar')).status).toBe(400);
    const empty = await apiRequest(app, '/api/v1/extensions/placements?location=task');
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ available: true, extensions: [] });
  });

  it('lists enabled extensions per surface, on the project-scoped spelling too', async () => {
    await installAndEnable();
    const palette = await (await apiRequest(app, '/api/v1/p/default/extensions/placements?location=palette')).json();
    expect(palette).toEqual({ available: true, extensions: [{ extensionId: 'placed.test', name: 'Placed', status: 'running', panels: [], commands: [{ id: 'pal', title: 'Palette', location: 'palette' }] }] });
    const task = await (await apiRequest(app, '/api/v1/extensions/placements?location=task')).json();
    expect(task).toEqual({ available: true, extensions: [{ extensionId: 'placed.test', name: 'Placed', status: 'running', panels: [{ id: 'tp', title: 'Task panel', location: 'task' }], commands: [{ id: 'tc', title: 'Task command', location: 'task' }] }] });
    expect(await (await apiRequest(app, '/api/v1/extensions/placements?location=settings')).json()).toEqual({ available: true, extensions: [] });
    expect((await post('/api/v1/extensions/placed.test/disable')).status).toBe(200);
    expect(await (await apiRequest(app, '/api/v1/extensions/placements?location=task')).json()).toEqual({ available: true, extensions: [] });
  });

  it('resolves runId in the project store: 404 for an unknown run, the task context for a known one', async () => {
    await installAndEnable();
    const run = runs.createRun({ title: 'Mine', workflow: 'quick-task', task: 'do it', steps: [{ id: 'work', name: 'work', kind: 'agent' }] });
    const missing = await apiRequest(app, '/api/v1/extensions/placed.test/panels/tp?runId=not-in-this-project');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'run not found' });
    const invokeMissing = await post('/api/v1/extensions/placed.test/commands/tc/invoke', { runId: 'not-in-this-project' });
    expect(invokeMissing.status).toBe(404);
    expect(await invokeMissing.json()).toEqual({ error: 'run not found' });
    // A malformed run id never reaches the store.
    expect((await apiRequest(app, '/api/v1/extensions/placed.test/panels/tp?runId=..%2Fescape')).status).toBe(400);
    expect((await post('/api/v1/extensions/placed.test/commands/tc/invoke', { runId: 'a b' })).status).toBe(400);
    const panel = await apiRequest(app, `/api/v1/extensions/placed.test/panels/tp?runId=${run.id}`);
    expect(panel.status).toBe(200);
    expect(((await panel.json()) as { title: string }).title).toBe(JSON.stringify([{ runId: run.id }, { id: run.id, title: 'Mine', status: run.status }]));
    const invoked = await post('/api/v1/extensions/placed.test/commands/tc/invoke', { input: { note: 'x' }, runId: run.id });
    expect(invoked.status).toBe(200);
    expect(await invoked.json()).toEqual({ ok: true, message: JSON.stringify({ note: 'x', runId: run.id }) });
    // Sidebar/palette contributions never receive a task, even when a (valid) run id is sent.
    const side = await apiRequest(app, `/api/v1/extensions/placed.test/panels/side?runId=${run.id}`);
    expect(((await side.json()) as { title: string }).title).toBe('[]');
    expect(await (await post('/api/v1/extensions/placed.test/commands/pal/invoke', { runId: run.id })).json()).toEqual({ ok: true, message: 'null' });
    // And without one, V1 behaviour is untouched.
    expect(((await (await apiRequest(app, '/api/v1/extensions/placed.test/panels/side')).json()) as { title: string }).title).toBe('[]');
  });
});
