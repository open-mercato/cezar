import { webhookStoredSettingsSchema } from '@open-mercato/cezar-contract';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatTransportError, type ChatTransport } from '../chat/provider.ts';
import { ChatSecrets } from '../chat/credentials.ts';
import { SecretStore } from '../workspace/secrets.ts';
import { WebhookScheduler } from './scheduler.ts';
import { WebhookService } from './service.ts';
import type { PrivateReceiver } from './endpoints.ts';
// Isolate the shared transaction; contract-parity.chat-providers exercises the real adapters and socket discovery.
vi.mock('../chat/registry.ts', async importOriginal => {
 const actual = await importOriginal<typeof import('../chat/registry.ts')>();
 return { ...actual, chatProvider: (id: string) => id === 'telegram' ? actual.chatProvider('telegram') : ({
  id, label: id, format: `${id}.v1`, credentials: [{ name: 'token' }], limits: { perChatPerSecond: 100, perBotPerSecond: 100 },
  destination: () => id === 'slack' ? 'https://slack.com/api/chat.postMessage' : 'https://discord.com/api/v10',
  presentation: { isGroup: () => false, formatText: (text: string) => text, taskReply: () => 'Task notice', maxText: 2000 },
 }) };
});
const services: WebhookService[] = [], roots: string[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.dispose(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
async function fixture(provider: 'slack' | 'discord') {
 vi.stubEnv('CEZ_WEBHOOKS', '1');
 const root = await mkdtemp(join(tmpdir(), 'chat-upgrade-')); roots.push(root); execFileSync('git', ['init', '-q'], { cwd: root });
 const botId = provider === 'slack' ? 'TTEAM:UBOT' : '456', chatId = provider === 'slack' ? 'private:TTEAM:UBOT:DCHAN' : 'discord:dm:123';
 const send = vi.fn(async () => ({ chatId, messageId: provider === 'slack' ? '123.001' : '789' }));
 const transport = { identify: async () => ({ id: botId, username: botId }), inspect: async () => ({ id: chatId, kind: 'private', eligible: true }), send, guarded: () => transport } as unknown as ChatTransport;
 const webhookSend = vi.fn(async () => ({ kind: 'http' as const, status: 200 }));
 const vault = new ChatSecrets({ kind: 'project', root, projectId: 'test' }, new SecretStore({ ...process.env, CEZ_HOME: join(root, 'vault') }, { keychain: async () => null }));
 const service = (await WebhookService.open({ root, dataDir: join(root, '.ai/cezar'), projectId: 'test', mode: 'local', serverPorts: () => [], scheduler: new WebhookScheduler(), chatSecrets: vault, send: webhookSend, chatTransport: () => transport }))!; services.push(service);
 const url = provider === 'slack' ? 'https://hooks.slack.com/services/TA/BB/old' : `https://discord.com/api/webhooks/123456789012345678/${'x'.repeat(60)}`;
 const original = (await service.create({ name: 'Ops', format: `${provider}.v1`, url })).receiver;
 const upgrade = () => (service.chat as unknown as { chatReceiver(provider: string, credential: string, name: string, chatId: string, id: string, revision: number): Promise<PrivateReceiver> }).chatReceiver(provider, 'fixture-private-credential', 'Ops', chatId, original.id, original.revision);
 return { service, original, upgrade, send, webhookSend };
}
it.each(['slack', 'discord'] as const)('upgrades %s in place through the bot test and never the legacy sender', async provider => {
 const x = await fixture(provider); const receiver = await x.upgrade();
 expect(receiver).toMatchObject({ id: x.original.id, state: 'active', lastTest: 'success', profile: 'standard' });
 expect(x.service.list().receivers).toHaveLength(1); expect(x.send).toHaveBeenCalledTimes(1); expect(x.webhookSend).not.toHaveBeenCalled();
});
it.each(['slack', 'discord'] as const)('keeps a failed %s upgrade inactive without webhook fallback', async provider => {
 const x = await fixture(provider); x.send.mockRejectedValue(new ChatTransportError({ kind: 'auth' }));
 await expect(x.upgrade()).rejects.toThrow('test failed');
 expect(x.service.list().receivers).toHaveLength(1); expect(x.service.list().receivers[0]?.state).not.toBe('active');
 expect(x.webhookSend).not.toHaveBeenCalled();
});
it.each(['slack', 'discord'] as const)('does not activate or acknowledge a newer %s edit during the test send', async provider => {
 const x = await fixture(provider);
 let entered!: () => void, release!: () => void;
 const sending = new Promise<void>(resolve => { entered = resolve; });
 const resume = new Promise<void>(resolve => { release = resolve; });
 const send = x.send.getMockImplementation()!;
 x.send.mockImplementationOnce(async () => { entered(); await resume; return send(); });
 const outcome = x.upgrade().then(() => 'activated', () => 'rejected');
 await sending;
 try {
  const before = x.service.list().receivers[0]!;
  await x.service.update(before.id, { ...webhookStoredSettingsSchema.strip().parse(x.service.endpoints.privateReceiver(before.id)), name: 'New user name', expectedRevision: before.revision });
 } finally { release(); }
 expect(await outcome).toBe('rejected');
 expect(x.service.list().receivers).toHaveLength(1);
 expect(x.service.list().receivers[0]).toMatchObject({ name: 'New user name', state: 'inactive' });
});
