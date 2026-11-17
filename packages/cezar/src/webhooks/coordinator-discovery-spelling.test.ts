import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

// Windows' JS realpath keeps an 8.3 short name (C:\Users\RUNNER~1) that the native realpath, and so
// the project registry, expands. Simulated here: the JS realpath leaves the `short` alias unresolved.
const alias = vi.hoisted(() => ({ short: '', long: '' }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const realpathSync = Object.assign((path: string, options?: unknown) => {
    const resolved = String(path);
    if (alias.short && (resolved === alias.short || resolved.startsWith(alias.short + '/'))) {
      actual.realpathSync(join(alias.long, relative(alias.short, resolved)));
      return resolved;
    }
    return actual.realpathSync(path, options as never);
  }, { native: actual.realpathSync.native });
  // A short name is not a link: lstat sees the directory it names.
  const lstatSync = ((path: string, options?: unknown) => actual.lstatSync(alias.short && String(path) === alias.short ? alias.long : path, options as never)) as typeof actual.lstatSync;
  return { ...actual, realpathSync, lstatSync, default: { ...actual, realpathSync, lstatSync } };
});

const { listProjects, registerProject } = await import('../workspace/projects.ts');
const { normalizeMessage, telegramSeam } = await import('../chat/test-support/telegram-wire.testkit.ts');
const { WebhookCoordinator } = await import('./coordinator.ts');
type TelegramCall = import('../chat/test-support/telegram-wire.testkit.ts').TelegramCall;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); alias.short = alias.long = ''; });

it.skipIf(process.platform === 'win32')('keeps the bot another process paired through a second spelling of the same root', async () => {
  const outer = mkdtempSync(join(realpathSync.native(tmpdir()), 'chat-discovery-spelling-'));
  cleanups.push(() => rmSync(outer, { recursive: true, force: true }));
  const home = join(outer, 'home'), long = join(outer, 'long'); mkdirSync(home); mkdirSync(long);
  symlinkSync(long, join(outer, 'short'), 'dir'); alias.short = join(outer, 'short'); alias.long = long;
  const project = join(long, 'project'); mkdirSync(project); execFileSync('git', ['init', '-q'], { cwd: project });
  vi.stubEnv('CEZ_HOME', home); vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_CHAT_INBOUND', '1'); vi.stubEnv('CEZ_SINGLE_PROJECT', '0');
  let polls = 0;
  const call: TelegramCall = async (method, body, signal) => {
    if (method === 'getMe') return { id: 123456, username: 'discovered_bot', first_name: 'Discovered' };
    if (method === 'getUpdates') { polls++; return new Promise(resolve => signal?.addEventListener('abort', () => resolve([]), { once: true })); }
    if (method === 'sendMessage') return { message_id: 1, chat: { id: Number((body as { chat_id?: unknown }).chat_id) } };
    return true;
  };
  const cockpit = new WebhookCoordinator({ mode: () => 'local', ports: () => [], projects: () => listProjects(), dryRun: true, chatTransport: telegramSeam(call) });
  cleanups.push(() => cockpit.dispose());
  const { id } = await registerProject(project);
  const other = new WebhookCoordinator({ mode: () => 'local', ports: () => [], projects: async () => [], dryRun: true, chatTransport: telegramSeam(call) });
  const service = await other.get(id, join(alias.short, 'project'), true);
  const { receiver } = await service.create({ name: 'Ops', format: 'telegram.v1', url: `https://api.telegram.org/bot123456:${'x'.repeat(35)}/sendMessage`, chatId: '456', profile: 'standard', graceSeconds: 0 });
  await service.test(receiver.id, { expectedRevision: receiver.revision, deliveryRevision: receiver.deliveryRevision, operationId: 'spelling-test' });
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
