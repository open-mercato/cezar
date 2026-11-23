import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PR_ENDS_MAX, createPrEndMemory, prEndKey, prEndLookup, type PrEndRecord } from './pr-ends.ts';

/** What cezar has seen of PRs ending (spec 2026-11-23-needs-you-triage). */

const fileIn = () => join(mkdtempSync(join(tmpdir(), 'cez-pr-ends-')), 'attention-pr-ends.json');
const record = (number: number, over: Partial<PrEndRecord> = {}): PrEndRecord =>
  ({ root: '/repo', number, state: 'merged', endedAt: '2026-11-23T10:00:00.000Z', ...over });

describe('createPrEndMemory', () => {
  it('keeps the newest 2,000, an end seen again counting as new (review of #2443, round 2)', async () => {
    const path = fileIn();
    const memory = createPrEndMemory(() => path);
    await memory.note(Array.from({ length: PR_ENDS_MAX }, (_, i) => record(i + 1)), []);
    // #1 seen again, then one more: #2 is now the oldest, and the one that goes.
    await memory.note([record(1, { endedAt: '2026-11-23T11:00:00.000Z' })], []);
    await memory.note([record(PR_ENDS_MAX + 1)], []);
    const kept = await createPrEndMemory(() => path).load();
    expect(kept.size).toBe(PR_ENDS_MAX);
    expect(kept.has(prEndKey('/repo', 1))).toBe(true);
    expect(kept.has(prEndKey('/repo', 2))).toBe(false);
    expect(kept.has(prEndKey('/repo', PR_ENDS_MAX + 1))).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8')).ends).toHaveLength(PR_ENDS_MAX);
  });

  it('forgets a PR a fresh read found open again', async () => {
    const path = fileIn();
    const store = createPrEndMemory(() => path);
    await store.note([record(7)], []);
    await store.note([], [prEndKey('/repo', 7)]);
    expect((await store.load()).size).toBe(0);
  });
});

describe('prEndLookup', () => {
  const none = { end: () => undefined, isOpen: () => false };

  it('a fresh closed (not merged) end is used and remembered', () => {
    const ends = prEndLookup(new Map(), { end: () => ({ state: 'closed', endedAt: '2026-11-23T09:00:00.000Z' }), isOpen: () => false });
    expect(ends.lookup('/repo', 4)).toEqual({ state: 'closed', endedAt: '2026-11-23T09:00:00.000Z' });
    expect(ends.seen).toEqual([{ root: '/repo', number: 4, state: 'closed', endedAt: '2026-11-23T09:00:00.000Z' }]);
  });

  it('an end with no endedAt is used for this read but never remembered', () => {
    const ends = prEndLookup(new Map(), { end: () => ({ state: 'merged' }), isOpen: () => false });
    expect(ends.lookup('/repo', 5)).toEqual({ state: 'merged' });
    expect(ends.seen).toEqual([]);
  });

  it('falls back to the memory, and drops it when a fresh read says open', () => {
    const known = new Map([[prEndKey('/repo', 6), record(6, { state: 'closed' })]]);
    expect(prEndLookup(known, none).lookup('/repo', 6)).toEqual({ state: 'closed', endedAt: '2026-11-23T10:00:00.000Z' });
    const reopened = prEndLookup(known, { end: () => undefined, isOpen: () => true });
    expect(reopened.lookup('/repo', 6)).toBeUndefined();
    expect(reopened.reopened).toEqual([prEndKey('/repo', 6)]);
  });

  it('an unchanged fresh end is not written again', () => {
    const known = new Map([[prEndKey('/repo', 8), record(8)]]);
    const ends = prEndLookup(known, { end: () => ({ state: 'merged', endedAt: '2026-11-23T10:00:00.000Z' }), isOpen: () => false });
    ends.lookup('/repo', 8);
    expect(ends.seen).toEqual([]);
  });
});
