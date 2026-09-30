import { afterEach, expect, it, vi } from 'vitest';
import { TrackerWatches } from './watch.ts';
import type { TrackerAssociation, TrackerItemsResponse } from '@open-mercato/cezar-contract';

const association: TrackerAssociation = { kind: 'jira', source: { id: 's', webUrl: 'https://example.com' }, externalId: '1', externalName: 'One' };
const page: TrackerItemsResponse = { available: true, items: [], truncated: false };
const input = { association, query: '', state: 'active' as const, labels: [] };
const project = { root: '/repo/a', dataDir: '/repo/a/.ai/cezar' };
afterEach(() => vi.useRealTimers());
function fixture() {
  vi.useFakeTimers();
  let current = association;
  const read = vi.fn(async () => page);
  const watches = new TrackerWatches({
    driver: async () => ({ association: current, listIssues: read, searchItems: read, getItem: vi.fn() }),
  });
  return { watches, read, change: () => { current = { ...association, externalId: '2' }; } };
}
it('shares normalized filters, checks only on demand every60s and stops at last unsubscribe', async () => {
  const { watches, read } = fixture();
  const a = await watches.open(project, { ...input, labels: ['b', 'a', 'a'] });
  const b = await watches.open(project, { ...input, labels: ['a', 'b'] });
  expect(a.id).toBe(b.id);
  expect(read).not.toHaveBeenCalled();
  const offA = watches.subscribe(a.id, () => {});
  const offB = watches.subscribe(b.id, () => {});
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenLastCalledWith({ state: 'active', labels: ['a', 'b'], limit: 50, refresh: '1' });
  const stamp = watches.snapshot(project, a.id)!.checkedAt;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(read).toHaveBeenCalledTimes(2);
  expect(watches.snapshot(project, a.id)!.checkedAt).not.toBe(stamp);
  offA();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(read).toHaveBeenCalledTimes(3);
  offB();
  await vi.advanceTimersByTimeAsync(180_000);
  expect(read).toHaveBeenCalledTimes(3);
  expect(watches.snapshot(project, a.id)).toBeNull();
});
it('isolates projects and rejects old results after association replacement', async () => {
  const { watches, read, change } = fixture();
  const a = await watches.open(project, input);
  const b = await watches.open({ ...project, root: '/repo/b' }, input);
  expect(a.id).not.toBe(b.id);
  expect(watches.snapshot({ ...project, root: '/repo/b' }, a.id)).toBeNull();
  let finish!: (value: TrackerItemsResponse) => void;
  read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const off = watches.subscribe(a.id, () => {});
  await vi.advanceTimersByTimeAsync(0);
  change(); finish(page);
  await vi.advanceTimersByTimeAsync(0);
  expect(watches.snapshot(project, a.id)).toMatchObject({ checkedAt: null, result: { available: false, code: 'source_changed' } });
  await vi.advanceTimersByTimeAsync(180_000);
  expect(read).toHaveBeenCalledTimes(1);
  off(); watches.close();
});
it('retains successful time on failure, honors cooldown and never overlaps requests', async () => {
  const { watches, read } = fixture();
  const a = await watches.open(project, input);
  const off = watches.subscribe(a.id, () => {});
  await vi.advanceTimersByTimeAsync(0);
  const stamp = watches.snapshot(project, a.id)!.checkedAt;
  read.mockResolvedValue({ available: false, code: 'rate_limited', reason: 'Wait', retryAfterSeconds: 120 });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(watches.snapshot(project, a.id)!.checkedAt).toBe(stamp);
  await watches.refresh(project, a.id);
  await vi.advanceTimersByTimeAsync(119_999);
  expect(read).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(3);
  off(); watches.close();
});
it('an aborted remote long read releases demand and cannot keep the publisher alive', async () => {
  const { watches, read } = fixture();
  const handle = await watches.open(project, input);
  const first = watches.wait(project, handle.id, 0, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(0);
  await first;
  await vi.advanceTimersByTimeAsync(0);
  const controller = new AbortController();
  const waiting = watches.wait(project, handle.id, watches.snapshot(project, handle.id)!.version, controller.signal);
  await vi.advanceTimersByTimeAsync(0);
  controller.abort(); await waiting;
  await vi.advanceTimersByTimeAsync(180_000);
  expect(read).toHaveBeenCalledTimes(1);
  watches.close();
});
it('never overlaps a slow check and resumes without a catch-up burst', async () => {
  const { watches, read } = fixture();
  let finish!: (value: TrackerItemsResponse) => void;
  read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const handle = await watches.open(project, input);
  let off = watches.subscribe(handle.id, () => {});
  await vi.advanceTimersByTimeAsync(0);
  const manual = watches.refresh(project, handle.id);
  await vi.advanceTimersByTimeAsync(180_000);
  expect(read).toHaveBeenCalledTimes(1);
  finish(page); await manual;
  off();
  await vi.advanceTimersByTimeAsync(70_000);
  off = watches.subscribe(handle.id, () => {});
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(2);
  off(); watches.close();
});
it('expired topic handles dispose their registration and do not remove a later replacement', async () => {
  const { read } = fixture();
  const remove = vi.fn();
  const register = vi.fn(() => remove);
  const watches = new TrackerWatches({ driver: async () => ({ association, listIssues: read, searchItems: read, getItem: vi.fn() }) }, { registerTopic: register, attach() {}, close() {} });
  await watches.open(project, input);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(remove).toHaveBeenCalledTimes(1);
  expect(read).not.toHaveBeenCalled();
  watches.close();
});
