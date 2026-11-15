import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentRunSpec } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import { REVIEW_PR } from './templates.ts';

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

/** The read-only `review-pr` workflow keeps its tool limits on every launch, or does not launch. */
describe('a read-only workflow', { timeout: 30_000 }, () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;

  beforeEach(async () => {
    captured.launches.length = 0;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-read-only-workflow-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    writeFileSync(join(repoRoot, '.gitignore'), '.ai/\n');
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

  const terminal = (id: string) =>
    vi.waitFor(() => expect(['done', 'review', 'failed', 'cancelled']).toContain(store.getRun(id)?.status), { timeout: 20_000 });

  it('launches on Claude with a read-only shell and no private MCP', async () => {
    manager!.startRun(REVIEW_PR, { task: 'https://github.com/o/r/pull/1', runner: 'claude' });
    await vi.waitFor(() => expect(captured.launches.length).toBeGreaterThan(0), { timeout: 15_000 });
    const { spec } = captured.launches[0]!;
    expect(spec.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
    expect(spec.bashAllowlist).toContain('gh pr diff');
    expect(spec.bashAllowlist).not.toContain('git push');
    expect(spec.mcpServers).toEqual([]);
  });

  it('refuses a backend that ignores tool limits, before spawning it', async () => {
    const id = manager!.startRun(REVIEW_PR, { task: 'https://github.com/o/r/pull/1', runner: 'codex' }).id;
    await terminal(id);
    // By backend: a previous case's disposed run may still land a late launch of its own.
    expect(captured.launches.filter((l) => l.backend === 'codex')).toEqual([]);
    expect(store.getRun(id)?.status).toBe('failed');
    expect(readFileSync(join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`), 'utf8')).toContain('codex does not enforce');
  });

  it('refuses a Continue on such a backend too', async () => {
    const id = manager!.startRun(REVIEW_PR, { task: 'https://github.com/o/r/pull/1', runner: 'claude' }).id;
    await terminal(id);
    manager!.continueRun(id, { text: 'now push it', runner: 'codex' });
    await vi.waitFor(() => expect(readFileSync(join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`), 'utf8')).toContain('codex does not enforce'), { timeout: 15_000 });
    expect(captured.launches.filter((l) => l.backend === 'codex')).toEqual([]);
  });
});
