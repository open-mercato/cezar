import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentRunSpec } from '../core/agent-runner.ts';
import { privateMcpPath } from '../core/private-mcp.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** Every spec a (mocked) runner's `startSession` receives, in spawn order. */
const captured = vi.hoisted(() => ({ specs: [] as AgentRunSpec[] }));

// Same capture stub as `continuation-tools.test.ts`: the seam under test is what the engine puts
// INTO the spec; each runner's spec → wire mapping is `private-mcp.test.ts`'s business.
vi.mock('../core/runner-factory.ts', () => ({
  createRunner: () => ({
    backend: 'claude' as const,
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: (spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void) => {
      captured.specs.push(spec);
      const sessionId = `sess-${captured.specs.length}`;
      // `hold` keeps the session (and so the run) live until it is ended.
      let release: () => void = () => {};
      return {
        result: new Promise<AgentRunResult>((resolve) => {
          release = () => resolve({ text: 'ok', toolCalls: [], tokensUsed: 0 });
          setTimeout(() => {
            onEvent?.({ type: 'session', sessionId });
            if (!spec.userPrompt.includes('hold')) release();
          }, 0);
        }),
        sendMessage: () => false,
        end: () => release(),
        interrupt: () => release(),
        open: false,
      };
    },
    interrupt: async () => {},
  }),
}));

const TASK: WorkflowDef = {
  name: 'one-step',
  source: 'file',
  steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }],
};

/** Spec 2026-10-07-private-project-mcp: the project's private servers reach every agent session. */
// Real runs: well under a second alone, past the 5 s default under the full parallel suite.
describe('private MCP servers at launch', { timeout: 20_000 }, () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;

  beforeEach(async () => {
    captured.specs.length = 0;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-private-mcp-launch-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(async () => {
    manager?.dispose();
    manager = undefined;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function writePrivateMcp(servers: Record<string, unknown>): void {
    mkdirSync(join(repoRoot, '.ai', 'cezar'), { recursive: true });
    writeFileSync(privateMcpPath(repoRoot), JSON.stringify({ mcpServers: servers }));
  }

  async function specAt(index: number): Promise<AgentRunSpec> {
    await expect.poll(() => captured.specs.length, { timeout: 15_000 }).toBeGreaterThan(index);
    return captured.specs[index] as AgentRunSpec;
  }

  async function settled(runId: string): Promise<void> {
    await expect
      .poll(() => store.getRun(runId)?.status, { timeout: 15_000 })
      .toSatisfy((status) => ['done', 'review', 'failed', 'cancelled'].includes(String(status)));
  }

  function notes(runId: string): string[] {
    return store
      .readEvents(runId)
      .filter((e) => e.type === 'note')
      .map((e) => String((e as { message?: unknown }).message));
  }

  it('the opening session and its Continue both carry the servers, read fresh each launch', async () => {
    writePrivateMcp({ tracker: { command: 'tracker-mcp', env: { TOKEN: 't' } } });
    const record = manager!.startRun(TASK, { task: 'do it', worktree: false, runner: 'claude' });
    const opening = await specAt(0);
    expect(opening.mcpServers?.map((s) => s.name)).toEqual(['tracker']);
    await settled(record.id);
    expect(notes(record.id)).toContain('private MCP servers from .ai/cezar/mcp.local.json: tracker');

    // An edit between sessions applies to the next one — no restart, no cache.
    writePrivateMcp({ tracker: { command: 'tracker-mcp' }, docs: { type: 'http', url: 'https://mcp.example.com/mcp' } });
    expect(manager!.continueRun(record.id, { text: 'more', runner: 'claude' })).toEqual({ ok: true });
    const resumed = await specAt(1);
    expect(resumed.mcpServers?.map((s) => s.name)).toEqual(['tracker', 'docs']);
    await settled(record.id);
  });

  it('no file → no servers and no note', async () => {
    const record = manager!.startRun(TASK, { task: 'do it', worktree: false, runner: 'claude' });
    expect((await specAt(0)).mcpServers).toBeUndefined();
    await settled(record.id);
    expect(notes(record.id).some((n) => n.includes('MCP'))).toBe(false);
  });

  it('a runner with no launch-time channel gets a note instead of silence', async () => {
    writePrivateMcp({ tracker: { command: 'tracker-mcp' } });
    const record = manager!.startRun(TASK, { task: 'do it', worktree: false, runner: 'cursor' });
    expect((await specAt(0)).mcpServers).toBeUndefined();
    await settled(record.id);
    expect(notes(record.id)).toContain('private MCP: cursor cannot attach tracker — cursor has no launch-time MCP channel');
  });

  // MCP tools pass neither the stage-only guard nor its sandbox, so a GitHub
  // server could publish from a harness run that promises it never does.
  it('a stage-only harness phase gets no servers, and a note says why', async () => {
    writePrivateMcp({ github: { command: 'github-mcp', env: { TOKEN: 't' } } });
    const record = manager!.startRun(TASK, { task: 'hold', worktree: false, runner: 'claude' });
    expect((await specAt(0)).mcpServers?.map((s) => s.name)).toEqual(['github']);
    const internals = manager as unknown as {
      active: Map<string, unknown>;
      runAgentStep: (...args: unknown[]) => Promise<string | null>;
    };
    const emitted: string[] = [];
    await internals.runAgentStep.call(
      manager,
      record.id,
      internals.active.get(record.id),
      { id: 'implement', name: 'Implement', prompt: 'implement it' },
      { task: 'x', worktree: false },
      [],
      null,
      false,
      (event: { type: string; message?: unknown }) => {
        if (event.type === 'note') emitted.push(String(event.message));
      },
      undefined,
      'claude',
      undefined,
      undefined,
      [],
      undefined,
      { concurrent: true, env: { CEZ_HARNESS_STAGE_ONLY: '1' } },
    );
    expect((await specAt(1)).mcpServers).toBeUndefined();
    expect(emitted).toContain('private MCP: claude cannot attach github — a stage-only harness phase gets no MCP servers');
    // nor the handoff, dispatch or automations parts it cannot act on.
    expect((await specAt(0)).systemPrompt).toContain('## Handoff (cezar)');
    expect((await specAt(1)).systemPrompt ?? '').not.toContain('## Handoff (cezar)');
    manager!.cancel(record.id);
  });

  it('a broken file is a note, never a failed run', async () => {
    mkdirSync(join(repoRoot, '.ai', 'cezar'), { recursive: true });
    writeFileSync(privateMcpPath(repoRoot), '{not json');
    const record = manager!.startRun(TASK, { task: 'do it', worktree: false, runner: 'claude' });
    expect((await specAt(0)).mcpServers).toBeUndefined();
    await settled(record.id);
    expect(store.getRun(record.id)?.status).not.toBe('failed');
    expect(notes(record.id).some((n) => n.startsWith('private MCP: mcp.local.json is not valid JSON'))).toBe(true);
  });
});
