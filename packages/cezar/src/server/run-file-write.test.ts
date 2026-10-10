import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { fileHash } from './git-changes.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/**
 * `PUT /api/v1/runs/:id/files` and the fields the `GET` gained for it (spec
 * `.ai/specs/2026-07-20-worktree-file-editing.md`). What a path may be written is
 * `worktree-write.test.ts`'s business; this suite owns the route: the policy gate, the status
 * mapping, and the trace a save leaves in the run's event log.
 */
describe('saving a file from the Code view', () => {
  let repoRoot: string;
  let worktree: string;
  let store: RunStore;
  const saved = { CEZ_REMOTE: process.env.CEZ_REMOTE, CEZ_FILE_EDIT: process.env.CEZ_FILE_EDIT };

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-file-write-'));
    worktree = join(repoRoot, 'wt');
    mkdirSync(join(worktree, 'src'), { recursive: true });
    writeFileSync(join(worktree, 'src', 'a.ts'), 'export const a = 1\n');
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    delete process.env.CEZ_REMOTE;
    delete process.env.CEZ_FILE_EDIT;
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const app = () => createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
  const seedRun = () => {
    const run = store.createRun({ title: 't', workflow: 'quick-task', task: 'do a thing', steps: [] });
    store.updateRun(run.id, { worktreePath: worktree } as never);
    return run.id;
  };
  const onDisk = () => readFileSync(join(worktree, 'src', 'a.ts'), 'utf8');
  const baseHash = () => fileHash(readFileSync(join(worktree, 'src', 'a.ts')));
  const put = (runId: string, body: unknown, path = 'src/a.ts') =>
    apiRequest(app(), `/api/v1/runs/${runId}/files?path=${encodeURIComponent(path)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const edits = (runId: string) => store.readEvents(runId).filter((event) => event.type === 'file-edited');

  it('the GET reports the hash a save must echo, and whether the file is editable', async () => {
    const runId = seedRun();
    mkdirSync(join(worktree, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(worktree, 'node_modules', 'pkg', 'index.js'), 'x\n');

    const file = await (await apiRequest(app(), `/api/v1/runs/${runId}/files?path=src/a.ts`)).json();
    expect(file).toMatchObject({ type: 'file', editable: true, hash: baseHash() });
    expect(file).not.toHaveProperty('editableReason');

    const dep = await (await apiRequest(app(), `/api/v1/runs/${runId}/files?path=node_modules/pkg/index.js`)).json();
    expect(dep).toMatchObject({ editable: false, editableReason: 'installed dependencies are not editable' });
  });

  it('writes the file, answers the new hash, and records the edit without its content', async () => {
    const runId = seedRun();
    const base = baseHash();
    const res = await put(runId, { content: 'export const a = 2\n', baseHash: base });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: 'src/a.ts', size: 19, hash: baseHash() });
    expect(onDisk()).toBe('export const a = 2\n');

    const [event] = edits(runId);
    expect(event).toMatchObject({ type: 'file-edited', path: 'src/a.ts', baseHash: base, hash: baseHash(), size: 19 });
    expect(JSON.stringify(event)).not.toContain('export const');
  });

  it('answers 409 for a stale base, and neither writes nor records anything', async () => {
    const runId = seedRun();
    const stale = baseHash();
    writeFileSync(join(worktree, 'src', 'a.ts'), 'the agent got here first\n');
    const res = await put(runId, { content: 'mine\n', baseHash: stale });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toMatch(/changed on disk/);
    expect(onDisk()).toBe('the agent got here first\n');
    expect(edits(runId)).toEqual([]);
  });

  it('answers 400 for a body without baseHash, 404 for an unknown run, 409 for a refused target', async () => {
    const runId = seedRun();
    expect((await put(runId, { content: 'x' })).status).toBe(400);
    expect((await put('nope', { content: 'x', baseHash: baseHash() })).status).toBe(404);
    expect((await put(runId, { content: 'x', baseHash: 'sha256:0' }, '../escape.txt')).status).toBe(409);
    expect(onDisk()).toBe('export const a = 1\n');
  });

  // Written so it cannot pass for the wrong reason: the SAME request succeeds one line later.
  it('refuses on a hosted cockpit until CEZ_FILE_EDIT=1 opts it in', async () => {
    const runId = seedRun();
    const body = () => ({ content: 'export const a = 3\n', baseHash: baseHash() });

    process.env.CEZ_REMOTE = '1';
    const refused = await put(runId, body());
    expect(refused.status).toBe(409);
    expect((await refused.json() as { error: string }).error).toMatch(/hosted mode.*CEZ_FILE_EDIT=1/);
    expect(onDisk()).toBe('export const a = 1\n');

    process.env.CEZ_FILE_EDIT = '1';
    expect((await put(runId, body())).status).toBe(200);
    expect(onDisk()).toBe('export const a = 3\n');
  });

  const send = (method: string, url: string, body?: unknown) =>
    apiRequest(app(), url, {
      method,
      ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
  const eventsOf = (runId: string, type: string) => store.readEvents(runId).filter((event) => event.type === type);

  it('creates, renames and deletes a file, each leaving its own event', async () => {
    const runId = seedRun();
    const files = `/api/v1/runs/${runId}/files`;

    const created = await send('POST', `${files}?path=src/new.ts`, { content: 'export {}\n' });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ path: 'src/new.ts', size: 10 });
    expect(readFileSync(join(worktree, 'src', 'new.ts'), 'utf8')).toBe('export {}\n');
    expect(eventsOf(runId, 'file-created')).toMatchObject([{ path: 'src/new.ts', size: 10 }]);

    // Creating it again is a refusal, not an overwrite.
    expect((await send('POST', `${files}?path=src/new.ts`, { content: 'again' })).status).toBe(409);
    expect(readFileSync(join(worktree, 'src', 'new.ts'), 'utf8')).toBe('export {}\n');

    const renamed = await send('POST', `${files}/rename`, { from: 'src/new.ts', to: 'lib/renamed.ts' });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toEqual({ from: 'src/new.ts', to: 'lib/renamed.ts' });
    expect(existsSync(join(worktree, 'src', 'new.ts'))).toBe(false);
    expect(eventsOf(runId, 'file-renamed')).toMatchObject([{ from: 'src/new.ts', to: 'lib/renamed.ts' }]);

    const deleted = await send('DELETE', `${files}?path=lib/renamed.ts`);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ path: 'lib/renamed.ts' });
    expect(existsSync(join(worktree, 'lib', 'renamed.ts'))).toBe(false);
    expect(eventsOf(runId, 'file-deleted')).toMatchObject([{ path: 'lib/renamed.ts' }]);
  });

  it('refuses all three on a hosted cockpit, and a refused target leaves no event', async () => {
    const runId = seedRun();
    const files = `/api/v1/runs/${runId}/files`;
    expect((await send('POST', `${files}?path=node_modules/x.js`, { content: 'x' })).status).toBe(409);
    expect((await send('DELETE', `${files}?path=src`)).status).toBe(409);
    expect((await send('POST', `${files}/rename`, { from: 'src/a.ts', to: '.git/hooks/pre-commit' })).status).toBe(409);

    process.env.CEZ_REMOTE = '1';
    expect((await send('POST', `${files}?path=src/new.ts`, { content: 'x' })).status).toBe(409);
    expect((await send('DELETE', `${files}?path=src/a.ts`)).status).toBe(409);
    expect((await send('POST', `${files}/rename`, { from: 'src/a.ts', to: 'src/b.ts' })).status).toBe(409);

    expect(onDisk()).toBe('export const a = 1\n');
    expect(existsSync(join(worktree, 'src', 'new.ts'))).toBe(false);
    expect(store.readEvents(runId).filter((event) => event.type.startsWith('file-'))).toEqual([]);
  });

  it('CEZ_FILE_EDIT=0 turns it off on a local cockpit too, while reading stays open', async () => {
    const runId = seedRun();
    process.env.CEZ_FILE_EDIT = '0';
    const res = await put(runId, { content: 'x', baseHash: baseHash() });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe('file editing is disabled (CEZ_FILE_EDIT=0)');
    expect((await apiRequest(app(), `/api/v1/runs/${runId}/files?path=src/a.ts`)).status).toBe(200);
  });
});
