import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  draftSurfaceSchema,
  setRunDraftInputSchema,
  type DraftEntry,
  type DraftImage,
  type RunDraftsResponse,
} from '@open-mercato/cezar-contract';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { draftsRoot } from '../runs/drafts.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

/**
 * The in-task draft routes (#939) through the real Hono app.
 *
 * What is pinned here is the boundary the store cannot enforce on its own: an unknown run is a
 * 404 on EVERY verb (a draft must not outlive its task through this surface), an unknown surface
 * is a 400 from the param validator rather than a path segment the handler concatenates, and the
 * empty-PUT-is-a-delete rule holds for any client, not just a polite cockpit.
 */
/** The schemas on their own — the surface vocabulary and the caps, before any route sees them.
 *  `packages/contract` is not a vitest project, so its schemas are exercised from here. */
describe('contract/drafts.ts schemas', () => {
  it('accepts the surface vocabulary and refuses anything else', () => {
    for (const ok of ['composer', 'review-notes', 'task-prompt', 'title', 'message:abc_1-2']) {
      expect(draftSurfaceSchema.safeParse(ok).success).toBe(true);
    }
    for (const bad of ['../x', 'message:../x', 'composer/../..', 'Composer', '', 'message:']) {
      expect(draftSurfaceSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('defaults an omitted text/images to empty — an omitted body is an empty draft, not a 400', () => {
    expect(setRunDraftInputSchema.parse({})).toEqual({ text: '', images: [] });
  });

  it('rejects over-cap text and over-cap image counts', () => {
    expect(setRunDraftInputSchema.safeParse({ text: 'x'.repeat(100_001) }).success).toBe(false);
    expect(setRunDraftInputSchema.safeParse({ images: ['a', 'b', 'c', 'd', 'e'] }).success).toBe(false);
    expect(setRunDraftInputSchema.safeParse({ images: ['../x'] }).success).toBe(false);
  });
});

describe('/api/v1/runs/:id/drafts', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let run: RunRecord;

  const png = 'iVBORw0KGgoAAAANSUhEUg==';

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-drafts-api-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({
      repoRoot,
      store,
      manager: { isActive: () => false } as unknown as RunManager,
      version: '0.0.0-test',
    });
    run = store.createRun({ title: 'a task', workflow: 'quick-task', task: 'a task', steps: [] });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const json = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const drafts = (id = run.id) => apiRequest(app, `/api/v1/runs/${id}/drafts`);
  const put = (surface: string, body: unknown, id = run.id) =>
    apiRequest(app, `/api/v1/runs/${id}/drafts/${surface}`, json('PUT', body));

  it('answers an empty listing for a run that has never held a draft', async () => {
    const res = await drafts();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ surfaces: {} });
  });

  it('round-trips a composer draft', async () => {
    const written = await put('composer', { text: 'half a sentence' });
    expect(written.status).toBe(200);
    expect((await written.json() as DraftEntry).text).toBe('half a sentence');

    const listed = (await (await drafts()).json()) as RunDraftsResponse;
    expect(listed.surfaces.composer?.text).toBe('half a sentence');
  });

  it('accepts every surface in the vocabulary, including a per-message one', async () => {
    for (const surface of ['composer', 'review-notes', 'task-prompt', 'title', 'message:abc-123']) {
      expect((await put(surface, { text: `draft for ${surface}` })).status).toBe(200);
    }
    const listed = (await (await drafts()).json()) as RunDraftsResponse;
    expect(Object.keys(listed.surfaces).sort()).toEqual([
      'composer',
      'message:abc-123',
      'review-notes',
      'task-prompt',
      'title',
    ]);
  });

  it('rejects an unknown surface with a 400 — it is a path segment, not a free string', async () => {
    const res = await put('..%2F..%2Fetc', { text: 'x' });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain('surface');
  });

  it('an empty PUT deletes the entry', async () => {
    await put('composer', { text: 'typed' });
    const emptied = await put('composer', { text: '', images: [] });

    expect(emptied.status).toBe(200);
    expect(await (await drafts()).json()).toEqual({ surfaces: {} });
  });

  it('DELETE drops one surface and leaves the others', async () => {
    await put('composer', { text: 'a reply' });
    await put('review-notes', { text: 'some notes' });

    const res = await apiRequest(app, `/api/v1/runs/${run.id}/drafts/composer`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });

    const listed = (await (await drafts()).json()) as RunDraftsResponse;
    expect(Object.keys(listed.surfaces)).toEqual(['review-notes']);
  });

  it('rejects a body over the text cap', async () => {
    const res = await put('composer', { text: 'x'.repeat(100_001) });
    expect(res.status).toBe(400);
  });

  it('404s on every verb for a run that does not exist', async () => {
    expect((await drafts('no-such-run')).status).toBe(404);
    expect((await put('composer', { text: 'x' }, 'no-such-run')).status).toBe(404);
    expect(
      (await apiRequest(app, '/api/v1/runs/no-such-run/drafts/composer', { method: 'DELETE' })).status,
    ).toBe(404);
    expect(
      (
        await apiRequest(
          app,
          '/api/v1/runs/no-such-run/drafts/composer/images',
          json('POST', { mediaType: 'image/png', data: png }),
        )
      ).status,
    ).toBe(404);
  });

  it('deleting the run deletes its drafts — an unreachable draft is not kept', async () => {
    await put('composer', { text: 'never sent' });
    expect(existsSync(join(repoRoot, '.ai/cezar', 'drafts', run.id))).toBe(true);

    const res = await apiRequest(app, `/api/v1/runs/${run.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(existsSync(join(draftsRoot(join(repoRoot, '.ai/cezar')), run.id))).toBe(false);
  });

  describe('attachments', () => {
    const upload = (surface = 'composer', body: unknown = { mediaType: 'image/png', data: png, name: 'shot.png' }) =>
      apiRequest(app, `/api/v1/runs/${run.id}/drafts/${surface}/images`, json('POST', body));

    it('uploads on attach, then references the id from the draft', async () => {
      const stored = (await (await upload()).json()) as DraftImage;
      expect(stored.id).toMatch(/^[a-f0-9]+$/);

      const written = (await (await put('composer', { text: 'see this', images: [stored.id] })).json()) as DraftEntry;
      expect(written.images).toEqual([stored]);

      const blob = await apiRequest(
        app,
        `/api/v1/runs/${run.id}/drafts/composer/images/${stored.id}`,
      );
      expect(blob.status).toBe(200);
      expect(await blob.json()).toEqual({ ...stored, data: png });
    });

    it('refuses a PUT naming an image the server never stored', async () => {
      const res = await put('composer', { text: 'x', images: ['deadbeef'] });
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toContain('unknown image');
    });

    it('re-validates the per-surface cap, so a non-cockpit client cannot exceed it', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 4; i += 1) ids.push(((await (await upload()).json()) as DraftImage).id);
      await put('composer', { text: 'four', images: ids });

      const fifth = await upload();
      expect(fifth.status).toBe(400);
      expect((await fifth.json() as { error: string }).error).toContain('4 images');
    });

    it('rejects a traversal-shaped image id at the param validator', async () => {
      const res = await apiRequest(app, `/api/v1/runs/${run.id}/drafts/composer/images/..%2F..%2Fx`);
      expect(res.status).toBe(400);
    });

    it('DELETEs one blob and drops it from the draft that named it', async () => {
      const stored = (await (await upload()).json()) as DraftImage;
      await put('composer', { text: 'with an image', images: [stored.id] });

      const res = await apiRequest(app, `/api/v1/runs/${run.id}/drafts/composer/images/${stored.id}`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);

      const listed = (await (await drafts()).json()) as RunDraftsResponse;
      expect(listed.surfaces.composer?.images).toEqual([]);
      expect(listed.surfaces.composer?.text).toBe('with an image');
    });

    it('404s for a blob that was never stored', async () => {
      const res = await apiRequest(app, `/api/v1/runs/${run.id}/drafts/composer/images/deadbeef`);
      expect(res.status).toBe(404);
    });
  });
});
