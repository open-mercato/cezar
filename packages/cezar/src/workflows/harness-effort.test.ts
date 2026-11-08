import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertReasoningEffortSupported, type AgentEvent, type AgentRunResult, type AgentRunSpec, type RunnerId } from '../core/agent-runner.ts';
import { runHarnessDriver } from '../harness/driver.ts';
import { harnessWorkflowDefs, HARNESS_FIX_ISSUE } from '../harness/workflows.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';

const sessions = vi.hoisted(() => [] as AgentRunSpec[]);
vi.mock('../harness/driver.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../harness/driver.ts')>()),
  runHarnessDriver: vi.fn(),
}));
vi.mock('../core/runner-factory.ts', () => ({
  createRunner: (backend: RunnerId) => ({
    startSession: (spec: AgentRunSpec, emit: (event: AgentEvent) => void) => {
      assertReasoningEffortSupported(backend, spec.reasoningEffort);
      sessions.push(spec);
      let open = true;
      let end = () => {};
      const result = new Promise<AgentRunResult>((resolve) => {
        end = () => { open = false; resolve({ text: '', toolCalls: [], tokensUsed: 0 }); };
      });
      setTimeout(() => {
        writeFileSync(spec.env!.CEZ_HARNESS_RESULT_FILE!, '{}');
        emit({ type: 'turn-end' });
      }, 0);
      return { result, get open() { return open; }, sendMessage: () => true, end, interrupt: end };
    },
  }),
}));

describe('harness effort reaches the native runner seam', { timeout: 30_000 }, () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;

  beforeEach(() => {
    vi.stubEnv('CEZ_MULTI_MODEL', '1');
    vi.stubEnv('CEZ_DRY_RUN', '1');
    sessions.length = 0;
    root = mkdtempSync(join(tmpdir(), 'cez-harness-effort-'));
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    writeFileSync(join(root, '.gitignore'), '.ai/cezar/\n');
    execFileSync('git', ['add', '.gitignore'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'base'], { cwd: root });
    writeFileSync(join(root, '.ai/cezar/config.json'), JSON.stringify({ skillsRepos: [], branchNaming: { enabled: false } }));
    store = RunStore.open(join(root, '.ai/cezar'));
    manager = new RunManager(store, root);
    vi.mocked(runHarnessDriver).mockReset();
  });

  afterEach(async () => {
    for (const run of store.listRuns()) manager.cancel(run.id);
    await vi.waitFor(() => expect(store.listRuns().some((run) => manager.isActive(run.id))).toBe(false));
    manager.dispose();
    store.flush();
    rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it.each([
    { runner: 'claude' as const, effort: 'high' as const, expectedEffort: undefined, budget: '32768' },
    { runner: 'claude' as const, effort: 'max' as const, expectedEffort: undefined, budget: '63999' },
    { runner: 'claude' as const, effort: undefined, expectedEffort: undefined, budget: undefined },
    { runner: 'codex' as const, effort: 'max' as const, expectedEffort: 'xhigh', budget: undefined },
    { runner: 'codex' as const, effort: undefined, expectedEffort: undefined, budget: undefined },
  ])('applies $runner / $effort without changing ordinary runner semantics', async ({ runner, effort, expectedEffort, budget }) => {
    vi.mocked(runHarnessDriver).mockImplementation(async (host) => {
      const resultPath = join(root, 'phase-result.json');
      host.upsertStep({ id: 'implement', name: 'Implement', kind: 'agent' });
      return host.runAgent({
        phaseId: 'implement', name: 'Implement', skill: undefined, prompt: 'Implement the feature',
        runner, effort, timeoutMs: 10_000, resultPath,
        env: { CEZ_HARNESS_STAGE_ONLY: '1', CEZ_HARNESS_RESULT_FILE: resultPath, CEZ_HARNESS_OUTPUT_DIR: root },
      });
    });
    const workflow = harnessWorkflowDefs().find((item) => item.name === HARNESS_FIX_ISSUE)!;
    const run = manager.startRun(workflow, { task: 'Fix issue #42', runner: 'codex', reasoningEffort: 'low' });
    await vi.waitFor(() => expect(manager.isActive(run.id)).toBe(false), { timeout: 15_000 });
    expect(store.getRun(run.id)?.error).toBeUndefined();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.reasoningEffort).toBe(expectedEffort);
    expect(sessions[0]?.env?.CLAUDE_CODE_EFFORT_LEVEL).toBe(runner === 'claude' ? effort : undefined);
    expect(sessions[0]?.env?.MAX_THINKING_TOKENS).toBe(budget);
    expect(store.getRun(run.id)?.steps.find((step) => step.id === 'implement')?.reasoningEffort).toBe(expectedEffort);
  });
});
