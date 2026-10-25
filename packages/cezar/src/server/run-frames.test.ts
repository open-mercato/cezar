import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { WORKSPACE_RUN_EVENT_OMITTED_KEYS, workspaceRunEventSchema } from '@open-mercato/cezar-contract';
import type { RunRecord, RunStore } from '../runs/store.ts';
import { onRunFrames, toWorkspaceRunEvent } from './run-frames.ts';

/** The store's `run` emits are the only surface this module touches, so a plain emitter stands in
 *  for the real store. `RunStore` extends `EventEmitter`; everything else on it is out of scope. */
class FakeStore extends EventEmitter {
  run(run: RunRecord): void {
    this.emit('run', run);
  }
}

const asStore = (store: FakeStore): RunStore => store as unknown as RunStore;

function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'r1',
    title: 'r1',
    workflow: 'quick-task',
    task: 'do it',
    status: 'running',
    createdAt: '2026-07-14T10:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  };
}

describe('toWorkspaceRunEvent', () => {
  it('stamps the project and leaves the thread-only keys off', () => {
    const frame = toWorkspaceRunEvent(
      record({ systemPrompt: 'sys', status: 'done' }),
      'p1',
    );

    for (const key of WORKSPACE_RUN_EVENT_OMITTED_KEYS) expect(frame).not.toHaveProperty(key);
    expect(frame).toMatchObject({ id: 'r1', status: 'done', project: 'p1' });
    expect(workspaceRunEventSchema.strict().safeParse(frame).success).toBe(true);
  });
});

describe('onRunFrames', () => {
  it('uses one store listener however many subscribers join', () => {
    const store = new FakeStore();
    const offA = onRunFrames(asStore(store), () => undefined);
    const offB = onRunFrames(asStore(store), () => undefined);

    expect(store.listenerCount('run')).toBe(1);
    offA();
    expect(store.listenerCount('run')).toBe(1);
    offB();
    expect(store.listenerCount('run')).toBe(0);
  });

  it('detaches the shared listener when the last subscriber leaves', () => {
    const store = new FakeStore();
    const seen: string[] = [];
    const off = onRunFrames(asStore(store), (_run, frames) => seen.push(frames.record()));

    store.run(record());
    off();
    store.run(record());

    expect(seen).toHaveLength(1);
    expect(store.listenerCount('run')).toBe(0);
  });

  it('serializes each frame shape once for one emit, however many subscribers relay it', () => {
    const store = new FakeStore();
    const stringify = vi.spyOn(JSON, 'stringify');
    const offA = onRunFrames(asStore(store), (_run, frames) => frames.workspace('p1'));
    const offB = onRunFrames(asStore(store), (_run, frames) => frames.workspace('p1'));
    const offC = onRunFrames(asStore(store), (_run, frames) => frames.record());

    store.run(record());

    const workspaceCalls = stringify.mock.calls.filter(
      ([value]) => (value as { project?: unknown } | null)?.project === 'p1',
    );
    stringify.mockRestore();
    expect(workspaceCalls).toHaveLength(1);
    offA();
    offB();
    offC();
  });

  it('rebuilds the frame text on each emit — the store emits one mutable record', () => {
    const store = new FakeStore();
    const texts: string[] = [];
    const off = onRunFrames(asStore(store), (_run, frames) => texts.push(frames.record()));

    const run = record();
    store.run(run);
    run.status = 'done';
    store.run(run);
    off();

    expect(texts[0]).not.toBe(texts[1]);
    expect((JSON.parse(texts[1] as string) as { status: string }).status).toBe('done');
  });

  it('resumes with a fresh shared listener after a full unsubscribe', () => {
    const store = new FakeStore();
    const first = vi.fn();
    const off = onRunFrames(asStore(store), first);
    off();
    const second = vi.fn();
    const off2 = onRunFrames(asStore(store), second);

    store.run(record());

    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(store.listenerCount('run')).toBe(1);
    off2();
  });
});
