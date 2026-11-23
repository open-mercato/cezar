import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  runTagsResponseSchema,
  taskTagResponseSchema,
  taskTagsListSchema,
} from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager, StartRunInput } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import { loadTaskTags } from '../workspace/task-tags.ts';
import { clearProjectProbeCache, registerProject } from '../workspace/projects.ts';
import { automationTaskSchema } from '../automations/types.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';
import { createApp } from './server.ts';

/** Task tags over HTTP (spec 2026-11-23-task-tags § 5). */
describe('task tags API', () => {
  const savedHome = process.env.CEZ_HOME;
  let home: string;
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let started: StartRunInput[];

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-tags-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-tags-repo-'));
    process.env.CEZ_HOME = home;
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    started = [];
    const manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) => {
        started.push(input);
        return store.createRun({ title: 't', workflow: '(planned)', task: input.task, tags: input.tags, steps: [] });
      },
    } as unknown as RunManager;
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test', providerAuth: connectedProviderAuth() });
  });

  afterEach(() => {
    store.flush();
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
  });

  const send = async (method: string, path: string, body?: unknown) => {
    const res = await apiRequest(app, path, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  const createTag = async (body: Record<string, unknown>) => {
    const res = await send('POST', '/api/v1/workspace/task-tags', body);
    expect(res.status).toBe(201);
    return taskTagResponseSchema.parse(res.body).tag;
  };

  it('creates, lists, renames, promotes and deletes a tag', async () => {
    const tag = await createTag({ name: 'review batch', color: 'blue', projectId: 'default' });
    expect(tag.projectId).toBeDefined();

    const listed = taskTagsListSchema.parse((await send('GET', '/api/v1/workspace/task-tags')).body);
    expect(listed.tags.map((t) => t.name)).toEqual(['review batch']);

    const renamed = await send('PATCH', `/api/v1/workspace/task-tags/${tag.id}`, { name: 'Batch 2', color: null });
    expect(renamed.status).toBe(200);
    const renamedTag = taskTagResponseSchema.parse(renamed.body).tag;
    expect(renamedTag.name).toBe('Batch 2');
    expect(renamedTag.color).toBeUndefined();

    const promoted = taskTagResponseSchema.parse((await send('PATCH', `/api/v1/workspace/task-tags/${tag.id}`, { global: true })).body).tag;
    expect(promoted.projectId).toBeUndefined();

    expect((await send('DELETE', `/api/v1/workspace/task-tags/${tag.id}`)).body).toEqual({ deleted: true });
    expect((await send('DELETE', `/api/v1/workspace/task-tags/${tag.id}`)).status).toBe(200);
    const after = taskTagsListSchema.parse((await send('GET', '/api/v1/workspace/task-tags')).body);
    expect(after).toEqual({ tags: [], deletedIds: [tag.id] });
    expect((await send('PATCH', `/api/v1/workspace/task-tags/${tag.id}`, { name: 'x' })).status).toBe(404);
  });

  it('refuses a duplicate name case-insensitively, and an unknown project', async () => {
    await createTag({ name: 'API' });
    expect((await send('POST', '/api/v1/workspace/task-tags', { name: 'api', projectId: 'default' })).status).toBe(409);
    expect((await send('POST', '/api/v1/workspace/task-tags', { name: 'other', projectId: 'no-such-project' })).status).toBe(404);
    expect((await send('POST', '/api/v1/workspace/task-tags', { name: '   ' })).status).toBe(400);
    expect((await send('PATCH', '/api/v1/workspace/task-tags/tt-abcdefgh12', {})).status).toBe(400);
  });

  describe('POST /runs/:id/tags', () => {
    it('adds by name (creating a project tag), by id, and removes', async () => {
      const run = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [] });
      const first = await send('POST', `/api/v1/runs/${run.id}/tags`, { add: [{ name: 'batch' }] });
      expect(first.status).toBe(200);
      const [tag] = runTagsResponseSchema.parse(first.body).tags;
      expect(tag?.name).toBe('batch');
      expect((await loadTaskTags()).tags[0]?.projectRoot).toBe(realpathSync(repoRoot));

      const global = await createTag({ name: 'global one' });
      const second = runTagsResponseSchema.parse((await send('POST', `/api/v1/runs/${run.id}/tags`, { add: [{ id: global.id }] })).body);
      expect(second.tags.map((t) => t.name)).toEqual(['batch', 'global one']);
      expect(store.getRun(run.id)?.tags?.map((t) => t.id)).toEqual([tag!.id, global.id]);

      const removed = runTagsResponseSchema.parse((await send('POST', `/api/v1/runs/${run.id}/tags`, { remove: [tag!.id, 'tt-notonrun00'] })).body);
      expect(removed.tags.map((t) => t.id)).toEqual([global.id]);
      await send('POST', `/api/v1/runs/${run.id}/tags`, { remove: [global.id] });
      expect(store.getRun(run.id)?.tags).toBeUndefined();
    });

    it('works on an archived run and on a running run', async () => {
      const archived = store.createRun({ title: 'a', workflow: 'w', task: 't', steps: [] });
      store.updateRun(archived.id, { status: 'done', archived: true });
      const running = store.createRun({ title: 'r', workflow: 'w', task: 't', steps: [] });
      store.updateRun(running.id, { status: 'running' });
      for (const id of [archived.id, running.id]) {
        const res = await send('POST', `/api/v1/runs/${id}/tags`, { add: [{ name: 'x' }] });
        expect(res.status).toBe(200);
      }
      expect(store.getRun(running.id)?.status).toBe('running');
    });

    it('refuses a deleted id, an empty delta, and an unknown run', async () => {
      const run = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [] });
      const tag = await createTag({ name: 'gone' });
      await send('DELETE', `/api/v1/workspace/task-tags/${tag.id}`);
      expect((await send('POST', `/api/v1/runs/${run.id}/tags`, { add: [{ id: tag.id }] })).status).toBe(400);
      expect((await send('POST', `/api/v1/runs/${run.id}/tags`, {})).status).toBe(400);
      expect((await send('POST', '/api/v1/runs/nope/tags', { add: [{ name: 'x' }] })).status).toBe(404);
    });

    it('refuses an eleventh tag and changes nothing', async () => {
      const run = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [] });
      await send('POST', `/api/v1/runs/${run.id}/tags`, { add: Array.from({ length: 10 }, (_, i) => ({ name: `t${i}` })) });
      expect(store.getRun(run.id)?.tags).toHaveLength(10);
      const res = await send('POST', `/api/v1/runs/${run.id}/tags`, { add: [{ name: 'eleven' }] });
      expect(res.status).toBe(400);
      expect(store.getRun(run.id)?.tags).toHaveLength(10);
    });

    // D8's regression test: each delta reads the run AFTER its own await, so two concurrent adds
    // both land. A handler that read `run.tags` before resolving (or replaced the list) loses one.
    it('composes two concurrent adds', async () => {
      const run = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [] });
      const [a, b] = await Promise.all([
        send('POST', `/api/v1/runs/${run.id}/tags`, { add: [{ name: 'alpha' }] }),
        send('POST', `/api/v1/runs/${run.id}/tags`, { add: [{ name: 'beta' }] }),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(store.getRun(run.id)?.tags?.map((t) => t.name).sort()).toEqual(['alpha', 'beta']);
    });
  });

  describe('POST /runs with tags', () => {
    const base = { task: 'do it', steps: [{ id: 'work', prompt: '{{task}}' }] };

    it('resolves the refs and stores them on the run', async () => {
      const res = await send('POST', '/api/v1/runs', { ...base, tags: [{ name: 'batch' }] });
      expect(res.status).toBe(201);
      expect(started[0]?.tags?.map((t) => t.name)).toEqual(['batch']);
      expect((res.body as { tags?: unknown[] }).tags).toHaveLength(1);
    });

    it('creates no run for a bad ref', async () => {
      const res = await send('POST', '/api/v1/runs', { ...base, tags: [{ id: 'tt-doesnotexist' }] });
      expect(res.status).toBe(400);
      expect(started).toHaveLength(0);
      expect(store.listRuns()).toHaveLength(0);
    });
  });

  it('serves the run tags on the workspace runs index', async () => {
    clearProjectProbeCache();
    await registerProject(repoRoot);
    const run = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [] });
    await send('POST', `/api/v1/runs/${run.id}/tags`, { add: [{ name: 'indexed' }] });
    const index = (await send('GET', '/api/v1/workspace/runs-index')).body as { runs: Array<{ id: string; tags?: Array<{ name: string }> }> };
    expect(index.runs.find((r) => r.id === run.id)?.tags?.map((t) => t.name)).toEqual(['indexed']);
  });

  it('an automation task carrying tags is refused', () => {
    expect(automationTaskSchema.safeParse({ prompt: 'x' }).success).toBe(true);
    expect(automationTaskSchema.safeParse({ prompt: 'x', tags: [{ name: 'batch' }] }).success).toBe(false);
  });
});
