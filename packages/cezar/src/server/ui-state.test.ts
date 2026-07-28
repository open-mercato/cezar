import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

/**
 * `PUT /api/v1/ui-state` — the cockpit's small prefs file. Covered here for `promptTemplates`
 * (#413) and its `skills` assignment field (#413 follow-up): the schema is the ONLY thing
 * standing between a cockpit bug and an unreadable `ui-state.json`, and the additive-key rule
 * ("an old client's payload must keep validating") is easy to break by tightening it later.
 */
describe('PUT /api/v1/ui-state — promptTemplates', () => {
  let repoRoot: string;
  let app: Hono;

  const put = (body: unknown) =>
    apiRequest(app, '/api/v1/ui-state', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const template = (over: Record<string, unknown> = {}) => ({
    id: 'a',
    label: 'Add tests',
    text: 'Also add tests.',
    ...over,
  });

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-ui-state-'));
    const dataDir = join(repoRoot, '.ai/cezar');
    app = createApp({
      repoRoot,
      store: RunStore.open(dataDir),
      manager: {} as unknown as RunManager,
      version: '0.0.0-test',
    });
  });

  afterEach(() => rmSync(repoRoot, { recursive: true, force: true }));

  it('accepts a template with assigned skills and round-trips them', async () => {
    const templates = [template({ skills: ['om-fix', 'om-review'] })];
    expect((await put({ promptTemplates: templates })).status).toBe(200);

    const read = await apiRequest(app, '/api/v1/ui-state');
    expect(await read.json()).toMatchObject({ promptTemplates: templates });
  });

  it('accepts a template with NO skills key — the pre-assignment client must keep working', async () => {
    expect((await put({ promptTemplates: [template()] })).status).toBe(200);
    const read = await apiRequest(app, '/api/v1/ui-state');
    expect(((await read.json()) as { promptTemplates: unknown[] }).promptTemplates[0]).toEqual(
      template(),
    );
  });

  it('accepts a deliberately empty list — "I cleared every template" is a real state', async () => {
    expect((await put({ promptTemplates: [] })).status).toBe(200);
    const read = await apiRequest(app, '/api/v1/ui-state');
    expect(await read.json()).toMatchObject({ promptTemplates: [] });
  });

  it('rejects skills that are not strings, or an over-long name', async () => {
    expect((await put({ promptTemplates: [template({ skills: [42] })] })).status).toBe(400);
    expect((await put({ promptTemplates: [template({ skills: [''] })] })).status).toBe(400);
    expect((await put({ promptTemplates: [template({ skills: ['x'.repeat(201)] })] })).status).toBe(400);
  });

  it('bounds the assignment list — 50 skills is fine, 51 is not', async () => {
    const names = (count: number) => Array.from({ length: count }, (_, i) => `skill-${i}`);
    expect((await put({ promptTemplates: [template({ skills: names(50) })] })).status).toBe(200);
    expect((await put({ promptTemplates: [template({ skills: names(51) })] })).status).toBe(400);
  });

  it('the merge stays shallow, so an unrelated pref is not clobbered by a templates PUT', async () => {
    expect((await put({ notifications: { enabled: true } })).status).toBe(200);
    expect((await put({ promptTemplates: [template({ skills: ['om-fix'] })] })).status).toBe(200);

    const read = await apiRequest(app, '/api/v1/ui-state');
    expect(await read.json()).toMatchObject({
      notifications: { enabled: true },
      promptTemplates: [template({ skills: ['om-fix'] })],
    });
  });
});
