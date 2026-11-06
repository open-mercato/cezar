import { expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
const request = vi.hoisted(() => vi.fn());
vi.mock('undici', () => ({ Agent: class { async destroy() {} }, request }));
import { WebhookService } from '../webhooks/service.ts';
import { WebhookScheduler } from '../webhooks/scheduler.ts';
import { sendWebhook } from '../webhooks/transport.ts';
import { TelegramSecrets } from '../webhooks/telegram-secrets.ts';
import { SecretStore } from '../workspace/secrets.ts';
import type { TelegramCall } from '../telegram/client.ts';

// Through the boot sequence the coordinator runs (open → start → startTelegram): setup links, like
// pairings, do not survive a restart (spec 2026-10-29-telegram-setup-and-replies), so a bot with no grant stays idle.
it('a restarted service forgets an interrupted setup and does not poll its bot', async () => {
  vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_CHAT_INBOUND', '1');
  const root = await mkdtemp(join(tmpdir(), 'telegram-restart-'));
  execFileSync('git', ['init', '-q'], { cwd: root, timeout: 10000 });
  const dataDir = join(root, '.ai/cezar'), botId = randomInt(100000, 99999999);
  request.mockImplementation(async () => ({ statusCode: 200, headers: {}, body: Object.assign((async function* () {
    yield Buffer.from(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 456 } } }));
  })(), { once() {}, destroy() {} }) }));
  let polls = 0;
  const call: TelegramCall = async (method, _body, signal) => {
    if (method === 'getMe') return { id: botId, username: 'test_bot', first_name: 'Test' };
    if (method === 'getUpdates') { polls++; return new Promise(resolve => signal?.addEventListener('abort', () => resolve([]), { once: true })); }
    return { message_id: 1, chat: { id: 456 } };
  };
  const vault = new SecretStore({ ...process.env, CEZ_HOME: join(root, 'vault') }, { keychain: async () => null });
  const open = async () => (await WebhookService.open({ root, dataDir, projectId: 'project', mode: 'local', serverPorts: () => [], scheduler: new WebhookScheduler(),
    telegramSecrets: new TelegramSecrets({ kind: 'project', projectId: 'project', root }, vault), telegramCall: () => call,
    send: input => sendWebhook(input, { lookup: async () => [{ address: '8.8.8.8', family: 4 }] }) }))!;
  let first: WebhookService | undefined, restarted: WebhookService | undefined;
  try {
    first = await open();
    const { receiver } = await first.create({ name: 'Restart', format: 'telegram.v1', url: `https://api.telegram.org/bot${botId}:${'A'.repeat(35)}/sendMessage`, telegramChatId: '456', profile: 'standard', graceSeconds: 0 });
    await first.test(receiver.id, { expectedRevision: receiver.revision, deliveryRevision: receiver.deliveryRevision, operationId: 'initial-test' });
    await first.tick(); await first.activate(receiver.id, first.list().receivers[0]!.revision);
    const begun = await first.telegram.beginSetup({ receiverId: receiver.id, expectedRevision: first.telegram.list().receivers[0]!.inboundRevision, dedicatedBot: true });
    expect(first.telegram.list().grants ?? []).toHaveLength(0);
    await first.dispose(); first = undefined;
    polls = 0;
    restarted = await open();
    restarted.start();
    await restarted.startTelegram();
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(polls).toBe(0);
    expect(() => restarted!.telegram.setupStatus(begun.setupId)).toThrow(expect.objectContaining({ code: 'pairing_expired' }));
    expect((await readdir(dataDir, { recursive: true })).filter(file => file.endsWith('setups.json'))).toEqual([]);
  } finally {
    await first?.dispose(); await restarted?.dispose();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
