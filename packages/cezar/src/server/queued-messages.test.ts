import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderAuthService } from '../core/provider-auth.ts';
import { RunStore, type QueuedMessage, type RunRecord } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';
import { createApp } from './server.ts';

/**
 * #472 — the queued prompt stack over HTTP: the three-rung delivery ladder on
 * `POST /api/v1/runs/:id/messages`, the edit/remove routes, the `task` field on
 * `PATCH /api/v1/runs/:id`, and the bounds (per-message, per-stack, and the folded
 * total that actually matters).
 *
 * The manager is faked so each rung can be selected deterministically — the real
 * engine's queued/starting/live states are covered in `workflows/run.test.ts`.
 */
describe('queued prompt stack routes (#472)', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let manager: RunManager;
  let record: RunRecord;
  /** Which rung the fake engine answers on. */
  let rung: 'live' | 'queued' | 'starting' | 'closed';

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-472-routes-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    record = store.createRun({ title: 't', workflow: '(planned)', task: 'the task', steps: [] });
    // The record's own status now gates the early bounds checks (a finished run gets 409
    // rather than a bounds 400), so the fixture must look queued as well as answer on that rung.
    store.updateRun(record.id, { status: 'queued' });
    rung = 'queued';

    manager = {
      sendMessage: () => rung === 'live',
      enqueueMessage: (id: string, content: Array<{ type: string; text?: string }>): QueuedMessage | null => {
        if (rung !== 'queued') return null;
        const message: QueuedMessage = {
          id: `msg-${(store.getRun(id)?.queuedMessages?.length ?? 0) + 1}`,
          text: content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n'),
          createdAt: '2026-07-21T10:00:00.000Z',
        };
        store.updateRun(id, { queuedMessages: [...(store.getRun(id)?.queuedMessages ?? []), message] });
        return message;
      },
      editQueuedMessage: (id: string, msgId: string, edit: { text?: string; images?: Array<{ type: string }> }) => {
        if (rung !== 'queued') return null;
        const stack = store.getRun(id)?.queuedMessages ?? [];
        const at = stack.findIndex((m) => m.id === msgId);
        if (at < 0) return null;
        const next = [...stack];
        next[at] = {
          ...stack[at]!,
          ...(edit.text !== undefined ? { text: edit.text } : {}),
          ...(edit.images !== undefined ? { images: [] } : {}),
        };
        store.updateRun(id, { queuedMessages: next });
        return next[at]!;
      },
      removeQueuedMessage: (id: string, msgId: string) => {
        if (rung !== 'queued') return false;
        const stack = store.getRun(id)?.queuedMessages ?? [];
        if (!stack.some((m) => m.id === msgId)) return false;
        store.updateRun(id, { queuedMessages: stack.filter((m) => m.id !== msgId) });
        return true;
      },
      editTask: (id: string, task: string) => {
        if (rung !== 'queued') return false;
        store.updateRun(id, { task });
        return true;
      },
      deferMessage: () => rung === 'starting',
    } as unknown as RunManager;

    app = createApp({
      repoRoot,
      store,
      manager,
      version: '0.0.0-test',
      providerAuth: connectedProviderAuth(),
    });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const send = (path: string, method: string, body?: unknown) =>
    apiRequest(app, path, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const post = (body: unknown) => send(`/api/v1/runs/${record.id}/messages`, 'POST', body);
  const seed = (...texts: string[]) =>
    store.updateRun(record.id, {
      queuedMessages: texts.map((text, i) => ({ id: `msg-${i + 1}`, text, createdAt: '2026-07-21T10:00:00.000Z' })),
    });

  // ---- the three-rung ladder ------------------------------------------------

  /** The no-regression assertion: a live session answers exactly as before. */
  it('still answers { delivered: true } for a running run', async () => {
    rung = 'live';
    const res = await post({ text: 'hello' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ delivered: true });
    expect(store.getRun(record.id)?.queuedMessages).toBeUndefined();
  });

  it('appends to the stack and answers { queued: true } for a queued run', async () => {
    const res = await post({ text: 'stack me' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { queued: boolean; message: QueuedMessage };
    expect(body.queued).toBe(true);
    expect(body.message.text).toBe('stack me');
    expect(store.getRun(record.id)?.queuedMessages?.map((m) => m.text)).toEqual(['stack me']);
  });

  it('does not probe or require provider credentials to amend a queued prompt', async () => {
    const status = vi.fn(() => Promise.reject(new Error('provider status must not be read')));
    app = createApp({
      repoRoot,
      store,
      manager,
      version: '0.0.0-test',
      providerAuth: { status } as unknown as ProviderAuthService,
    });

    const res = await post({ text: 'keep this queued Codex task moving' });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ queued: true });
    expect(status).not.toHaveBeenCalled();
  });

  /** The rung that exists so a message in the dequeue → session-open gap is
   *  buffered rather than dropped — the exact failure this feature prevents. */
  it('buffers with { deferred: true } while the run is starting up', async () => {
    rung = 'starting';
    const res = await post({ text: 'mid-spawn' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deferred: true });
  });

  it('still 409s for a genuinely closed run', async () => {
    rung = 'closed';
    const res = await post({ text: 'too late' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'session closed' });
  });

  /**
   * Review fix: the bounds describe a message about to be STACKED, so they must not answer
   * for a run that can no longer stack anything. An over-long message posted to a finished
   * run gets the truthful `409 session closed`, not `400 prompt too long`.
   */
  it('answers 409, not a bounds 400, when an over-long message hits a finished run', async () => {
    // Individually legal (the per-message zod bound is 100k and rejects earlier), but it
    // would overflow the FOLDED total — which is the bound the gate now skips for a run
    // that can no longer stack anything.
    seed('x'.repeat(100_000), 'y'.repeat(99_000));
    const overflowing = { text: 'z'.repeat(2_000) };

    // Same body while queued: rejected by the folded bound, proving the input really is
    // over-long and the two cases differ only by status.
    expect((await post(overflowing)).status).toBe(400);

    store.updateRun(record.id, { status: 'done' });
    rung = 'closed';
    const res = await post(overflowing);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'session closed' });
  });

  it('404s for an unknown run', async () => {
    const res = await send('/api/v1/runs/nope/messages', 'POST', { text: 'hi' });
    expect(res.status).toBe(404);
  });

  // ---- bounds ---------------------------------------------------------------

  it('rejects a 21st stacked message with a named 400', async () => {
    seed(...Array.from({ length: 20 }, (_, i) => `m${i}`));
    const res = await post({ text: 'one too many' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('20 message limit');
  });

  it('rejects an over-cap image count across the stack', async () => {
    store.updateRun(record.id, {
      queuedMessages: [
        { id: 'msg-1', text: 'with images', images: Array.from({ length: 7 }, (_, i) => `/i/${i}.png`), createdAt: 'x' },
      ],
    });
    const res = await post({
      text: 'two more',
      images: [
        { mediaType: 'image/png', data: 'aaaa' },
        { mediaType: 'image/png', data: 'bbbb' },
      ],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('8 attachment limit');
  });

  /**
   * The bound that actually matters: each message is individually legal, but the
   * composition is not. Rejected at the write, where there is still someone to
   * tell — not at dequeue.
   */
  it('rejects an append that individually fits but overflows the folded total', async () => {
    seed('x'.repeat(100_000), 'y'.repeat(99_000));
    const res = await post({ text: 'z'.repeat(2_000) });
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain('200000 character limit');
    // …and reports the total it would have reached.
    expect(error).toMatch(/would be \d+/);
    // The rejected message was never written.
    expect(store.getRun(record.id)?.queuedMessages).toHaveLength(2);
  });

  /** The bound is inclusive: landing exactly on 200 000 is allowed, one over is not. */
  it('accepts an append landing exactly on the folded bound, rejects one char more', async () => {
    // 'the task' is 8 chars; each join adds 2. Sizing the single stacked message
    // so that task + '\n\n' + stacked + '\n\n' + append == 200_000 exactly.
    const append = 'z'.repeat(1_000);
    const stacked = 200_000 - 8 - 2 - 2 - append.length;

    seed('x'.repeat(stacked));
    const ok = await post({ text: append });
    expect(ok.status).toBe(200);
    expect(store.getRun(record.id)?.queuedMessages).toHaveLength(2);

    // Reset to the same starting point, then overflow by exactly one character.
    seed('x'.repeat(stacked));
    const over = await post({ text: 'z'.repeat(append.length + 1) });
    expect(over.status).toBe(400);
    expect(((await over.json()) as { error: string }).error).toContain('would be 200001');
  });

  it('rejects a whitespace-only message with no images', async () => {
    const res = await post({ text: '   ' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('needs text or at least one attachment');
  });

  // ---- PATCH / DELETE a stacked message -------------------------------------

  const patchMsg = (msgId: string, body: unknown) =>
    send(`/api/v1/runs/${record.id}/queued-messages/${msgId}`, 'PATCH', body);
  const deleteMsg = (msgId: string) => send(`/api/v1/runs/${record.id}/queued-messages/${msgId}`, 'DELETE');

  it('edits a stacked message', async () => {
    seed('typo here');
    const res = await patchMsg('msg-1', { text: 'fixed now' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { message: QueuedMessage }).message.text).toBe('fixed now');
    expect(store.getRun(record.id)?.queuedMessages?.[0]?.text).toBe('fixed now');
  });

  it('preserves attached images when a PATCH only supplies text', async () => {
    store.updateRun(record.id, {
      queuedMessages: [{
        id: 'msg-1',
        text: 'typo',
        images: [`/api/v1/runs/${record.id}/images/pasted-1.png`],
        createdAt: '2026-07-21T10:00:00.000Z',
      }],
    });

    const res = await patchMsg('msg-1', { text: 'fixed' });

    expect(res.status).toBe(200);
    expect(store.getRun(record.id)?.queuedMessages?.[0]).toMatchObject({
      text: 'fixed',
      images: [`/api/v1/runs/${record.id}/images/pasted-1.png`],
    });
  });

  it('removes a stacked message', async () => {
    seed('remove me');
    const res = await deleteMsg('msg-1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: true });
    expect(store.getRun(record.id)?.queuedMessages).toEqual([]);
  });

  it('404s on an unknown message id', async () => {
    seed('one');
    expect((await patchMsg('nope', { text: 'x' })).status).toBe(404);
    expect((await deleteMsg('nope')).status).toBe(404);
  });

  it('404s on an unknown run', async () => {
    expect((await send('/api/v1/runs/nope/queued-messages/m1', 'PATCH', { text: 'x' })).status).toBe(404);
    expect((await send('/api/v1/runs/nope/queued-messages/m1', 'DELETE')).status).toBe(404);
  });

  it('409s once the run has started', async () => {
    seed('too late');
    rung = 'live';
    const patched = await patchMsg('msg-1', { text: 'x' });
    expect(patched.status).toBe(409);
    expect(await patched.json()).toEqual({ error: 'run already started' });

    const removed = await deleteMsg('msg-1');
    expect(removed.status).toBe(409);
    expect(await removed.json()).toEqual({ error: 'run already started' });
  });

  it('applies the folded bound to an edit too', async () => {
    seed('a', 'y'.repeat(150_000));
    const res = await patchMsg('msg-1', { text: 'x'.repeat(100_000) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('200000 character limit');
  });

  // ---- PATCH /api/v1/runs/:id { task } -----------------------------------------

  const patchRun = (body: unknown) => send(`/api/v1/runs/${record.id}`, 'PATCH', body);

  it('edits the initial prompt while queued', async () => {
    const res = await patchRun({ task: 'a better prompt' });
    expect(res.status).toBe(200);
    expect(store.getRun(record.id)?.task).toBe('a better prompt');
  });

  it('409s on a task edit once the run has started', async () => {
    rung = 'live';
    const res = await patchRun({ task: 'too late' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'run already started' });
    expect(store.getRun(record.id)?.task).toBe('the task');
  });

  /** No regression to #389: renaming keeps working on any status. */
  it('still renames a started run', async () => {
    rung = 'live';
    const res = await patchRun({ title: 'a new title' });
    expect(res.status).toBe(200);
    expect(store.getRun(record.id)?.titleSummary).toBe('a new title');
  });

  /** A rejected prompt edit must not half-apply the title alongside it. */
  it('leaves the title untouched when the task edit is rejected', async () => {
    rung = 'live';
    const res = await patchRun({ task: 'too late', title: 'sneaky rename' });
    expect(res.status).toBe(409);
    expect(store.getRun(record.id)?.titleSummary).toBeUndefined();
  });

  it('rejects an empty task', async () => {
    expect((await patchRun({ task: '   ' })).status).toBe(400);
  });
});
