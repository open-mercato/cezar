import { randomInt, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { TelegramInbound } from './test-support/telegram-wire.testkit.ts';
import { readBinding } from './bindings.ts';
import type { PrivateReceiver } from '../webhooks/endpoints.ts';
import type { TelegramCall } from './test-support/telegram-wire.testkit.ts';

// Stands in for a crash at the first inbound state write; binding.json writes pass through.
const failing = vi.hoisted(() => ({ file: '' }));
vi.mock('../webhooks/storage.ts', async original => {
  const actual = await original<typeof import('../webhooks/storage.ts')>();
  return { ...actual, atomicWrite: async (directory: string, file: string, value: unknown) => {
    if (file === failing.file) throw new Error('crashed before the first state write');
    return actual.atomicWrite(directory, file, value);
  } };
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { failing.file = ''; for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); });

it('a first pairing cut short before its first state write leaves no bound, blocked bot behind', async () => {
  vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_CHAT_INBOUND', '1');
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'chat-interrupted-')));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const botId = String(randomInt(100000, 99999999));
  const receiver = { id: randomUUID(), revision: 1, deliveryRevision: 1, format: 'telegram.v1', chatId: '456', state: 'active', lastTest: 'success',
    profile: 'standard', events: ['task.attention_required'], chatSecret: { sha256: 'a'.repeat(64) } } as PrivateReceiver;
  const call = vi.fn<TelegramCall>(async (method, _body, signal) => {
    if (method === 'getMe') return { id: Number(botId), username: 'test_bot', first_name: 'Test' };
    if (method === 'getUpdates') return new Promise(resolve => signal?.addEventListener('abort', () => resolve([]), { once: true }));
    return {};
  });
  const options = { projectId: 'project', root: directory, installationId: randomUUID(), directory, mode: 'local', receivers: () => [receiver],
    call: () => call, context: vi.fn(), deliver: vi.fn(), episode: () => undefined, changed() {}, now: () => 10_000 };
  const first = new TelegramInbound(options as never);
  cleanups.push(() => first.dispose());
  failing.file = `${botId}.json`;
  await expect(first.pair({ receiverId: receiver.id, expectedRevision: first.list().receivers[0]!.inboundRevision, dedicatedBot: true })).rejects.toThrow('crashed');
  failing.file = '';
  await first.dispose();
  const restarted = new TelegramInbound(options as never);
  cleanups.push(() => restarted.dispose());
  await restarted.load();
  expect(restarted.list().bots).toEqual([]);
  expect(await readBinding(botId, false)).toBeUndefined();
});
