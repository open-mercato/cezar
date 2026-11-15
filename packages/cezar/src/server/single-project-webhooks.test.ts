import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { registerProject } from '../workspace/projects.ts';
import { WebhookCoordinator } from '../webhooks/coordinator.ts';
import { ProjectContexts } from './project-context.ts';
import { startServer } from './server.ts';

it.each(['0', '1'])('production single-project resolver rejects hidden webhook scope before opening it (remote=%s)', async remote => {
  const dir = mkdtempSync(join(tmpdir(), 'cez-single-webhooks-'));
  const root = join(dir, 'boot'), otherRoot = join(dir, 'hidden');
  for (const path of [root, otherRoot]) { mkdirSync(path); execFileSync('git', ['init', '-q'], { cwd: path }); }
  vi.stubEnv('CEZ_HOME', join(dir, 'home'));
  vi.stubEnv('CEZ_DRY_RUN', '1'); vi.stubEnv('CEZ_WEBHOOKS', '1');
  vi.stubEnv('CEZ_SINGLE_PROJECT', '1'); vi.stubEnv('CEZ_REMOTE', remote);
  vi.stubEnv('CEZ_AUTOMATIONS', '0'); vi.stubEnv('CEZ_SKILLS_AUTO_UPDATE', '0'); vi.stubEnv('CEZ_NO_BANNER', '1');
  const boot = await registerProject(root), hidden = await registerProject(otherRoot);
  const store = RunStore.open(join(root, '.ai/cezar'));
  const webhooks = new WebhookCoordinator({ mode: () => remote === '1' ? 'hosted' : 'local', ports: () => [], projects: async () => [], dryRun: true });
  const context = vi.spyOn(ProjectContexts.prototype, 'context');
  const server = startServer({ repoRoot: root, store, manager: { isActive: () => false } as unknown as RunManager, version: 'test', webhooks }, 0);
  try {
    await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No TCP address');
    const url = `http://127.0.0.1:${address.port}/api/v1`;
    for (const suffix of ['/webhooks', '/p/default/webhooks', `/p/${boot.id}/webhooks`]) expect((await fetch(url + suffix)).status).toBe(200);
    context.mockClear();
    const read = await fetch(`${url}/p/${hidden.id}/webhooks`);
    expect(read.status).toBe(404);
    const write = await fetch(`${url}/p/${hidden.id}/webhooks/00000000-0000-4000-8000-000000000000`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: 1, name: 'must not write' }) });
    expect(write.status).toBe(404);
    expect(context).not.toHaveBeenCalled();
    expect(existsSync(join(otherRoot, '.ai/cezar/webhooks'))).toBe(false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await webhooks.dispose(); store.flush(); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true });
  }
});
