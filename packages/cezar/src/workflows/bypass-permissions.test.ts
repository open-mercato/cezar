import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentRunSpec } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local', '-c', 'commit.gpgsign=false'];

const captured = vi.hoisted(() => ({ specs: [] as AgentRunSpec[] }));

vi.mock('../core/runner-factory.ts', () => ({
  createRunner: (backend: string) => ({
    backend,
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: (spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void) => {
      captured.specs.push(spec);
      return {
        result: new Promise<AgentRunResult>((resolve) => {
          setTimeout(() => {
            onEvent?.({ type: 'session', sessionId: `sess-${captured.specs.length}` });
            resolve({ text: 'ok', toolCalls: [], tokensUsed: 0 });
          }, 0);
        }),
        sendMessage: () => false,
        end: () => {},
        interrupt: () => {},
        open: false,
      };
    },
    interrupt: async () => {},
  }),
}));

/** The project's opt-in `bypassPermissions` reaches every agent step, and nothing else grants it. */
describe('bypassPermissions project setting', { timeout: 20_000 }, () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const QUICK: WorkflowDef = { name: 'quick-task', source: 'built-in', steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }] };

  beforeEach(async () => {
    captured.specs.length = 0;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-bypass-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    manager?.dispose();
    store?.flush();
    rmSync(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const enable = () => writeFileSync(join(repoRoot, '.ai/cezar/config.json'), JSON.stringify({ bypassPermissions: true }));
  const start = async (input: { readOnly?: true } = {}) => {
    const record = manager.startRun(QUICK, { task: 'do it', runner: 'claude', ...input });
    await vi.waitFor(() => expect(captured.specs).toHaveLength(1), { timeout: 15_000 });
    return record.id;
  };

  it('is off by default', async () => {
    await start();
    expect(captured.specs[0]!.bypassPermissions).toBeUndefined();
  });

  it('reaches the first step and a Continue', async () => {
    enable();
    const id = await start();
    expect(captured.specs[0]!.bypassPermissions).toBe(true);
    await vi.waitFor(() => expect(['done', 'review']).toContain(store.getRun(id)?.status), { timeout: 15_000 });
    expect(manager.continueRun(id, { text: 'and then?' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(captured.specs).toHaveLength(2), { timeout: 15_000 });
    expect(captured.specs[1]!.bypassPermissions).toBe(true);
  });

  it('never applies to a read-only task', async () => {
    enable();
    await start({ readOnly: true });
    expect(captured.specs[0]!.bypassPermissions).toBeUndefined();
  });

  it('a hosted cockpit ignores a value already in the file, and the run says why', async () => {
    enable();
    manager.dispose();
    manager = new RunManager(store, repoRoot, { hosted: () => true });
    const id = await start();
    expect(captured.specs[0]!.bypassPermissions).toBeUndefined();
    const notes = store.readEvents(id).filter((event) => (event as { type?: string }).type === 'note');
    expect(JSON.stringify(notes)).toMatch(/local-only/);
  });

  it('a git-tracked config.json cannot grant it, and the run says why', async () => {
    enable();
    await run('git', ['add', '-f', '.ai/cezar/config.json'], { cwd: repoRoot });
    const id = await start();
    expect(captured.specs[0]!.bypassPermissions).toBeUndefined();
    const notes = store.readEvents(id).filter((event) => (event as { type?: string }).type === 'note');
    expect(JSON.stringify(notes)).toMatch(/tracked by git/);
  });

  it('a Continue after config.json became tracked drops it, and says why', async () => {
    enable();
    const id = await start();
    expect(captured.specs[0]!.bypassPermissions).toBe(true);
    await vi.waitFor(() => expect(['done', 'review']).toContain(store.getRun(id)?.status), { timeout: 15_000 });
    await run('git', ['add', '-f', '.ai/cezar/config.json'], { cwd: repoRoot });
    expect(manager.continueRun(id, { text: 'and then?' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(captured.specs).toHaveLength(2), { timeout: 15_000 });
    expect(captured.specs[1]!.bypassPermissions).toBeUndefined();
    const notes = store.readEvents(id).filter((event) => (event as { type?: string }).type === 'note');
    expect(JSON.stringify(notes)).toMatch(/tracked by git/);
  });
});
