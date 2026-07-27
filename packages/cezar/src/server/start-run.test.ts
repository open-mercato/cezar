import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.js';
import type { RunManager, StartRunInput } from '../workflows/run.js';
import type { WorkflowDef } from '../workflows/types.js';
import { createApp } from './server.js';
import { apiRequest } from './loopback-request.testkit.js';

/**
 * `POST /api/runs` `systemPrompt` (R2 2.3) — the programmatic per-run
 * override (bookmarklets, scripts; deliberately no composer-UI control).
 * Validation contract: trimmed, blank degrades to absent, 20k cap.
 */
describe('POST /api/runs systemPrompt', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let captured: StartRunInput | undefined;
  const savedFollowups = process.env.CEZ_FOLLOWUPS;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-startrun-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    captured = undefined;
    // #471: these assertions are about systemPrompt, so pin the inbox on and
    // let the dedicated suite below own the gate's behavior.
    process.env.CEZ_FOLLOWUPS = '1';
    // The route hands the parsed input straight to the manager — a capturing
    // stub is all the harness needs (the patch-run.test.ts pattern).
    const manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) => {
        captured = input;
        return store.createRun({ title: 't', workflow: '(planned)', task: input.task, steps: [] });
      },
    } as unknown as RunManager;
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test' });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedFollowups === undefined) delete process.env.CEZ_FOLLOWUPS;
    else process.env.CEZ_FOLLOWUPS = savedFollowups;
  });

  const post = (body: unknown) =>
    apiRequest(app, '/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const base = { task: 'do the thing', steps: [{ id: 'work', prompt: '{{task}}' }] };

  it('passes a trimmed systemPrompt through to the manager', async () => {
    const res = await post({ ...base, systemPrompt: '  Answer in bullet points.  ' });
    expect(res.status).toBe(201);
    expect(captured?.systemPrompt).toBe('Answer in bullet points.');
  });

  it('an absent systemPrompt stays absent', async () => {
    const res = await post(base);
    expect(res.status).toBe(201);
    expect(captured?.systemPrompt).toBeUndefined();
  });

  it('forwards an explicit generateFollowups=false choice', async () => {
    const res = await post({ ...base, generateFollowups: false });
    expect(res.status).toBe(201);
    expect(captured?.generateFollowups).toBe(false);
  });

  it('keeps generateFollowups absent for old clients (enabled by default) on an inbox-enabled server', async () => {
    const res = await post(base);
    expect(res.status).toBe(201);
    expect(captured?.generateFollowups).toBeUndefined();
  });

  it('a whitespace-only systemPrompt degrades to absent (not a 400, not an empty string)', async () => {
    const res = await post({ ...base, systemPrompt: '   ' });
    expect(res.status).toBe(201);
    expect(captured?.systemPrompt).toBeUndefined();
  });

  it('accepts exactly 20k characters', async () => {
    const res = await post({ ...base, systemPrompt: 'x'.repeat(20_000) });
    expect(res.status).toBe(201);
    expect(captured?.systemPrompt).toHaveLength(20_000);
  });

  it('rejects an over-cap systemPrompt with a 400', async () => {
    const res = await post({ ...base, systemPrompt: 'x'.repeat(20_001) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('systemPrompt');
    expect(captured).toBeUndefined();
  });

  it('rejects a non-string systemPrompt with a 400', async () => {
    const res = await post({ ...base, systemPrompt: 42 });
    expect(res.status).toBe(400);
    expect(captured).toBeUndefined();
  });
});

/**
 * The inbox capability is the ceiling on `generateFollowups` (#471): whatever a
 * client asks for, an inbox-less server pins it to false. That single decision
 * is what stops the agent being handed FOLLOWUP_INSTRUCTIONS and a usable
 * CEZ_TODOS_FILE downstream (`RunManager.agentEnv`).
 */
describe('POST /api/runs generateFollowups — the CEZ_FOLLOWUPS ceiling (#471)', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let captured: StartRunInput | undefined;
  const savedFollowups = process.env.CEZ_FOLLOWUPS;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-startrun-followups-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    captured = undefined;
    const manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) => {
        captured = input;
        return store.createRun({ title: 't', workflow: '(planned)', task: input.task, steps: [] });
      },
    } as unknown as RunManager;
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test' });
    delete process.env.CEZ_FOLLOWUPS;
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedFollowups === undefined) delete process.env.CEZ_FOLLOWUPS;
    else process.env.CEZ_FOLLOWUPS = savedFollowups;
  });

  const post = (body: unknown) =>
    apiRequest(app, '/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const base = { task: 'do the thing', steps: [{ id: 'work', prompt: '{{task}}' }] };

  it('pins an omitted flag to false by default (the #444 default is now off)', async () => {
    const res = await post(base);
    expect(res.status).toBe(201);
    expect(captured?.generateFollowups).toBe(false);
  });

  it('overrides a client asking for follow-ups — 201, not an error', async () => {
    const res = await post({ ...base, generateFollowups: true });
    expect(res.status).toBe(201);
    expect(captured?.generateFollowups).toBe(false);
  });

  it('honours generateFollowups=true once CEZ_FOLLOWUPS=1', async () => {
    process.env.CEZ_FOLLOWUPS = '1';
    const res = await post({ ...base, generateFollowups: true });
    expect(res.status).toBe(201);
    expect(captured?.generateFollowups).toBe(true);
  });

  it('still lets an enabled server opt a single run out', async () => {
    process.env.CEZ_FOLLOWUPS = '1';
    const res = await post({ ...base, generateFollowups: false });
    expect(res.status).toBe(201);
    expect(captured?.generateFollowups).toBe(false);
  });
});
