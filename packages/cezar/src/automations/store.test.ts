import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AutomationStore } from './store.js';

const dirs: string[] = [];
const input = {
  name: 'Review new PRs',
  enabled: false,
  events: ['pull_request.opened'] as const,
  intervalSeconds: 300,
  filters: { lookbackDays: 7, maxRecords: 25 },
  task: { prompt: 'Review {{github.url}}' },
};

async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cezar-automations-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('AutomationStore', () => {
  it('writes definitions atomically at private permissions and preserves unknown fields', async () => {
    const dir = await directory();
    const store = AutomationStore.open(dir);
    const created = store.create(input, 'review-prs');
    const path = join(dir, 'automations.json');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.future = { kept: true };
    raw.automations[0].futureDefinition = true;
    writeFileSync(path, JSON.stringify(raw));

    const reopened = AutomationStore.open(dir);
    reopened.update('review-prs', created.revision, { ...input, name: 'Updated' });
    const persisted = JSON.parse(readFileSync(path, 'utf8'));
    expect(persisted.future).toEqual({ kept: true });
    expect(persisted.automations[0].futureDefinition).toBe(true);
    expect((await import('node:fs/promises')).stat(path).then((stat) => stat.mode & 0o777)).resolves.toBe(
      0o600,
    );
  });

  it('salvages valid entries and malformed NDJSON rows with one warning per file', async () => {
    const dir = await directory();
    const valid = AutomationStore.open(dir).create(input, 'valid');
    writeFileSync(
      join(dir, 'automations.json'),
      JSON.stringify({ version: 1, automations: [valid, { id: 'broken' }] }),
    );
    writeFileSync(join(dir, 'automation-receipts.ndjson'), '{bad json}\n{}\n');
    const warnings: string[] = [];
    const store = AutomationStore.open(dir, { warn: (warning) => warnings.push(warning) });
    expect(store.list().map((item) => item.id)).toEqual(['valid']);
    expect(store.receipts()).toEqual([]);
    expect(warnings).toHaveLength(2);
  });

  it('enforces optimistic revisions and tombstones deleted ids', async () => {
    const store = AutomationStore.open(await directory());
    store.create(input, 'one');
    expect(() => store.update('one', 9, input)).toThrow('revision conflict');
    expect(store.delete('one')).toBe(true);
    expect(() => store.create(input, 'one')).toThrow('unavailable');
  });

  it('reserves one receipt per automation event and appends finalized rows', async () => {
    const store = AutomationStore.open(await directory());
    const receipt = store.reserveReceipt({ automationId: 'one', revision: 1, eventId: 'event' });
    expect(receipt?.receiptKey).toBe('one:event');
    expect(store.reserveReceipt({ automationId: 'one', revision: 1, eventId: 'event' })).toBeUndefined();
    store.appendReceipt({
      ...receipt!,
      status: 'launched',
      runId: 'run-1',
      updatedAt: '2026-07-26T01:00:00.000Z',
    });
    expect(store.latestReceipts().get('one:event')?.runId).toBe('run-1');
  });

  it('holds an exclusive recoverable project polling lease', async () => {
    const dir = await directory();
    const store = AutomationStore.open(dir);
    const first = store.acquireLease();
    expect(first).toBeDefined();
    expect(store.acquireLease()).toBeUndefined();
    first?.release();
    expect(store.acquireLease()).toBeDefined();
    chmodSync(dir, 0o700);
  });
});
