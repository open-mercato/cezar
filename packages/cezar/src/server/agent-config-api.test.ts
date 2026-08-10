import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/**
 * `GET/PUT /api/v1/agent-config` (spec #404). The contract under test: files are
 * addressed by catalog id (unknown → 404); reads work in every mode; and the
 * load-bearing security property — EVERY write 409s in hosted mode
 * (`CEZ_REMOTE`), including a repo-LOCAL file whose hooks would otherwise be a
 * remote code-execution primitive.
 */
describe('the agent-config API', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  const prevRemote = process.env.CEZ_REMOTE;

  beforeEach(() => {
    delete process.env.CEZ_REMOTE;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-agentcfg-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({
      repoRoot,
      store,
      manager: {} as RunManager,
      version: '0.0.0-test',
    });
  });
  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (prevRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = prevRemote;
  });

  const put = (id: string, body: unknown) =>
    apiRequest(app, `/api/v1/agent-config/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('GET lists the catalog with editable:true locally', async () => {
    const res = await apiRequest(app, '/api/v1/agent-config');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      editable: boolean;
      files: unknown[];
      userMcp: unknown;
    };
    expect(body.editable).toBe(true);
    expect(body.files.length).toBeGreaterThan(10);
    expect(body.userMcp).not.toBeNull();
  });

  it('GET :id → 404 for an unknown id', async () => {
    expect((await apiRequest(app, '/api/v1/agent-config/nope')).status).toBe(404);
  });

  it('GET :id reads an absent file as exists:false', async () => {
    const res = await apiRequest(app, '/api/v1/agent-config/claude.project.settings');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ exists: false, version: null });
  });

  it('PUT creates a file, then a correct-version PUT updates it', async () => {
    const created = await put('claude.project.settings', {
      content: '{"a":1}',
      version: null,
    });
    expect(created.status).toBe(200);
    const { version } = (await created.json()) as { version: string };
    expect(readFileSync(join(repoRoot, '.claude', 'settings.json'), 'utf8')).toBe('{"a":1}');
    const updated = await put('claude.project.settings', {
      content: '{"a":2}',
      version,
    });
    expect(updated.status).toBe(200);
  });

  it('PUT rejects invalid JSON with 400', async () => {
    expect((await put('claude.project.settings', { content: '{bad', version: null })).status).toBe(400);
  });

  it('PUT rejects a stale version with 409', async () => {
    await put('claude.project.settings', { content: '{"a":1}', version: null });
    expect(
      (
        await put('claude.project.settings', {
          content: '{"a":2}',
          version: null,
        })
      ).status,
    ).toBe(409);
  });

  it('PUT :id → 404 for an unknown id', async () => {
    expect((await put('nope', { content: 'x', version: null })).status).toBe(404);
  });

  // The regression test for the hooks RCE hole: a repo-LOCAL file must 409 in
  // hosted mode, not just a user-scope one. settings.json defines hooks.
  it('hosted mode: EVERY write 409s — including a repo-local settings file', async () => {
    process.env.CEZ_REMOTE = '1';
    const local = await put('claude.project.settings', {
      content: '{"hooks":{}}',
      version: null,
    });
    expect(local.status).toBe(409);
    const userScope = await put('claude.user.settings', {
      content: '{}',
      version: null,
    });
    expect(userScope.status).toBe(409);
  });

  it('hosted mode: repo-file reads work, home-dir file reads are withheld, userMcp is null', async () => {
    process.env.CEZ_REMOTE = '1';
    const res = await apiRequest(app, '/api/v1/agent-config');
    const body = (await res.json()) as {
      editable: boolean;
      userMcp: unknown;
      files: { writable: boolean }[];
    };
    expect(body.editable).toBe(false);
    expect(body.userMcp).toBeNull();
    expect(body.files.every((f) => f.writable === false)).toBe(true);
    // a repo-local file read still works (the cockpit already serves repo contents)
    expect((await apiRequest(app, '/api/v1/agent-config/claude.project.settings')).status).toBe(200);
    // but an OUTSIDE-REPO ($HOME) file's contents are NOT served — they can hold secrets
    expect((await apiRequest(app, '/api/v1/agent-config/claude.user.settings')).status).toBe(409);
    expect((await apiRequest(app, '/api/v1/agent-config/codex.user.config')).status).toBe(409);
  });
});
