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
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

const captured = vi.hoisted(() => ({ launches: [] as Array<{ backend: string; spec: AgentRunSpec }> }));

// A capture stub: the backend refusal itself is `read-only-env.test.ts`'s business.
vi.mock('../core/runner-factory.ts', () => ({
  createRunner: (backend: string) => ({
    backend,
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: (spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void) => {
      captured.launches.push({ backend, spec });
      return {
        result: new Promise<AgentRunResult>((resolve) => {
          setTimeout(() => {
            onEvent?.({ type: 'session', sessionId: `sess-${captured.launches.length}` });
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

/** Ask keeps what it had before managers (#2038 review): only a manager's task is enforced. */
describe('read-only enforcement is a manager opt-in', { timeout: 20_000 }, () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;
  const QUICK: WorkflowDef = { name: 'quick-task', source: 'built-in', steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }] };

  beforeEach(async () => {
    captured.launches.length = 0;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-read-only-enforce-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/cezar/mcp.local.json'), JSON.stringify({ mcpServers: { tracker: { command: 'tracker-mcp' } } }));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    manager?.dispose();
    manager = undefined;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const launch = async (input: { readOnly: true; enforceReadOnly?: true }) => {
    const record = manager!.startRun(QUICK, { task: 'what does this do?', runner: 'kimi', ...input });
    await vi.waitFor(() => expect(captured.launches).toHaveLength(1), { timeout: 15_000 });
    return { record: store.getRun(record.id), spec: captured.launches[0]!.spec };
  };

  it('an Ask task keeps its login and private MCP, with no backend enforcement', async () => {
    const { record, spec } = await launch({ readOnly: true });
    expect(record).toMatchObject({ readOnly: true });
    expect(record?.enforceReadOnly).toBeUndefined();
    expect(spec.enforceReadOnly).toBeUndefined();
    expect(spec.env?.GH_TOKEN).toBeUndefined();
    expect(spec.env?.GH_CONFIG_DIR).toBeUndefined();
    expect(spec.mcpServers?.map((server) => server.name)).toEqual(['tracker']);
  });

  it('a manager read-only task is enforced, logged out and without private MCP', async () => {
    const { record, spec } = await launch({ readOnly: true, enforceReadOnly: true });
    expect(record).toMatchObject({ readOnly: true, enforceReadOnly: true });
    expect(spec.enforceReadOnly).toBe(true);
    expect(spec.env?.GH_TOKEN).toBe('');
    expect(spec.env?.GIT_SSH_COMMAND).toBe('false');
    expect(spec.mcpServers).toEqual([]);
  });
});
