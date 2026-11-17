import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChatInbound } from './service.ts';
import type { ChatServiceDescriptor, ChatTransport } from './provider.ts';
import type { PrivateReceiver } from '../webhooks/endpoints.ts';
import { telegramServiceDescriptor } from './providers/telegram/index.ts';
import { fakeChatTransport } from './test-support/chat-transport.testkit.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.unstubAllEnvs(); });

const providers = ['telegram'] as const;
for (const provider of providers) for (const group of [false, true]) for (const path of ['pair', 'setup', 'token'] as const) {
  it(`${provider} ${group ? 'group' : 'DM'} ${path}: confirmation sends one approval to the verified private destination`, async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_CHAT_INBOUND', '1');
    const directory = await mkdtemp(join(tmpdir(), 'approval-delivery-'));
    vi.stubEnv('CEZ_HOME', join(directory, 'home'));
    const posts: { destination: string; text: string }[] = [];
    const botId = '123456';
    const userId = '456';
    const privateId = '456';
    const groupId = '-10020';
    const descriptor: ChatServiceDescriptor = telegramServiceDescriptor;
    const token = `123456:${'A'.repeat(35)}`;
    const transport: ChatTransport = fakeChatTransport({ botId, isGroup: id => descriptor.presentation.isGroup(id), send(destination, message) { posts.push({ destination, text: message.text }); return { chatId: destination, messageId: '100' }; } }).transport;
    const receiver = { id: randomUUID(), revision: 1, deliveryRevision: 1, format: descriptor.format, chatId: group ? groupId : privateId,
      state: 'active', lastTest: 'success', profile: 'standard', events: ['task.attention_required'], chatSecret: { sha256: 'a'.repeat(64) } } as PrivateReceiver;
    const receivers = path === 'token' ? [] : [receiver];
    const service = new ChatInbound({ provider: descriptor, projectId: 'p', root: directory, installationId: randomUUID(), directory, mode: 'local',
      receivers: () => receivers, transport: () => transport, credentialTransport: () => transport,
      createReceiverFromToken: async (_token, _name, chatId) => { expect(chatId).toBe(receiver.chatId); receivers.push(receiver); return receiver; },
      context: vi.fn(), deliver: vi.fn(), episode: () => undefined, changed() {} });
    cleanups.push(async () => { await service.dispose(); await rm(directory, { recursive: true, force: true }); });
    const input = path === 'token' ? { token, dedicatedBot: true as const } : { receiverId: receiver.id,
      expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true as const, ...(group ? { groupVisibilityAccepted: true as const } : {}) };
    const begun = path === 'pair' ? await service.pair(input) : await service.beginSetup(input);
    const id = 'pairingId' in begun ? begun.pairingId : begun.setupId;
    const url = new URL(begun.deepLink), code = url.searchParams.get('start') ?? url.searchParams.get('cezar_start') ?? new URLSearchParams(url.hash.slice(1)).get('cezar-start')!;
    const accept = (chatId: string, kind: 'private' | 'group', actor = userId) => service.pairings.accept(botId, botId, {
      id: '1', at: Date.now(), chat: { id: chatId, kind }, user: { id: actor, label: 'Person' }, text: `/start ${code}`,
      addressed: true, command: { kind: 'command', name: 'start', args: code } });
    if (group && path === 'token') {
      expect(accept(groupId, 'group')).toBe('candidate');
      const status = service.setupStatus(id);
      await expect(service.activateSetup(id, { activate: true, taskControl: true, permissions: ['respond'], groupVisibilityAccepted: true,
        comparisonVerified: true, expectedRevision: status.inboundRevision, candidateUserId: userId })).rejects.toMatchObject({ code: 'comparison_required' });
      expect(posts).toEqual([]);
      expect(accept(privateId, 'private', '789')).toBe('ignored');
    }
    expect(accept(privateId, 'private')).toBe('candidate');
    const status = service.pairing(id);
    expect(status.candidate).toMatchObject({ userId, chatId: privateId, chatType: 'private' });
    const approval = { expectedRevision: status.inboundRevision, candidateUserId: userId, ...(group ? { comparisonVerified: true as const } : {}) };
    const result = path === 'pair' ? await service.confirm(id, approval) : await service.activateSetup(id, {
      ...approval, activate: true, taskControl: true, permissions: ['respond'], ...(group ? { groupVisibilityAccepted: true as const } : {}) });
    expect(result.grant?.chatId).toBe(receiver.chatId);
    await expect.poll(() => posts.length, { timeout: 1500 }).toBe(1);
    expect(posts[0]!.destination).toBe(privateId);
    expect(posts[0]!.text).toContain('Access granted');
    await expect(service.confirm(id, approval)).rejects.toThrow();
    expect(posts).toHaveLength(1);
  });
}
