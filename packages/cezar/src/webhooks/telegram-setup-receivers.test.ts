import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { clearSharedTelegramCooldowns } from '../telegram/send-budget.ts';
import { SecretStore } from '../workspace/secrets.ts';
import { WebhookScheduler } from './scheduler.ts';
import { WebhookService } from './service.ts';
import { TelegramSecrets } from './telegram-secrets.ts';
import type { PrivateReceiver } from './endpoints.ts';
import type { SendResult, WebhookSend } from './transport.ts';

const roots: string[] = [];
const services: WebhookService[] = [];
afterEach(async () => {
  clearSharedTelegramCooldowns();
  for (const service of services.splice(0)) await service.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
const token = `123456789:${'T'.repeat(35)}`;
const url = `https://api.telegram.org/bot${token}/sendMessage`;
/** The seams the Telegram setup reaches the webhook service through. */
type Seams = {
  createReceiverFromToken(token: string, name: string | undefined, chatId: string, existingId?: string): Promise<PrivateReceiver>;
  removeBotReceivers(botId: string, receiverIds: readonly string[]): Promise<void>;
};
async function open() {
  vi.stubEnv('CEZ_WEBHOOKS', '1');
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'telegram-setup-receivers-')); roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  const send = vi.fn(async (_input: WebhookSend): Promise<SendResult> => ({ kind: 'http', status: 200, response: '{"ok":true,"result":{"message_id":1,"chat":{"id":42}}}' }));
  const vault = new SecretStore({ ...process.env, CEZ_HOME: join(root, 'vault-home') }, { keychain: async () => null });
  const scope = { kind: 'project' as const, projectId: 'project', root };
  const service = (await WebhookService.open({ root, dataDir: join(root, '.ai/cezar'), projectId: 'project', mode: 'local', serverPorts: () => [4317],
    scheduler: new WebhookScheduler(), send, telegramSecrets: new TelegramSecrets(scope, vault) }))!;
  services.push(service);
  const tokens = async () => (await vault.list(scope)).secrets.filter(secret => secret.name.startsWith('WEBHOOK_TELEGRAM_'));
  const seams = (service.telegram as unknown as { deps: Seams }).deps;
  return { service, send, tokens, seams, busy: (value: boolean) => { (service as unknown as { inFlight: boolean }).inFlight = value; } };
}
const settings = (receiver: { name: string; telegramChatId?: string; profile: 'minimal' | 'standard'; graceSeconds: 0 | 60 | 180 | 600; revision: number }) => ({
  name: receiver.name, format: 'telegram.v1' as const, telegramChatId: receiver.telegramChatId, profile: receiver.profile, preset: 'attention' as const, events: [],
  includeScheduledFailures: false, scope: 'main_and_questions' as const, graceSeconds: receiver.graceSeconds, allowLocalNetwork: false, expectedRevision: receiver.revision,
});

it('deletes the receiver it made, vault entry included, when the setup test fails', async () => {
  const x = await open();
  x.send.mockResolvedValue({ kind: 'http', status: 400, response: '{"ok":false,"description":"Bad Request: chat not found"}' });
  await expect(x.seams.createReceiverFromToken(token, 'Phone', '42')).rejects.toThrow('Telegram receiver test failed');
  expect(x.service.list().receivers).toEqual([]);
  expect(await x.tokens()).toEqual([]);
});
it('waits for the real test result instead of a single drain', async () => {
  const x = await open();
  // Another send is in flight when the test is queued: the first drain cannot claim it.
  x.busy(true);
  setTimeout(() => x.busy(false), 300);
  const receiver = await x.seams.createReceiverFromToken(token, 'Phone', '42');
  expect(receiver).toMatchObject({ state: 'active', lastTest: 'success', telegramChatId: '42' });
  expect(x.send).toHaveBeenCalledTimes(1);
});
it('reuses an existing receiver instead of adding a second one for the same chat', async () => {
  const x = await open();
  const first = await x.seams.createReceiverFromToken(token, 'Phone', '42');
  const again = await x.seams.createReceiverFromToken(token, 'Phone', '42', first.id);
  expect(again.id).toBe(first.id); expect(x.service.list().receivers).toHaveLength(1);
  expect(x.send).toHaveBeenCalledTimes(1);
  // A new token for the same bot and chat replaces the stored one, retested, still one receiver.
  const rotated = `123456789:${'U'.repeat(35)}`;
  const replaced = await x.seams.createReceiverFromToken(rotated, 'Phone', '42', first.id);
  expect(replaced).toMatchObject({ id: first.id, state: 'active', lastTest: 'success' });
  expect(x.service.list().receivers).toHaveLength(1); expect(await x.tokens()).toHaveLength(1);
  expect(x.send).toHaveBeenLastCalledWith(expect.objectContaining({ url: `https://api.telegram.org/bot${rotated}/sendMessage` }));
});
it('edits a wizard-made receiver’s message options without its token, keeping it active and its delivery revision', async () => {
  const x = await open();
  const made = await x.seams.createReceiverFromToken(token, 'Phone', '42');
  const before = x.service.list().receivers[0]!;
  const updated = await x.service.update(made.id, { ...settings({ ...before, profile: 'standard', graceSeconds: 60 }), includeAgentExcerpt: true });
  expect(updated).toMatchObject({ state: 'active', deliveryRevision: before.deliveryRevision, profile: 'standard', graceSeconds: 60, includeAgentExcerpt: true, lastTest: 'success' });
  const minimal = await x.service.update(made.id, settings({ ...updated, profile: 'minimal', graceSeconds: 0 }));
  expect(minimal).toMatchObject({ state: 'active', deliveryRevision: before.deliveryRevision, profile: 'minimal' });
  expect(minimal).not.toHaveProperty('includeAgentExcerpt');
  // Test, pause, resume and delete need no token either: the vault holds it.
  await x.service.test(made.id, { expectedRevision: minimal.revision, deliveryRevision: minimal.deliveryRevision, operationId: 'per-chat-test' });
  await x.service.tick();
  expect(x.send).toHaveBeenLastCalledWith(expect.objectContaining({ url, format: 'telegram.v1' }));
  const paused = await x.service.pause(made.id, x.service.list().receivers[0]!.revision);
  const resumed = await x.service.resume(made.id, paused.revision);
  expect(resumed.state).toBe('active');
  await x.service.delete(made.id, resumed.revision);
  expect(x.service.list().receivers).toEqual([]); expect(await x.tokens()).toEqual([]);
});
it('a destination edit still needs a fresh test and activation', async () => {
  const x = await open();
  const made = await x.seams.createReceiverFromToken(token, 'Phone', '42');
  const before = x.service.list().receivers[0]!;
  const moved = await x.service.update(made.id, settings({ ...before, telegramChatId: '43' }));
  expect(moved).toMatchObject({ state: 'inactive', lastTest: 'none', deliveryRevision: before.deliveryRevision + 1 });
});
it('disconnecting a bot deletes every receiver that sends through it and nothing else', async () => {
  const x = await open();
  const first = await x.seams.createReceiverFromToken(token, 'Phone', '42');
  const second = await x.seams.createReceiverFromToken(token, 'Group', '-1001234567890');
  const other = await x.seams.createReceiverFromToken(`987654321:${'O'.repeat(35)}`, 'Other bot', '42');
  const slack = await x.service.create({ name: 'Slack', format: 'slack.v1', url: 'https://hooks.slack.com/services/T1/B1/test' });
  await x.seams.removeBotReceivers('123456789', [first.id]);
  expect(x.service.list().receivers.map(receiver => receiver.id).sort()).toEqual([other.id, slack.receiver.id].sort());
  expect(x.service.list().receivers.some(receiver => receiver.id === second.id)).toBe(false);
  expect(await x.tokens()).toHaveLength(1);
});
