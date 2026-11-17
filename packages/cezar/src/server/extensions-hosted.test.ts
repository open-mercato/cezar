import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/** Installing, enabling or running extension code is a local-machine capability: a hosted
 *  cockpit (`CEZ_REMOTE`) must 409 every route that would execute plugin code on the host. */
describe('extension routes in hosted mode', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  const prevRemote = process.env.CEZ_REMOTE;
  const prevRemoteExtensions = process.env.CEZ_REMOTE_EXTENSIONS;

  beforeEach(() => {
    delete process.env.CEZ_REMOTE;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-ext-hosted-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    const ext = join(repoRoot, 'probe-ext');
    mkdirSync(ext);
    writeFileSync(join(ext, 'package.json'), JSON.stringify({ name: 'probe-ext', version: '1.0.0', type: 'module' }));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
  });
  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (prevRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = prevRemote;
    if (prevRemoteExtensions === undefined) delete process.env.CEZ_REMOTE_EXTENSIONS;
    else process.env.CEZ_REMOTE_EXTENSIONS = prevRemoteExtensions;
  });

  const post = (path: string, body: unknown = {}) => apiRequest(app, path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  it('refuses install, update, uninstall, enable and invocation with 409', async () => {
    process.env.CEZ_REMOTE = '1';
    const responses = await Promise.all([
      post('/api/v1/extensions/prepare-install', { source: './probe-ext' }),
      post('/api/v1/extensions/commit-install', { preparedId: 'x' }),
      post('/api/v1/extensions/probe/prepare-update'),
      apiRequest(app, '/api/v1/extensions/probe', { method: 'DELETE' }),
      post('/api/v1/extensions/probe/enable', {}),
      post('/api/v1/extensions/probe/disable', {}),
      post('/api/v1/extensions/probe/commands/run/invoke', {}),
      apiRequest(app, '/api/v1/extensions/probe/panels/main'),
      apiRequest(app, '/api/v1/extensions/probe/forms'),
    ]);
    expect(responses.map(r => r.status)).toEqual(Array(responses.length).fill(409));
  });

  it('still answers the read-only listing in hosted mode', async () => {
    process.env.CEZ_REMOTE = '1';
    expect((await apiRequest(app, '/api/v1/extensions')).status).toBe(200);
    const access = await apiRequest(app, '/api/v1/extensions/access');
    expect(access.status).toBe(200);
    expect(await access.json()).toEqual({ extensions: [] });
  });

  it('hides saved project inventory when hosted, including when extensions are also disabled', async () => {
    const directory = join(repoRoot,'.ai/cezar/extensions'); mkdirSync(directory,{recursive:true});
    writeFileSync(join(directory,'registry.json'),JSON.stringify([{source:'/private/software',installedAt:'now',enabled:false,manifest:{id:'saved.test',name:'Private saved provider',version:'1.0.0',apiVersion:'0.1',entry:'index.mjs',capabilities:[]}}]));
    process.env.CEZ_REMOTE = '1';
    const previous = process.env.CEZ_EXTENSIONS;
    try {
      for (const flag of [undefined,'0']) {
        if(flag === undefined) delete process.env.CEZ_EXTENSIONS; else process.env.CEZ_EXTENSIONS=flag;
        const response=await apiRequest(app,'/api/v1/extensions/inventory');
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({extensions:[]});
      }
    } finally { if(previous === undefined) delete process.env.CEZ_EXTENSIONS; else process.env.CEZ_EXTENSIONS=previous; }
  });

  it('trims absolute local-folder sources from the hosted global listing', async () => {
    const directory = join(process.env.CEZ_HOME!, 'extensions'); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'registry.json'), JSON.stringify([{ source: '/srv/private/secret-extension', installedAt: 'now', enabled: false, manifest: { id: 'saved.test', name: 'Saved', version: '1.0.0', apiVersion: '0.1', entry: 'index.mjs', capabilities: [] } }]));
    process.env.CEZ_REMOTE = '1';
    process.env.CEZ_REMOTE_EXTENSIONS = '1';
    const response = await apiRequest(app, '/api/v1/extensions');
    expect(response.status).toBe(200);
    expect((await response.json() as { extensions: Array<{ source: string }> }).extensions[0]?.source).toBe('secret-extension');
  });

  describe('with CEZ_REMOTE_EXTENSIONS=1, folder sources are confined to the browse root', () => {
    let root: string;
    const prevBrowse = process.env.CEZ_BROWSE_ROOT;
    const manifest = (id: string) => JSON.stringify({ id, name: id, version: '1.0.0', apiVersion: '0.1', entry: 'index.mjs', capabilities: [] });
    const extension = (dir: string, id: string) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'cezar-extension.json'), manifest(id));
      writeFileSync(join(dir, 'index.mjs'), 'export function activate() {}');
    };
    const prepare = async (source: string) => {
      const res = await post('/api/v1/extensions/prepare-install', { source });
      return { status: res.status, body: await res.json() as { error?: string; preparedId?: string } };
    };
    const outside = { status: 400, body: { error: 'local extension folders must be inside the hosted browse root' } };
    beforeEach(() => {
      root = join(repoRoot, 'plugins');
      extension(join(root, 'inside'), 'inside.test');
      extension(join(repoRoot, 'plugins-other', 'sibling'), 'sibling.test');
      extension(join(repoRoot, 'outside'), 'outside.test');
      process.env.CEZ_BROWSE_ROOT = root;
      process.env.CEZ_REMOTE = '1';
      process.env.CEZ_REMOTE_EXTENSIONS = '1';
    });
    afterEach(() => { if (prevBrowse === undefined) delete process.env.CEZ_BROWSE_ROOT; else process.env.CEZ_BROWSE_ROOT = prevBrowse; });

    it('stages a folder inside the root', async () => {
      const inside = await prepare(join(root, 'inside'));
      expect(inside.status).toBe(200);
      expect(inside.body.preparedId).toEqual(expect.any(String));
    });

    it('refuses a folder outside, a same-prefix sibling and a symlink out of the root', async () => {
      symlinkSync(join(repoRoot, 'outside'), join(root, 'escape'));
      expect(await prepare(join(repoRoot, 'outside'))).toEqual(outside);
      expect(await prepare(join(repoRoot, 'plugins-other', 'sibling'))).toEqual(outside);
      expect(await prepare(join(root, 'escape'))).toEqual(outside);
      expect(await prepare(join(root, 'inside', '..', '..', 'outside'))).toEqual(outside);
    });

    it('refuses a package that links out of the root', async () => {
      symlinkSync(join(repoRoot, 'outside', 'index.mjs'), join(root, 'inside', 'leak.mjs'));
      const res = await prepare(join(root, 'inside'));
      expect(res.status).toBe(400);
      expect(res.body.preparedId).toBeUndefined();
    });

    it('refuses everything when the browse root is missing', async () => {
      process.env.CEZ_BROWSE_ROOT = join(repoRoot, 'gone');
      expect(await prepare(join(repoRoot, 'gone', 'inside'))).toEqual(outside);
      expect(await prepare(join(root, 'inside'))).toEqual(outside);
    });

    it('asks for an absolute path, and says when an in-root folder does not exist', async () => {
      expect(await prepare('./inside')).toEqual({ status: 400, body: { error: 'use an absolute folder path inside the hosted browse root' } });
      expect(await prepare(join(root, 'nope'))).toEqual({ status: 400, body: { error: 'extension folder does not exist' } });
    });

    it('confines an update to the browse root too: a saved out-of-root source is never re-read', async () => {
      const directory = join(process.env.CEZ_HOME!, 'extensions'); mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'registry.json'), JSON.stringify([{ source: join(repoRoot, 'outside'), installedAt: 'now', enabled: false, manifest: JSON.parse(manifest('outside.test')) }]));
      const res = await post('/api/v1/extensions/outside.test/prepare-update');
      expect({ status: res.status, body: await res.json() }).toEqual(outside);
    });

    it('never discloses an absolute out-of-root path in the global or project inventory', async () => {
      const record = { source: '/srv/private/secret-extension', installedAt: 'now', enabled: false, manifest: JSON.parse(manifest('saved.test')) };
      const home = join(process.env.CEZ_HOME!, 'extensions'); mkdirSync(home, { recursive: true });
      writeFileSync(join(home, 'registry.json'), JSON.stringify([record]));
      const project = join(repoRoot, '.ai/cezar/extensions'); mkdirSync(project, { recursive: true });
      writeFileSync(join(project, 'registry.json'), JSON.stringify([record]));
      for (const path of ['/api/v1/extensions', '/api/v1/extensions/inventory']) {
        const res = await apiRequest(app, path);
        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).toContain('secret-extension');
        expect(body).not.toContain('/srv/private');
      }
    });
  });

  it('keeps the uninstall impact, which names every project, off a hosted cockpit', async () => {
    process.env.CEZ_REMOTE = '1';
    const res = await apiRequest(app, '/api/v1/extensions/probe/uninstall-impact');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: expect.stringContaining('hosted') });
  });

  it('lets a local cockpit reach the installer', async () => {
    const res = await post('/api/v1/extensions/prepare-install', { source: './probe-ext' });
    expect(res.status).not.toBe(409);
  });
});

describe('extension forms and panels on a failed worker', () => {
  it('answer a contract-shaped 400, never a 500', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-ext-failed-'));
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    const ext = join(root, 'dying');
    mkdirSync(ext);
    writeFileSync(join(ext, 'cezar-extension.json'), JSON.stringify({
      id: 'dying.test', name: 'Dying', version: '1.0.0', apiVersion: '0.1', entry: 'index.mjs',
      capabilities: ['commands', 'panels', 'forms'],
      contributes: { commands: [{ id: 'die', label: 'Die' }], panels: [{ id: 'main', title: 'Main' }], forms: [{ id: 'settings', title: 'Settings', commandId: 'die', fields: [] }] },
    }));
    writeFileSync(join(ext, 'index.mjs'), `export function activate(c) { c.commands.register('die', () => { process.exit(5) }) }`);
    const runs = RunStore.open(join(root, '.ai/cezar'));
    const server = createApp({ repoRoot: root, store: runs, manager: {} as RunManager, version: '0.0.0-test' });
    const send = (path: string, body: unknown = {}) => apiRequest(server, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    try {
      const prepared = await (await send('/api/v1/extensions/prepare-install', { source: ext })).json() as { preparedId: string };
      const installed = await (await send('/api/v1/extensions/commit-install', { preparedId: prepared.preparedId })).json() as { integrity: string };
      expect((await send('/api/v1/extensions/dying.test/enable', { integrity: installed.integrity })).status).toBe(200);
      expect((await apiRequest(server, '/api/v1/extensions/dying.test/forms')).status).toBe(200);
      expect((await send('/api/v1/extensions/dying.test/commands/die/invoke')).status).toBe(400);
      for (const path of ['/api/v1/extensions/dying.test/forms', '/api/v1/extensions/dying.test/panels/main']) {
        const res = await apiRequest(server, path);
        expect(res.status).toBe(400);
        expect(Object.keys(await res.json() as object)).toEqual(['error']);
      }
    } finally {
      await apiRequest(server, '/api/v1/extensions/dying.test', { method: 'DELETE' });
      runs.flush(); rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('CEZ_EXTENSIONS=0', () => {
  it('turns extension execution off on a local cockpit, keeping the listing readable', async () => {
    const { extensionsUnavailableReason } = await import('./extensions.ts');
    expect(extensionsUnavailableReason({ CEZ_EXTENSIONS: '0' }, true)).toMatch(/CEZ_EXTENSIONS=0/);
    expect(extensionsUnavailableReason({}, false)).toMatch(/hosted/);
    expect(extensionsUnavailableReason({}, true)).toBeUndefined();
  });
});

describe('extension chat routes', () => {
  it('answer a malformed extension id with 400, not a provider outage', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-ext-chat-'));
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    const runs = RunStore.open(join(root, '.ai/cezar'));
    const server = createApp({ repoRoot: root, store: runs, manager: {} as RunManager, version: '0.0.0-test' });
    try {
      const res = await apiRequest(server, '/api/v1/extensions/BAD!/chat/x');
      expect(res.status).toBe(400);
    } finally { runs.flush(); rmSync(root, { recursive: true, force: true }); }
  });
});
