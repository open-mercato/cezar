import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.js';
import type { RunManager } from '../workflows/run.js';
import { createApp, type ServerDeps } from './server.js';
import { apiRequest } from './loopback-request.testkit.js';

/**
 * The global follow-up inbox is opt-in (#471): `CEZ_FOLLOWUPS=1` turns it on,
 * off is the default. Off, the reader degrades to an empty inbox (never a 404
 * — the feature is switched off, not missing), the mutators 409 as defense in
 * depth, and a run can never be told to write todos.json.
 *
 * The per-task handoff journal is a separate feature and is asserted here to
 * stay on, because issue #471 keeps it explicitly.
 */

const TODO = {
  id: 'todo-1',
  ts: '2026-07-17T00:00:00.000Z',
  summary: 'a leftover follow-up',
  runnable: false,
};

describe('inbox gate (#471)', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  const savedFollowups = process.env.CEZ_FOLLOWUPS;
  const savedRemote = process.env.CEZ_REMOTE;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-inbox-'));
    dataDir = join(repoRoot, '.ai/cezar');
    store = RunStore.open(dataDir);
    mkdirSync(dataDir, { recursive: true });
    // A pre-existing entry: the gate must hide it, never delete it.
    writeFileSync(join(dataDir, 'todos.json'), JSON.stringify([TODO]), 'utf8');
    delete process.env.CEZ_FOLLOWUPS;
    delete process.env.CEZ_REMOTE;
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedFollowups === undefined) delete process.env.CEZ_FOLLOWUPS;
    else process.env.CEZ_FOLLOWUPS = savedFollowups;
    if (savedRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = savedRemote;
  });

  const app = (over: Partial<ServerDeps> = {}) =>
    createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', ...over });

  describe('off (the default)', () => {
    it('GET /api/todos serves an empty inbox instead of 404ing', async () => {
      const res = await apiRequest(app(), '/api/todos');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });

    it('DELETE /api/todos/:id 409s with a reason naming the flag', async () => {
      const res = await apiRequest(app(), `/api/todos/${TODO.id}`, { method: 'DELETE' });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('CEZ_FOLLOWUPS');
    });

    it('POST /api/todos/:id/start 409s rather than spawning a run', async () => {
      const res = await apiRequest(app(), `/api/todos/${TODO.id}/start`, { method: 'POST' });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('CEZ_FOLLOWUPS');
    });

    it('hides entries without destroying them — the file is untouched', async () => {
      await apiRequest(app(), '/api/todos');
      await apiRequest(app(), `/api/todos/${TODO.id}`, { method: 'DELETE' });
      // Flipping the flag back on brings the same entry back.
      process.env.CEZ_FOLLOWUPS = '1';
      const res = await apiRequest(app(), '/api/todos');
      expect(await res.json()).toEqual([TODO]);
    });
  });

  describe('on (CEZ_FOLLOWUPS=1)', () => {
    beforeEach(() => {
      process.env.CEZ_FOLLOWUPS = '1';
    });

    it('GET /api/todos serves the real entries', async () => {
      const res = await apiRequest(app(), '/api/todos');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([TODO]);
    });

    it('DELETE /api/todos/:id checks the entry off', async () => {
      const res = await apiRequest(app(), `/api/todos/${TODO.id}`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ removed: true });
      expect(await (await apiRequest(app(), '/api/todos')).json()).toEqual([]);
    });

    it('DELETE of an unknown id still 404s — the gate is not swallowing it', async () => {
      const res = await apiRequest(app(), '/api/todos/nope', { method: 'DELETE' });
      expect(res.status).toBe(404);
    });
  });
});
