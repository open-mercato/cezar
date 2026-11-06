import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SecretStore } from '../workspace/secrets.ts';
import { EndpointRegistry, type EndpointDependencies } from './endpoints.ts';
import { TelegramSecrets, TELEGRAM_ORIGIN } from './telegram-secrets.ts';

const token = `123456789:${'T'.repeat(35)}`;
const url = `${TELEGRAM_ORIGIN}/bot${token}/sendMessage`;
const input = { name: 'Telegram', format: 'telegram.v1' as const, url, telegramChatId: '42' };
const roots: string[] = [];
async function setup() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'telegram-vault-')); roots.push(root);
  const home = join(root, 'home');
  const store = new SecretStore({ ...process.env, CEZ_HOME: home }, { keychain: async () => null });
  const scope = { kind: 'project' as const, projectId: 'test', root };
  const secrets = new TelegramSecrets(scope, store);
  const deps: EndpointDependencies = { telegramSecrets: secrets, installationId: 'inst_test', highWater: () => 0, now: () => Date.now(), assertOwner() {} };
  const registry = await EndpointRegistry.open(root, deps);
  const persisted = () => JSON.parse(readFileSync(join(root, 'endpoints.json'), 'utf8'));
  const reopen = () => EndpointRegistry.open(root, { ...deps, telegramSecrets: new TelegramSecrets(scope, new SecretStore({ ...process.env, CEZ_HOME: home }, { keychain: async () => null })) });
  return { root, home, store, scope, secrets, deps, registry, persisted, reopen };
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('Telegram token vault storage', () => {
  it('keeps only a reference in endpoints, encrypts the token and excludes it from check environments', async () => {
    const x = await setup(); const { receiver } = await x.registry.create(input);
    const disk = x.persisted().receivers[0];
    expect(disk.url).toBe(TELEGRAM_ORIGIN); expect(disk.telegramSecret.name).toMatch(/^WEBHOOK_TELEGRAM_/);
    expect(JSON.stringify(x.persisted())).not.toContain(token);
    expect(readFileSync(join(x.home, 'secrets/test.json'), 'utf8')).not.toContain(token);
    expect((await x.store.read(x.scope)).values[disk.telegramSecret.name]).toMatchObject({ value: token, audiences: ['cezar'] });
    expect((await x.store.resolve({ projectId: 'test', root: x.root }, 'checks')).values).toEqual({});
    const restarted = await x.reopen();
    expect(await restarted.destinationUrl(restarted.privateReceiver(receiver.id)!)).toBe(url);
    expect(JSON.stringify(restarted.list())).not.toContain(token);
    const named = await restarted.create({ name: `leak ${token}`, url: 'https://example.com' });
    expect(named.receiver.name).not.toContain(token);
    const edited = await restarted.update(receiver.id, { ...input, url: undefined, name: 'Renamed', expectedRevision: 1 });
    expect(edited.deliveryRevision).toBe(1);
    expect(x.persisted().receivers[0].telegramSecret).toEqual(disk.telegramSecret);
  });

  it('treats a Telegram entry without a vault reference as credentials-unavailable, never migrating it', async () => {
    const x = await setup(); const first = (await x.registry.create(input)).receiver;
    const plain = x.persisted(); delete plain.receivers[0].telegramSecret; plain.receivers[0].url = url;
    writeFileSync(join(x.root, 'endpoints.json'), JSON.stringify(plain));
    const set = vi.spyOn(SecretStore.prototype, 'set');
    const restarted = await x.reopen();
    expect(set).not.toHaveBeenCalled();
    expect(restarted.privateReceiver(first.id)).not.toHaveProperty('telegramSecret');
    expect(restarted.list().webhookHealth).toMatchObject({ status: 'degraded' });
    await expect(restarted.destinationUrl(restarted.privateReceiver(first.id)!)).rejects.toMatchObject({ status: 409 });
    const custom = (await restarted.create({ name: 'Custom', url: 'https://example.com' })).receiver;
    await expect(restarted.activate(custom.id, 1)).resolves.toMatchObject({ state: 'active' });
    expect(JSON.stringify(x.persisted())).not.toContain(token);
  });

  it('reports a failed or skipped vault read as transient (503), a missing entry as gone (409)', async () => {
    const x = await setup(); const { receiver } = await x.registry.create(input);
    const current = x.registry.privateReceiver(receiver.id)!;
    vi.spyOn(x.store, 'read').mockRejectedValueOnce(new Error('keychain locked'));
    await expect(x.registry.destinationUrl(current)).rejects.toMatchObject({ status: 503 });
    vi.spyOn(x.store, 'read').mockResolvedValueOnce({ values: {}, skipped: 'the data key is gone' });
    await expect(x.registry.destinationUrl(current)).rejects.toMatchObject({ status: 503 });
    vi.restoreAllMocks(); expect(await x.registry.destinationUrl(current)).toBe(url);
    await x.store.unset(x.scope, current.telegramSecret!.name);
    await expect(x.registry.destinationUrl(current)).rejects.toMatchObject({ status: 409 });
  });

  it('never writes a new plaintext Telegram receiver when the vault fails', async () => {
    const x = await setup(); vi.spyOn(x.store, 'set').mockRejectedValue(new Error(token));
    await expect(x.registry.create(input)).rejects.toThrow('Telegram token is unavailable');
    expect(x.registry.list().receivers).toEqual([]);
    expect(() => x.persisted()).toThrow();
  });

  it('pins token identity and permissions, refusing direct vault edits or deletion', async () => {
    const x = await setup(); const { receiver } = await x.registry.create(input);
    const privateReceiver = x.registry.privateReceiver(receiver.id)!; const ref = privateReceiver.telegramSecret!;
    await x.store.set(x.scope, ref.name, token.replaceAll('T', 'U'), ['cezar']);
    await expect(x.registry.destinationUrl(privateReceiver)).rejects.toThrow('unavailable or changed');
    await x.store.set(x.scope, ref.name, token, ['checks']);
    await expect(x.registry.destinationUrl(privateReceiver)).rejects.toThrow('unavailable or changed');
    await x.store.unset(x.scope, ref.name);
    await expect(x.registry.destinationUrl(privateReceiver)).rejects.toThrow('unavailable or changed');
    const restarted = await x.reopen();
    expect(restarted.list().receivers).toHaveLength(1);
    expect(restarted.list().webhookHealth.status).toBe('degraded');
    await expect(restarted.update(receiver.id, { ...input, url: undefined, expectedRevision: 1 })).rejects.toThrow('unavailable or changed');
    const repaired = await restarted.update(receiver.id, { ...input, expectedRevision: 1 });
    expect(repaired).toMatchObject({ state: 'inactive', deliveryRevision: 2, lastTest: 'none' });
    expect(restarted.list().webhookHealth.status).toBe('ready');
  });

  it('rotates through a fresh slot, resets fences, and cleans up after deletion or leaving Telegram', async () => {
    const x = await setup(); const { receiver } = await x.registry.create(input);
    await x.registry.testResult(receiver.id, 1, 1, 'success'); await x.registry.activate(receiver.id, 1);
    const before = x.persisted().receivers[0].telegramSecret;
    const updated = await x.registry.update(receiver.id, { ...input, url: url.replaceAll('T', 'U'), expectedRevision: 2 });
    expect(updated).toMatchObject({ state: 'inactive', lastTest: 'none', deliveryRevision: 2 });
    expect(x.persisted().receivers[0].telegramSecret.name).not.toBe(before.name);
    expect((await x.store.read(x.scope)).values[before.name]).toBeUndefined();
    await x.registry.delete(receiver.id, updated.revision);
    expect((await x.store.list(x.scope)).secrets).toEqual([]);
    const again = (await x.registry.create(input)).receiver;
    await x.registry.update(again.id, { name: 'Custom', url: 'https://example.com', expectedRevision: 1 });
    expect(x.persisted().receivers[0]).not.toHaveProperty('telegramSecret');
    expect((await x.store.list(x.scope)).secrets).toEqual([]);
  });

  it('leaves the old credential usable if publication fails during rotation', async () => {
    const x = await setup(); const { receiver } = await x.registry.create(input);
    const oldDisk = x.persisted();
    x.deps.reserve = () => { throw new Error('disk capacity'); };
    await expect(x.registry.update(receiver.id, { ...input, url: url.replaceAll('T', 'U'), expectedRevision: 1 })).rejects.toThrow('disk capacity');
    expect(x.persisted()).toEqual(oldDisk);
    expect((await x.store.list(x.scope)).secrets).toHaveLength(1);
    expect(await x.registry.destinationUrl(x.registry.privateReceiver(receiver.id)!)).toBe(url);
  });

  it('does not overwrite unrelated secrets when the encryption key is missing', async () => {
    const x = await setup(); await x.registry.create(input);
    const ciphertext = readFileSync(join(x.home, 'secrets/test.json'), 'utf8');
    rmSync(join(x.home, 'secrets/.key'));
    const restarted = await x.reopen();
    await expect(restarted.create(input)).rejects.toThrow('Telegram token is unavailable');
    expect(readFileSync(join(x.home, 'secrets/test.json'), 'utf8')).toBe(ciphertext);
  });

  it('lets a reused project slug create its own token without inheriting the former project token', async () => {
    const x = await setup(); const { receiver } = await x.registry.create(input);
    const original = x.registry.privateReceiver(receiver.id)!.telegramSecret!;
    const otherRoot = mkdtempSync(join(realpathSync(tmpdir()), 'telegram-vault-new-root-')); roots.push(otherRoot);
    const replacement = new TelegramSecrets({ ...x.scope, root: otherRoot }, x.store);
    await expect(replacement.url(original)).rejects.toThrow('unavailable');
    const next = await replacement.save(receiver.id, url.replaceAll('T', 'U'));
    expect(await replacement.url(next)).toBe(url.replaceAll('T', 'U'));
    await expect(x.secrets.url(next)).rejects.toThrow('unavailable');
  });

  it('isolates projects and dry-run credentials and leaves Slack/Discord URLs unchanged', async () => {
    const x = await setup(); const { receiver } = await x.registry.create(input);
    const ref = x.registry.privateReceiver(receiver.id)!.telegramSecret!;
    const elsewhere = new TelegramSecrets({ ...x.scope, projectId: 'other' }, x.store);
    await expect(elsewhere.url(ref)).rejects.toThrow('unavailable');
    const dry = new TelegramSecrets(x.scope, x.store, true);
    const dryRef = await dry.save(receiver.id, url);
    expect(dryRef.name).toContain('_DRY_'); expect(dryRef.name).not.toBe(ref.name);
    await dry.remove(dryRef); expect(await x.secrets.url(ref)).toBe(url);
    for (const [format, target] of [['slack.v1', 'https://hooks.slack.com/services/TA/BB/secret'], ['discord.v1', `https://discord.com/api/webhooks/12345678901234567/${'D'.repeat(60)}`]] as const) {
      const item = (await x.registry.create({ name: format, format, url: target })).receiver;
      expect(x.persisted().receivers.find((r: { id: string }) => r.id === item.id)).toMatchObject({ url: target });
    }
    expect((await x.store.list(x.scope)).secrets).toHaveLength(1);
  });
});
