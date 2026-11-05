import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workflowsResponseSchema } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { ProjectContexts, type ProjectContextSource } from './project-context.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

describe('instance-wide multi-model enablement', () => {
  let root: string;
  let boot: string;
  let store: RunStore;
  let contexts: ProjectContexts;
  let projects: ProjectContextSource[];
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.stubEnv('CEZ_MULTI_MODEL', '0');
    vi.stubEnv('CEZ_DRY_RUN', '1');
    root = mkdtempSync(join(tmpdir(), 'cez-multi-instance-'));
    boot = join(root, 'boot');
    mkdirSync(boot);
    projects = [];
    contexts = new ProjectContexts({ listProjects: async () => projects });
    store = RunStore.open(join(boot, '.ai/cezar'));
    app = createApp({ repoRoot: boot, store, contexts, manager: { isActive: () => false } as unknown as RunManager, version: 'test' });
  });

  afterEach(() => {
    contexts.disposeAll();
    store.flush();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const body = async (path: string) => {
    const response = await apiRequest(app, `/api/v1${path}`);
    expect(response.status).toBe(200);
    return response.json();
  };

  it('enables the composer and workflows for a project added after boot without a project flag', async () => {
    vi.stubEnv('CEZ_MULTI_MODEL', '1');
    expect(await body('/config')).toMatchObject({ multiModel: true });

    const added = join(root, 'added');
    mkdirSync(added);
    projects.push({ id: 'added', root: added, status: 'not-git' });
    expect(await body('/p/added/config')).toMatchObject({ multiModel: true });
    expect(await body('/p/added/harness/status')).toMatchObject({ enabled: true });
    const catalog = workflowsResponseSchema.parse(await body('/p/added/workflows'));
    expect(catalog.workflows.map((workflow) => workflow.name)).toEqual(
      expect.arrayContaining(['harness-fix-issue', 'harness-implement-feature']),
    );
    expect(existsSync(join(added, '.ai/cezar/config.json'))).toBe(false);
  });

  it('keeps the instance disabled even when a repository or its config API tries to enable it', async () => {
    mkdirSync(join(boot, '.ai/cezar'), { recursive: true });
    writeFileSync(join(boot, '.ai/cezar/config.json'), '{"multiModel":true}');
    expect(await body('/config')).toMatchObject({ multiModel: false });
    expect(await body('/harness/status')).toMatchObject({ enabled: false });
    const response = await apiRequest(app, '/api/v1/config', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"multiModel":true}',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ multiModel: false });
  });

  it('does not let a project disable the instance flag', async () => {
    vi.stubEnv('CEZ_MULTI_MODEL', '1');
    mkdirSync(join(boot, '.ai/cezar'), { recursive: true });
    writeFileSync(join(boot, '.ai/cezar/config.json'), '{"multiModel":false}');
    expect(await body('/config')).toMatchObject({ multiModel: true });
    expect(await body('/harness/status')).toMatchObject({ enabled: true });
  });
});
