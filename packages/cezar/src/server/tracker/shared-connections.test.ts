import { mkdtemp, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { connectionRecordSchema, encodeConnectionEnv } from './connection-env.ts';
import { TrackerConnections } from './connections.ts';
import { SecretStore } from '../../workspace/secrets.ts';

// Spec 2026-11-18-shared-tracker-connections.
let root: string;
let home: string;
let a: string;
let b: string;
const jira = { kind: 'jira' as const, origin: 'https://acme.atlassian.net', email: 'dev@acme.test', token: 'shared-private-token' };
const hash = (project: string) => createHash('sha256').update(project).digest('hex');
const projectFile = (project: string, suffix = '.vault') => join(home, 'tracker-connections', hash(project) + suffix);
const sharedOf = async (store: TrackerConnections, project: string) => {
  const saved = await store.saveCredentials(project, jira, { shared: true });
  if (!('record' in saved)) throw new Error('save failed');
  const [listed] = await store.listShared();
  return { record: saved.record, sharedId: listed!.id };
};
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'tracker-shared-')));
  home = join(root, 'home'); a = join(root, 'a'); b = join(root, 'b');
  await mkdir(a); await mkdir(b);
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

it('saves a shared connection that another project uses only after it picks it', async () => {
  const store = new TrackerConnections({ CEZ_HOME: home });
  const { record, sharedId } = await sharedOf(store, a);
  expect(await store.read(a)).toEqual({ id: record.id, projectRoot: a, credentials: jira });
  expect((await store.inspect(a)).shared).toBe(true);
  // Explicit consent: B sees nothing until it links.
  expect(await store.read(b)).toBeNull();
  const listed = await store.listShared();
  expect(listed).toEqual([{ id: sharedId, kind: 'jira', credentials: { origin: jira.origin, email: jira.email }, createdAt: expect.any(String) }]);
  expect(JSON.stringify(listed)).not.toContain(jira.token);
  const linked = await store.link(b, sharedId);
  expect(linked).toEqual({ record: { id: expect.any(String), projectRoot: b, credentials: jira } });
  // Each link is its own revision: two projects never share cache, cursor or association ids.
  expect((await store.read(b))?.id).not.toBe(record.id);
  expect(sharedId).not.toBe(record.id);
  const dir = join(home, 'tracker-connections');
  const sharedFile = join(dir, `shared-${sharedId}.vault`);
  expect(await readFile(sharedFile, 'utf8')).not.toContain(jira.token);
  expect((await stat(sharedFile)).mode & 0o777).toBe(0o600);
  expect(await readFile(projectFile(b), 'utf8')).not.toContain(jira.token);
  expect(await readdir(a)).toEqual([]);
  expect(await readdir(b)).toEqual([]);
});

it('keeps project-only saves unchanged and never lists them as shared', async () => {
  const store = new TrackerConnections({ CEZ_HOME: home });
  const saved = await store.write(a, { kind: 'linear', key: 'project-only' });
  expect(saved).not.toBeNull();
  expect(await store.inspect(a)).toEqual({ record: saved });
  expect(await store.listShared()).toEqual([]);
  expect(await store.read(b)).toBeNull();
});

it('re-linking issues a new revision, so a scope bound to an older link stays disconnected', async () => {
  const store = new TrackerConnections({ CEZ_HOME: home });
  const { sharedId } = await sharedOf(store, a);
  const first = await store.link(b, sharedId);
  await store.remove(b);
  const second = await store.link(b, sharedId);
  if (!('record' in first) || !('record' in second)) throw new Error('link failed');
  expect(second.record.id).not.toBe(first.record.id);
});

it('replaces the project record when linking, and a project-only save replaces the link', async () => {
  const store = new TrackerConnections({ CEZ_HOME: home });
  const own = await store.write(b, { kind: 'linear', key: 'own-b' });
  const { record, sharedId } = await sharedOf(store, a);
  await store.link(b, sharedId);
  expect((await store.read(b))?.credentials).toEqual(jira);
  expect((await store.read(b))?.id).not.toBe(own?.id);
  const again = await store.write(b, { kind: 'linear', key: 'own-b-again' });
  expect(await store.inspect(b)).toEqual({ record: again });
  // The shared record and A's link are untouched.
  expect((await store.read(a))?.id).toBe(record.id);
});

it('unlinks on remove without deleting the shared record other projects use', async () => {
  const store = new TrackerConnections({ CEZ_HOME: home });
  const { record, sharedId } = await sharedOf(store, a);
  await store.link(b, sharedId);
  expect(await store.remove(b)).toBe(true);
  expect(await store.read(b)).toBeNull();
  expect((await store.read(a))?.id).toBe(record.id);
  expect(await store.listShared()).toHaveLength(1);
});

it('reports a project linked to a removed shared connection instead of a silent blank', async () => {
  const store = new TrackerConnections({ CEZ_HOME: home });
  const { sharedId } = await sharedOf(store, a);
  await store.link(b, sharedId);
  await store.removeId('shared-' + sharedId);
  expect(await store.listShared()).toEqual([]);
  expect(await store.inspect(b)).toEqual({ record: null, error: expect.stringContaining('removed') });
  // Removing credentials still clears the dangling link.
  expect(await store.remove(b)).toBe(true);
  expect(await store.inspect(b)).toEqual({ record: null });
});

it('refuses to link an unknown shared connection and keeps the previous record', async () => {
  const store = new TrackerConnections({ CEZ_HOME: home });
  const own = await store.write(b, { kind: 'linear', key: 'own-b' });
  expect(await store.link(b, randomUUID())).toEqual({ missing: true });
  expect(await store.link(b, '../escape')).toEqual({ missing: true });
  expect(await store.read(b)).toEqual(own);
});

it('promotes a project record to shared keeping its revision id', async () => {
  const store = new TrackerConnections({ CEZ_HOME: home });
  const own = await store.write(a, jira);
  expect(await store.promote(a)).toEqual({ record: own });
  expect(await store.inspect(a)).toEqual({ record: own, shared: true, sharedId: expect.any(String) });
  expect(await store.listShared()).toEqual([expect.objectContaining({ kind: 'jira' })]);
  expect(await store.promote(a)).toEqual({ error: expect.stringContaining('already') });
  expect(await store.promote(b)).toEqual({ error: expect.stringContaining('no credentials') });
  expect(await store.listShared()).toHaveLength(1);
});

it('never opens a renamed project ciphertext as a shared record', async () => {
  const store = new TrackerConnections({ CEZ_HOME: home });
  const own = await store.write(a, { kind: 'linear', key: 'own-a' });
  const forged = randomUUID();
  await writeFile(join(home, 'tracker-connections', `shared-${forged}.vault`), await readFile(projectFile(a), 'utf8'), { mode: 0o600 });
  expect(await store.listShared()).toEqual([]);
  expect(await store.link(b, forged)).not.toHaveProperty('record');
  expect(await store.read(b)).toBeNull();
  expect(await store.read(a)).toEqual(own);
});

it('fails closed with the existing message when an older reader meets a link record', async () => {
  const store = new TrackerConnections({ CEZ_HOME: home });
  const { sharedId } = await sharedOf(store, a);
  const vault = new SecretStore({ CEZ_HOME: home });
  const opened: unknown = JSON.parse(await vault.openManaged('tracker', hash(a), await readFile(projectFile(a), 'utf8')));
  // The pre-shared reader parsed every record with this strict schema.
  expect(connectionRecordSchema.safeParse(opened).success).toBe(false);
  expect(opened).toEqual({ id: expect.any(String), projectRoot: a, sharedId });
});

it('links a project that still has a legacy plaintext record, migrating then replacing it', async () => {
  const store = new TrackerConnections({ CEZ_HOME: home });
  const { sharedId } = await sharedOf(store, a);
  await writeFile(projectFile(b, '.env'), encodeConnectionEnv({ id: randomUUID(), projectRoot: b, credentials: { kind: 'linear', key: 'legacy-b' } }), { mode: 0o600 });
  const linked = await store.link(b, sharedId);
  expect(linked).toMatchObject({ record: { credentials: jira } });
  await expect(stat(projectFile(b, '.env'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await store.read(b))?.credentials).toEqual(jira);
});

it('inventories shared records and linked projects without secrets or emails', async () => {
  const store = new TrackerConnections({ CEZ_HOME: home });
  const { sharedId } = await sharedOf(store, a);
  await store.write(b, { kind: 'linear', key: 'own-b' });
  const inventory = await store.inventory();
  expect(inventory).toEqual([
    ...[
      { id: hash(a), root: a, provider: 'jira', status: 'valid', shared: `shared-${sharedId}` },
      { id: hash(b), root: b, provider: 'linear', status: 'valid' },
    ].sort((left, right) => left.id.localeCompare(right.id)),
    { id: `shared-${sharedId}`, root: null, provider: 'jira', status: 'valid', links: 1 },
  ]);
  expect(JSON.stringify(inventory)).not.toMatch(/shared-private-token|own-b|dev@acme/);
  await store.removeId(`shared-${sharedId}`);
  expect(await store.inventory()).toEqual(expect.arrayContaining([expect.objectContaining({ id: hash(a), status: 'invalid' })]));
});

it('demo mode never writes or lists shared credentials', async () => {
  const store = new TrackerConnections({ CEZ_HOME: home, CEZ_DRY_RUN: '1' });
  expect(await store.saveCredentials(a, jira, { shared: true })).toEqual({ error: null });
  expect(await store.listShared()).toEqual([]);
  expect(await store.link(a, randomUUID())).toEqual({ error: null });
  expect(await store.promote(a)).toEqual({ error: null });
  expect(await stat(join(home, 'tracker-connections')).catch(() => null)).toBeNull();
});

it.each(['shared record', 'project link'])('keeps the previous project record when writing the %s fails', async failing => {
  const store = new TrackerConnections({ CEZ_HOME: home });
  const own = await store.write(a, { kind: 'linear', key: 'own-a' });
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    const target = String(to);
    if (failing === 'shared record' ? target.includes('shared-') : target.endsWith(hash(a) + '.vault')) throw Object.assign(new Error('fixture'), { code: 'EACCES' });
    return rename(from, to);
  });
  expect(await store.saveCredentials(a, jira, { shared: true })).toEqual({ error: null });
  vi.restoreAllMocks();
  expect(await store.read(a)).toEqual(own);
  // No orphan shared record is left for other projects to pick.
  expect(await store.listShared()).toEqual([]);
});

it('does not deadlock when a shared record is removed while a project links to it', async () => {
  const store = new TrackerConnections({ CEZ_HOME: home });
  const { sharedId } = await sharedOf(store, a);
  const [linked] = await Promise.all([store.link(b, sharedId), store.removeId(`shared-${sharedId}`)]);
  expect(linked).toBeDefined();
  // Whichever won, B never reads credentials from a removed record.
  expect(await store.listShared()).toEqual([]);
  expect((await store.inspect(b)).record).toBeNull();
});

it('keeps the revision when the shared connection already in use is picked again', async () => {
  const store = new TrackerConnections({ CEZ_HOME: home });
  const { sharedId } = await sharedOf(store, a);
  const first = await store.link(b, sharedId);
  const again = await store.link(b, sharedId);
  expect(again).toEqual(first);
  expect((await store.read(b))?.id).toBe('record' in first ? first.record.id : undefined);
});

it('keeps the project record and leaves no orphan when promoting fails to commit', async () => {
  const store = new TrackerConnections({ CEZ_HOME: home });
  const own = await store.write(a, jira);
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to).endsWith(hash(a) + '.vault')) throw Object.assign(new Error('fixture'), { code: 'EACCES' });
    return rename(from, to);
  });
  expect(await store.promote(a)).toEqual({ error: null });
  vi.restoreAllMocks();
  expect(await store.inspect(a)).toEqual({ record: own });
  expect(await store.listShared()).toEqual([]);
});

it('reports a shared save as saved when only the directory fsync after its link rename fails', async () => {
  const store = new TrackerConnections({ CEZ_HOME: home });
  await store.write(a, { kind: 'linear', key: 'own-a' });
  const rename = fs.rename.bind(fs), open = fs.open.bind(fs);
  let renamed = false;
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => { await rename(from, to); if (String(to).endsWith(hash(a) + '.vault')) renamed = true; });
  vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    if (renamed && String(args[0]).endsWith('tracker-connections') && args[1] === 'r') throw Object.assign(new Error('fixture'), { code: 'EIO' });
    return open(...args);
  });
  const saved = await store.saveCredentials(a, jira, { shared: true });
  vi.restoreAllMocks();
  expect(saved).toMatchObject({ record: { credentials: jira } });
  expect((await store.inspect(a)).shared).toBe(true);
  expect(await store.listShared()).toHaveLength(1);
});
