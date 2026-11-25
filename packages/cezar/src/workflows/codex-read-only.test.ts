import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import { REVIEW_PR } from './templates.ts';
import type { WorkflowDef } from './types.ts';

// Real orchestration and runner process; only the Codex provider is the bundled dry-run mock.
describe.skipIf(process.platform === 'win32')('Codex restricted workflows', { timeout: 30_000 }, () => {
  let root: string; let store: RunStore; let manager: RunManager;
  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', '1'); vi.stubEnv('CEZ_CODEX_BIN', undefined); vi.stubEnv('CEZ_AUTONAME', '0');
    root = mkdtempSync(join(tmpdir(), 'cez-codex-workflow-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe', timeout: 10_000 });
    git('init', '-q', '-b', 'main'); writeFileSync(join(root, 'a.txt'), 'one\n');
    git('add', '-A'); git('-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-q', '-m', 'base');
    store = RunStore.open(join(root, '.ai/cezar')); manager = new RunManager(store, root);
  });
  afterEach(async () => {
    for (const run of store.listRuns()) if (manager.isActive(run.id)) manager.cancel(run.id);
    await vi.waitFor(() => expect(store.listRuns().some(r => manager.isActive(r.id))).toBe(false), { timeout: 15_000 });
    manager.dispose(); store.flush(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  it('runs review-pr through every restricted step without granting a write or publish tool', async () => {
    const id = manager.startRun(REVIEW_PR, { task: 'https://github.com/o/r/pull/1 mock:verdict=approve', runner: 'codex' }).id;
    await vi.waitFor(() => expect(['done', 'review', 'failed']).toContain(store.getRun(id)?.status), { timeout: 20_000 });
    const run = store.getRun(id)!;
    expect(run.status, run.error).not.toBe('failed');
    const agents = run.steps.filter(s => s.kind === 'agent');
    expect(agents).toHaveLength(4);
    for (const step of agents) {
      expect(step.status).toBe('done');
      expect(step.toolPolicy?.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
      expect(step.toolPolicy?.bashAllowlist).toContain('gh pr diff');
      expect(step.toolPolicy?.bashAllowlist).not.toContain('git push');
    }
    expect(store.readEvents(id).filter(e => e.type === 'note' && typeof e.message === 'string' && e.message.includes('isolated read-only enforcement active'))).toHaveLength(4);
    expect(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8', timeout: 10_000 })).toBe('');
  });
  it('dispatches an explicitly empty grant through the isolated child runner', async () => {
    const def: WorkflowDef = { name: 'parent', source: 'built-in', steps: [{ id: 'task', prompt: '{{task}}' }] };
    const parent = manager.startRun(def, { task: 'hold for a child', runner: 'codex', worktree: false }).id;
    await vi.waitFor(() => expect(store.getRun(parent)?.status).toBe('waiting'), { timeout: 15_000 });
    const child = manager.dispatch(parent, { objective: 'read nothing', runner: 'codex', allowed_tools: [] });
    expect(child).not.toHaveProperty('refused');
    if ('refused' in child) return;
    await vi.waitFor(() => expect(store.readEvents(child.id).some(e => e.type === 'note' && typeof e.message === 'string' && e.message.includes('isolated read-only enforcement active'))).toBe(true), { timeout: 15_000 });
    expect(store.getRun(child.id)?.steps[0]?.toolPolicy?.allowedTools).toEqual([]);
  });
});
