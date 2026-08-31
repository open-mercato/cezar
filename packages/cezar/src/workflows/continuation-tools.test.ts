import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunSpec } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import { DEFAULT_ALLOWED_TOOLS, type WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** Every spec a (mocked) runner's `startSession` receives, in spawn order. */
const captured = vi.hoisted(() => ({ specs: [] as AgentRunSpec[] }));

// The seam under test is what `runContinuation` puts INTO the spec, so the runner is a
// capture stub: the spec→argv mapping below it is `claude-cli-runner.test.ts`'s business
// (`buildAllowedTools`), and the resume mechanics around it are `auto-resume.test.ts`'s.
vi.mock('../core/runner-factory.ts', () => ({
  createRunner: () => ({
    backend: 'claude' as const,
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: (spec: AgentRunSpec) => {
      captured.specs.push(spec);
      return {
        result: Promise.resolve({ text: 'ok', toolCalls: [], tokensUsed: 0 }),
        sendMessage: () => false,
        end: () => {},
        interrupt: () => {},
        open: false,
      };
    },
    interrupt: async () => {},
  }),
}));

/**
 * A rebuilt session keeps its workflow step's tools.
 *
 * `runContinuation` used to hand `startSession` the bare `DEFAULT_ALLOWED_TOOLS`, so the
 * moment a step's session came back through Continue, restart recovery or the usage-limit
 * auto-resume, every tool the workflow granted beyond the default set (MCP servers,
 * subagents) was silently revoked — and dropping the step's `bashAllowlist` simultaneously
 * WIDENED Bash from an allowlist to unrestricted (`AgentRunSpec.allowedTools`, #430).
 * `ActiveRun` has two construction sites (#811's lesson): `execute` resolved per-step tools,
 * `runContinuation` did not.
 */
describe('a resumed session keeps its workflow step tools', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;

  const TOOLS = ['Read', 'Edit', 'Bash', 'mcp__github__create_pr'];
  const BASH = ['npm', 'git'];
  const TAIL_TOOLS = ['Read', 'Grep'];

  /** Two agent steps with DIFFERENT tools, so "the owning step's entry" and "the
   *  definition's last agent step" are distinguishable — plus a trailing check step,
   *  which the last-AGENT-step fallback must skip. */
  const CHAIN_DEF: WorkflowDef = {
    name: 'tooled-chain',
    source: 'file',
    steps: [
      { id: 'implement', name: 'Implement', prompt: '{{task}}', allowedTools: TOOLS, bashAllowlist: BASH },
      { id: 'review', name: 'Review', prompt: 'review {{task}}', allowedTools: TAIL_TOOLS },
      { id: 'verify', command: 'true' },
    ],
  };

  const SINGLE_DEF: WorkflowDef = {
    name: 'tooled-task',
    source: 'file',
    steps: [
      { id: 'work', name: 'Work', prompt: '{{task}}', allowedTools: TOOLS, bashAllowlist: BASH },
    ],
  };

  beforeEach(async () => {
    captured.specs.length = 0;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-continue-tools-'));
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
    // Bounded retry: on Windows a transient handle inside the fresh git tree (a
    // scanner, a just-exited child) holds the delete with EPERM for a beat or
    // two; elsewhere the first attempt succeeds and the loop never waits.
    for (let attempt = 0; ; attempt++) {
      try {
        rmSync(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        break;
      } catch (err) {
        if (attempt >= 5) throw err;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  });

  /** A terminal run whose `workflowDef` and steps are exactly what the caller says. */
  function terminalRun(input: {
    def?: WorkflowDef;
    steps: { id: string; sessionId?: string; backend?: 'claude' | 'codex' }[];
    status?: 'done' | 'failed';
    error?: string;
    autoResumeAt?: string;
  }): string {
    const record = store.createRun({
      title: 't',
      workflow: input.def?.name ?? 'legacy',
      task: 'do the thing',
      steps: input.steps.map((s) => ({ id: s.id, name: s.id, kind: 'agent' as const })),
    });
    store.updateRun(record.id, {
      status: input.status ?? 'done',
      finishedAt: new Date().toISOString(),
      workflowDef: input.def,
      error: input.error,
      autoResumeAt: input.autoResumeAt,
    });
    for (const s of input.steps) {
      store.updateStep(record.id, s.id, {
        status: 'done',
        sessionId: s.sessionId,
        backend: s.backend,
      });
    }
    return record.id;
  }

  async function specAt(index: number): Promise<AgentRunSpec> {
    await expect.poll(() => captured.specs.length, { timeout: 15_000 }).toBeGreaterThan(index);
    return captured.specs[index] as AgentRunSpec;
  }

  /** Continuations settle the run again — wait, so no session outlives its test. */
  async function settled(runId: string): Promise<void> {
    await expect
      .poll(() => store.getRun(runId)?.status, { timeout: 15_000 })
      .toSatisfy((status) => ['done', 'review', 'failed', 'cancelled'].includes(String(status)));
  }

  it("Continue rebuilds the session with the OWNING step's allowedTools and bashAllowlist, verbatim", async () => {
    // The resumed session belongs to `implement`, NOT the definition's last agent step —
    // so this passes only when the tools come from the owning step's own entry.
    const id = terminalRun({
      def: CHAIN_DEF,
      steps: [{ id: 'implement', sessionId: 'sess-1', backend: 'claude' }],
      status: 'failed',
      error: 'boom',
    });

    expect(manager!.continueRun(id, { text: 'keep going' })).toEqual({ ok: true });
    const spec = await specAt(0);
    expect(spec.resume).toBe(true);
    expect(spec.sessionId).toBe('sess-1');
    expect(spec.allowedTools).toEqual(TOOLS);
    expect(spec.bashAllowlist).toEqual(BASH);
    await settled(id);
  });

  it('a legacy record without workflowDef keeps the defaults, with no bashAllowlist', async () => {
    // Records from before `workflowDef` was persisted (#367): the store parses it back as
    // absent (`workflowDefSchema.optional().catch(undefined)`), never as an error.
    const id = terminalRun({
      steps: [{ id: 'work', sessionId: 'sess-1', backend: 'claude' }],
    });

    expect(manager!.continueRun(id, { text: 'keep going' })).toEqual({ ok: true });
    const spec = await specAt(0);
    expect(spec.allowedTools).toEqual(DEFAULT_ALLOWED_TOOLS);
    expect(spec.bashAllowlist).toBeUndefined();
    await settled(id);
  });

  it("a fresh-session continuation (backend switch) resolves the definition's LAST agent step", async () => {
    // A session owned by another backend forces `resume: false` — `runContinuation` gets no
    // sessionId, so there is no owning step to read; the run's tail is the documented fallback.
    const id = terminalRun({
      def: CHAIN_DEF,
      steps: [{ id: 'implement', sessionId: 'sess-1', backend: 'codex' }],
    });

    expect(manager!.continueRun(id, { text: 'keep going', runner: 'claude' })).toEqual({ ok: true });
    const spec = await specAt(0);
    expect(spec.resume).toBe(false);
    expect(spec.sessionId).toBeUndefined();
    expect(spec.allowedTools).toEqual(TAIL_TOOLS);
    expect(spec.bashAllowlist).toBeUndefined();
    await settled(id);
  });

  it('a second Continue — the session now owned by a synthetic continue-N step — keeps them too', async () => {
    // `continue-1` exists in the record but never in `workflowDef.steps`, so the by-id
    // lookup misses and must fall back to the definition's tail, not the defaults.
    const id = terminalRun({
      def: SINGLE_DEF,
      steps: [
        { id: 'work', sessionId: 'sess-1', backend: 'claude' },
        { id: 'continue-1', sessionId: 'sess-2', backend: 'claude' },
      ],
    });

    expect(manager!.continueRun(id, { text: 'and again' })).toEqual({ ok: true });
    const spec = await specAt(0);
    expect(spec.sessionId).toBe('sess-2');
    expect(spec.allowedTools).toEqual(TOOLS);
    expect(spec.bashAllowlist).toEqual(BASH);
    await settled(id);
  });

  it('the usage-limit auto-resume keeps the step tools too', async () => {
    // The headline scenario: nobody is at the keyboard when the window reopens, so a tool
    // set silently narrowed here (and a Bash silently widened) is the least visible of all.
    // `recover()` re-arms the past deadline and fires the resume through `continueRun`.
    const id = terminalRun({
      def: SINGLE_DEF,
      steps: [{ id: 'work', sessionId: 'sess-1', backend: 'claude' }],
      status: 'failed',
      error: 'Claude AI usage limit reached|1756166400',
      autoResumeAt: new Date(Date.now() - 1_000).toISOString(),
    });
    manager!.dispose();

    manager = new RunManager(store, repoRoot);
    await manager.recover();

    const spec = await specAt(0);
    expect(spec.resume).toBe(true);
    expect(spec.sessionId).toBe('sess-1');
    expect(spec.allowedTools).toEqual(TOOLS);
    expect(spec.bashAllowlist).toEqual(BASH);
    await settled(id);
  });
});
