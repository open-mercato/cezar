import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttentionResponse } from '@open-mercato/cezar-contract';
import { createAttentionService } from './service.ts';

const listOf = (revision: string): AttentionResponse => ({
  items: [],
  counts: { total: 0, question: 0, approval: 0, task: 0, review: 0, failed: 0, message: 0 },
  revision,
  overrides: [],
  olderAfterDays: 7,
});

describe('createAttentionService', () => {
  afterEach(() => vi.useRealTimers());

  it('reuses one read for polls until a poke or the max age (health is polled)', async () => {
    let clock = 0;
    let reads = 0;
    const service = createAttentionService({ read: async () => listOf(`r${++reads}`), now: () => clock, maxAgeMs: 10_000, settleMs: 60_000 });
    expect((await service.list()).revision).toBe('r1');
    expect((await service.list()).revision).toBe('r1');
    clock = 9_999;
    expect((await service.list()).revision).toBe('r1');
    clock = 10_000;
    expect((await service.list()).revision).toBe('r2');
    service.poke();
    expect((await service.list()).revision).toBe('r3');
    expect(reads).toBe(3);
    service.dispose();
  });

  it('shares an in-flight read, but never one a poke has overtaken', async () => {
    let reads = 0;
    const gates: Array<() => void> = [];
    const service = createAttentionService({
      read: () => new Promise((resolve) => { const n = ++reads; gates.push(() => resolve(listOf(`r${n}`))); }),
      settleMs: 60_000,
    });
    const first = service.list();
    const shared = service.list();
    expect(reads).toBe(1);
    service.poke();
    const after = service.list();
    expect(reads).toBe(2);
    gates.forEach((open) => open());
    expect((await first).revision).toBe('r1');
    expect((await shared).revision).toBe('r1');
    expect((await after).revision).toBe('r2');
    // The pre-poke read was not cached over the newer one.
    expect((await service.list()).revision).toBe('r2');
    service.dispose();
  });

  it('tells listeners once per real change after a settled burst of pokes', async () => {
    vi.useFakeTimers();
    let revision = 'a';
    const service = createAttentionService({ read: async () => listOf(revision), settleMs: 100 });
    const heard: string[] = [];
    service.onChange((list) => heard.push(list.revision));
    service.poke();
    service.poke();
    await vi.advanceTimersByTimeAsync(100);
    await service.idle();
    service.poke();
    await vi.advanceTimersByTimeAsync(100);
    await service.idle();
    revision = 'b';
    service.poke();
    await vi.advanceTimersByTimeAsync(100);
    await service.idle();
    expect(heard).toEqual(['a', 'b']);
    service.dispose();
  });

  // Review of #2367: a run event every 2 s must not recount when no phone could hear the result.
  it('recounts only while someone could hear it, though a poke still drops the cache', async () => {
    vi.useFakeTimers();
    let reads = 0;
    let wanted = false;
    const service = createAttentionService({ read: async () => listOf(`r${++reads}`), settleMs: 100, wanted: () => wanted });
    const heard: string[] = [];
    service.poke();
    await vi.advanceTimersByTimeAsync(100);
    expect(reads).toBe(0);
    service.onChange((list) => heard.push(list.revision));
    service.poke();
    await vi.advanceTimersByTimeAsync(100);
    expect(reads).toBe(0);
    expect((await service.list()).revision).toBe('r1');
    service.poke();
    expect((await service.list()).revision).toBe('r2');
    wanted = true;
    service.poke();
    await vi.advanceTimersByTimeAsync(100);
    await service.idle();
    expect(heard).toEqual(['r3']);
    service.dispose();
  });
});
