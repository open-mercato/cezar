import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkEnvNamesSchema } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { registerProject } from '../workspace/projects.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

describe('check-env API (spec 2026-10-06-agentic-e2e-checks Phase 1)', () => {
  let root: string;
  let store: RunStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-check-env-api-'));
    vi.stubEnv('CEZ_HOME', join(root, 'home'));
    vi.stubEnv('CEZ_SINGLE_PROJECT', '0');
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(root, '.ai/cezar'));
  });
  afterEach(() => {
    store.flush();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const app = async () => {
    const project = await registerProject(root);
    return {
      id: project.id,
      instance: createApp({ repoRoot: root, store, manager: {} as RunManager, version: 'test', bootProjectId: project.id }),
    };
  };
  const put = (value: unknown): RequestInit => ({
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }),
  });

  it('stores a value, answers names only, and deletes it', async () => {
    const { id, instance } = await app();
    expect((await apiRequest(instance, '/api/v1/check-env/E2E_KEY', put('secret-value-123'))).status).toBe(204);

    for (const path of ['/api/v1/check-env', `/api/v1/p/${id}/check-env`]) {
      const response = await apiRequest(instance, path);
      expect(response.status).toBe(200);
      const text = await response.text();
      // The value never comes back, in any form.
      expect(text).not.toContain('secret-value-123');
      expect(checkEnvNamesSchema.parse(JSON.parse(text))).toEqual({ names: ['E2E_KEY'] });
    }
    expect(readFileSync(join(root, 'home', 'check-env', `${id}.env`), 'utf8')).toContain('E2E_KEY="secret-value-123"');

    expect((await apiRequest(instance, `/api/v1/p/${id}/check-env/E2E_KEY`, { method: 'DELETE' })).status).toBe(204);
    expect((await apiRequest(instance, '/api/v1/check-env/E2E_KEY', { method: 'DELETE' })).status).toBe(404);
    expect(await (await apiRequest(instance, '/api/v1/check-env')).json()).toEqual({ names: [] });
  });

  it('refuses a bad name or value with a 400 naming the reason', async () => {
    const { instance } = await app();
    for (const [name, reason] of [
      ['CEZ_RUN_ID', 'reserved'],
      ['PATH', 'refused'],
      ['DYLD_INSERT_LIBRARIES', 'refused'],
      ['lower', 'uppercase'],
    ] as const) {
      const response = await apiRequest(instance, `/api/v1/check-env/${name}`, put('x'));
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toContain(reason);
    }
    expect((await apiRequest(instance, '/api/v1/check-env/KEY', put('a\nB=b'))).status).toBe(400);
    // An empty value is refused here too: the CLI and the cockpit both refuse it, and storing
    // `NAME=""` would shadow the server's own variable of that name instead of reading as unset.
    const empty = await apiRequest(instance, '/api/v1/check-env/KEY', put(''));
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: string }).error).toContain('not empty');
    expect((await apiRequest(instance, '/api/v1/check-env/KEY', put('x'.repeat(16 * 1024 + 1)))).status).toBe(400);
    expect((await apiRequest(instance, '/api/v1/check-env/KEY', put(42))).status).toBe(400);
    expect(await (await apiRequest(instance, '/api/v1/check-env')).json()).toEqual({ names: [] });
  });

  it('refuses writes for an unregistered boot project instead of writing what nothing reads', async () => {
    const instance = createApp({ repoRoot: root, store, manager: {} as RunManager, version: 'test' });
    expect((await apiRequest(instance, '/api/v1/check-env/KEY', put('value'))).status).toBe(409);
    expect((await apiRequest(instance, '/api/v1/check-env/KEY', { method: 'DELETE' })).status).toBe(409);
  });
});
