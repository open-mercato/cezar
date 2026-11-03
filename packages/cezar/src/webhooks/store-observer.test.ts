import { realpathSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunStore, reconcileLoadedRun, type RunRecord } from '../runs/store.ts';

const stores: RunStore[] = [];
const dirs: string[] = [];
function setup() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-observer-')); dirs.push(dir);
  const store = RunStore.open(dir); stores.push(store);
  const run = store.createRun({ title: 'task', task: 'private prompt', workflow: 'quick-task', steps: [] });
  return { store, run };
}
afterEach(() => { for (const store of stores.splice(0)) store.flush(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const request = { requestId: 'question-1', askedAt: '2026-10-13T12:00:00.000Z', questions: [{ question: 'Choose?' }] };
function attach(store: RunStore, callback: (before: any, after: any, cause: string) => void) {
  const target = store as unknown as { setLifecycleObserver?: (observer: typeof callback) => void };
  expect(target.setLifecycleObserver).toBeTypeOf('function');
  target.setLifecycleObserver!(callback);
}
describe('RunStore webhook lifecycle observation', () => {
  it('captures the outer transition before a reentrant run listener', () => {
    const { store, run } = setup(); const seen: string[] = [];
    attach(store, (before, after) => { if (before?.status !== after?.status) seen.push(`${before?.status}:${after?.status}`); });
    store.on('run', r => { if (r.status === 'waiting') store.updateRun(run.id, { status: 'running' }); });
    store.updateRun(run.id, { status: 'waiting' });
    expect(seen).toEqual(['queued:waiting', 'waiting:running']);
  });
  it('isolates capture failures from task mutation and publication', () => {
    const { store, run } = setup(); let published = false;
    attach(store, () => { throw new Error('disk full'); });
    store.on('run', () => { published = true; });
    expect(() => store.updateRun(run.id, { status: 'done' })).not.toThrow();
    expect(store.getRun(run.id)?.status).toBe('done'); expect(published).toBe(true);
  });
  it('observes archive, bulk archive and deletion without prompt contents', () => {
    const { store, run } = setup(); const seen: any[] = [];
    attach(store, (before, after, cause) => seen.push({ before, after, cause }));
    store.updateRun(run.id, { status: 'done' }); store.setArchived(run.id, true); store.setArchived(run.id, false);
    store.archiveFinished(); store.deleteRun(run.id);
    expect(seen.map(x => x.after?.archived)).toEqual([false, true, false, true, undefined]);
    expect(seen.at(-1).before.id).toBe(run.id);
    expect(JSON.stringify(seen)).not.toContain('private prompt');
    expect(JSON.stringify(seen)).not.toContain('workflow');
  });
  it('clears additive metadata based on resulting status, including metadata-only patches', () => {
    const { store, run } = setup();
    store.updateRun(run.id, { status: 'waiting', attentionRequest: request } as any);
    expect((store.getRun(run.id) as any).attentionRequest).toEqual(request);
    store.updateRun(run.id, { status: 'done', completionReason: 'completed' } as any);
    expect((store.getRun(run.id) as any).attentionRequest).toBeUndefined();
    store.updateRun(run.id, { status: 'running' });
    expect((store.getRun(run.id) as any).completionReason).toBeUndefined();
    store.updateRun(run.id, { attentionRequest: request, completionReason: 'completed' } as any);
    expect((store.getRun(run.id) as any).attentionRequest).toBeUndefined();
    expect((store.getRun(run.id) as any).completionReason).toBeUndefined();
  });
  it('clears stale lifecycle metadata on load reconciliation', () => {
    const { run } = setup();
    const recovered = reconcileLoadedRun({ ...run, status: 'waiting', attentionRequest: request, completionReason: 'completed' } as RunRecord);
    expect(recovered.status).toBe('failed');
    expect((recovered as any).attentionRequest).toBeUndefined();
    expect((recovered as any).completionReason).toBeUndefined();
  });
});
