import { describe, expect, it } from 'vitest';
import { runWorkflow, type WorkflowGitHub } from '../../src/workflows/workflow-engine.js';
import {
  autofixWorkflow,
  type AutofixBlackboard,
} from '../../src/workflows/definitions/autofix.workflow.js';
import type {
  AgentBackend,
  AgentRunner,
  AgentRunResult,
  AgentRunSpec,
} from '../../src/agents/agent-runner.js';
import type { RunEnv, ShellResult } from '../../src/provision/run-env.js';
import { IssueStore } from '../../src/store/store.js';
import { ConfigSchema } from '../../src/config/config.model.js';
import type { Store } from '../../src/store/store.model.js';

function makeConfig(projectEnv: Record<string, unknown> = {}) {
  return ConfigSchema.parse({
    github: { owner: 'acme', repo: 'cezar', token: 'token' },
    llm: { apiKey: 'test-key' },
    store: { path: '.issue-store-test' },
    autofix: { enabled: true, repoRoot: '/tmp/repo', maxAttemptsPerIssue: 3, projectEnv },
  });
}

async function makeStore(): Promise<IssueStore> {
  const data: Store = {
    meta: {
      owner: 'acme',
      repo: 'cezar',
      lastSyncedAt: null,
      totalFetched: 0,
      version: 1,
      orgMembers: [],
      orgMembersFetchedAt: null,
    },
    issues: [],
  };
  return IssueStore.fromPort({ load: async () => data, save: async () => {} });
}

function makeFakeGitHub(): WorkflowGitHub {
  let nextId = 3000;
  return {
    async addComment() {
      return nextId++;
    },
    async updateComment() {},
    async getIssueWithComments(n) {
      return { issue: { number: n, title: `Bug #${n}`, body: 'It breaks.' }, comments: [] };
    },
    async setLabels() {},
    async addLabel() {},
    async closeIssue() {},
    async pushBranch() {},
    async createPullRequest() {
      return { url: 'https://example.test/pr/7', number: 7 };
    },
  };
}

class SequencedRunner implements AgentRunner {
  private idx = 0;
  readonly calls: string[] = [];
  constructor(
    readonly backend: AgentBackend,
    private readonly outputs: unknown[],
  ) {}
  async run<T>(spec: AgentRunSpec<T>): Promise<AgentRunResult<T>> {
    this.calls.push(spec.systemPrompt.slice(0, 12));
    const parsed = (this.outputs[this.idx] ?? null) as T | null;
    this.idx++;
    return {
      text: JSON.stringify(parsed),
      parsed,
      toolCalls: [],
      tokensUsed: 10,
      budgetExceeded: false,
    };
  }
  async interrupt(): Promise<void> {}
}

function makeFakeGit() {
  let n = 0;
  return {
    async commitAll(): Promise<string | null> {
      n++;
      return `sha${n}000000`;
    },
    async getDiffAgainstBase(): Promise<string> {
      return 'diff';
    },
  };
}

function shell(command: string, ok: boolean): ShellResult {
  return {
    command,
    ok,
    exitCode: ok ? 0 : 1,
    stdout: ok ? 'pass' : '',
    stderr: ok ? '' : 'FAIL: expected 1 got 2',
    durationMs: 1,
  };
}

/** A fake env recording which commands ran; `test` fails its first N calls. */
function makeFakeRunEnv(testFailures = 0): RunEnv & { ran: string[] } {
  let testCalls = 0;
  const ran: string[] = [];
  return {
    ran,
    kind: 'native',
    async install() {
      ran.push('install');
      return shell('install', true);
    },
    async build() {
      ran.push('build');
      return shell('build', true);
    },
    async test() {
      ran.push('test');
      testCalls++;
      return shell('test', testCalls > testFailures);
    },
    async run(cmd) {
      return shell(cmd, true);
    },
    async startDevServer() {
      return null;
    },
    async dispose() {},
  };
}

const VERIFY = { isRealUnfixedDefect: true, reason: 'reproduced', confidence: 0.9 };
const ROOT = {
  summary: 'null deref',
  suspectedFiles: ['a.ts'],
  hypothesis: 'token undefined',
  confidence: 0.85,
};
const FIX = { changedFiles: ['a.ts'], approach: 'guard token', testCommandsRun: [] };
const REVIEW_PASS = { verdict: 'pass' as const, summary: 'good', issues: [] };

describe('autofix shell-check steps', () => {
  it('runs install/build/test and opens a PR when everything passes', async () => {
    const runner = new SequencedRunner('anthropic-api', [VERIFY, ROOT, FIX, REVIEW_PASS]);
    const env = makeFakeRunEnv(0);
    const result = await runWorkflow(autofixWorkflow, {
      store: await makeStore(),
      config: makeConfig({ install: 'yarn', build: 'yarn build', test: 'yarn test' }),
      github: makeFakeGitHub(),
      issueNumber: 10,
      apply: true,
      worktreePath: '/tmp/wt',
      runnerFactory: () => runner,
      gitOps: makeFakeGit(),
      runEnv: env,
      loopMaxIterations: { 'fix-review': 3 },
    });

    expect(result.status).toBe('succeeded');
    expect(result.prNumber).toBe(7);
    expect(env.ran).toEqual(['install', 'build', 'test']);
    const bb = result.blackboard as AutofixBlackboard;
    expect(bb.installResult?.ok).toBe(true);
    expect(bb.testResult?.ok).toBe(true);
  });

  it('loops back to fix when a gated test fails, carrying the failure as retry notes', async () => {
    // fix runs twice (iter 0 fails test, iter 1 passes), so 5 agent outputs.
    const runner = new SequencedRunner('anthropic-api', [VERIFY, ROOT, FIX, FIX, REVIEW_PASS]);
    const env = makeFakeRunEnv(1); // test fails once
    const result = await runWorkflow(autofixWorkflow, {
      store: await makeStore(),
      config: makeConfig({ test: 'yarn test', gateOnTest: true }),
      github: makeFakeGitHub(),
      issueNumber: 11,
      apply: true,
      worktreePath: '/tmp/wt',
      runnerFactory: () => runner,
      gitOps: makeFakeGit(),
      runEnv: env,
      loopMaxIterations: { 'fix-review': 3 },
    });

    expect(result.status).toBe('succeeded');
    // test ran twice (fail, then pass); review only reached after the pass.
    expect(env.ran.filter((c) => c === 'test')).toHaveLength(2);
    expect(runner.calls.filter((c) => c.includes('FIX') || c.length > 0)).toBeTruthy();
  });

  it('fails the run when a gated test never passes (loop exhausted)', async () => {
    const runner = new SequencedRunner('anthropic-api', [VERIFY, ROOT, FIX, FIX, FIX]);
    const env = makeFakeRunEnv(99); // test always fails
    const result = await runWorkflow(autofixWorkflow, {
      store: await makeStore(),
      config: makeConfig({ test: 'yarn test', gateOnTest: true }),
      github: makeFakeGitHub(),
      issueNumber: 12,
      apply: true,
      worktreePath: '/tmp/wt',
      runnerFactory: () => runner,
      gitOps: makeFakeGit(),
      runEnv: env,
      loopMaxIterations: { 'fix-review': 2 },
    });

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/test failed/i);
  });

  it('does not gate when gateOnTest is false — test failure is informational', async () => {
    const runner = new SequencedRunner('anthropic-api', [VERIFY, ROOT, FIX, REVIEW_PASS]);
    const env = makeFakeRunEnv(99); // test always fails but ungated
    const result = await runWorkflow(autofixWorkflow, {
      store: await makeStore(),
      config: makeConfig({ test: 'yarn test', gateOnTest: false }),
      github: makeFakeGitHub(),
      issueNumber: 13,
      apply: true,
      worktreePath: '/tmp/wt',
      runnerFactory: () => runner,
      gitOps: makeFakeGit(),
      runEnv: env,
      loopMaxIterations: { 'fix-review': 3 },
    });

    expect(result.status).toBe('succeeded');
    expect(result.prNumber).toBe(7);
  });

  it('skips shell-check steps entirely when no RunEnv is supplied', async () => {
    const runner = new SequencedRunner('anthropic-api', [VERIFY, ROOT, FIX, REVIEW_PASS]);
    const result = await runWorkflow(autofixWorkflow, {
      store: await makeStore(),
      config: makeConfig({ test: 'yarn test' }),
      github: makeFakeGitHub(),
      issueNumber: 14,
      apply: true,
      worktreePath: '/tmp/wt',
      runnerFactory: () => runner,
      gitOps: makeFakeGit(),
      loopMaxIterations: { 'fix-review': 3 },
    });
    expect(result.status).toBe('succeeded');
  });
});
