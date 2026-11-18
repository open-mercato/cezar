import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { EndpointRegistry } from './endpoints.ts';
import { ChatSecrets } from '../chat/credentials.ts';
import { SecretStore } from '../workspace/secrets.ts';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
it.each([
  ['slack.v1', 'https://hooks.slack.com/services/TA/BB/old', 'https://slack.com/api/chat.postMessage', 'private:TTEAM:UBOT:DCHAN', 'TTEAM:UBOT'],
  ['discord.v1', 'https://discord.com/api/webhooks/123456789012345678/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'https://discord.com/api/v10', 'discord:dm:123', '456'],
] as const)('attaches %s to the same receiver with private credentials, identity and revision fences', async (format, url, destination, chatId, botId) => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-attach-')); dirs.push(dir);
  const vault = new ChatSecrets({ kind: 'project', root: dir, projectId: 'test' }, new SecretStore({ ...process.env, CEZ_HOME: join(dir, 'home') }));
  const deps = { chatSecrets: vault, installationId: 'test', highWater: () => 0, now: Date.now, assertOwner() {} };
  const registry = await EndpointRegistry.open(dir, deps);
  const original = (await registry.create({ name: 'Ops', format, url })).receiver;
  if (format === 'slack.v1') await expect(registry.attachChat({ receiverId: original.id, expectedRevision: original.revision, format, url: destination, chatId, botId: 'TTEAM:UOTHER', credential: 'wrong-bot' })).rejects.toThrow('another bot');
  const attached = await registry.attachChat({ receiverId: original.id, expectedRevision: original.revision, format, url: destination, chatId, botId, credential: 'private-fixture-credential' });
  expect(attached).toMatchObject({ id: original.id, state: 'inactive', lastTest: 'none', deliveryRevision: 2, chatId, chatBotId: botId });
  await expect(registry.activate(attached.id, attached.revision)).rejects.toThrow('successful test');
  await expect(registry.attachChat({ receiverId: original.id, expectedRevision: original.revision, format, url: destination, chatId, botId, credential: 'stale' })).rejects.toThrow('revision changed');
  expect(await registry.chatCredential(attached)).toBe('private-fixture-credential');
  expect(await readFile(join(dir, 'endpoints.json'), 'utf8')).not.toContain('private-fixture-credential');
  expect(JSON.stringify(registry.list())).not.toMatch(/chatSecret|chatBotId|private-fixture-credential/);
  const reopened = await EndpointRegistry.open(dir, deps);
  expect(reopened.privateReceiver(original.id)).toMatchObject({ chatBotId: botId, chatId, url: destination });
  expect(await reopened.chatCredential(reopened.privateReceiver(original.id)!)).toBe('private-fixture-credential');
  const edited = await reopened.update(original.id, { name: 'Renamed', format, expectedRevision: attached.revision });
  expect(reopened.privateReceiver(original.id)).toMatchObject({ chatBotId: botId, chatId, url: destination });
  expect(edited.id).toBe(original.id);
});
