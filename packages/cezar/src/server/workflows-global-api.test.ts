import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { cezarHomeDir } from '../paths.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/** Global workflows are read-only through the routes (#1984). */
describe('global workflows API', () => {
  let repoRoot: string;
  let store: RunStore;
  const file = () => join(cezarHomeDir(), 'workflows', 'shared.yaml');
  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-global-wf-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    mkdirSync(join(cezarHomeDir(), 'workflows'), { recursive: true });
    writeFileSync(file(), 'name: shared\nsteps:\n  - id: a\n    name: A\n    prompt: hi\n');
  });
  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(join(cezarHomeDir(), 'workflows'), { recursive: true, force: true });
  });
  const app = () => createApp({ repoRoot, store, manager: {} as RunManager, version: 'test' });

  it('lists with scope: global and refuses delete with 409', async () => {
    const list = await apiRequest(app(), '/api/v1/workflows');
    const body = (await list.json()) as { workflows: { name: string; scope?: string }[] };
    expect(body.workflows.find((w) => w.name === 'shared')?.scope).toBe('global');
    const del = await apiRequest(app(), '/api/v1/workflows/shared', { method: 'DELETE' });
    expect(del.status).toBe(409);
    expect(readFileSync(file(), 'utf8')).toContain('name: shared');
  });
});
