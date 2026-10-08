import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentRunSpec } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import {
  agentStepTimeoutMs,
  skillStackOf,
  workflowFileSchema,
  workflowStepSchema,
  type WorkflowDef,
} from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** Every spec a (mocked) runner's `startSession` receives, in spawn order. */
const captured = vi.hoisted(() => ({ specs: [] as AgentRunSpec[] }));

// The seam under test is the `timeoutMs` the engine puts INTO the spec; what a runner does
// with it (`limitMs > 0` arms the kill switch) is each runner's own test's business.
vi.mock('../core/runner-factory.ts', () => ({
  createRunner: () => ({
    backend: 'claude' as const,
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: (spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void) => {
      captured.specs.push(spec);
      const sessionId = `sess-${captured.specs.length}`;
      return {
        result: new Promise<AgentRunResult>((resolve) => {
          setTimeout(() => {
            onEvent?.({ type: 'session', sessionId });
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

describe('workflow step timeoutMs (#880)', () => {
  it('is optional — existing step shapes parse unchanged', () => {
    const parsed = workflowStepSchema.parse({ id: 'a', prompt: '{{task}}' });
    expect(parsed.timeoutMs).toBeUndefined();
  });

  it('accepts 0 (no wall clock) and the 24 h cap on an agent step', () => {
    expect(workflowStepSchema.parse({ id: 'a', skill: 's', timeoutMs: 0 }).timeoutMs).toBe(0);
    expect(workflowStepSchema.parse({ id: 'a', skill: 's', timeoutMs: 86_400_000 }).timeoutMs).toBe(86_400_000);
  });

  it.each([-1, 1.5, 86_400_001, '90m'])('rejects %j', (timeoutMs) => {
    expect(workflowStepSchema.safeParse({ id: 'a', prompt: 'x', timeoutMs }).success).toBe(false);
  });

  it('rejects it on a check step, which has no wall clock to set', () => {
    const parsed = workflowStepSchema.safeParse({ id: 'v', command: 'npm test', timeoutMs: 60_000 });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message).join('; ')).toContain('agent steps only');
  });

  it('parses from a workflow file', () => {
    const doc = workflowFileSchema.parse({
      name: 'long',
      steps: [
        { id: 'implement', skill: 'my-skill', timeoutMs: 5_400_000 },
        { id: 'verify', command: 'npm test' },
      ],
    });
    expect(doc.steps?.[0]?.timeoutMs).toBe(5_400_000);
  });

  it('keeps a step with its own limit out of the compact skills: form', () => {
    expect(skillStackOf([{ id: 's', name: 's', skill: 's', prompt: '{{task}}' }])).toEqual(['s']);
    expect(skillStackOf([{ id: 's', name: 's', skill: 's', prompt: '{{task}}', timeoutMs: 0 }])).toBeNull();
  });
});

describe('agentStepTimeoutMs precedence (#880)', () => {
  it('step timeoutMs, then the repo agentTimeoutMs, then the runner default', () => {
    expect(agentStepTimeoutMs({ timeoutMs: 7_200_000 }, 5_400_000, false)).toBe(7_200_000);
    expect(agentStepTimeoutMs({}, 5_400_000, false)).toBe(5_400_000);
    expect(agentStepTimeoutMs({}, undefined, false)).toBeUndefined();
  });

  it('a step 0 disables the wall clock even under a repo limit', () => {
    expect(agentStepTimeoutMs({ timeoutMs: 0 }, 5_400_000, false)).toBe(0);
  });

  it('the interactive step never gets a wall clock', () => {
    expect(agentStepTimeoutMs({ timeoutMs: 7_200_000 }, 5_400_000, true)).toBe(0);
  });
});

describe('the resolved limit reaches AgentRunSpec.timeoutMs (#880)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;

  /** Two agent steps followed by a check, so neither agent step is the interactive one. */
  const CHAIN: WorkflowDef = {
    name: 'long-chain',
    source: 'file',
    steps: [
      { id: 'implement', name: 'Implement', prompt: '{{task}}', timeoutMs: 7_200_000 },
      { id: 'review', name: 'Review', prompt: 'review {{task}}' },
      { id: 'verify', command: 'true' },
    ],
  };

  beforeEach(async () => {
    captured.specs.length = 0;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-agent-timeout-'));
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

  function writeConfig(value: unknown): void {
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), JSON.stringify(value), 'utf8');
  }

  async function settled(runId: string): Promise<void> {
    await expect
      .poll(() => store.getRun(runId)?.status, { timeout: 15_000 })
      .toSatisfy((status) => ['done', 'review', 'failed', 'cancelled'].includes(String(status)));
  }

  it('the step limit wins, the repo agentTimeoutMs covers the rest', async () => {
    writeConfig({ agentTimeoutMs: 5_400_000 });
    const record = manager!.startRun(CHAIN, { task: 'do the thing', worktree: false, runner: 'claude' });
    await settled(record.id);

    expect(captured.specs.map((spec) => spec.timeoutMs)).toEqual([7_200_000, 5_400_000]);
  });

  it('with no config the runner default stays in charge (zero config)', async () => {
    const record = manager!.startRun(CHAIN, { task: 'do the thing', worktree: false, runner: 'claude' });
    await settled(record.id);

    // `undefined` is what lets each runner fall back to its own `DEFAULT_RUN_TIMEOUT_MS`.
    expect(captured.specs.map((spec) => spec.timeoutMs)).toEqual([7_200_000, undefined]);
  });

  it('the final interactive step keeps no wall clock whatever is configured', async () => {
    writeConfig({ agentTimeoutMs: 5_400_000 });
    const single: WorkflowDef = {
      name: 'single',
      source: 'file',
      steps: [{ id: 'work', name: 'Work', prompt: '{{task}}', timeoutMs: 7_200_000 }],
    };
    const record = manager!.startRun(single, { task: 'do the thing', worktree: false, runner: 'claude' });
    await expect.poll(() => captured.specs.length, { timeout: 15_000 }).toBeGreaterThan(0);

    expect(captured.specs[0]?.timeoutMs).toBe(0);
    manager!.cancel(record.id);
    await settled(record.id);
  });
});
