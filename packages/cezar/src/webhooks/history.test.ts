import { constants, readFileSync, statSync, readdirSync, realpathSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fs from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebhookHistory, pageRecords } from './history.ts';
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe('bounded scoped webhook history', () => {
  it('pages stable snapshots, excludes concurrent new rows and rejects another scope', () => {
    const rows = [1, 2, 3, 4].map(id => ({ id: String(id), at: `2026-10-13T12:00:0${id}Z` }));
    const first = pageRecords(rows, 'project/receiver/task', { limit: 2 });
    expect(first.items.map(item => item.id)).toEqual(['4', '3']);
    const next = pageRecords([...rows, { id: '5', at: '2026-10-13T12:00:05Z' }], 'project/receiver/task', { limit: 2, cursor: first.nextCursor });
    expect(next.items.map(item => item.id)).toEqual(['2', '1']); expect(next.hasMore).toBe(false);
    expect(() => pageRecords(rows, 'project/other/task', { limit: 2, cursor: first.nextCursor })).toThrow('cursor');
  });
  it('keeps masked latest results across restart, bounded by age and bytes', async () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-history-')); dirs.push(dir); let now = Date.parse('2026-10-13T12:00:00Z');
    let history = await WebhookHistory.open(dir, () => now, 1000);
    for (let index = 0; index < 12; index++) await history.activity('receiver', { id: String(index), at: new Date(now++).toISOString(), action: 'test', source: 'cockpit/api', fields: [], detail: 'https://secret.example/path?token=hidden' }, ['https://secret.example/path?token=hidden']);
    history = await WebhookHistory.open(dir, () => now, 1000);
    expect(history.activities('receiver').length).toBeGreaterThan(0); expect(history.activities('receiver').length).toBeLessThan(12);
    expect(JSON.stringify(history.activities('receiver'))).not.toContain('token=hidden');
    now += 31 * 86400000; await history.prune();
    expect(history.activities('receiver')).toHaveLength(0);
  });
  // Spec §"Storage, privacy and degradation": malformed state disables nothing beyond this
  // project's webhooks, and users must not repair JSON by hand. History is display data, so a
  // bad row is quarantined and the service keeps serving new deliveries.
  it('quarantines an unreadable delivery or activity log instead of bricking the service', async () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-history-')); dirs.push(dir);
    writeFileSync(join(dir, 'deliveries.ndjson'), '{"deliveryId":"not-a-delivery"}\n');
    writeFileSync(join(dir, 'activity.ndjson'), 'not json\n');
    const history = await WebhookHistory.open(dir);
    expect(history.wasReset).toBe(true);
    expect(history.results('receiver')).toEqual([]);
    expect(history.activities('receiver')).toEqual([]);
    const files = readdirSync(dir);
    expect(files.some(name => name.startsWith('deliveries.ndjson.corrupt-'))).toBe(true);
    expect(files.some(name => name.startsWith('activity.ndjson.corrupt-'))).toBe(true);
    const reopened = await WebhookHistory.open(dir);
    expect(reopened.wasReset).toBe(false);
  });
});

it('appends durably without replacing the log and serializes concurrent updates', async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-history-')); dirs.push(dir);
  const history = await WebhookHistory.open(dir);
  const row = (id: string) => ({ id, at: new Date().toISOString(), action: 'test' as const, source: 'cockpit/api' as const, fields: [] });
  await history.activity('receiver', row('first'));
  const path = join(dir, 'activity.ndjson'), inode = statSync(path).ino, prefix = readFileSync(path, 'utf8');
  const snapshot = history.activities('receiver');
  await Promise.all([history.activity('receiver', row('second')), history.activity('receiver', row('third'))]);
  expect(statSync(path).ino).toBe(inode);
  expect(readFileSync(path, 'utf8').startsWith(prefix)).toBe(true);
  expect(history.activities('receiver').map(row => row.id)).toEqual(['first', 'second', 'third']);
  expect(snapshot.map(row => row.id)).toEqual(['first']);
  expect((await WebhookHistory.open(dir)).activities('receiver')).toEqual(history.activities('receiver'));
});

it('recovers an interrupted append, replays the latest result and keeps snapshots immutable', async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-history-')); dirs.push(dir);
  const history = await WebhookHistory.open(dir);
  const at = new Date().toISOString();
  const row = { deliveryId: 'delivery', receiverId: 'receiver', eventId: 'event', deliveryRevision: 1,
    eventType: 'webhook.test' as const, status: 'failed' as const, createdAt: at, expiresAt: at,
    attempts: 1, destination: 'https://example.test', retryAllowed: false, replayAllowed: false };
  await history.result(row);
  const snapshot = history.results('receiver');
  await history.result({ ...row, status: 'delivered', httpStatus: 204 });
  snapshot[0]!.destination = 'mutated';
  const path = join(dir, 'deliveries.ndjson');
  const committed = readFileSync(path, 'utf8');
  writeFileSync(path, committed + '{"deliveryId":');
  const reopened = await WebhookHistory.open(dir);
  expect(reopened.wasReset).toBe(false);
  expect(readFileSync(path, 'utf8')).toBe(committed);
  expect(reopened.results('receiver')).toEqual(history.results('receiver'));
  expect(reopened.results('receiver')).toHaveLength(1);
  expect(reopened.results('receiver')[0]).toMatchObject({ status: 'delivered', destination: 'https://example.test' });
});

it.each(['write', 'sync'])('rolls back a failed append %s and permits a later durable write', async fault => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-history-')); dirs.push(dir);
  const history = await WebhookHistory.open(dir);
  const row = { id: 'first', at: new Date().toISOString(), action: 'test' as const, source: 'cockpit/api' as const, fields: [] };
  await history.activity('receiver', row);
  const path = join(dir, 'activity.ndjson'), before = readFileSync(path, 'utf8');
  const realOpen = fs.open;
  vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
    const file = await realOpen(...args);
    // Windows append handles cannot be truncated, even when opened with O_RDWR.
    if (typeof args[1] === 'number' && (args[1] & constants.O_APPEND)) {
      vi.spyOn(file, 'truncate').mockRejectedValue(Object.assign(new Error('append handle cannot truncate'), { code: 'EPERM' }));
    }
    const write = file.writeFile.bind(file);
    if (fault === 'write') vi.spyOn(file, 'writeFile').mockImplementationOnce(async () => { await write('{"partial":'); throw new Error('disk full'); });
    else vi.spyOn(file, 'sync').mockRejectedValueOnce(new Error('disk full'));
    return file;
  });
  await expect(history.activity('receiver', { ...row, id: 'lost' })).rejects.toThrow('disk full');
  expect(readFileSync(path, 'utf8')).toBe(before);
  expect(history.activities('receiver').map(row => row.id)).toEqual(['first']);
  await history.activity('receiver', { ...row, id: 'next' });
  expect((await WebhookHistory.open(dir)).activities('receiver').map(row => row.id)).toEqual(['first', 'next']);
});

it('compacts with headroom under the byte cap and preserves age retention', async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-history-')); dirs.push(dir);
  let now = Date.now();
  const history = await WebhookHistory.open(dir, () => now, 4096);
  const path = join(dir, 'activity.ndjson');
  let replacements = 0, inode: number | undefined;
  for (let index = 0; index < 100; index++) {
    await history.activity('receiver', { id: String(index), at: new Date(now).toISOString(), action: 'test', source: 'cockpit/api', fields: [] });
    const stat = statSync(path);
    if (inode !== undefined && inode !== stat.ino) replacements++;
    inode = stat.ino;
    expect(stat.size).toBeLessThanOrEqual(4096);
  }
  expect(replacements).toBeGreaterThan(0);
  expect(replacements).toBeLessThan(15);
  const reopened = await WebhookHistory.open(dir, () => now, 4096);
  expect(reopened.activities('receiver')).toEqual(history.activities('receiver'));
  expect(reopened.activities('receiver').at(-1)!.id).toBe('99');
  now += 31 * 86400000;
  await reopened.prune();
  expect((await WebhookHistory.open(dir)).activities('receiver')).toEqual([]);
});
