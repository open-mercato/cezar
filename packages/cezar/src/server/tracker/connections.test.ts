import { execFileSync } from 'node:child_process';
import { mkdtemp, cp, mkdir, readFile, readdir, realpath, stat, rm, chmod, symlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encodeConnectionEnv } from './connection-env.ts';
import { TrackerConnections } from './connections.ts';
import { SecretStore } from '../../workspace/secrets.ts';
let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'tracker-secret-'))); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
it('stores each project outside its checkout with private permissions and fresh revisions', async () => {
  const home = join(root, 'home');
  const a = join(root, 'a'); const b = join(root, 'b');
  await mkdir(a); await mkdir(b);
  const store = new TrackerConnections({ CEZ_HOME: home });
  const first = await store.write(a, { kind: 'linear', key: 'private-test-A' });
  expect(first).not.toBeNull();
  expect(await store.read(b)).toBeNull();
  const alias = join(root, 'alias'); await symlink(a, alias);
  expect((await store.read(alias))?.id).toBe(first?.id);
  expect(await readdir(a)).toEqual([]);
  const dir = join(home, 'tracker-connections');
  const file = join(dir, (await readdir(dir)).find(name => name.endsWith('.vault'))!);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect((await stat(dir)).mode & 0o777).toBe(0o700);
  expect(await readFile(file, 'utf8')).not.toContain('private-test-A');
  const next = await store.write(a, { kind: 'linear', key: 'private-test-B' });
  expect(next?.id).not.toBe(first?.id);
  expect(await readFile(file, 'utf8')).not.toContain('private-test-B');
  await chmod(file, 0o644);
  expect(await store.read(a)).toBeNull();
  expect(await store.remove(a)).toBe(true);
  expect(await store.remove(a)).toBe(true);
  expect(await store.read(a)).toBeNull();
});
it('fails closed on corrupt storage and keeps the previous record after invalid replacement', async () => {
  const store = new TrackerConnections({ CEZ_HOME: join(root, 'home') });
  const saved = await store.write(root, { kind: 'linear', key: 'previous-secret' });
  expect(await store.write(root, { kind: 'linear', key: '' })).toBeNull();
  expect((await store.read(root))?.id).toBe(saved?.id);
});

const secretPath = (home: string, project: string, suffix: string) =>
  join(home, 'tracker-connections', createHash('sha256').update(project).digest('hex') + suffix);
async function legacy(home: string, project: string) {
  const record = { id: randomUUID(), credentials: { kind: 'linear', key: 'legacy-dummy' } };
  await mkdir(join(home, 'tracker-connections'), { recursive: true, mode: 0o700 });
  await writeFile(secretPath(home, project, '.json'), JSON.stringify(record), { mode: 0o600 });
  return record;
}
it('writes ciphertext outside the repo and never populates the process environment', async () => {
  const home = join(root, 'home'); const store = new TrackerConnections({ CEZ_HOME: home });
  const before = process.env.LINEAR_API_KEY;
  const value = 'dummy#=value$' + '{UNEXPANDED}\\tail';
  const saved = await store.write(root, { kind: 'linear', key: value });
  expect(saved).not.toBeNull();
  const file = await readFile(secretPath(home, root, '.vault'), 'utf8');
  expect(file).not.toContain(value);
  expect(file).not.toContain('"credentials":');
  expect((await store.read(root))?.credentials).toEqual({ kind: 'linear', key: value });
  expect(process.env.LINEAR_API_KEY).toBe(before);
});
it('leaves prototype JSON untouched and never migrates it', async () => {
  const home = join(root, 'home'); const record = await legacy(home, root);
  expect(await new TrackerConnections({ CEZ_HOME: home }).read(root)).toBeNull();
  expect(JSON.parse(await readFile(secretPath(home, root, '.json'), 'utf8'))).toEqual(record);
  expect(await stat(secretPath(home, root, '.env')).catch(() => null)).toBeNull();
});
it('never falls back to legacy JSON when an env file exists but is corrupt', async () => {
  const home = join(root, 'home'); await legacy(home, root);
  await writeFile(secretPath(home, root, '.env'), 'invalid', { mode: 0o600 });
  expect(await new TrackerConnections({ CEZ_HOME: home }).read(root)).toBeNull();
});
it('rejects manual token changes with an old revision and recovers through the form save', async () => {
  const home = join(root, 'home'); const store = new TrackerConnections({ CEZ_HOME: home });
  const saved = await store.write(root, { kind: 'linear', key: 'before-edit' });
  const file = secretPath(home, root, '.vault');
  await writeFile(file, '{broken');
  expect(await store.read(root)).toBeNull();
  const next = await store.write(root, { kind: 'linear', key: 'after-edit' });
  expect(next?.id).not.toBe(saved?.id);
  expect((await store.read(root))?.credentials).toEqual({ kind: 'linear', key: 'after-edit' });
});
it('removes the env record without a deletion marker or touching prototype files', async () => {
  const home = join(root, 'home'); const store = new TrackerConnections({ CEZ_HOME: home });
  await store.write(root, { kind: 'linear', key: 'current-dummy' });
  await legacy(home, root);
  expect(await store.remove(root)).toBe(true);
  expect(await stat(secretPath(home, root, '.env')).catch(() => null)).toBeNull();
  expect(await stat(secretPath(home, root, '.json'))).not.toBeNull();
  expect(await store.read(root)).toBeNull();
});
it('does not alter existing credentials on line-injection input', async () => {
  const home = join(root, 'home'); const store = new TrackerConnections({ CEZ_HOME: home });
  const saved = await store.write(root, { kind: 'linear', key: 'valid-dummy' });
  expect(await store.write(root, { kind: 'linear', key: 'dummy\nNODE_OPTIONS=--inspect' })).toBeNull();
  expect(await store.read(root)).toEqual(saved);
});

it('keeps the previous env when an atomic replacement fails', async () => {
  const home = join(root, 'home'); const store = new TrackerConnections({ CEZ_HOME: home });
  const record = await store.write(root, { kind: 'linear', key: 'previous' });
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to).endsWith('.vault')) throw Object.assign(new Error('fixture'), { code: 'EACCES' });
    return rename(from, to);
  });
  expect(await store.write(root, { kind: 'linear', key: 'replacement' })).toBeNull();
  expect(await store.read(root)).toEqual(record);
});
it('reports a replacement as saved when only the directory fsync after its rename fails', async () => {
  const store = new TrackerConnections({ CEZ_HOME: join(root, 'home') });
  const previous = await store.write(root, { kind: 'linear', key: 'previous' });
  const rename = fs.rename.bind(fs), open = fs.open.bind(fs);
  let renamed = false;
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => { await rename(from, to); if (String(to).endsWith('.vault')) renamed = true; });
  vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (renamed && String(args[0]).endsWith('tracker-connections')) handle.sync = async () => { throw Object.assign(new Error('fixture'), { code: 'EIO' }); };
    return handle;
  });
  const replacement = await store.write(root, { kind: 'linear', key: 'replacement' });
  vi.restoreAllMocks();
  expect(replacement?.id).not.toBe(previous?.id);
  expect(await store.read(root)).toEqual(replacement);
});
it('refuses a record larger than the reader accepts and keeps the previous one', async () => {
  const store = new TrackerConnections({ CEZ_HOME: join(root, 'home') });
  const previous = await store.write(root, { kind: 'linear', key: 'previous' });
  expect(await store.write(root, { kind: 'linear', key: '漢'.repeat(8192) })).toBeNull();
  expect(await store.read(root)).toEqual(previous);
});
it('does not follow credential symlinks or oversized env files, including with legacy JSON present', async () => {
  const home = join(root, 'home'); await legacy(home, root);
  const file = secretPath(home, root, '.env');
  const target = join(root, 'elsewhere'); await writeFile(target, 'dummy', { mode: 0o600 });
  await symlink(target, file);
  const store = new TrackerConnections({ CEZ_HOME: home });
  expect(await store.read(root)).toBeNull();
  expect(await store.remove(root)).toBe(true);
  expect(await readFile(target, 'utf8')).toBe('dummy');
  await writeFile(file, 'x'.repeat(32_769), { mode: 0o600 });
  expect(await store.read(root)).toBeNull();
});

it('requires an existing canonical root and stores its identity', async () => {
  const home = join(root, 'home'); const store = new TrackerConnections({ CEZ_HOME: home });
  expect(await store.write(join(root, 'missing'), { kind: 'linear', key: 'dummy' })).toBeNull();
  await store.write(root, { kind: 'linear', key: 'dummy' });
  expect((await store.read(root))?.projectRoot).toBe(root);
});

it('lists invalid records safely and removes entries after a repository disappears', async () => {
  const home = join(root, 'home'); const store = new TrackerConnections({ CEZ_HOME: home });
  const project = join(root, 'project'); await mkdir(project);
  await store.write(project, { kind: 'linear', key: 'secret-never-listed' });
  const id = createHash('sha256').update(project).digest('hex');
  expect(await store.inventory()).toEqual([{ id, root: project, provider: 'linear', status: 'valid' }]);
  await rm(project, { recursive: true });
  await writeFile(secretPath(home, project, '.vault'), 'corrupt', { mode: 0o600 });
  expect(await store.inventory()).toEqual([{ id, root: null, provider: null, status: 'invalid' }]);
  await store.removeId(id); await store.removeId(id);
  expect(await store.inventory()).toEqual([]);
  await expect(store.removeId('../escape')).rejects.toThrow();
});
it('distinguishes missing storage from corrupt credentials and rejects mismatched owners', async () => {
  const home = join(root, 'home'); const store = new TrackerConnections({ CEZ_HOME: home });
  expect(await store.inspect(root)).toEqual({ record: null });
  await store.write(root, { kind: 'linear', key: 'dummy' });
  const path = secretPath(home, root, '.vault');
  await writeFile(path, '{broken');
  expect(await store.inspect(root)).toMatchObject({ record: null, error: expect.stringContaining('Settings') });
});

it('serializes independent store mutations and reports failed unlink without claiming deletion', async () => {
  const home = join(root, 'home'); const first = new TrackerConnections({ CEZ_HOME: home });
  const second = new TrackerConnections({ CEZ_HOME: home });
  await first.write(root, { kind: 'linear', key: 'old' });
  const rename = fs.rename.bind(fs);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = vi.fn();
  vi.spyOn(fs, 'rename').mockImplementation(async (...args) => { entered(); await gate; return rename(...args); });
  const saving = first.write(root, { kind: 'linear', key: 'replacement' });
  await vi.waitFor(() => expect(entered).toHaveBeenCalled());
  const removing = second.remove(root);
  release(); expect(await saving).not.toBeNull(); expect(await removing).toBe(true);
  expect(await first.read(root)).toBeNull();
  vi.restoreAllMocks();
  await first.write(root, { kind: 'linear', key: 'retained' });
  const unlink = fs.unlink.bind(fs);
  vi.spyOn(fs, 'unlink').mockImplementation(async path => {
    if (String(path).endsWith('.vault')) throw Object.assign(new Error('fixture'), { code: 'EACCES' });
    return unlink(path);
  });
  expect(await first.remove(root)).toBe(false);
  expect(await first.read(root)).not.toBeNull();
});

it('keeps managed credentials out of git when CEZ_HOME is inside a repository', async () => {
  execFileSync('git', ['init', '-q', root]);
  const home = join(root, 'local-home');
  const store = new TrackerConnections({ CEZ_HOME: home });
  expect(await store.write(root, { kind: 'linear', key: 'synthetic-private-token' })).not.toBeNull();
  execFileSync('git', ['add', '.'], { cwd: root });
  expect(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' })).toBe('');
  expect((await store.read(root))?.credentials).toEqual({ kind: 'linear', key: 'synthetic-private-token' });
});

async function plaintext(home: string, project: string) {
  const record = { id: randomUUID(), projectRoot: project, credentials: { kind: 'linear' as const, key: 'migration-secret' } };
  await mkdir(join(home, 'tracker-connections'), { recursive: true, mode: 0o700 });
  await writeFile(secretPath(home, project, '.env'), encodeConnectionEnv(record), { mode: 0o600 });
  return record;
}
it('migrates a complete dotenv record without rotating its identity and removes plaintext only after verification', async () => {
  const home = join(root, 'home');
  const record = await plaintext(home, root);
  const store = new TrackerConnections({ CEZ_HOME: home });
  expect(await store.read(root)).toEqual(record);
  expect(await readFile(secretPath(home, root, '.vault'), 'utf8')).not.toContain('migration-secret');
  expect(await stat(secretPath(home, root, '.env')).catch(() => null)).toBeNull();
  expect(await new TrackerConnections({ CEZ_HOME: home }).read(root)).toEqual(record);
});
it('preserves plaintext on failed migration and recovers on retry', async () => {
  const home = join(root, 'home'); const record = await plaintext(home, root);
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to).endsWith('.vault')) throw new Error('injected failure');
    return rename(from, to);
  });
  expect((await new TrackerConnections({ CEZ_HOME: home }).inspect(root)).error).toBeDefined();
  expect(await readFile(secretPath(home, root, '.env'), 'utf8')).toContain('migration-secret');
  vi.restoreAllMocks();
  expect(await new TrackerConnections({ CEZ_HOME: home }).read(root)).toEqual(record);
});
it('rejects an old writer conflict and never falls back when ciphertext is corrupt', async () => {
  const home = join(root, 'home'); const store = new TrackerConnections({ CEZ_HOME: home });
  await store.write(root, { kind: 'linear', key: 'encrypted-current' });
  await plaintext(home, root);
  expect((await store.inspect(root)).error).toBeDefined();
  await writeFile(secretPath(home, root, '.vault'), '{broken');
  expect((await store.inspect(root)).error).toBeDefined();
  expect(await stat(secretPath(home, root, '.env'))).not.toBeNull();
});
it('does not replace a temporarily locked established keychain key', async () => {
  const home = join(root, 'home'); let key: Buffer | null = null;
  const keychain = async () => ({ get: async () => key, set: async (value: Buffer) => { key = value; } });
  const first = new TrackerConnections({ CEZ_HOME: home }, { keychain });
  const saved = await first.write(root, { kind: 'linear', key: 'protected' });
  expect(saved).not.toBeNull();
  const set = vi.fn();
  const locked = new TrackerConnections({ CEZ_HOME: home }, { keychain: async () => ({ get: async () => { throw new Error('locked'); }, set }) });
  expect(await locked.write(root, { kind: 'linear', key: 'replacement' })).toBeNull();
  expect(set).not.toHaveBeenCalled();
  expect(await first.read(root)).toEqual(saved);
});

it('does not resurrect a removed encrypted record from an old plaintext writer', async () => {
  const home = join(root, 'home'); const store = new TrackerConnections({ CEZ_HOME: home });
  await store.write(root, { kind: 'linear', key: 'current' });
  await store.remove(root);
  expect(await store.read(root)).toBeNull();
  await plaintext(home, root);
  expect((await store.inspect(root)).error).toBeDefined();
  expect(await store.write(root, { kind: 'linear', key: 'explicit-replacement' })).not.toBeNull();
  expect((await store.read(root))?.credentials).toEqual({ kind: 'linear', key: 'explicit-replacement' });
});

it('reads a legacy record without migrating it when the home is read-only', async () => {
  const home = join(root, 'home'); const record = await plaintext(home, root);
  const mkdirReal = fs.mkdir.bind(fs);
  vi.spyOn(fs, 'mkdir').mockImplementation(async (path, options) => {
    if (String(path).includes('tracker-connections')) throw Object.assign(new Error('read-only'), { code: 'EROFS' });
    return mkdirReal(path, options);
  });
  expect(await new TrackerConnections({ CEZ_HOME: home }).read(root)).toEqual(record);
  expect(await readFile(secretPath(home, root, '.env'), 'utf8')).toContain('migration-secret');
  expect(await stat(secretPath(home, root, '.vault')).catch(() => null)).toBeNull();
});

// Separate CEZ_HOME locks must never write the same native keychain item.
it.each(['save', 'migration'])('retains concurrent cross-home %s credentials after restart', async mode => {
  const keys = new Map<string, Buffer>();
  let writes = 0;
  let release!: () => void;
  const both = new Promise<void>(resolve => { release = resolve; });
  const keychain = async (account = 'secrets-data-key') => ({
    get: async () => keys.get(account) ?? null,
    set: async (key: Buffer) => {
      if (++writes === 2) release();
      await both;
      keys.set(account, key);
    },
  });
  const homes = [join(root, 'home-a'), join(root, 'home-b')];
  const stores = homes.map(CEZ_HOME => new TrackerConnections({ CEZ_HOME }, { keychain }));
  if (mode === 'migration') {
    for (const home of homes) {
      await mkdir(join(home, 'tracker-connections'), { recursive: true, mode: 0o700 });
      await writeFile(secretPath(home, root, '.env'), encodeConnectionEnv({ id: randomUUID(), projectRoot: root, credentials: { kind: 'linear', key: 'synthetic' } }), { mode: 0o600 });
    }
  }
  const records = await Promise.all(stores.map(store => mode === 'migration' ? store.read(root) : store.write(root, { kind: 'linear', key: 'synthetic' })));
  expect(records.every(Boolean)).toBe(true);
  if (mode === 'migration') for (const home of homes) await expect(stat(secretPath(home, root, '.env'))).rejects.toMatchObject({ code: 'ENOENT' });
  const restarted = await Promise.all(homes.map(CEZ_HOME => new TrackerConnections({ CEZ_HOME }, { keychain }).read(root)));
  expect(restarted).toEqual(records);
  expect(keys.has('secrets-data-key')).toBe(false);
});

it.each(['delete', 'restore'])('uses durable keys after live vault %s', async change => {
  const home = join(root, 'home');
  const store = new TrackerConnections({ CEZ_HOME: home });
  await store.write(root, { kind: 'linear', key: 'initial' });
  if (change === 'restore') {
    const other = join(root, 'other-home');
    await new TrackerConnections({ CEZ_HOME: other }).write(root, { kind: 'linear', key: 'backup' });
    await rm(join(home, 'secrets'), { recursive: true });
    await cp(join(other, 'secrets'), join(home, 'secrets'), { recursive: true });
  } else {
    await rm(join(home, 'secrets'), { recursive: true });
    // Its key may still be recoverable elsewhere: no new key while that ciphertext exists.
    expect(await store.write(root, { kind: 'linear', key: 'after-reset' })).toBeNull();
    expect(await store.remove(root)).toBe(true);
  }
  const saved = await store.write(root, { kind: 'linear', key: 'after-reset' });
  expect(saved).not.toBeNull();
  expect(await new TrackerConnections({ CEZ_HOME: home }).read(root)).toEqual(saved);
});
it('migrates intact plaintext after a live key reset using a restart-readable key', async () => {
  const home = join(root, 'home');
  const store = new TrackerConnections({ CEZ_HOME: home });
  await store.write(root, { kind: 'linear', key: 'initial' });
  const project = join(root, 'second-project'); await mkdir(project);
  const record = await plaintext(home, project);
  await rm(join(home, 'secrets'), { recursive: true });
  // The first project's ciphertext blocks a new key: plaintext stays readable, unmigrated.
  expect(await store.read(project)).toEqual(record);
  expect(await stat(secretPath(home, project, '.env'))).not.toBeNull();
  expect(await store.remove(root)).toBe(true);
  expect(await store.read(project)).toEqual(record);
  expect(await new TrackerConnections({ CEZ_HOME: home }).read(project)).toEqual(record);
  expect(await stat(secretPath(home, project, '.env')).catch(() => null)).toBeNull();
});

it('never replaces a legacy shared keychain key that is locked after its key metadata was lost', async () => {
  const home = join(root, 'home'); const items = new Map<string, Buffer>([['secrets-data-key', Buffer.alloc(32, 7)]]); let locked = false;
  const keychain = async (account: string) => ({
    get: async () => { if (locked) throw new Error('locked'); return items.get(account) ?? null; },
    set: async (value: Buffer) => { if (locked) throw new Error('locked'); items.set(account, value); },
  });
  const saved = await new TrackerConnections({ CEZ_HOME: home }, { keychain }).write(root, { kind: 'linear', key: 'legacy-keyed' });
  await rm(join(home, 'secrets'), { recursive: true });
  locked = true;
  await expect(new SecretStore({ CEZ_HOME: home }, { keychain }).set({ kind: 'workspace' }, 'TOKEN', 'value-123456789')).rejects.toThrow('data key is unavailable');
  locked = false;
  expect(await new TrackerConnections({ CEZ_HOME: home }, { keychain }).read(root)).toEqual(saved);
});

it('reads a legacy record without migrating while an established data key is locked', async () => {
  const home = join(root, 'home'); let locked = false; const items = new Map<string, Buffer>();
  const keychain = async (account: string) => ({
    get: async () => { if (locked) throw new Error('locked'); return items.get(account) ?? null; },
    set: async (value: Buffer) => { if (locked) throw new Error('locked'); items.set(account, value); },
  });
  await new SecretStore({ CEZ_HOME: home }, { keychain }).set({ kind: 'workspace' }, 'API_KEY', 'value-123456789');
  const record = await plaintext(home, root);
  locked = true;
  expect(await new TrackerConnections({ CEZ_HOME: home }, { keychain }).inspect(root)).toEqual({ record });
  expect(await stat(secretPath(home, root, '.vault')).catch(() => null)).toBeNull();
  locked = false;
  expect(await new TrackerConnections({ CEZ_HOME: home }, { keychain }).read(root)).toEqual(record);
  expect(await stat(secretPath(home, root, '.env')).catch(() => null)).toBeNull();
  locked = true;
  expect((await new TrackerConnections({ CEZ_HOME: home }, { keychain }).inspect(root)).error).toContain('data key is unavailable');
});

it('recovers from a lost data key once the unreadable records are removed', async () => {
  const home = join(root, 'home'); const env = { CEZ_HOME: home, CEZ_SECRETS_KEYCHAIN: '0' };
  const secrets = new SecretStore(env);
  await secrets.set({ kind: 'workspace' }, 'API_KEY', 'value-123456789');
  expect(await new TrackerConnections(env).write(root, { kind: 'linear', key: 'before-loss' })).not.toBeNull();
  await rm(join(home, 'secrets', '.key'));
  expect(await new TrackerConnections(env).saveCredentials(root, { kind: 'linear', key: 'after-loss' })).toEqual({ error: expect.stringContaining('secrets/workspace.json, tracker-connections/') });
  // Ciphertext remains: the key may only be misplaced, so nothing may replace it yet.
  await expect(secrets.set({ kind: 'workspace' }, 'API_KEY', 'value-123456789')).rejects.toThrow('data key is unavailable');
  expect(await new TrackerConnections(env).write(root, { kind: 'linear', key: 'after-loss' })).toBeNull();
  await secrets.unset({ kind: 'workspace' }, 'API_KEY');
  expect(await new TrackerConnections(env).remove(root)).toBe(true);
  await secrets.set({ kind: 'workspace' }, 'API_KEY', 'value-123456789');
  expect((await secrets.read({ kind: 'workspace' })).values.API_KEY?.value).toBe('value-123456789');
  expect(await new TrackerConnections(env).write(root, { kind: 'linear', key: 'after-loss' })).not.toBeNull();
  expect((await new TrackerConnections(env).read(root))?.credentials).toEqual({ kind: 'linear', key: 'after-loss' });
});

it('refuses a new key while a keychain-held key is unreadable, even before any record exists', async () => {
  const home = join(root, 'home'); const items = new Map<string, Buffer>(); let locked = false;
  const keychain = async (account: string) => ({
    get: async () => { if (locked) throw new Error('locked'); return items.get(account) ?? null; },
    set: async (value: Buffer) => { if (locked) throw new Error('locked'); items.set(account, value); },
  });
  // A sealed record is in flight: key metadata exists, its ciphertext is not on disk yet.
  const first = new SecretStore({ CEZ_HOME: home }, { keychain });
  const sealed = await first.sealManaged('tracker', 'in-flight', 'payload');
  locked = true;
  await expect(new SecretStore({ CEZ_HOME: home }, { keychain }).set({ kind: 'workspace' }, 'TOKEN', 'value-123456789')).rejects.toThrow('unlock the OS keychain');
  await expect(stat(join(home, 'secrets', '.key'))).rejects.toMatchObject({ code: 'ENOENT' });
  locked = false;
  expect(await first.openManaged('tracker', 'in-flight', sealed)).toBe('payload');
});

it('lists unreadable secrets by name after a lost key so they can be unset', async () => {
  const home = join(root, 'home'); const env = { CEZ_HOME: home, CEZ_SECRETS_KEYCHAIN: '0' };
  await new SecretStore(env).set({ kind: 'workspace' }, 'API_KEY', 'value-123456789');
  await rm(join(home, 'secrets', '.key'));
  const listed = await new SecretStore(env).list({ kind: 'workspace' });
  expect(listed.secrets.map(entry => entry.name)).toEqual(['API_KEY']);
  expect(listed.skipped).toContain('data key is gone');
});

it('tells a locked or unavailable keychain apart from a lost key', async () => {
  const home = join(root, 'home'); const items = new Map<string, Buffer>(); let locked = false;
  const keychain = async (account: string) => ({
    get: async () => { if (locked) throw new Error('locked'); return items.get(account) ?? null; },
    set: async (value: Buffer) => { items.set(account, value); },
  });
  await new SecretStore({ CEZ_HOME: home }, { keychain }).set({ kind: 'workspace' }, 'API_KEY', 'value-123456789');
  locked = true;
  expect((await new SecretStore({ CEZ_HOME: home }, { keychain }).list({ kind: 'workspace' })).skipped).toContain('locked or unreachable');
  const unavailable = new SecretStore({ CEZ_HOME: home }, { keychain: async () => null });
  expect((await unavailable.list({ kind: 'workspace' })).skipped).toContain('unavailable here');
  await unavailable.unset({ kind: 'workspace' }, 'API_KEY');
  await expect(unavailable.set({ kind: 'workspace' }, 'API_KEY', 'value-123456789')).rejects.toThrow('delete ~/.cezar/secrets/.backend');
  locked = false; items.clear();
  expect((await new SecretStore({ CEZ_HOME: home }, { keychain }).list({ kind: 'workspace' })).secrets).toEqual([]);
});

it.each(['syntax', 'digest'])('replaces malformed legacy %s through Settings', async damage => {
  const home = join(root, 'home'); const previous = await plaintext(home, root);
  const file = secretPath(home, root, '.env');
  await writeFile(file, damage === 'syntax' ? 'invalid' : encodeConnectionEnv(previous).replace('migration-secret', 'edited-secret'));
  const store = new TrackerConnections({ CEZ_HOME: home });
  expect((await store.inspect(root)).error).toBeDefined();
  const saved = await store.write(root, { kind: 'linear', key: 'replacement' });
  expect(saved).not.toBeNull();
  expect(saved?.id).not.toBe(previous.id);
  expect(await new TrackerConnections({ CEZ_HOME: home }).read(root)).toEqual(saved);
  await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('preserves valid legacy identity when replacement commit fails', async () => {
  const home = join(root, 'home'); const previous = await plaintext(home, root);
  const rename = fs.rename.bind(fs); let commits = 0;
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to).endsWith('.vault') && ++commits === 2) throw Object.assign(new Error('fixture'), { code: 'EIO' });
    return rename(from, to);
  });
  expect(await new TrackerConnections({ CEZ_HOME: home }).write(root, { kind: 'linear', key: 'replacement' })).toBeNull();
  vi.restoreAllMocks();
  expect(await new TrackerConnections({ CEZ_HOME: home }).read(root)).toEqual(previous);
});

it('does not bypass unreadable ciphertext when replacing malformed legacy content', async () => {
  const home = join(root, 'home'); const store = new TrackerConnections({ CEZ_HOME: home });
  await store.write(root, { kind: 'linear', key: 'current' });
  await writeFile(secretPath(home, root, '.vault'), '{broken');
  await writeFile(secretPath(home, root, '.env'), 'invalid', { mode: 0o600 });
  expect(await store.write(root, { kind: 'linear', key: 'replacement' })).toBeNull();
  expect(await readFile(secretPath(home, root, '.vault'), 'utf8')).toBe('{broken');
  expect(await readFile(secretPath(home, root, '.env'), 'utf8')).toBe('invalid');
});

it.each([false, true])('prevents plaintext resurrection after interrupted migration (marker failure on removal: %s)', async failRemoval => {
  const home = join(root, 'home'); const previous = await plaintext(home, root);
  const store = new TrackerConnections({ CEZ_HOME: home });
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to).endsWith('.migrated')) throw Object.assign(new Error('fixture'), { code: 'EIO' });
    return rename(from, to);
  });
  expect((await store.inspect(root)).error).toBeDefined();
  const ciphertext = await readFile(secretPath(home, root, '.vault'), 'utf8');
  await expect(stat(secretPath(home, root, '.migrated'))).rejects.toMatchObject({ code: 'ENOENT' });
  if (failRemoval) {
    expect(await store.remove(root)).toBe(false);
    expect(await readFile(secretPath(home, root, '.vault'), 'utf8')).toBe(ciphertext);
    expect(await readFile(secretPath(home, root, '.env'), 'utf8')).toBe(encodeConnectionEnv(previous));
  }
  vi.restoreAllMocks();
  await store.removeId(createHash('sha256').update(root).digest('hex'));
  await writeFile(secretPath(home, root, '.env'), encodeConnectionEnv(previous), { mode: 0o600 });
  expect(await new TrackerConnections({ CEZ_HOME: home }).inspect(root)).toMatchObject({ record: null, error: expect.any(String) });
  expect(await readFile(secretPath(home, root, '.migrated'), 'utf8')).toBe('1\n');
});

it('keeps valid ciphertext when replacing malformed legacy content fails', async () => {
  const home = join(root, 'home'); const store = new TrackerConnections({ CEZ_HOME: home });
  const previous = await store.write(root, { kind: 'linear', key: 'current' });
  expect(previous).not.toBeNull();
  await writeFile(secretPath(home, root, '.env'), 'invalid', { mode: 0o600 });
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to).endsWith('.vault')) throw Object.assign(new Error('fixture'), { code: 'EIO' });
    return rename(from, to);
  });
  expect(await store.write(root, { kind: 'linear', key: 'replacement' })).toBeNull();
  vi.restoreAllMocks();
  expect(await new TrackerConnections({ CEZ_HOME: home }).read(root)).toEqual(previous);
});

it('does not discard legacy storage on a read failure during replacement', async () => {
  const home = join(root, 'home'); const previous = await plaintext(home, root);
  const open = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    if (String(args[0]).endsWith('.env')) throw Object.assign(new Error('fixture'), { code: 'EIO' });
    return open(...args);
  });
  expect(await new TrackerConnections({ CEZ_HOME: home }).write(root, { kind: 'linear', key: 'replacement' })).toBeNull();
  vi.restoreAllMocks();
  expect(await readFile(secretPath(home, root, '.env'), 'utf8')).toBe(encodeConnectionEnv(previous));
});
