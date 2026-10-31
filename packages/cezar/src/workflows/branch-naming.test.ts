import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

/**
 * Branch naming instructions (spec 2026-10-11-branch-naming-instructions), end to end through
 * the real RunManager against a real fixture repo: the dry-run namer (mock-claude answers
 * `feature/implementing cr fixes` whenever the prompt carries instructions) names the branch the
 * fork is created on. CEZ_AUTONAME=1 forces the namer under CEZ_DRY_RUN (vitest.setup pins it
 * off for every other case).
 */

const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const CHECK_ONLY: WorkflowDef = {
  name: 'check-only',
  source: 'built-in',
  steps: [{ id: 'check', command: 'node -e "process.exit(0)"' }],
};

const roots: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function fixtureRepo(config?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'cez-branch-naming-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', [...GIT_ID, 'commit', '--allow-empty', '-q', '-m', 'base'], { cwd: root });
  if (config) {
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    writeFileSync(join(root, '.ai/cezar/config.json'), JSON.stringify(config));
  }
  return root;
}

async function waitForDone(store: RunStore, id: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (['done', 'failed', 'cancelled'].includes(store.getRun(id)?.status ?? '')) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`run ${id} did not finish: ${store.getRun(id)?.status}`);
}

beforeEach(() => {
  for (const key of ['CEZ_DRY_RUN', 'CEZ_AUTONAME']) savedEnv[key] = process.env[key];
  process.env.CEZ_DRY_RUN = '1';
  process.env.CEZ_AUTONAME = '1';
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('branch naming instructions', () => {
  it('forks the task on the namer\'s branch when instructions are configured', async () => {
    const root = fixtureRepo({ branchNaming: 'start with feature/, dashes between words' });
    const store = RunStore.open(join(root, '.ai/cezar'));
    const manager = new RunManager(store, root);
    try {
      const record = manager.startRun(CHECK_ONLY, { task: 'implement the cr fixes' });
      await waitForDone(store, record.id);
      const run = store.getRun(record.id);
      expect(run?.status).toBe('done');
      expect(run?.branch).toBe('feature/implementing-cr-fixes');
      const head = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: run!.worktreePath!, encoding: 'utf8' });
      expect(head.trim()).toBe('feature/implementing-cr-fixes');
    } finally {
      manager.dispose();
      store.flush();
    }
  }, 30_000);

  it('suffixes the id8 when the generated name is already a branch', async () => {
    const root = fixtureRepo({ branchNaming: 'start with feature/' });
    execFileSync('git', ['branch', 'feature/implementing-cr-fixes'], { cwd: root });
    const store = RunStore.open(join(root, '.ai/cezar'));
    const manager = new RunManager(store, root);
    try {
      const record = manager.startRun(CHECK_ONLY, { task: 'implement the cr fixes' });
      await waitForDone(store, record.id);
      expect(store.getRun(record.id)?.branch).toBe(`feature/implementing-cr-fixes-${record.id.slice(0, 8)}`);
    } finally {
      manager.dispose();
      store.flush();
    }
  }, 30_000);

  it('keeps cez/<id8> when an existing branch blocks the generated name as a path prefix', async () => {
    // `feature` exists, so git can never create `feature/…` — the run must still start.
    const root = fixtureRepo({ branchNaming: 'start with feature/' });
    execFileSync('git', ['branch', 'feature'], { cwd: root });
    const store = RunStore.open(join(root, '.ai/cezar'));
    const manager = new RunManager(store, root);
    try {
      const record = manager.startRun(CHECK_ONLY, { task: 'implement the cr fixes' });
      await waitForDone(store, record.id);
      const run = store.getRun(record.id);
      expect(run?.status).toBe('done');
      expect(run?.branch).toBe(`cez/${record.id.slice(0, 8)}`);
      const notes = store.readEvents(record.id).filter((e) => e.type === 'note').map((e) => String(e.message));
      expect(notes.some((n) => n.includes('not usable'))).toBe(true);
    } finally {
      manager.dispose();
      store.flush();
    }
  }, 30_000);

  it('keeps cez/<id8> without instructions, even though the namer runs', async () => {
    const root = fixtureRepo();
    const store = RunStore.open(join(root, '.ai/cezar'));
    const manager = new RunManager(store, root);
    try {
      const record = manager.startRun(CHECK_ONLY, { task: 'implement the cr fixes' });
      await waitForDone(store, record.id);
      expect(store.getRun(record.id)?.branch).toBe(`cez/${record.id.slice(0, 8)}`);
    } finally {
      manager.dispose();
      store.flush();
    }
  }, 30_000);

  it('keeps cez/<id8> when naming is off, without waiting on a namer that never runs', async () => {
    process.env.CEZ_AUTONAME = '0';
    const root = fixtureRepo({ branchNaming: 'start with feature/' });
    const store = RunStore.open(join(root, '.ai/cezar'));
    const manager = new RunManager(store, root);
    try {
      const started = Date.now();
      const record = manager.startRun(CHECK_ONLY, { task: 'implement the cr fixes' });
      await waitForDone(store, record.id);
      expect(store.getRun(record.id)?.branch).toBe(`cez/${record.id.slice(0, 8)}`);
      expect(Date.now() - started).toBeLessThan(4_000);
    } finally {
      manager.dispose();
      store.flush();
    }
  }, 30_000);
});
