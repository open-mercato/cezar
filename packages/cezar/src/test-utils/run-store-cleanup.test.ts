import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { cleanupRunStores } from './run-store-cleanup.ts';

describe('run-store test cleanup', () => {
  it('blocks a save scheduled after teardown cleanup', () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-run-store-cleanup-'));
    try {
      const store = RunStore.open(join(root, '.ai/cezar'));
      store.createRun({ title: 'before cleanup', workflow: 'test', task: 'test', steps: [] });

      cleanupRunStores();
      store.createRun({ title: 'late write', workflow: 'test', task: 'test', steps: [] });

      expect((store as unknown as { saveTimer: NodeJS.Timeout | null }).saveTimer).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
