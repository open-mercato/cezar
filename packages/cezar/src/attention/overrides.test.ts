import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OVERRIDES_MAX, OVERRIDE_TTL_MS, createAttentionOverrideStore, nextOverrideWake } from './overrides.ts';

const NOW = Date.parse('2026-11-23T12:00:00.000Z');
const fileIn = () => join(mkdtempSync(join(tmpdir(), 'cez-overrides-')), 'attention-overrides.json');

describe('attention override store (spec 2026-11-23-needs-you-triage)', () => {
  it('works with no file, then sets, replaces and clears by key', async () => {
    const path = fileIn();
    const store = createAttentionOverrideStore(() => path);
    expect(await store.list(NOW)).toEqual([]);
    await store.set({ key: 'a', mode: 'dismiss' }, NOW);
    await store.set({ key: 'a', mode: 'keep' }, NOW);
    expect((await store.list(NOW)).map((entry) => [entry.key, entry.mode])).toEqual([['a', 'keep']]);
    // A second process reads what the first wrote.
    expect((await createAttentionOverrideStore(() => path).list(NOW)).map((entry) => entry.key)).toEqual(['a']);
    await store.clear('a', NOW);
    expect(await store.list(NOW)).toEqual([]);
  });

  it('drops ended snoozes, expired entries and bad rows', async () => {
    const path = fileIn();
    writeFileSync(path, JSON.stringify({ overrides: [
      { key: 'old', mode: 'dismiss', at: new Date(NOW - OVERRIDE_TTL_MS - 1).toISOString() },
      { key: 'ended', mode: 'dismiss', at: new Date(NOW).toISOString(), until: new Date(NOW - 1).toISOString() },
      { key: 'snoozed', mode: 'dismiss', at: new Date(NOW).toISOString(), until: new Date(NOW + 60_000).toISOString() },
      { key: 7 },
    ] }));
    const store = createAttentionOverrideStore(() => path);
    expect((await store.list(NOW)).map((entry) => entry.key)).toEqual(['snoozed']);
    await store.set({ key: 'b', mode: 'dismiss' }, NOW);
    expect(JSON.parse(readFileSync(path, 'utf8')).overrides.map((entry: { key: string }) => entry.key)).toEqual(['snoozed', 'b']);
  });

  it('a store that already read sees another process’s later write (review finding 12)', async () => {
    const path = fileIn();
    const mine = createAttentionOverrideStore(() => path);
    expect(await mine.list(NOW)).toEqual([]);
    await createAttentionOverrideStore(() => path).set({ key: 'phone', mode: 'dismiss', projectId: 'app', runId: 'r1' }, NOW);
    expect((await mine.list(NOW)).map((entry) => [entry.key, entry.runId])).toEqual([['phone', 'r1']]);
  });

  it('keeps run fields only as a pair', async () => {
    const path = fileIn();
    const store = createAttentionOverrideStore(() => path);
    await store.set({ key: 'half', mode: 'dismiss', projectId: 'app' }, NOW);
    expect((await store.list(NOW))[0]).not.toHaveProperty('projectId');
  });

  // chmod does not stop root, and Windows ignores it (review of #2443, finding 3).
  const canDenyWrites = process.platform !== 'win32' && process.getuid?.() !== 0;

  it.skipIf(!canDenyWrites)('on a read-only home keeps every change in memory and still sees the file (review 2, finding 2)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-overrides-ro-'));
    const path = join(dir, 'attention-overrides.json');
    writeFileSync(path, JSON.stringify({ overrides: [{ key: 'old', mode: 'dismiss', at: new Date(NOW).toISOString() }] }));
    chmodSync(dir, 0o500);
    try {
      const store = createAttentionOverrideStore(() => path);
      await store.set({ key: 'a', mode: 'dismiss' }, NOW);
      await store.set({ key: 'b', mode: 'dismiss' }, NOW);
      await store.clear('old', NOW);
      expect((await store.list(NOW)).map((entry) => entry.key)).toEqual(['a', 'b']);
      // The home comes back and another process writes: its entry shows, ours stay.
      chmodSync(dir, 0o700);
      await createAttentionOverrideStore(() => path).set({ key: 'phone', mode: 'dismiss' }, NOW + 1);
      expect((await store.list(NOW + 1)).map((entry) => entry.key).sort()).toEqual(['a', 'b', 'phone']);
      // The next write lands everything on disk.
      await store.set({ key: 'c', mode: 'keep' }, NOW + 2);
      expect(JSON.parse(readFileSync(path, 'utf8')).overrides.map((entry: { key: string }) => entry.key).sort()).toEqual(['a', 'b', 'c', 'phone']);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it.skipIf(!canDenyWrites)('a newer change on disk to a key this process failed to write wins (review of #2443, finding 4)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-overrides-ro-'));
    const path = join(dir, 'attention-overrides.json');
    writeFileSync(path, JSON.stringify({ overrides: [] }));
    chmodSync(dir, 0o500);
    try {
      const mine = createAttentionOverrideStore(() => path);
      await mine.set({ key: 'k', mode: 'dismiss' }, NOW);
      await mine.set({ key: 'only-mine', mode: 'dismiss' }, NOW);
      chmodSync(dir, 0o700);
      // Later, another process says the opposite about `k`.
      await createAttentionOverrideStore(() => path).set({ key: 'k', mode: 'keep' }, NOW + 1);
      const seen = Object.fromEntries((await mine.list(NOW + 1)).map((entry) => [entry.key, entry.mode]));
      expect(seen).toEqual({ k: 'keep', 'only-mine': 'dismiss' });
      // And our next write does not put the old `k` back.
      await mine.set({ key: 'other', mode: 'dismiss' }, NOW + 2);
      const disk = JSON.parse(readFileSync(path, 'utf8')).overrides as Array<{ key: string; mode: string }>;
      expect(Object.fromEntries(disk.map((entry) => [entry.key, entry.mode]))).toEqual({ k: 'keep', 'only-mine': 'dismiss', other: 'dismiss' });
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it('wakes at the soonest snooze end or TTL expiry (review 2, finding 6)', () => {
    const at = new Date(NOW).toISOString();
    expect(nextOverrideWake([])).toBeUndefined();
    expect(nextOverrideWake([{ key: 'plain', mode: 'dismiss', at }])).toBe(NOW + OVERRIDE_TTL_MS);
    expect(nextOverrideWake([{ key: 'plain', mode: 'dismiss', at }, { key: 's', mode: 'dismiss', at, until: new Date(NOW + 60_000).toISOString() }])).toBe(NOW + 60_000);
  });

  it('keeps the newest 500, a key set again counting as new (review of #2443, round 2)', async () => {
    const path = fileIn();
    const store = createAttentionOverrideStore(() => path);
    for (let i = 0; i <= OVERRIDES_MAX; i += 1) {
      await store.set({ key: `k${i}`, mode: 'dismiss' }, NOW + i);
      if (i === 250) await store.set({ key: 'k0', mode: 'dismiss' }, NOW + i);
    }
    const keys = (await store.list(NOW + OVERRIDES_MAX)).map((entry) => entry.key);
    expect(keys).toHaveLength(OVERRIDES_MAX);
    // k0 was set again after k1..k250: k1 is now the oldest, and the one that goes.
    expect(keys).toContain('k0');
    expect(keys).not.toContain('k1');
    expect(keys.at(-1)).toBe(`k${OVERRIDES_MAX}`);
  }, 60_000);

  it('treats a corrupt file as empty', async () => {
    const path = fileIn();
    writeFileSync(path, '{not json');
    expect(await createAttentionOverrideStore(() => path).list(NOW)).toEqual([]);
  });
});
