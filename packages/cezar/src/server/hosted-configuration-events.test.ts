import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ExtensionManager } from '../extensions/manager.ts';
import { RunStore } from '../runs/store.ts';
import { WebhookCoordinator } from '../webhooks/coordinator.ts';
import type { RunManager } from '../workflows/run.ts';
import { registerProject } from '../workspace/projects.ts';
import { WorkspaceEventBus, createApp } from './server.ts';

// Spec 2026-11-12-hosted-extensions §4: a hosted cockpit has no WebSocket, so extension and chat
// configuration changes ride the workspace SSE, coalesced per 250 ms; a local cockpit sends none.
const changed = () => (ExtensionManager as unknown as { changed(): void }).changed();
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers(); vi.unstubAllEnvs(); });

async function boot(remote: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'hosted-config-events-')); execFileSync('git', ['init', '-q'], { cwd: root });
  vi.stubEnv('CEZ_HOME', join(root, 'home')); vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_AUTOMATIONS', '0'); vi.stubEnv('CEZ_NO_BANNER', '1');
  if (remote) vi.stubEnv('CEZ_REMOTE', '1'); else vi.stubEnv('CEZ_REMOTE', '');
  const project = await registerProject(root), store = RunStore.open(join(root, '.ai/cezar'));
  const coordinator = new WebhookCoordinator({ dryRun: true, mode: () => remote ? 'hosted' : 'local', ports: () => [], projects: async () => [{ ...project, status: 'ready' }] });
  const chat = new Map<string, Array<() => void>>();
  const real = coordinator.onChatChange.bind(coordinator);
  vi.spyOn(coordinator, 'onChatChange').mockImplementation((provider, listener) => {
    chat.set(provider, [...chat.get(provider) ?? [], listener]); return real(provider, listener);
  });
  const bus = new WorkspaceEventBus(), events: Array<[string, unknown]> = [];
  bus.on((event, data) => { if (event === 'extension-inventory-changed' || event === 'chat-configuration-changed') events.push([event, data]); });
  const disposers: Array<() => void | Promise<void>> = [];
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  createApp({ repoRoot: root, bootProjectId: project.id, store, manager: { isActive: () => false } as unknown as RunManager, version: 'test',
    webhooks: coordinator, workspaceEvents: bus, socketHub: { registerTopic: () => () => {}, attach() {}, close() {} }, onDispose: fn => disposers.push(fn) });
  cleanups.push(async () => { for (const fn of disposers) await fn(); await coordinator.dispose(); store.flush(); await rm(root, { recursive: true, force: true }); });
  return { events, chat: (provider: string) => { for (const listener of chat.get(provider) ?? []) listener(); } };
}

it('relays a burst of extension and chat changes as one SSE event each on a hosted cockpit', async () => {
  const app = await boot(true);
  changed(); changed(); app.chat('telegram'); app.chat('slack');
  expect(app.events).toEqual([]);
  await vi.advanceTimersByTimeAsync(250);
  expect(app.events).toEqual([['extension-inventory-changed', { changed: true }], ['chat-configuration-changed', { changed: true }]]);
  changed(); await vi.advanceTimersByTimeAsync(250);
  expect(app.events).toHaveLength(3);
}, 30_000);

it('sends neither event on a local cockpit, which has the WebSocket topics', async () => {
  const app = await boot(false);
  changed(); app.chat('telegram');
  await vi.advanceTimersByTimeAsync(1_000);
  expect(app.events).toEqual([]);
}, 30_000);
