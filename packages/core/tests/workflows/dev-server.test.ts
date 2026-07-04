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
import type { DevServerHandle, RunEnv, ShellResult } from '../../src/provision/run-env.js';
import { IssueStore } from '../../src/store/store.js';
import { ConfigSchema } from '../../src/config/config.model.js';
import type { Store } from '../../src/store/store.model.js';

function makeConfig(projectEnv: Record<string, unknown> = {}) {
  return ConfigSchema.parse({
    github: { owner: 'acme', repo: 'cezar', token: 'token' },
    llm: { apiKey: 'test-key' },
    store: { path: '.issue-store-test' },
    autofix: { enabled: true, repoRoot: '/tmp/repo', maxAttemptsPerIssue: 2, projectEnv },
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
  let nextId = 4000;
  return {
    async addComment() {
      return nextId++;
    },
    async updateComment() {},
    async getIssueWithComments(n) {
      return { issue: { number: n, title: `Bug #${n}`, body: 'breaks' }, comments: [] };
    },
    async setLabels() {},
    async addLabel() {},
    async closeIssue() {},
    async pushBranch() {},
    async createPullRequest() {
      return { url: 'https://example.test/pr/9', number: 9 };
    },
  };
}

/** Captures the full spec of every agent run so we can assert prompt/tool injection. */
class CapturingRunner implements AgentRunner {
  private idx = 0;
  readonly specs: AgentRunSpec<unknown>[] = [];
  constructor(
    readonly backend: AgentBackend,
    private readonly outputs: unknown[],
  ) {}
  async run<T>(spec: AgentRunSpec<T>): Promise<AgentRunResult<T>> {
    this.specs.push(spec as AgentRunSpec<unknown>);
    const parsed = (this.outputs[this.idx++] ?? null) as T | null;
    return {
      text: JSON.stringify(parsed),
      parsed,
      toolCalls: [],
      tokensUsed: 5,
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
      return `sha${n}00000`;
    },
    async getDiffAgainstBase(): Promise<string> {
      return 'diff';
    },
  };
}

const ok = (cmd: string): ShellResult => ({
  command: cmd,
  ok: true,
  exitCode: 0,
  stdout: '',
  stderr: '',
  durationMs: 1,
});

/** Fake env whose dev server boots to a fixed URL. */
function makeFakeEnv(
  opts: { devUrl?: string; ready?: boolean; throwOnStart?: boolean } = {},
): RunEnv & { started: number } {
  const state = { started: 0 };
  return {
    started: 0,
    kind: 'native',
    async install() {
      return ok('install');
    },
    async build() {
      return null;
    },
    async test() {
      return null;
    },
    async run(c) {
      return ok(c);
    },
    async startDevServer(): Promise<DevServerHandle | null> {
      state.started++;
      this.started = state.started;
      if (opts.throwOnStart) throw new Error('boom: port in use');
      if (!opts.devUrl) return null;
      return { url: opts.devUrl, ready: opts.ready ?? true, stop: async () => {} };
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

describe('autofix dev-server step', () => {
  it('boots the dev server and injects the URL + curl into agent steps', async () => {
    const runner = new CapturingRunner('anthropic-api', [VERIFY, ROOT, FIX, REVIEW_PASS]);
    const env = makeFakeEnv({ devUrl: 'http://127.0.0.1:51000', ready: true });
    const result = await runWorkflow(autofixWorkflow, {
      store: await makeStore(),
      config: makeConfig({ devServer: { enabled: true, command: 'yarn dev', port: 3000 } }),
      github: makeFakeGitHub(),
      issueNumber: 20,
      apply: true,
      worktreePath: '/tmp/wt',
      runnerFactory: () => runner,
      gitOps: makeFakeGit(),
      runEnv: env,
      loopMaxIterations: { 'fix-review': 2 },
    });

    expect(result.status).toBe('succeeded');
    expect(env.started).toBe(1);
    expect((result.blackboard as AutofixBlackboard).devServerUrl).toBe('http://127.0.0.1:51000');

    // verify-in-repo runs BEFORE the dev-server step ⇒ no URL in its prompt.
    const verifySpec = runner.specs[0];
    expect(verifySpec.userPrompt).not.toContain('51000');

    // root-cause / fix run AFTER ⇒ URL injected, and fix (which has a bash
    // allowlist) gets `curl` added.
    const fixSpec =
      runner.specs.find(
        (s) => s.userPrompt.includes('guard') || s.systemPrompt.includes('FIXER'),
      ) ?? runner.specs[2];
    expect(fixSpec.userPrompt).toContain('http://127.0.0.1:51000');
    expect(fixSpec.bashAllowlist).toContain('curl');
  });

  it('continues (no URL) when the dev server is not configured', async () => {
    const runner = new CapturingRunner('anthropic-api', [VERIFY, ROOT, FIX, REVIEW_PASS]);
    const env = makeFakeEnv({}); // startDevServer → null
    const result = await runWorkflow(autofixWorkflow, {
      store: await makeStore(),
      config: makeConfig({}),
      github: makeFakeGitHub(),
      issueNumber: 21,
      apply: true,
      worktreePath: '/tmp/wt',
      runnerFactory: () => runner,
      gitOps: makeFakeGit(),
      runEnv: env,
      loopMaxIterations: { 'fix-review': 2 },
    });
    expect(result.status).toBe('succeeded');
    expect((result.blackboard as AutofixBlackboard).devServerUrl).toBeUndefined();
    expect(runner.specs.every((s) => !s.userPrompt.includes('dev server'))).toBe(true);
  });

  it('does not fail the run when boot throws (ungated dev-server step)', async () => {
    const runner = new CapturingRunner('anthropic-api', [VERIFY, ROOT, FIX, REVIEW_PASS]);
    const env = makeFakeEnv({ throwOnStart: true });
    const result = await runWorkflow(autofixWorkflow, {
      store: await makeStore(),
      config: makeConfig({ devServer: { enabled: true, command: 'yarn dev', port: 3000 } }),
      github: makeFakeGitHub(),
      issueNumber: 22,
      apply: true,
      worktreePath: '/tmp/wt',
      runnerFactory: () => runner,
      gitOps: makeFakeGit(),
      runEnv: env,
      loopMaxIterations: { 'fix-review': 2 },
    });
    expect(result.status).toBe('succeeded'); // dev-server step is informational (gate: false)
  });
});
