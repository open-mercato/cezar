import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readAgentProviderKey, readAgentProviders, updateAgentProviders, type StoredProviderMethod } from './agent-providers.ts';
import { SecretStore } from './secrets.ts';
import * as keyring from './secret-keyring.ts';
import * as paths from '../paths.ts';
import * as files from '../fs-rename.ts';

let home: string;
let metadata: string;
const first = 'synthetic-first-9662';
const second = 'synthetic-rotated-9662'; // The same hint cannot identify a key.
const custom = (baseUrl = 'https://one.example'): StoredProviderMethod => ({
  kind: 'custom', addedAt: '2026-11-27', baseUrl,
});
async function put(value = first, url?: string) {
  await updateAgentProviders((state, keys) => {
    state.agents.claude = { active: 'custom', methods: { custom: custom(url) } };
    keys.set('claude', 'custom', value);
  });
}
async function method() {
  return (await readAgentProviders()).agents.claude!.methods.custom!;
}
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'cez-agent-providers-'));
  metadata = join(home, 'agent-providers.json');
  vi.stubEnv('CEZ_HOME', home);
  vi.stubEnv('CEZ_SECRETS_KEYCHAIN', '0');
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

it('reads an untouched home without writing, and persists explicit select-none', async () => {
  expect((await readAgentProviders()).agents).toEqual({});
  expect(await readAgentProviderKey('claude', 'custom')).toBeUndefined();
  expect(await readdir(home)).toEqual([]);
  await updateAgentProviders(state => { state.agents.codex = { active: null, methods: {} }; });
  expect((await readAgentProviders()).agents).toEqual({ codex: { active: null, methods: {} } });
  expect(await readdir(join(home, 'secrets'))).not.toContain('.key');
});

it('uses the existing data key, private files, and a namespace even a project named agent-providers cannot reach', async () => {
  const general = new SecretStore();
  const collision = { kind: 'project' as const, projectId: 'agent-providers', root: home };
  await general.set(collision, 'BUILD_TOKEN', 'synthetic-check-only');
  const priorKey = await readFile(join(home, 'secrets', '.key'));
  await put();
  expect(await readFile(join(home, 'secrets', '.key'))).toEqual(priorKey);
  expect(JSON.stringify(await readAgentProviders())).not.toContain(first);
  expect(await method()).toMatchObject({ kind: 'custom', keyHint: '…9662' });
  const dir = join(home, 'secrets');
  const names = await readdir(dir);
  for (const path of [metadata, ...names.map(name => join(dir, name))]) {
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, 'utf8')).not.toContain(first);
  }
  if (process.platform !== 'win32') expect((await stat(dir)).mode & 0o777).toBe(0o700);
  expect((await general.list(collision)).secrets.map(s => s.name)).toEqual(['BUILD_TOKEN']);
  expect((await general.list({ kind: 'workspace' })).secrets).toEqual([]);
  expect((await general.resolve(collision, 'checks')).values).toEqual({ BUILD_TOKEN: 'synthetic-check-only' });
  await general.unset(collision, 'BUILD_TOKEN');
  expect(await readAgentProviderKey('claude', 'custom', await method())).toBe(first);
});

it('keeps the key through an edit and identical apply, rotates without trusting the hint, and removes retired ciphertext', async () => {
  await put();
  const original = await method();
  const vaultFiles = () => readdir(join(home, 'secrets')).then(names => names.filter(n => n.endsWith('.vault')));
  const filesBefore = await vaultFiles();
  expect(filesBefore).toHaveLength(1);
  await put();
  expect(await method()).toEqual(original);
  await updateAgentProviders(state => {
    state.agents.claude!.methods.custom = { ...custom('https://two.example'), label: 'New endpoint' };
  });
  expect(await readAgentProviderKey('claude', 'custom')).toBe(first);
  await expect(readAgentProviderKey('claude', 'custom', original)).rejects.toThrow(/changed/i);
  const updated = await method();
  await put(second, updated.baseUrl);
  expect(await readAgentProviderKey('claude', 'custom', await method())).toBe(second);
  await expect(readAgentProviderKey('claude', 'custom', updated)).rejects.toThrow(/changed/i);
  expect(await vaultFiles()).toHaveLength(1);
  expect(await vaultFiles()).not.toEqual(filesBefore);
  await updateAgentProviders((state, keys) => {
    keys.remove('claude', 'custom');
    state.agents.claude!.active = null;
    delete state.agents.claude!.methods.custom;
  });
  expect(await readAgentProviderKey('claude', 'custom')).toBeUndefined();
  expect(await vaultFiles()).toEqual([]);
});

it('preserves cached models and the metadata inode for an identical key, and invalidates models on rotation or removal', async () => {
  await put();
  const models = { fetchedAt: '2026-11-27', ids: [{ id: 'model-one', label: 'One', contextLength: 1024 }] };
  await updateAgentProviders(state => { state.agents.claude!.methods.custom!.models = models; });
  const inode = (await stat(metadata)).ino;
  const setKey = (value: string) => updateAgentProviders((_state, keys) => keys.set('claude', 'custom', value));
  await setKey(first);
  expect((await method()).models).toEqual(models);
  expect((await stat(metadata)).ino).toBe(inode);
  await setKey(second);
  expect((await method()).models).toBeUndefined();
  await updateAgentProviders(state => { state.agents.claude!.methods.custom!.models = models; });
  await updateAgentProviders((_state, keys) => keys.remove('claude', 'custom'));
  const row = await method();
  expect(row.keyRef).toBeUndefined();
  expect(row.keyHint).toBeUndefined();
  expect(row.models).toBeUndefined();
  expect(await readAgentProviderKey('claude', 'custom', row)).toBeUndefined();
});

it('keeps the entire old configuration when publication fails after staging new ciphertext', async () => {
  await put();
  const before = await readFile(metadata, 'utf8');
  const beforeFiles = (await readdir(join(home, 'secrets'))).sort();
  const rename = files.renameWithRetry;
  vi.spyOn(files, 'renameWithRetry').mockImplementation(async (from, to, ...args) => {
    if (to === metadata) {
      const visible = await method();
      expect(visible.baseUrl).toBe(custom().baseUrl);
      expect(await readAgentProviderKey('claude', 'custom', visible)).toBe(first);
      throw new Error('simulated commit failure');
    }
    return rename(from, to, ...args);
  });
  await expect(put(second, 'https://two.example')).rejects.toThrow('simulated commit failure');
  expect(await readFile(metadata, 'utf8')).toBe(before);
  expect((await readdir(join(home, 'secrets'))).sort()).toEqual(beforeFiles);
  expect(await readAgentProviderKey('claude', 'custom', await method())).toBe(first);
});

it('retains both generations when rename succeeded but durability could not be confirmed', async () => {
  await put();
  const rename = files.renameWithRetry;
  const fault = vi.spyOn(files, 'renameWithRetry').mockImplementation(async (from, to, ...args) => {
    await rename(from, to, ...args);
    if (to === metadata) throw new Error('simulated failure after rename');
  });
  await expect(put(second, 'https://two.example')).rejects.toThrow('after rename');
  expect((await readdir(join(home, 'secrets'))).filter(n => n.endsWith('.vault'))).toHaveLength(2);
  expect(await readAgentProviderKey('claude', 'custom', await method())).toBe(second);
  fault.mockRestore();
  await updateAgentProviders(state => { state.agents.claude!.active = null; });
  expect((await readdir(join(home, 'secrets'))).filter(n => n.endsWith('.vault'))).toHaveLength(1);
});

it('binds ciphertext to its slot and generation, and does not echo a damaged vault', async () => {
  await put();
  await updateAgentProviders((s, keys) => {
    s.agents.codex = { methods: { custom: custom() } };
    keys.set('codex', 'custom', second);
  });
  const refs = (await readAgentProviders()).agents;
  const pathFor = (runner: 'claude' | 'codex') =>
    join(home, 'secrets', `.agent-provider-${refs[runner]!.methods.custom!.keyRef}.vault`);
  await writeFile(pathFor('codex'), await readFile(pathFor('claude')));
  await expect(readAgentProviderKey('codex', 'custom')).rejects.toThrow(/cannot be decrypted/);
  await writeFile(pathFor('codex'), first);
  await expect(readAgentProviderKey('codex', 'custom')).rejects.toThrow('invalid ciphertext');
  await expect(readAgentProviderKey('codex', 'custom')).rejects.not.toThrow(first);
});

it('refuses an inline key accidentally copied into metadata', async () => {
  const untrustedInput: Record<string, string> = { apiKey: first };
  await expect(updateAgentProviders(state => {
    state.agents.codex = { methods: { custom: { ...custom(), ...untrustedInput } } };
  })).rejects.toThrow('keys.set');
  await expect(stat(metadata)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.skipIf(process.platform === 'win32')('refuses unsafe metadata and ciphertext permissions', async () => {
  await put();
  const path = join(home, 'secrets', `.agent-provider-${(await method()).keyRef}.vault`);
  await chmod(path, 0o644);
  await expect(readAgentProviderKey('claude', 'custom')).rejects.toThrow(/0600/);
  await chmod(metadata, 0o644);
  expect((await readAgentProviders()).agents).toEqual({});
  await expect(put(second)).rejects.toThrow(/0600/);
});

it('salvages good records and future fields, and refuses to overwrite unreadable metadata', async () => {
  await writeFile(metadata, JSON.stringify({ version: 1, extra: 7, agents: {
    claude: { active: 'custom', extra: true, methods: { custom: { ...custom(), extra: 9, label: 12 }, broken: false } },
    codex: false,
  } }), { mode: 0o600 });
  const { agents } = await readAgentProviders();
  expect(agents.codex).toBeUndefined();
  expect(agents.claude?.methods.custom).toMatchObject({ ...custom(), extra: 9 });
  expect(agents.claude?.methods.custom?.label).toBeUndefined();
  expect(agents.claude?.methods.broken).toBeUndefined();
  await updateAgentProviders(state => { state.agents.claude!.active = null; });
  expect(JSON.parse(await readFile(metadata, 'utf8'))).toMatchObject({ extra: 7, agents: { claude: { extra: true } } });
  await writeFile(metadata, '{');
  expect((await readAgentProviders()).agents).toEqual({});
  await expect(put()).rejects.toThrow();
  expect(await readFile(metadata, 'utf8')).toBe('{');
});

it('retains newer method records and ciphertext through unrelated edits', async () => {
  await put();
  const raw = JSON.parse(await readFile(metadata, 'utf8'));
  const future = raw.agents.claude.methods.custom;
  future.kind = 'future-provider';
  future.origin = { future: true };
  await writeFile(metadata, JSON.stringify(raw));
  const vault = join(home, 'secrets', `.agent-provider-${future.keyRef}.vault`);
  const ciphertext = await readFile(vault);

  expect((await readAgentProviders()).agents.claude?.methods.custom).toBeUndefined();
  await updateAgentProviders(state => { state.agents.codex = { active: null, methods: {} }; });
  expect(JSON.parse(await readFile(metadata, 'utf8')).agents.claude.methods.custom).toEqual(future);
  expect(await readFile(vault)).toEqual(ciphertext);
  await expect(put(second)).rejects.toThrow(/newer|unsupported/);
  expect(await readFile(vault)).toEqual(ciphertext);
});

it('refuses unpinned writes at the sandbox guard, before creating any files', async () => {
  vi.spyOn(paths, 'assertCezarHomeWriteIsSandboxed').mockImplementation(() => { throw new Error('sandbox guard'); });
  await expect(put()).rejects.toThrow('sandbox guard');
  expect(await readdir(home)).toEqual([]);
});

it('refuses a locked keychain during first save, rotation and reads, without disturbing metadata-only reads', async () => {
  let locked = true;
  let dataKey: Buffer | null = null;
  const ring = {
    async get() { if (locked) throw new Error('locked'); return dataKey; },
    async set(key: Buffer) { dataKey = key; },
  };
  vi.spyOn(keyring, 'osKeychain').mockResolvedValue(ring);
  await expect(put()).rejects.toThrow(/keychain/i);
  await expect(stat(metadata)).rejects.toMatchObject({ code: 'ENOENT' });
  locked = false;
  await put();
  locked = true;
  const original = await method();
  expect(original.baseUrl).toBe(custom().baseUrl);
  await expect(put(second)).rejects.toThrow(/keychain/i);
  await expect(readAgentProviderKey('claude', 'custom', original)).rejects.toThrow(/keychain/i);
  expect(await readAgentProviderKey('claude', 'subscription')).toBeUndefined();
  await expect(stat(join(home, 'secrets', '.key'))).rejects.toMatchObject({ code: 'ENOENT' });
  locked = false;
  expect(await readAgentProviderKey('claude', 'custom', original)).toBe(first);
});

it('keeps provider-only ciphertext from being orphaned by general key creation', async () => {
  await put();
  const keyPath = join(home, 'secrets', '.key');
  await rm(keyPath);
  await expect(new SecretStore().set({ kind: 'workspace' }, 'SAMPLE', 'synthetic-value')).rejects.toThrow(/data key/i);
  await expect(stat(keyPath)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('orders edits from independent processes without losing methods', async () => {
  const path = new URL('./agent-providers.ts', import.meta.url).href;
  const script = `import { updateAgentProviders } from ${JSON.stringify(path)};
    await updateAgentProviders((s, keys) => {
      const id = process.argv[1];
      (s.agents.pi ??= {methods:{}}).methods[id] = {kind:'custom', addedAt:''};
      keys.set('pi', id, 'synthetic-' + id);
    });`;
  const ids = ['one', 'two', 'three'];
  await Promise.all(ids.map(id => promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, id], {
    env: { ...process.env, CEZ_HOME: home, CEZ_SECRETS_KEYCHAIN: '0' }, timeout: 20_000,
  })));
  expect(Object.keys((await readAgentProviders()).agents.pi!.methods).sort()).toEqual(ids.sort());
  for (const id of ids) expect(await readAgentProviderKey('pi', id)).toBe('synthetic-' + id);
}, 30_000);
