import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { registerProject } from '../workspace/projects.ts';
import { WebhookCoordinator } from '../webhooks/coordinator.ts';
import { TelegramInbound } from '../telegram/service.ts';
import { ProjectContexts } from './project-context.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

it.each(['0', '1'])('Telegram settings never recover a project or start polling (single project=%s)', async single => {
  const dir = mkdtempSync(join(tmpdir(), 'cez-telegram-scope-'));
  const root = join(dir, 'boot'), other = join(dir, 'other');
  for (const path of [root, other]) { mkdirSync(path); execFileSync('git', ['init', '-q'], { cwd: path }); }
  vi.stubEnv('CEZ_HOME', join(dir, 'home')); vi.stubEnv('CEZ_DRY_RUN', '1');
  vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_CHAT_INBOUND', '1'); vi.stubEnv('CEZ_SINGLE_PROJECT', single);
  vi.stubEnv('CEZ_REMOTE', '0'); vi.stubEnv('CEZ_AUTOMATIONS', '0'); vi.stubEnv('CEZ_NO_BANNER', '1');
  const boot = await registerProject(root), foreign = await registerProject(other);
  const store = RunStore.open(join(root, '.ai/cezar'));
  const webhooks = new WebhookCoordinator({ mode: () => 'local', ports: () => [], projects: async () => [], dryRun: true });
  const context = vi.spyOn(ProjectContexts.prototype, 'context'), poller = vi.spyOn(TelegramInbound.prototype, 'start');
  const cleanups: (() => void)[] = [];
  const app = createApp({ repoRoot: root, store, manager: { isActive: () => false } as unknown as RunManager, version: 'test', webhooks, onDispose: fn => { cleanups.push(fn); } });
  try {
    for (const prefix of ['/api/v1', '/api/v1/p/default', `/api/v1/p/${boot.id}`]) {
      const response = await apiRequest(app, `${prefix}/telegram`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ available: true });
      expect((await apiRequest(app, `${prefix}/telegram/unknown`)).status).toBe(404);
    }
    expect((await apiRequest(app, `/api/v1/p/${foreign.id}/telegram`)).status).toBe(single === '1' ? 404 : 200);
    expect((await apiRequest(app, '/api/v1/p/nonexistent-project/telegram')).status).toBe(404);
    expect((await apiRequest(app, '/api/v1/telegram/bot-bindings')).status).toBe(200);
    expect((await apiRequest(app, '/api/v1/p/default/telegram/bot-bindings')).status).toBe(404);
    expect(context).not.toHaveBeenCalled(); expect(poller).not.toHaveBeenCalled();
  } finally {
    for (const cleanup of cleanups) cleanup();
    await webhooks.dispose(); store.flush(); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true });
  }
});
