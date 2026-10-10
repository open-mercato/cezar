import { chmodSync, mkdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AutomationStore } from './store.ts';

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

  it('normalizes a legacy receipt key before checking event identity', async () => {
    const store = AutomationStore.open(await directory());
    store.appendReceipt({
      receiptId: 'old-receipt',
      receiptKey: 'one:1:event',
      eventId: 'event',
      automationId: 'one',
      revision: 1,
      status: 'launched',
      runId: 'run-1',
      observedAt: '2026-07-26T01:00:00.000Z',
      updatedAt: '2026-07-26T01:00:00.000Z',
    });
    expect(store.reserveReceipt({ automationId: 'one', revision: 2, eventId: 'event' })).toBeUndefined();
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

describe('AutomationStore.acquireLease — a lock nobody is holding any more (#983)', () => {
  const FOREIGN_PID = 424_242;
  /** Above every platform's pid_max, so the real probe always reports it gone. */
  const UNREACHABLE_PID = 2_147_483_647;

  async function lockedDirectory(contents: string): Promise<string> {
    const dir = await directory();
    writeFileSync(join(dir, 'automation-poll.lock'), contents);
    return dir;
  }

  it('reclaims a fresh lock whose writer is gone instead of waiting out the ten-minute age rule', async () => {
    const dir = await lockedDirectory(JSON.stringify({ pid: FOREIGN_PID, startedAt: new Date().toISOString() }));
    const store = AutomationStore.open(dir, { processAlive: () => false });
    const lease = store.acquireLease();
    expect(lease).toBeDefined();
    // The reclaimed lock now names this process, so the next contender probes us, not the corpse.
    expect(JSON.parse(readFileSync(join(dir, 'automation-poll.lock'), 'utf8')).pid).toBe(process.pid);
    lease?.release();
  });

  it('leaves a lock alone while its writer is still alive', async () => {
    const dir = await lockedDirectory(JSON.stringify({ pid: FOREIGN_PID, startedAt: new Date().toISOString() }));
    const probed: number[] = [];
    const store = AutomationStore.open(dir, { processAlive: (pid) => { probed.push(pid); return true; } });
    expect(store.acquireLease()).toBeUndefined();
    expect(probed).toEqual([FOREIGN_PID]);
    // And the live holder's lock is still on disk, untouched.
    expect(JSON.parse(readFileSync(join(dir, 'automation-poll.lock'), 'utf8')).pid).toBe(FOREIGN_PID);
  });

  it('does not overwrite a replacement that appears after stale metadata validation', async () => {
    const dir = await lockedDirectory(JSON.stringify({ pid: UNREACHABLE_PID, startedAt: new Date().toISOString() }));
    const replacement = JSON.stringify({ pid: process.pid, token: 'replacement', startedAt: new Date().toISOString() });
    const store = AutomationStore.open(dir, {
      processAlive: () => false,
      beforeLeaseMetadataWrite: (path) => writeFileSync(path, replacement),
    });
    expect(store.acquireLease()).toBeUndefined();
    expect(readFileSync(join(dir, 'automation-poll.lock'), 'utf8')).toBe(replacement);
  });

  it('falls back to the age rule for a lock whose pid cannot be read', async () => {
    const dir = await lockedDirectory('{half-writ');
    const store = AutomationStore.open(dir, { processAlive: () => false });
    expect(store.acquireLease()).toBeUndefined();
    // Same unreadable lock, now with staleAfterMs of 0: "stale regardless of age" is
    // deterministic and does not depend on any real time having passed since it was written.
    expect(store.acquireLease(0)).toBeDefined();
  });

  it('retries when stale-guard cleanup loses the path race', async () => {
    const dir = await lockedDirectory(JSON.stringify({ pid: UNREACHABLE_PID, startedAt: new Date().toISOString() }));
    let attempts = 0;
    const store = AutomationStore.open(dir, {
      beforeLeaseMetadataWrite: () => {
        if (attempts++ === 0) {
          const error = new Error('guard was replaced during stale recovery') as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          throw error;
        }
      },
    });
    const lease = store.acquireLease();
    expect(lease).toBeDefined();
    expect(attempts).toBe(2);
    lease?.release();
  });

  it('bounds repeated stale-guard ENOENT failures to one retry', async () => {
    const dir = await lockedDirectory(JSON.stringify({ pid: UNREACHABLE_PID, startedAt: new Date().toISOString() }));
    let attempts = 0;
    const store = AutomationStore.open(dir, {
      beforeLeaseMetadataWrite: () => {
        attempts += 1;
        const error = new Error('guard keeps racing') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      },
    });
    expect(store.acquireLease()).toBeUndefined();
    expect(attempts).toBe(2);
  });

  it('does not steal a competitor that wins before the retry', async () => {
    const dir = await lockedDirectory(JSON.stringify({ pid: UNREACHABLE_PID, startedAt: new Date().toISOString() }));
    const replacement = JSON.stringify({ pid: process.pid, token: 'competitor', startedAt: new Date().toISOString() });
    let first = true;
    const store = AutomationStore.open(dir, {
      beforeLeaseMetadataWrite: (path) => {
        if (first) {
          first = false;
          writeFileSync(path, replacement);
          const error = new Error('guard was replaced during stale recovery') as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          throw error;
        }
      },
    });
    expect(store.acquireLease()).toBeUndefined();
    expect(readFileSync(join(dir, 'automation-poll.lock'), 'utf8')).toBe(replacement);
  });

  it('probes real pids when nothing is injected', async () => {
    const live = await lockedDirectory(JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }));
    expect(AutomationStore.open(live).acquireLease()).toBeUndefined();
    const dead = await lockedDirectory(JSON.stringify({ pid: UNREACHABLE_PID, startedAt: new Date().toISOString() }));
    const lease = AutomationStore.open(dead).acquireLease();
    expect(lease).toBeDefined();
    lease?.release();
  });

  it('serializes competing stale-lock reclaimers and does not let an old owner release a replacement', async () => {
    const dir = await lockedDirectory(JSON.stringify({ pid: UNREACHABLE_PID, startedAt: new Date().toISOString() }));
    const one = AutomationStore.open(dir, { processAlive: () => false });
    const two = AutomationStore.open(dir, { processAlive: () => false });
    const first = one.acquireLease();
    expect(first).toBeDefined();
    // A contender must observe the live replacement, not reclaim it as the abandoned lock.
    expect(two.acquireLease()).toBeUndefined();
    const replacement = JSON.stringify({ pid: process.pid, token: 'replacement', startedAt: new Date().toISOString() });
    writeFileSync(join(dir, 'automation-poll.lock'), replacement);
    first?.release();
    expect(readFileSync(join(dir, 'automation-poll.lock'), 'utf8')).toBe(replacement);
    unlinkSync(join(dir, 'automation-poll.lock'));
  });

  it('allows at most one of two processes to reclaim the same abandoned lock', async () => {
    const dir = await lockedDirectory(JSON.stringify({ pid: UNREACHABLE_PID, startedAt: new Date().toISOString() }));
    const guard = join(dir, 'automation-poll.lock.guard');
    mkdirSync(guard);
    const old = new Date(Date.now() - 20 * 60_000);
    utimesSync(guard, old, old);
    const barriers = join(dir, 'barriers');
    const child = fileURLToPath(new URL('./store-lease-child.testkit.ts', import.meta.url));
    const children = ['a', 'b'].map((role) => spawn(process.execPath, ['--import', 'tsx', child, dir, barriers, role], { stdio: ['pipe', 'pipe', 'inherit'] }));
    const states = children.map((childProcess) => {
      let buffer = '';
      let ready!: () => void;
      let result!: (held: boolean) => void;
      const readyPromise = new Promise<void>((resolve) => { ready = resolve; });
      const resultPromise = new Promise<boolean>((resolve) => { result = resolve; });
      childProcess.stdout.setEncoding('utf8');
      childProcess.stdout.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop()!;
        for (const line of lines) {
          if (line === 'ready') ready();
          else if (line) result(JSON.parse(line).held as boolean);
        }
      });
      return { readyPromise, resultPromise };
    });
    await Promise.all(states.map((state) => state.readyPromise));
    for (const childProcess of children) childProcess.stdin.write('go\n');
    const results = await Promise.all(states.map((state) => state.resultPromise));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('recovers a guard abandoned by a dead process', async () => {
    const dir = await lockedDirectory(JSON.stringify({ pid: UNREACHABLE_PID, startedAt: new Date().toISOString() }));
    const guard = join(dir, 'automation-poll.lock.guard');
    mkdirSync(guard);
    const old = new Date(Date.now() - 20 * 60_000);
    utimesSync(guard, old, old);
    const lease = AutomationStore.open(dir).acquireLease();
    expect(lease).toBeDefined();
    expect(JSON.parse(readFileSync(join(dir, 'automation-poll.lock'), 'utf8')).pid).toBe(process.pid);
    lease?.release();
  });

  it('recovers a real killed owner after the bounded guard stale window', async () => {
    const dir = await directory();
    const child = fileURLToPath(new URL('./store-lease-child.testkit.ts', import.meta.url));
    const childProcess = spawn(process.execPath, ['--import', 'tsx', child, dir], { stdio: ['pipe', 'pipe', 'inherit'] });
    let output = '';
    const acquired = new Promise<void>((resolve, reject) => {
      childProcess.stdout.setEncoding('utf8');
      childProcess.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.includes('ready\n')) childProcess.stdin.write('go\n');
        if (output.includes('"held":true')) resolve();
      });
      childProcess.once('error', reject);
    });
    await acquired;
    childProcess.kill('SIGKILL');
    await new Promise<void>((resolve) => childProcess.once('close', () => resolve()));
    // proper-lockfile's stale threshold is 2s minimum; leave margin for the final
    // heartbeat/stat timestamp and filesystem timestamp granularity.
    await new Promise((resolve) => setTimeout(resolve, 3_200));
    const lease = AutomationStore.open(dir).acquireLease();
    expect(lease).toBeDefined();
    lease?.release();
  }, 8_000);
});

describe('AutomationStore.setState (spec 2026-09-14: read-modify-write)', () => {
  it('lets two stores on one directory interleave writes without clobbering each other', async () => {
    const dir = await directory();
    const one = AutomationStore.open(dir);
    const two = AutomationStore.open(dir);
    one.setState('a', (current) => ({ ...current, nextRunAt: '2026-09-15T02:00:00.000Z' }));
    two.setState('b', (current) => ({ ...current, cursor: { timestamp: '2026-09-14T00:00:00.000Z' } }));
    one.setState('a', (current) => ({ ...current, nextRunAt: '2026-09-16T02:00:00.000Z' }));
    const fresh = AutomationStore.open(dir);
    expect(fresh.state('a')).toEqual({ nextRunAt: '2026-09-16T02:00:00.000Z' });
    expect(fresh.state('b')).toEqual({ cursor: { timestamp: '2026-09-14T00:00:00.000Z' } });
    // Each in-memory copy also sees the other's id after its own next write.
    expect(one.state('b')).toEqual({ cursor: { timestamp: '2026-09-14T00:00:00.000Z' } });
  });

  it('two stores racing on the SAME id: the loser computes its update from a fresh disk read, never its own stale cached snapshot', async () => {
    const dir = await directory();
    const one = AutomationStore.open(dir);
    const two = AutomationStore.open(dir);
    // `two`'s only knowledge of 'a' at this point is "absent" — its stale baseline.
    expect(two.state('a')).toBeUndefined();
    // `one` (the process that held the launch lease) commits a successful-launch snapshot.
    one.setState('a', (current) => ({
      ...current,
      consecutiveFailures: 0,
      lastRunAt: '2026-09-14T01:00:00.000Z',
      lastSuccessAt: '2026-09-14T02:00:00.000Z',
    }));
    // `two` (the process that lost the lease) now bumps the failure counter. If this closed over
    // `two`'s stale in-memory snapshot instead of re-reading disk, the result would silently
    // revert `one`'s `lastRunAt`/`lastSuccessAt` and read `consecutiveFailures: 1` in isolation.
    two.setState('a', (current) => ({ ...current, consecutiveFailures: (current.consecutiveFailures ?? 0) + 1 }));
    const fresh = AutomationStore.open(dir);
    expect(fresh.state('a')).toEqual({
      consecutiveFailures: 1,
      lastRunAt: '2026-09-14T01:00:00.000Z',
      lastSuccessAt: '2026-09-14T02:00:00.000Z',
    });
  });
});

it('keeps old tracker receipts while the definition can resume history, then expires them after deletion', async () => {
  let now = new Date('2026-01-01T00:00:00.000Z');
  const store = AutomationStore.open(await directory(), { now: () => now });
  store.create({ ...input, kind: 'tracker', filters: { ...input.filters, status: 'To Do' } }, 'tracker');
  store.create(input, 'github');
  store.reserveReceipt({ automationId: 'tracker', revision: 1, eventId: 'history:1' });
  store.reserveReceipt({ automationId: 'github', revision: 1, eventId: 'event:1' });
  now = new Date('2026-09-19T00:00:00.000Z');
  store.compact();
  expect(store.receipts().map(receipt => receipt.automationId)).toEqual(['tracker']);
  expect(store.reserveReceipt({ automationId: 'tracker', revision: 1, eventId: 'history:1' })).toBeUndefined();
  store.delete('tracker');
  store.compact();
  expect(store.receipts()).toEqual([]);
});
