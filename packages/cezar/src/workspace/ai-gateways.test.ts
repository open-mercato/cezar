import { spawn } from 'node:child_process';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aiGatewaySecretName } from '@open-mercato/cezar-contract';
import { cezarHomeDir, workspaceConfigPath } from '../paths.ts';
import { loadWorkspaceConfig, mergeWriteWorkspaceConfig, workspaceConfigBackupPath } from './config.ts';
import { AiGatewayError, AiGateways } from './ai-gateways.ts';
import { FileLockTimeoutError } from './file-lock.ts';
import { SecretStore } from './secrets.ts';

const auth = {
  protocols: { 'openai-responses': 'bearer' as const },
  catalog: 'bearer' as const,
};

const custom = {
  name: ' Sandbox ',
  baseUrl: 'https://gateway.example/v1/',
  protocols: ['openai-responses' as const],
  auth,
  apiKey: 'sk-sandbox',
};

function gateways(): AiGateways {
  return new AiGateways(new SecretStore(process.env, { keychain: async () => null }));
}

const children: Array<{ kill: (signal?: NodeJS.Signals) => boolean }> = [];

describe('AI gateways store', () => {
  beforeEach(async () => {
    await rm(workspaceConfigPath(), { force: true });
    await rm(workspaceConfigBackupPath(), { recursive: true, force: true });
    await rm(`${workspaceConfigPath()}.lock`, { recursive: true, force: true });
    await rm(join(cezarHomeDir(), 'ai-gateways.lock'), { recursive: true, force: true });
    await rm(join(cezarHomeDir(), 'secrets'), { recursive: true, force: true });
  });

  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
  });

  const formerOpenRouterDefault = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    provisioningKey: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    protocols: ['openai-completions', 'openai-responses', 'anthropic-messages'],
    auth: {
      protocols: {
        'openai-completions': 'bearer',
        'openai-responses': 'bearer',
        'anthropic-messages': 'bearer',
      },
      catalog: 'bearer',
    },
    enabled: false,
    routingRevision: 'rev',
  };

  it('starts empty and does not invent a provider', async () => {
    const first = await gateways().list();
    expect(first.gateways).toEqual([]);
    expect(first.unavailable).toEqual([]);
    expect(first.secretsSkipped).toBeUndefined();
    expect((await loadWorkspaceConfig()).aiGateways).toBeUndefined();

    const again = await gateways().list();
    expect(again.gateways).toEqual([]);
  });

  it('drops an untouched OpenRouter default and keeps a gateway the operator saved', async () => {
    const kept = {
      id: '550e8400-e29b-41d4-a716-446655440001',
      name: 'Already',
      baseUrl: 'https://gateway.example/v1',
      protocols: ['openai-responses'],
      auth,
      enabled: false,
      routingRevision: 'rev',
    };
    const renamed = { ...formerOpenRouterDefault, id: '550e8400-e29b-41d4-a716-446655440002', name: 'My router' };
    await writeFile(workspaceConfigPath(), JSON.stringify({
      aiGatewaysSeeded: true,
      aiGateways: [formerOpenRouterDefault, kept, renamed],
    }));
    const listed = await gateways().list();
    expect(listed.gateways.map((gateway) => gateway.name).sort()).toEqual(['Already', 'My router']);
    expect(listed.gateways.some((gateway) => gateway.provisioningKey === 'openrouter' && gateway.name === 'OpenRouter')).toBe(false);

    const withKey = { ...formerOpenRouterDefault, id: '550e8400-e29b-41d4-a716-446655440003' };
    await writeFile(workspaceConfigPath(), JSON.stringify({ aiGateways: [withKey] }));
    const secrets = new SecretStore(process.env, { keychain: async () => null });
    await secrets.set({ kind: 'workspace' }, aiGatewaySecretName(withKey.id), 'sk-kept', ['cezar']);
    const preserved = await gateways().list();
    expect(preserved.gateways.map((gateway) => gateway.id)).toEqual([withKey.id]);
    expect(preserved.gateways[0]?.hasApiKey).toBe(true);

    await writeFile(workspaceConfigPath(), JSON.stringify({ aiGateways: [formerOpenRouterDefault] }));
    const created = await gateways().create({ ...custom, apiKey: undefined, enabled: false });
    expect((await gateways().list()).gateways.map((gateway) => gateway.id)).toEqual([created.id]);
  });

  it('rejects an unreadable registry instead of showing an empty saved list', async () => {
    await writeFile(workspaceConfigPath(), JSON.stringify({ aiGateways: { bad: true } }));
    const listed = await gateways().list();
    expect(listed.registryError).toMatch(/could not be read/);
    expect(listed.gateways).toEqual([]);
    expect(JSON.parse(await readFile(workspaceConfigPath(), 'utf8')).aiGateways).toEqual({ bad: true });
  });

  it('creates, preserves a blank key replacement, and rotates without changing the routing revision', async () => {
    const store = gateways();
    const created = await store.create({ ...custom, enabled: true });
    expect(created).toMatchObject({
      name: 'Sandbox',
      baseUrl: 'https://gateway.example/v1',
      enabled: true,
      hasApiKey: true,
    });
    expect(created.provisioningKey).toBeUndefined();
    const revision = created.routingRevision;

    const renamed = await store.update(created.id, { name: 'Renamed' });
    expect(renamed.name).toBe('Renamed');
    expect(renamed.routingRevision).toBe(revision);
    expect(renamed.hasApiKey).toBe(true);

    const secrets = new SecretStore(process.env, { keychain: async () => null });
    const before = await secrets.list({ kind: 'workspace' });
    const same = await store.update(created.id, { apiKey: 'sk-sandbox' });
    const after = await secrets.list({ kind: 'workspace' });
    expect(same.routingRevision).toBe(revision);
    expect(after.secrets.find((entry) => entry.name === aiGatewaySecretName(created.id))?.updatedAt)
      .toBe(before.secrets.find((entry) => entry.name === aiGatewaySecretName(created.id))?.updatedAt);

    const rotated = await store.update(created.id, { apiKey: 'sk-next' });
    expect(rotated.routingRevision).toBe(revision);
    const resolved = await secrets.resolve(undefined, 'cezar', [aiGatewaySecretName(created.id)]);
    expect(resolved.values[aiGatewaySecretName(created.id)]).toBe('sk-next');

    const moved = await store.update(created.id, { baseUrl: 'https://other.example/v1' });
    expect(moved.routingRevision).not.toBe(revision);
  });

  it('does not store an invalid gateway or echo its key', async () => {
    const store = gateways();
    const secret = 'sk-do-not-echo-this';
    await expect(store.create({ ...custom, baseUrl: 'https://user:secret@gateway.example/v1', apiKey: secret }))
      .rejects.toThrow(AiGatewayError);
    expect((await loadWorkspaceConfig()).aiGateways).toBeUndefined();
    await expect(store.create({ ...custom, apiKey: '' })).rejects.toThrow(/invalid/i);
    try {
      await store.create({ ...custom, apiKey: '' });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it('stops at 100 records and keeps a malformed row unavailable', async () => {
    const store = gateways();
    const kept = await store.create({ ...custom, apiKey: undefined, enabled: false });
    await mergeWriteWorkspaceConfig((config) => {
      const rows = Array.isArray(config.aiGateways) ? [...config.aiGateways] : [];
      const broken = '550e8400-e29b-41d4-a716-446655440001';
      rows.push({ id: broken, provisioningKey: 'Not A Key' });
      while (rows.length < 100) rows.push({ id: `filler-${rows.length}` });
      config.aiGateways = rows;
    });
    await expect(store.create(custom)).rejects.toMatchObject({ code: 'capacity' });
    const listed = await store.list();
    expect(listed.gateways.map((gateway) => gateway.id)).toEqual([kept.id]);
    expect(listed.unavailable.map((row) => row.id)).toEqual(['550e8400-e29b-41d4-a716-446655440001']);
    await expect(store.update('550e8400-e29b-41d4-a716-446655440001', { name: 'Nope' }))
      .rejects.toMatchObject({ code: 'unavailable' });
    await store.remove('550e8400-e29b-41d4-a716-446655440001');
    expect((await store.list()).unavailable).toEqual([]);
  });

  it('waits on the gateway lock and does not write a gateway list', async () => {
    const lock = join(cezarHomeDir(), 'ai-gateways.lock');
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], { stdio: 'ignore' });
    children.push(child);
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, String(child.pid)), '');
    const store = new AiGateways(new SecretStore(process.env, { keychain: async () => null }), 80);
    await expect(store.list()).rejects.toBeInstanceOf(FileLockTimeoutError);
    expect((await loadWorkspaceConfig()).aiGateways).toBeUndefined();
  });

  it('refuses to enable a gateway that has no key', async () => {
    const store = gateways();
    const created = await store.create({ ...custom, apiKey: undefined, enabled: false });
    await expect(store.update(created.id, { enabled: true })).rejects.toThrow(/API key/);
    expect((await store.list()).gateways.find((gateway) => gateway.id === created.id)?.enabled).toBe(false);
    expect(created.pendingWrite).toBeUndefined();
  });

  it('marks a key write pending in both copies before the vault, then clears it', async () => {
    const secrets = new WatchingSecrets();
    const store = new AiGateways(secrets);
    const created = await store.create(custom);
    expect(secrets.primaryPending).toBe(true);
    expect(secrets.backupPending).toBe(true);
    expect(created.pendingWrite).toBeUndefined();
    expect(created.hasApiKey).toBe(true);
    expect(secrets.calls).toBe(1);

    await store.update(created.id, { apiKey: 'sk-sandbox' });
    expect(secrets.calls).toBe(1);

    secrets.fail = true;
    const secret = 'sk-do-not-echo';
    await expect(store.update(created.id, { apiKey: secret })).rejects.toThrow(/could not be saved/);
    try {
      await store.update(created.id, { apiKey: secret });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
    const pending = (await store.list()).gateways.find((gateway) => gateway.id === created.id);
    expect(pending).toMatchObject({ pendingWrite: true, hasApiKey: true, name: 'Sandbox' });
    await expect(store.update(created.id, { name: 'Still pending' })).rejects.toThrow(/interrupted/);
    expect((await store.list()).gateways.find((gateway) => gateway.id === created.id)?.name).toBe('Sandbox');

    secrets.fail = false;
    const repaired = await store.update(created.id, { apiKey: 'sk-repaired', name: 'Repaired' });
    expect(repaired).toMatchObject({ name: 'Repaired', hasApiKey: true });
    expect(repaired.pendingWrite).toBeUndefined();

    secrets.fail = true;
    await expect(store.create({ ...custom, name: 'Other', apiKey: 'sk-do-not-echo' })).rejects.toThrow(/could not be saved/);
    expect((await store.list()).gateways.find((gateway) => gateway.name === 'Other'))
      .toMatchObject({ pendingWrite: true, hasApiKey: false });
  });

  it('restores the ready record when the backup copy cannot be written', async () => {
    const store = gateways();
    await store.list();
    await rm(workspaceConfigBackupPath(), { force: true });
    await mkdir(workspaceConfigBackupPath());
    const secrets = new WatchingSecrets();
    await expect(new AiGateways(secrets).create(custom)).rejects.toThrow();
    expect(secrets.calls).toBe(0);
    const saved = await loadWorkspaceConfig();
    const rows = Array.isArray(saved.aiGateways) ? saved.aiGateways : [];
    expect(rows.some((row) => isRecord(row) && row.name === 'Sandbox')).toBe(false);
    const listed = await store.list();
    expect(listed.gateways.some((gateway) => gateway.name === 'Sandbox')).toBe(false);
  });

  it('stores a runner default without touching agent defaults', async () => {
    const store = gateways();
    await mergeWriteWorkspaceConfig((config) => { config.agentDefaults = { runner: 'codex' }; });
    const created = await store.create(custom);
    await store.setDefault('claude', created.id);
    const saved = await loadWorkspaceConfig();
    expect(saved.agentDefaults).toMatchObject({ runner: 'codex' });
    expect(saved.aiGatewayDefaults).toEqual({ claude: created.id });
    await store.setDefault('claude', null);
    expect((await loadWorkspaceConfig()).aiGatewayDefaults).toEqual({});
    await writeFile(workspaceConfigPath(), JSON.stringify({ aiGatewayDefaults: 'nope', agentDefaults: { runner: 'codex' } }));
    await expect(store.setDefault('claude', 'native')).rejects.toMatchObject({ code: 'unavailable' });
    expect(JSON.parse(await readFile(workspaceConfigPath(), 'utf8')).aiGatewayDefaults).toBe('nope');
  });
});

class WatchingSecrets extends SecretStore {
  calls = 0;
  primaryPending = false;
  backupPending = false;
  fail = false;

  constructor() {
    super(process.env, { keychain: async () => null });
  }

  override async set(...args: Parameters<SecretStore['set']>): Promise<void> {
    const pending = (raw: string): boolean => {
      const parsed = JSON.parse(raw) as { aiGateways?: unknown };
      return Array.isArray(parsed.aiGateways) && parsed.aiGateways.some((row) => isRecord(row) && row.pendingWrite === true && row.name === 'Sandbox');
    };
    this.primaryPending = pending(await readFile(workspaceConfigPath(), 'utf8'));
    this.backupPending = pending(await readFile(workspaceConfigBackupPath(), 'utf8'));
    this.calls += 1;
    if (this.fail) throw new Error('vault failed');
    return super.set(...args);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
