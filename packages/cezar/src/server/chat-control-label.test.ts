import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { WebhookCoordinator, type ChatInteractions } from '../webhooks/coordinator.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import type { ProjectContext } from './project-context.ts';
import { registerProject } from '../workspace/projects.ts';
import { createApp } from './server.ts';
import { prepareChatControl } from '../chat/controls.ts';

vi.mock('../chat/controls.ts', async original => ({ ...await original<typeof import('../chat/controls.ts')>(), prepareChatControl: vi.fn(async () => undefined) }));

it.each(['Slack', 'Discord', 'Telegram'])('continues a task from %s under that provider label', async label => {
  const root = await mkdtemp(join(tmpdir(), 'chat-control-label-')); execFileSync('git', ['init', '-q'], { cwd: root });
  vi.stubEnv('CEZ_HOME', join(root, 'home')); vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_DRY_RUN', '0'); vi.stubEnv('CEZ_AUTOMATIONS', '0'); vi.stubEnv('CEZ_NO_BANNER', '1');
  const project = await registerProject(root), store = RunStore.open(join(root, '.ai/cezar'));
  const coordinator = new WebhookCoordinator({ dryRun: false, mode: () => 'local', ports: () => [], projects: async () => [{ ...project, status: 'ready' }] });
  let interactions: ChatInteractions | undefined;
  vi.spyOn(coordinator, 'setChatInteractions').mockImplementation(value => { interactions = value; });
  const cleanups: (() => void)[] = [];
  try {
    createApp({ repoRoot: root, bootProjectId: project.id, store, manager: { isActive: () => false } as unknown as RunManager, version: 'test', webhooks: coordinator,
      socketHub: { registerTopic: () => () => {}, attach() {}, close() {} }, onDispose: fn => cleanups.push(fn) });
    const run = { id: 'task' } as RunRecord, context = { root } as ProjectContext;
    await interactions!.prepareControl!(context, run, 'continue', 'hello', label);
    expect(vi.mocked(prepareChatControl)).toHaveBeenLastCalledWith(context, run, 'continue', 'hello', expect.any(Object), label);
  } finally { for (const cleanup of cleanups) cleanup(); await coordinator.dispose(); store.flush(); vi.unstubAllEnvs(); vi.mocked(prepareChatControl).mockClear(); await rm(root, { recursive: true, force: true }); }
});
