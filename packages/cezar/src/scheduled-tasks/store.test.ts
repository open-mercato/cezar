import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ScheduledTaskStore, ScheduledTaskLeaseBusyError } from './store.ts';

const dirs: string[] = [];
const input = {
  name: 'Nightly report',
  enabled: true,
  timing: { kind: 'once' as const, at: '2026-09-01T13:30:00.000Z', timezone: 'America/New_York' },
  task: { prompt: 'Summarize the day' },
};

async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cezar-scheduled-tasks-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('ScheduledTaskStore', () => {
  it('writes definitions atomically at private permissions and preserves unknown fields', async () => {
    const dir = await directory();
    const store = ScheduledTaskStore.open(dir);
    const created = store.create(input, 'nightly');
    const path = join(dir, 'scheduled-tasks.json');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.future = { kept: true };
    raw.scheduledTasks[0].futureDefinition = true;
    writeFileSync(path, JSON.stringify(raw));

    const reopened = ScheduledTaskStore.open(dir);
    reopened.update('nightly', created.revision, { ...input, name: 'Updated' });
    const persisted = JSON.parse(readFileSync(path, 'utf8'));
    expect(persisted.future).toEqual({ kept: true });
    expect(persisted.scheduledTasks[0].futureDefinition).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('salvages valid entries and malformed NDJSON rows with one warning per file', async () => {
    const dir = await directory();
    const valid = ScheduledTaskStore.open(dir).create(input, 'valid');
    writeFileSync(
      join(dir, 'scheduled-tasks.json'),
      JSON.stringify({ version: 1, scheduledTasks: [valid, { id: 'broken' }] }),
    );
    writeFileSync(join(dir, 'scheduled-task-occurrences.ndjson'), '{bad json}\n{}\n');
    const warnings: string[] = [];
    const store = ScheduledTaskStore.open(dir, { warn: (warning) => warnings.push(warning) });
    expect(store.list().map((item) => item.id)).toEqual(['valid']);
    expect(store.occurrences()).toEqual([]);
    expect(warnings).toHaveLength(2);
  });

  it('enforces optimistic revisions and tombstones deleted ids', async () => {
    const store = ScheduledTaskStore.open(await directory());
    store.create(input, 'one');
    expect(() => store.update('one', 9, input)).toThrow('revision conflict');
    expect(store.delete('one')).toBe(true);
    expect(() => store.create(input, 'one')).toThrow('unavailable');
  });

  it('reserves exactly one occurrence per key and finalizes it', async () => {
    const store = ScheduledTaskStore.open(await directory());
    const key = 'one:1:2026-09-01T13:30:00.000Z';
    const occurrence = store.reserveOccurrence({
      scheduledTaskId: 'one',
      revision: 1,
      scheduledFor: input.timing.at,
      trigger: 'scheduled',
      key,
    });
    expect(occurrence?.status).toBe('reserved');
    expect(
      store.reserveOccurrence({ scheduledTaskId: 'one', revision: 1, scheduledFor: input.timing.at, trigger: 'scheduled', key }),
    ).toBeUndefined();
    const { seq: _seq, ...base } = occurrence!;
    store.appendOccurrence({ ...base, status: 'launched', runId: 'run-1', updatedAt: '2026-09-01T13:31:00.000Z' });
    expect(store.latestOccurrencesById().get(occurrence!.occurrenceId)?.runId).toBe('run-1');
    expect(store.occurrencesList({ scheduledTaskId: 'one' })[0]?.status).toBe('launched');
  });

  it('runExclusive re-reads the latest file and refuses when the lease is held', async () => {
    const dir = await directory();
    const store = ScheduledTaskStore.open(dir);
    const held = store.acquireLease();
    expect(held).toBeDefined();
    expect(() => store.runExclusive(() => store.create(input, 'x'))).toThrow(ScheduledTaskLeaseBusyError);
    held?.release();
    // With the lease free the exclusive create merges onto whatever is on disk.
    const created = store.runExclusive(() => store.create(input, 'x'));
    expect(created.id).toBe('x');
    chmodSync(dir, 0o700);
  });

  it('holds an exclusive recoverable project lease', async () => {
    const dir = await directory();
    const store = ScheduledTaskStore.open(dir);
    const first = store.acquireLease();
    expect(first).toBeDefined();
    expect(store.acquireLease()).toBeUndefined();
    first?.release();
    expect(store.acquireLease()).toBeDefined();
    chmodSync(dir, 0o700);
  });

  it('compacts occurrences while retaining unresolved reservations', async () => {
    const store = ScheduledTaskStore.open(await directory());
    // One unresolved reservation plus many terminal rows.
    store.reserveOccurrence({ scheduledTaskId: 'keep', revision: 1, scheduledFor: input.timing.at, trigger: 'scheduled', key: 'keep:1:at' });
    for (let i = 0; i < 5; i++) {
      const occurrence = store.reserveOccurrence({
        scheduledTaskId: `t${i}`, revision: 1, scheduledFor: input.timing.at, trigger: 'scheduled', key: `t${i}:1:at`,
      })!;
      const { seq: _seq, ...base } = occurrence;
      store.appendOccurrence({ ...base, status: 'launched', runId: `run-${i}`, updatedAt: '2026-09-01T13:31:00.000Z' });
    }
    store.compact();
    const reserved = store.occurrences().filter((row) => row.status === 'reserved');
    expect(reserved.map((row) => row.scheduledTaskId)).toContain('keep');
    // The terminal rows survive as their latest (launched) state.
    expect(store.occurrencesList({ status: 'launched' }).length).toBe(5);
  });
});
