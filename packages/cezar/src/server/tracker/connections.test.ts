import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, stat, rm, chmod, symlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TrackerConnections } from './connections.ts';
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'tracker-secret-')); });
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
  const file = join(dir, (await readdir(dir)).find(name => name.endsWith('.env'))!);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect((await stat(dir)).mode & 0o777).toBe(0o700);
  expect(await readFile(file, 'utf8')).toContain('private-test-A');
  const next = await store.write(a, { kind: 'linear', key: 'private-test-B' });
  expect(next?.id).not.toBe(first?.id);
  expect(await readFile(file, 'utf8')).not.toContain('private-test-A');
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
it('writes dotenv outside the repo and never populates the process environment', async () => {
  const home = join(root, 'home'); const store = new TrackerConnections({ CEZ_HOME: home });
  const before = process.env.LINEAR_API_KEY;
  const value = 'dummy#=value$' + '{UNEXPANDED}\\tail';
  const saved = await store.write(root, { kind: 'linear', key: value });
  expect(saved).not.toBeNull();
  const file = await readFile(secretPath(home, root, '.env'), 'utf8');
  expect(file).toContain('LINEAR_API_KEY=');
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
  const file = secretPath(home, root, '.env');
  await writeFile(file, (await readFile(file, 'utf8')).replace('before-edit', 'after-edit'));
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
  vi.spyOn(fs, 'rename').mockRejectedValue(Object.assign(new Error('fixture'), { code: 'EACCES' }));
  expect(await store.write(root, { kind: 'linear', key: 'replacement' })).toBeNull();
  expect(await store.read(root)).toEqual(record);
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
  expect(await readFile(secretPath(home, root, '.env'), 'utf8')).toContain('PROJECT_ROOT=');
});

it('lists invalid records safely and removes entries after a repository disappears', async () => {
  const home = join(root, 'home'); const store = new TrackerConnections({ CEZ_HOME: home });
  const project = join(root, 'project'); await mkdir(project);
  await store.write(project, { kind: 'linear', key: 'secret-never-listed' });
  const id = createHash('sha256').update(project).digest('hex');
  expect(await store.inventory()).toEqual([{ id, root: project, provider: 'linear', status: 'valid' }]);
  await rm(project, { recursive: true });
  await writeFile(secretPath(home, project, '.env'), 'corrupt', { mode: 0o600 });
  expect(await store.inventory()).toEqual([{ id, root: null, provider: null, status: 'invalid' }]);
  await store.removeId(id); await store.removeId(id);
  expect(await store.inventory()).toEqual([]);
  await expect(store.removeId('../escape')).rejects.toThrow();
});
it('distinguishes missing storage from corrupt credentials and rejects mismatched owners', async () => {
  const home = join(root, 'home'); const store = new TrackerConnections({ CEZ_HOME: home });
  expect(await store.inspect(root)).toEqual({ record: null });
  await store.write(root, { kind: 'linear', key: 'dummy' });
  const path = secretPath(home, root, '.env');
  await writeFile(path, (await readFile(path, 'utf8')).replace(root, '/different/root'));
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
    if (String(path).endsWith('.env')) throw Object.assign(new Error('fixture'), { code: 'EACCES' });
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
