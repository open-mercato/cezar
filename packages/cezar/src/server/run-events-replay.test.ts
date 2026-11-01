import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

describe('per-run SSE replay without a live cursor', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-sse-replay-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** Frame ids up to the `run` snapshot the route sends once replay is done. */
  async function replayedIds(path: string): Promise<number[]> {
    const res = await apiRequest(app, path);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!/^event: run$/m.test(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
    return [...text.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
  }

  it('streams the transcript from disk instead of parsing it synchronously on the request path', async () => {
    const run = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [] });
    for (const message of ['one', 'two', 'three']) store.appendEvent(run.id, { type: 'note', message });
    const readEvents = vi.spyOn(store, 'readEvents');

    expect(await replayedIds(`/api/v1/runs/${run.id}/events`)).toEqual([1, 2, 3]);
    expect(readEvents).not.toHaveBeenCalled();
  });

  it('replays only what follows afterSeq', async () => {
    const run = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [] });
    for (const message of ['one', 'two', 'three']) store.appendEvent(run.id, { type: 'note', message });

    expect(await replayedIds(`/api/v1/runs/${run.id}/events?afterSeq=2`)).toEqual([3]);
  });

  it('answers a run with no transcript yet with an empty replay', async () => {
    const run = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [] });

    expect(await replayedIds(`/api/v1/runs/${run.id}/events`)).toEqual([]);
  });

  /** Raw body bytes of the stream up to the `run` snapshot. */
  async function replayBody(path: string, headers?: Record<string, string>): Promise<string> {
    const res = await apiRequest(app, path, { headers });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!/^event: run$/m.test(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
    return text;
  }

  it('bounds a cursorless replay of a long transcript and flags the gap (#882)', async () => {
    const run = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [] });
    for (let i = 0; i < 1_200; i += 1) store.appendEvent(run.id, { type: 'note', message: 'x'.repeat(4_000) }); // ~4.8 MB
    store.flush();

    const fresh = await replayBody(`/api/v1/runs/${run.id}/events`);
    expect(fresh.length).toBeLessThan(1_800_000);
    expect(fresh).toMatch(/^event: history-truncated$/m);
    expect(fresh).toContain(`id: 1200\n`);
    expect(fresh).not.toContain(`id: 1\n`);

    // A reconnect with Last-Event-ID near the end must cost a few events, not the history.
    const resumed = await replayBody(`/api/v1/runs/${run.id}/events`, { 'Last-Event-ID': '1198' });
    expect(resumed.length).toBeLessThan(20_000);
    expect(resumed).not.toMatch(/^event: history-truncated$/m);
    expect([...resumed.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]))).toEqual([1199, 1200]);
  });
});
