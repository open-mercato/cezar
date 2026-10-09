import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';
import { onRunDeleted, onRunEvent } from './sse-subscriptions.ts';

describe('shared SSE subscriptions (#1222)', () => {
  let root: string;
  let store: RunStore;
  let app: Hono;
  const bodies: ReadableStream<Uint8Array>[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-sse-subscriptions-'));
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(root, '.ai/cezar'));
    app = createApp({ repoRoot: root, store, manager: {} as RunManager, version: 'test' });
  });

  afterEach(async () => {
    await Promise.all(bodies.splice(0).map((body) => body.cancel().catch(() => undefined)));
    store.flush();
    rmSync(root, { recursive: true, force: true });
  });

  async function open(path: string): Promise<void> {
    const response = await apiRequest(app, path);
    expect(response.status).toBe(200);
    expect(response.body).not.toBeNull();
    bodies.push(response.body as ReadableStream<Uint8Array>);
  }

  it('keeps one event listener for many run streams and restores the baseline', async () => {
    const run = store.createRun({ title: 'run', workflow: 'w', task: 't', steps: [] });
    const baseline = store.listenerCount('event');
    await Promise.all(Array.from({ length: 50 }, () => open(`/api/v1/runs/${run.id}/events`)));
    expect(store.listenerCount('event')).toBe(baseline + 1);

    await Promise.all(bodies.splice(0).map((body) => body.cancel().catch(() => undefined)));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.listenerCount('event')).toBe(baseline);
  });

  it('shares deleted listeners between project and workspace streams', async () => {
    const baseline = store.listenerCount('deleted');
    await Promise.all([
      ...Array.from({ length: 20 }, () => open('/api/v1/events')),
      ...Array.from({ length: 20 }, () => open('/api/v1/workspace/events')),
    ]);
    expect(store.listenerCount('deleted')).toBe(baseline + 1);

    await Promise.all(bodies.splice(0).map((body) => body.cancel().catch(() => undefined)));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.listenerCount('deleted')).toBe(baseline);
  });

  it('dispatches events only to the keyed run subscribers and tears down after the last one', () => {
    const first = store.createRun({ title: 'first', workflow: 'w', task: 't', steps: [] });
    const second = store.createRun({ title: 'second', workflow: 'w', task: 't', steps: [] });
    const baseline = store.listenerCount('event');
    const firstEvents: string[] = [];
    const secondEvents: string[] = [];
    const offFirst = onRunEvent(store, first.id, (event) => firstEvents.push(event.type));
    const offSecond = onRunEvent(store, second.id, (event) => secondEvents.push(event.type));

    expect(store.listenerCount('event')).toBe(baseline + 1);
    store.appendEvent(first.id, { type: 'stdout', text: 'first' } as never);
    store.appendEvent(second.id, { type: 'stdout', text: 'second' } as never);
    expect(firstEvents).toEqual(['stdout']);
    expect(secondEvents).toEqual(['stdout']);

    offFirst();
    expect(store.listenerCount('event')).toBe(baseline + 1);
    offSecond();
    expect(store.listenerCount('event')).toBe(baseline);
  });

  it('keeps replay-to-live ordering and drops a replay-boundary duplicate', async () => {
    const run = store.createRun({ title: 'replay', workflow: 'w', task: 't', steps: [] });
    store.appendEvent(run.id, { type: 'stdout', text: 'historical' } as never);
    const historical = store.readEvents(run.id)[0];
    expect(historical).toBeDefined();
    const readEvents = vi.spyOn(store, 'readEvents').mockImplementation((id) => {
      const events = RunStore.prototype.readEvents.call(store, id);
      // Simulate the same event arriving from the live hub while disk replay is
      // being captured. The handler's existing seq guard must emit it once.
      store.emit('event', { runId: id, event: events[0] });
      return events;
    });

    const response = await apiRequest(app, `/api/v1/runs/${run.id}/events`);
    expect(response.status).toBe(200);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let body = '';
    while (!body.includes('event: ping')) {
      const next = await reader.read();
      if (next.done) break;
      body += decoder.decode(next.value, { stream: true });
    }
    await reader.cancel();
    readEvents.mockRestore();

    const dataLine = `data: ${JSON.stringify(historical)}\n`;
    expect(body.split(dataLine)).toHaveLength(2);
    expect(body.indexOf(dataLine)).toBeGreaterThanOrEqual(0);
    expect(body.indexOf('event: ping')).toBeGreaterThan(body.indexOf(dataLine));
  });

  it('broadcasts deletion to subscribers and removes the store listener last', () => {
    const first: string[] = [];
    const second: string[] = [];
    const baseline = store.listenerCount('deleted');
    const offFirst = onRunDeleted(store, (id) => first.push(id));
    const offSecond = onRunDeleted(store, (id) => second.push(id));
    expect(store.listenerCount('deleted')).toBe(baseline + 1);

    store.emit('deleted', 'run-1');
    expect(first).toEqual(['run-1']);
    expect(second).toEqual(['run-1']);
    offFirst();
    expect(store.listenerCount('deleted')).toBe(baseline + 1);
    offSecond();
    expect(store.listenerCount('deleted')).toBe(baseline);
  });
});
