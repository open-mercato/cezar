import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

const streamState = vi.hoisted(() => ({ completed: false, returnedEarly: false }));

vi.mock('../runs/event-history.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runs/event-history.ts')>();
  return {
    ...actual,
    streamRunEvents: async function* (filePath: string) {
      let completed = false;
      try {
        for await (const event of actual.streamRunEvents(filePath)) yield event;
        completed = true;
      } finally {
        streamState.completed = completed;
        streamState.returnedEarly = !completed;
      }
    },
  };
});

describe('per-run SSE replay stops when the client disconnects', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;

  beforeEach(() => {
    streamState.completed = false;
    streamState.returnedEarly = false;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-sse-abort-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('returns the replay generator instead of draining the transcript', async () => {
    const run = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [] });
    for (let index = 0; index < 4_000; index += 1) {
      store.appendEvent(run.id, { type: 'note', message: `m${index}`, padding: 'x'.repeat(128) });
    }

    const res = await apiRequest(app, `/api/v1/runs/${run.id}/events`);
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(streamState.returnedEarly).toBe(true);
    expect(streamState.completed).toBe(false);
  });
});
