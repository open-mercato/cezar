import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from './store.ts';

/** `RunRecord.tags` persistence (spec 2026-11-23-task-tags § 4.3). */
describe('run store tags', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = join(mkdtempSync(join(tmpdir(), 'cez-store-tags-')), '.ai/cezar');
  });
  afterEach(() => rmSync(join(dataDir, '../..'), { recursive: true, force: true }));

  it('omits tags when a run has none, and round-trips them when it has', () => {
    const store = RunStore.open(dataDir);
    const plain = store.createRun({ title: 'p', workflow: 'w', task: 't', tags: [], steps: [] });
    const tagged = store.createRun({ title: 't', workflow: 'w', task: 't', tags: [{ id: 'tt-abcdefgh01', name: 'batch', color: 'blue' }], steps: [] });
    store.flush();
    const raw = JSON.parse(readFileSync(join(dataDir, 'runs.json'), 'utf8')) as Array<Record<string, unknown>>;
    expect(raw.find((r) => r.id === plain.id)).not.toHaveProperty('tags');
    const reopened = RunStore.open(dataDir);
    expect(reopened.getRun(tagged.id)?.tags).toEqual([{ id: 'tt-abcdefgh01', name: 'batch', color: 'blue' }]);
  });

  it('an old runs.json without tags parses, and a bad tags value drops only the tags', () => {
    mkdirSync(dataDir, { recursive: true });
    const run = (id: string, extra: Record<string, unknown> = {}) => ({
      id, title: id, workflow: 'w', task: 't', status: 'done', createdAt: '2026-11-01T00:00:00Z', tokensUsed: 0, archived: false, steps: [], ...extra,
    });
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([run('old'), run('bad', { tags: 'nonsense' })]));
    const store = RunStore.open(dataDir);
    expect(store.getRun('old')?.tags).toBeUndefined();
    expect(store.getRun('bad')).toBeDefined();
    expect(store.getRun('bad')?.tags).toBeUndefined();
  });
});
