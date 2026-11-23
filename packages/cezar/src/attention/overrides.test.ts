import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OVERRIDE_TTL_MS, createAttentionOverrideStore } from './overrides.ts';

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

  it('treats a corrupt file as empty', async () => {
    const path = fileIn();
    writeFileSync(path, '{not json');
    expect(await createAttentionOverrideStore(() => path).list(NOW)).toEqual([]);
  });
});
