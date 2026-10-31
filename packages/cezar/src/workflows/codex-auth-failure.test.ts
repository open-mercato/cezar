import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const workflow: WorkflowDef = {
  name: 'quick-task', source: 'built-in', steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
};
const failure = 'workspace routing discovery unauthorized (401)';
const task = 'mock:workspace-routing-unauthorized';

describe('Codex authentication failure before assistant output', () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;

  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', '0');
    vi.stubEnv('CEZ_AUTO_NAMING', '0');
    vi.stubEnv('CEZ_REVIEW_GATE', '0');
    vi.stubEnv('CEZ_CODEX_BIN', join(import.meta.dirname, '../core/__fixtures__/codex/mock-codex-app-server.mjs'));
    root = mkdtempSync(join(tmpdir(), 'cez-codex-auth-failure-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    writeFileSync(join(root, '.gitignore'), '.ai/\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base'], { cwd: root });
    store = RunStore.open(join(root, '.ai/cezar'));
    manager = new RunManager(store, root);
  });

  afterEach(() => {
    manager?.dispose();
    store?.flush();
    rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('fails the task and its continuation instead of parking an empty session for a reply', async () => {
    const id = manager.startRun(workflow, { task, runner: 'codex', worktree: false }).id;

    for (const stepId of ['task', 'continue-1']) {
      if (stepId === 'continue-1') expect(manager.continueRun(id, { text: task }).ok).toBe(true);

      await expect.poll(() => store.getRun(id)?.status, { timeout: 5_000 }).toBe('failed');
      await expect.poll(() => manager.isActive(id), { timeout: 5_000 }).toBe(false);
      const record = store.getRun(id);
      expect(record?.error).toContain(failure);
      expect(record?.steps.find(step => step.id === stepId)).toMatchObject({ status: 'failed', error: expect.stringContaining(failure) });
      expect(record?.attentionRequest).toBeUndefined();

      const events = store.readEvents(id).filter(event => event.stepId === stepId);
      expect(events).toContainEqual(expect.objectContaining({ type: 'error', message: failure }));
      expect(events).toContainEqual(expect.objectContaining({ type: 'turn.completed', stopReason: 'error' }));
      expect(events.some(event => event.type === 'text' || event.type === 'ask.requested')).toBe(false);
    }
  }, 20_000);
});
