import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHealCycle, listHealCycles, patchHealCycle, readHealCycle } from './heal.ts';

describe('heal cycle ledger', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  function dataDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cez-heal-'));
    dirs.push(dir);
    return dir;
  }

  it('creates, lists, patches and reads a cycle', async () => {
    const dir = dataDir();
    const created = createHealCycle(dir, {
      brief: 'fix flaky tests',
      successCriteria: 'npm test',
      maxCandidates: 3,
      budgetUsd: 2,
    });
    expect(created.status).toBe('scouting');
    expect(listHealCycles(dir)).toHaveLength(1);

    const patched = await patchHealCycle(dir, created.id, {
      status: 'spawning',
      candidates: [
        {
          title: 'fix A',
          objective: 'fix test A',
          source: 'test',
          status: 'pending',
        },
      ],
    });
    expect(patched?.status).toBe('spawning');
    expect(patched?.candidates).toHaveLength(1);

    const read = await readHealCycle(dir, created.id);
    expect(read?.candidates[0]?.title).toBe('fix A');
  });
});
