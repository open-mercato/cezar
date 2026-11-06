import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from './store.ts';
import { track } from '../telemetry.ts';

vi.mock('../telemetry.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), track: vi.fn() }));

/** `idleClosedAt` (spec 2026-11-04-idle-closed-attention-state): same failed-only invariant as
 *  `awaitingAnswerSince`, but an ordinary finished outcome — and never a counted failure. */
describe('RunStore — idleClosedAt', () => {
  let dataDir: string;
  const AT = '2026-11-04T10:00:00.000Z';
  const IDLE = 'the session closed after inactivity before the task declared completion — continue to resume it';

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-store-idle-'));
    vi.mocked(track).mockClear();
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  const idleClosed = (store: RunStore): string => {
    const run = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
    store.updateRun(run.id, { status: 'running' });
    store.updateRun(run.id, { status: 'failed', error: IDLE, finishedAt: AT, idleClosedAt: AT });
    return run.id;
  };

  it('round-trips through a reload', () => {
    const store = RunStore.open(dataDir);
    const id = idleClosed(store);
    store.flush();
    expect(RunStore.open(dataDir, { keepLive: true }).getRun(id)?.idleClosedAt).toBe(AT);
  });

  it.each(['running', 'queued', 'waiting', 'done', 'review', 'cancelled'] as const)(
    'is retired when the run moves to %s',
    (status) => {
      const store = RunStore.open(dataDir);
      const id = idleClosed(store);
      store.updateRun(id, { status });
      expect(store.getRun(id)?.idleClosedAt).toBeUndefined();
    },
  );

  it('is an ordinary outcome: "Archive finished" sweeps it', () => {
    const store = RunStore.open(dataDir);
    const id = idleClosed(store);
    expect(store.archiveFinished()).toBe(1);
    expect(store.getRun(id)?.archived).toBe(true);
  });

  it('drops a bad value, and a stray one on a non-failed record, without losing the record', () => {
    const store = RunStore.open(dataDir);
    const bad = idleClosed(store);
    const done = store.createRun({ title: 'd', workflow: 'quick-task', task: 'd', steps: [] });
    store.updateRun(done.id, { status: 'done', finishedAt: AT });
    store.flush();
    const path = join(dataDir, 'runs.json');
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Array<Record<string, unknown>>;
    raw.find((r) => r.id === bad)!.idleClosedAt = 'not a date';
    raw.find((r) => r.id === done.id)!.idleClosedAt = AT;
    writeFileSync(path, JSON.stringify(raw));
    const reopened = RunStore.open(dataDir);
    expect(reopened.getRun(bad)).toMatchObject({ status: 'failed', error: IDLE });
    expect(reopened.getRun(bad)?.idleClosedAt).toBeUndefined();
    expect(reopened.getRun(done.id)?.status).toBe('done');
    expect(reopened.getRun(done.id)?.idleClosedAt).toBeUndefined();
  });

  it('is not counted as task_failed, while the same message without the marker still is', () => {
    const store = RunStore.open(dataDir);
    idleClosed(store);
    expect(vi.mocked(track)).not.toHaveBeenCalledWith('task_failed', expect.anything());

    const plain = store.createRun({ title: 'p', workflow: 'quick-task', task: 'p', steps: [] });
    store.updateRun(plain.id, { status: 'running' });
    store.updateRun(plain.id, { status: 'failed', error: IDLE, finishedAt: AT });
    expect(vi.mocked(track)).toHaveBeenCalledWith('task_failed', expect.objectContaining({ label: expect.stringMatching(/:timeout$/) }));
  });
});
