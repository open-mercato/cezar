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
  const NOW = Date.parse('2026-11-23T12:00:00.000Z')
  const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString()
  const none = { end: () => undefined, isOpen: () => false }

  it('a fresh closed (not merged) end is used and remembered', () => {
    const ends = prEndLookup(new Map(), { end: () => ({ state: 'closed', endedAt: at(3) }), isOpen: () => false }, NOW)
    expect(ends.lookup('/repo', 4)).toEqual({ state: 'closed', endedAt: at(3) })
    expect(ends.seen).toEqual([{ root: '/repo', number: 4, state: 'closed', endedAt: at(3), seenAt: at(0) }])
  })

  it('an end with no endedAt, and none remembered, is used for this read but never stored', () => {
    const ends = prEndLookup(new Map(), { end: () => ({ state: 'merged' }), isOpen: () => false }, NOW)
    expect(ends.lookup('/repo', 5)).toEqual({ state: 'merged' })
    expect(ends.seen).toEqual([])
  })

  it('a fresh end with no time borrows the remembered one for the same end (review of #2443, round 3)', () => {
    const known = new Map([[prEndKey('/repo', 5), record(5, { endedAt: at(30), seenAt: at(1) })]])
    const ends = prEndLookup(known, { end: () => ({ state: 'merged' }), isOpen: () => false }, NOW)
    expect(ends.lookup('/repo', 5)).toEqual({ state: 'merged', endedAt: at(30) })
    // A different state is a different end: no time is borrowed.
    const closed = prEndLookup(known, { end: () => ({ state: 'closed' }), isOpen: () => false }, NOW)
    expect(closed.lookup('/repo', 5)).toEqual({ state: 'closed' })
  })

  it('falls back to the memory, and drops it when a fresh read says open', () => {
    const known = new Map([[prEndKey('/repo', 6), record(6, { state: 'closed', endedAt: at(2), seenAt: at(1) })]])
    expect(prEndLookup(known, none, NOW).lookup('/repo', 6)).toEqual({ state: 'closed', endedAt: at(2) })
    const reopened = prEndLookup(known, { end: () => undefined, isOpen: () => true }, NOW)
    expect(reopened.lookup('/repo', 6)).toBeUndefined()
    expect(reopened.dropped).toEqual([prEndKey('/repo', 6)])
  })

  it('a remembered closed end lapses a day after it was last confirmed; a merged one stays (review of #2443, round 3)', () => {
    const known = new Map([
      [prEndKey('/repo', 7), record(7, { state: 'closed', endedAt: at(40), seenAt: at(25) })],
      [prEndKey('/repo', 8), record(8, { state: 'closed', endedAt: at(40), seenAt: at(23) })],
      [prEndKey('/repo', 9), record(9, { state: 'merged', endedAt: at(400), seenAt: at(300) })],
    ])
    const ends = prEndLookup(known, none, NOW)
    expect(ends.lookup('/repo', 7)).toBeUndefined()
    expect(ends.lookup('/repo', 8)).toEqual({ state: 'closed', endedAt: at(40) })
    expect(ends.lookup('/repo', 9)).toEqual({ state: 'merged', endedAt: at(400) })
    expect(ends.dropped).toEqual([prEndKey('/repo', 7)])
  })

  it('without seenAt, a closed end lapses against when it ended; a merged one never (review of #2443, round 4)', () => {
    const bare = (number: number, state: 'merged' | 'closed', hoursAgo: number) => {
      const { seenAt: _seen, ...rest } = record(number, { state, endedAt: at(hoursAgo) })
      return rest
    }
    const known = new Map([
      [prEndKey('/repo', 1), bare(1, 'closed', 25)],
      [prEndKey('/repo', 2), bare(2, 'closed', 23)],
      [prEndKey('/repo', 3), bare(3, 'merged', 400)],
    ])
    const ends = prEndLookup(known, none, NOW)
    expect(ends.lookup('/repo', 1)).toBeUndefined()
    expect(ends.lookup('/repo', 2)).toEqual({ state: 'closed', endedAt: at(23) })
    expect(ends.lookup('/repo', 3)).toEqual({ state: 'merged', endedAt: at(400) })
    expect(ends.dropped).toEqual([prEndKey('/repo', 1)])
  })

  it('a fresh read confirming a closed end renews it, at most hourly', () => {
    const known = new Map([
      [prEndKey('/repo', 7), record(7, { state: 'closed', endedAt: at(40), seenAt: at(2) })],
      [prEndKey('/repo', 8), record(8, { state: 'closed', endedAt: at(40), seenAt: at(0.5) })],
    ])
    const ends = prEndLookup(known, { end: () => ({ state: 'closed', endedAt: at(40) }), isOpen: () => false }, NOW)
    ends.lookup('/repo', 7)
    ends.lookup('/repo', 8)
    expect(ends.seen.map((entry) => [entry.number, entry.seenAt])).toEqual([[7, at(0)]])
  })

  it('an unchanged fresh merged end is not written again', () => {
    const known = new Map([[prEndKey('/repo', 8), record(8, { seenAt: at(30) })]])
    const ends = prEndLookup(known, { end: () => ({ state: 'merged', endedAt: '2026-11-23T10:00:00.000Z' }), isOpen: () => false }, NOW)
    ends.lookup('/repo', 8)
    expect(ends.seen).toEqual([])
  })
})
