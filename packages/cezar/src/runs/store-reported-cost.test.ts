import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunStore } from './store.ts';

describe('reported run cost', () => {
  it('preserves an actual zero report through unrelated updates and disk reload without inventing missing zero', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-reported-cost-'));
    const store = RunStore.open(dir);
    try {
      const r = store.createRun({
        title: 'Measured',
        task: 't',
        workflow: 'build',
        steps: [
          { id: 'a', name: 'A', kind: 'agent' },
          { id: 'b', name: 'B', kind: 'agent' },
        ],
      });
      store.updateStep(r.id, 'a', { iterations: 1 });
      expect(store.getRun(r.id)?.costUsd).toBeUndefined();
      store.updateStep(r.id, 'a', { costUsd: 0 });
      expect(store.getRun(r.id)?.costUsd).toBe(0);
      store.updateStep(r.id, 'b', { tokensUsed: 500 });
      expect(store.getRun(r.id)?.costUsd).toBe(0);
      store.flush();
      expect(RunStore.open(dir).getRun(r.id)?.costUsd).toBe(0);
      store.updateStep(r.id, 'b', { costUsd: 0.002 });
      expect(store.getRun(r.id)?.costUsd).toBe(0.002);
    } finally {
      store.flush();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
