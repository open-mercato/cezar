import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunDispatch } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

// The Guard's task-scoped push authorization (#2322, #2381) must reach the system prompt a
// dispatched child's agent is actually spawned with — on a fresh run AND on Continue — while
// the CEZ:ASK requirement stays for everything outside that scope.
const AUTHORIZED = "an ordinary non-force push to that PR's head branch is already authorized and needs no CEZ:ASK";
const STILL_ASKS = 'Force pushes, history rewrites, merging into the base branch, deleting branches, credentials, budget increases, review/QA waivers and anything outside that scope still need a new CEZ:ASK';
const BASE_GUARD = 'pushing to a shared branch, merging into the base branch';

describe('dispatched child: Guard push authorization reaches the spawned agent (#2381)', () => {
  let repoRoot: string;
  let argsFile: string;
  let store: RunStore;
  let manager: RunManager;
  const saved: Record<string, string | undefined> = {};

  const wf: WorkflowDef = {
    name: 'guard-probe',
    source: 'built-in',
    steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }],
  };

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-guard-prompt-'));
    argsFile = join(repoRoot, 'mock-args.ndjson');
    for (const k of ['CEZ_DRY_RUN', 'CEZ_DISPATCH', 'CEZ_MOCK_ARGS_FILE']) saved[k] = process.env[k];
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_DISPATCH = '1';
    process.env.CEZ_MOCK_ARGS_FILE = argsFile;
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 1 } }) });
  });

  afterAll(() => {
    manager.dispose();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const spawns = (): string[][] => {
    try {
      return readFileSync(argsFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]);
    } catch {
      return [];
    }
  };
  const settled = async (id: string, after: number): Promise<void> => {
    const deadline = Date.now() + 25_000;
    for (;;) {
      const r = store.getRun(id);
      if (r && ['done', 'review', 'failed', 'cancelled'].includes(r.status) && spawns().length > after && !manager.isActive(id)) return;
      if (Date.now() > deadline) throw new Error(`run ${id} did not settle`);
      await new Promise((r2) => setTimeout(r2, 50));
    }
  };
  const promptOf = (argv: string[]): string => argv[argv.indexOf('--append-system-prompt') + 1] as string;
  const childOf = (kind?: 'review'): RunDispatch => ({ rootRunId: 'root-x', parentRunId: 'root-x', ...(kind ? { kind } : {}) });

  it('a child carries the authorization sentence AND the ask-for-the-rest sentence, fresh and on Continue', async () => {
    const child = manager.startRun(wf, { task: 'mock:done maintain the PR', dispatch: childOf(), runner: 'claude' });
    await settled(child.id, 0);
    const fresh = promptOf(spawns()[0]!);
    expect(fresh).toContain(AUTHORIZED);
    expect(fresh).toContain(STILL_ASKS);
    expect(fresh).toContain(BASE_GUARD);

    const before = spawns().length;
    expect(manager.continueRun(child.id, { text: 'mock:done keep going' })).toEqual({ ok: true });
    await settled(child.id, before);
    const cont = promptOf(spawns()[before]!);
    expect(cont).toContain(AUTHORIZED);
    expect(cont).toContain(STILL_ASKS);
    expect(cont).toContain(BASE_GUARD);
    expect(cont.split(AUTHORIZED).length - 1).toBe(1);
  }, 60_000);

  it('a review child keeps the same Guard', async () => {
    const before = spawns().length;
    const child = manager.startRun(wf, { task: 'mock:done review it', dispatch: childOf('review'), runner: 'claude' });
    await settled(child.id, before);
    const p = promptOf(spawns()[before]!);
    expect(p).toContain(AUTHORIZED);
    expect(p).toContain(STILL_ASKS);
    expect(p).toContain('Your KIND is review');
  }, 30_000);

  it('a child resumed from an older Guard snapshot still receives the current Guard on Continue', async () => {
    const before = spawns().length;
    const child = manager.startRun(wf, { task: 'mock:done old snapshot', dispatch: childOf(), runner: 'claude' });
    await settled(child.id, before);
    store.updateRun(child.id, { systemPrompt: 'Old dispatch text. Never work around a blocked action.' });
    const n = spawns().length;
    expect(manager.continueRun(child.id, { text: 'mock:done again' })).toEqual({ ok: true });
    await settled(child.id, n);
    const p = promptOf(spawns()[n]!);
    expect(p).toContain(AUTHORIZED);
    expect(p).toContain(STILL_ASKS);
  }, 60_000);

  it('a run with no dispatch record gets no dispatch Guard text', async () => {
    const before = spawns().length;
    const plain = manager.startRun(wf, { task: 'mock:done plain', runner: 'claude' });
    await settled(plain.id, before);
    expect(promptOf(spawns()[before]!)).not.toContain('The Guard.');
  }, 30_000);
});
