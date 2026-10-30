import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager, TURN_STALL_MS, TURN_STALL_TOOL_MS } from './run.ts';

/** #1499 — an in-flight turn that goes silent parks the run as "needs you" and frees its slot. */
describe('in-flight turn inactivity bound (#1499)', () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;
  let runId: string;
  let state: Record<string, unknown>;
  type Internals = {
    active: Map<string, unknown>;
    waiting: Set<string>;
    monitoring: Set<string>;
    touchTurn(id: string, s: unknown): void;
    endTurnWatch(id: string, s: unknown): void;
    trackRunningTool(s: unknown, e: unknown): void;
  };
  const m = () => manager as unknown as Internals;
  const minutes = (n: number) => vi.advanceTimersByTime(n * 60_000);
  const status = () => store.getRun(runId)?.status;

  beforeEach(() => {
    vi.useFakeTimers();
    root = mkdtempSync(join(tmpdir(), 'cez-stall-'));
    store = RunStore.open(join(root, '.ai/cezar'));
    manager = new RunManager(store, root);
    const r = store.createRun({ title: 't', workflow: 'w', task: 'x', steps: [{ id: 's', name: 's', kind: 'agent' as const }] });
    runId = r.id;
    store.updateRun(runId, { status: 'running' });
    state = { cancelled: false, session: { open: true }, currentStepId: 's', sessionEverOpened: true };
    m().active.set(runId, state);
  });
  afterEach(() => {
    vi.useRealTimers();
    manager.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('parks a silent turn as needs-you with a note, and releases the slot', () => {
    m().touchTurn(runId, state);
    minutes(TURN_STALL_MS / 60_000 - 1);
    expect(status()).toBe('running');
    minutes(2);
    expect(status()).toBe('waiting');
    expect(m().waiting.has(runId)).toBe(true);
    expect(store.readEvents(runId).some((e) => String(e.message).includes('silent'))).toBe(true);
  });

  it('every event pushes the deadline out, and activity after a park resumes the run', () => {
    m().touchTurn(runId, state);
    minutes(40);
    m().touchTurn(runId, state);
    minutes(40);
    expect(status()).toBe('running');
    minutes(10);
    expect(status()).toBe('waiting');
    m().touchTurn(runId, state);
    expect(status()).toBe('running');
    expect(m().waiting.has(runId)).toBe(false);
  });

  it('gives a tool the backend reports as running the longer bound', () => {
    m().trackRunningTool(state, { type: 'item.started', item: { kind: 'tool', id: 't1', status: 'running' } });
    m().touchTurn(runId, state);
    minutes(TURN_STALL_MS / 60_000 + 5);
    expect(status()).toBe('running');
    minutes(TURN_STALL_TOOL_MS / 60_000);
    expect(status()).toBe('waiting');
  });

  it('leaves parked and monitoring runs alone, and a turn end disarms it', () => {
    m().waiting.add(runId);
    m().touchTurn(runId, state);
    minutes(TURN_STALL_MS / 60_000 * 2);
    expect(status()).toBe('running'); // untouched: it is already parked by someone else
    m().waiting.delete(runId);
    m().monitoring.add(runId);
    m().touchTurn(runId, state);
    minutes(TURN_STALL_MS / 60_000 * 2);
    expect(status()).toBe('running');
    m().monitoring.delete(runId);
    m().touchTurn(runId, state);
    m().endTurnWatch(runId, state);
    minutes(TURN_STALL_MS / 60_000 * 2);
    expect(status()).toBe('running');
  });
});
