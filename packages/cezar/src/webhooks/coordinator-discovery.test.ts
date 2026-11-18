import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { listProjects, registerProject } from '../workspace/projects.ts';
import { normalizeMessage, telegramSeam, type TelegramCall } from '../chat/test-support/telegram-wire.testkit.ts';
import { WebhookCoordinator } from './coordinator.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); });

// Another `cezar` process registers a project by writing the shared registry only; this
// cockpit learns of it through discovery and must start that project's chat bot. Dry-run
// receivers live under webhooks/dry-run/, so discovery must look where its mode writes.
it.each([false, true])('starts the chat bot of a project another process registered, on the next discovery (dry run %s)', async dryRun => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'chat-discovery-home-'));
  const project = mkdtempSync(join(realpathSync(tmpdir()), 'chat-discovery-project-'));
  cleanups.push(() => { rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }); });
  execFileSync('git', ['init', '-q'], { cwd: project });
  vi.stubEnv('CEZ_HOME', home); vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_CHAT_INBOUND', '1'); vi.stubEnv('CEZ_SINGLE_PROJECT', '0');
  let polls = 0;
  const call: TelegramCall = async (method, body, signal) => {
    if (method === 'getMe') return { id: 123456, username: 'discovered_bot', first_name: 'Discovered' };
    if (method === 'getUpdates') { polls++; return new Promise(resolve => signal?.addEventListener('abort', () => resolve([]), { once: true })); }
    if (method === 'sendMessage') return { message_id: 1, chat: { id: Number((body as { chat_id?: unknown }).chat_id) } };
    return true;
  };

  // This cockpit reads the registry exactly as the server does.
  const cockpit = new WebhookCoordinator({ mode: () => 'local', ports: () => [], projects: () => listProjects(), dryRun, chatTransport: telegramSeam(call) });
  cleanups.push(() => cockpit.dispose());
  await cockpit.discover();
  expect(cockpit.count()).toBe(0);

  // The other process registers the project (a registry write), pairs a bot in it, then exits.
  const { id } = await registerProject(project);
  const other = new WebhookCoordinator({ mode: () => 'local', ports: () => [], projects: async () => [], dryRun, chatTransport: telegramSeam(call) });
  const service = await other.get(id, project, true);
  const { receiver } = await service.create({ name: 'Ops', format: 'telegram.v1', url: `https://api.telegram.org/bot123456:${'x'.repeat(35)}/sendMessage`, chatId: '456', profile: 'standard', graceSeconds: 0 });
  await service.test(receiver.id, { expectedRevision: receiver.revision, deliveryRevision: receiver.deliveryRevision, operationId: 'discovery-test' });
  await service.tick();
  await service.activate(receiver.id, service.list().receivers[0]!.revision);
  const inbound = service.telegram;
  const begun = await inbound.beginSetup({ receiverId: receiver.id, expectedRevision: inbound.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  inbound.pairings.accept('123456', 'discovered_bot', normalizeMessage({ message_id: 2, date: Math.ceil(Date.now() / 1000), chat: { id: 456, type: 'private' },
    from: { id: 456, is_bot: false, first_name: 'Person' }, text: `/start ${new URL(begun.deepLink).searchParams.get('start')}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] }, 'discovered_bot')!);
  await inbound.activateSetup(begun.setupId, { activate: true, expectedRevision: inbound.setupStatus(begun.setupId).inboundRevision, candidateUserId: '456', permissions: ['respond'] });
  await other.dispose();

  polls = 0;
  await cockpit.discover();
  expect(cockpit.count()).toBe(1);
  await vi.waitFor(() => expect(polls).toBeGreaterThan(0));
});
