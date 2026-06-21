import { describe, expect, it } from 'vitest';
import { runWorkflow, type WorkflowGitHub } from '../../src/workflows/workflow-engine.js';
import {
  autofixWorkflow,
  type AutofixBlackboard,
} from '../../src/workflows/definitions/autofix.workflow.js';
import {
  PR_LINK_MARKER_TAG,
  formatMarkerComment,
  parseMarkerComment,
} from '../../src/workflows/pr-link-marker.js';
import type {
  AgentBackend,
  AgentRunner,
  AgentRunResult,
  AgentRunSpec,
} from '../../src/agents/agent-runner.js';
import { IssueStore } from '../../src/store/store.js';
import { ConfigSchema } from '../../src/config/config.model.js';
import type { Store } from '../../src/store/store.model.js';

// Verifies that the engine's open-pr step writes a sticky `cezar:pr-link`
// marker on the issue — so a subsequent flow run can find it and bail out
// of fix attempts without hallucinating. Sister tests:
//   - pr-link-marker.test.ts — unit tests for format/parse/upsert primitives.
//   - autofix-workflow.test.ts — broader engine happy-path coverage.

function makeConfig() {
  return ConfigSchema.parse({
    github: { owner: 'acme', repo: 'cezar', token: 'token' },
    llm: { apiKey: 'test-key' },
    store: { path: '.issue-store-test' },
    autofix: { enabled: true, repoRoot: '/tmp/repo', maxAttemptsPerIssue: 2 },
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

/**
 * Like the fake in autofix-workflow.test.ts but also implements
 * `listIssueCommentsWithIds`, so the marker's find-then-upsert can take the
 * "edit existing comment in place" path instead of always creating fresh.
 */
function makeFakeGitHub(seedComments: Array<{ id: number; body: string }> = []) {
  const issueComments = seedComments.map((c) => ({
    id: c.id,
    author: 'cezar-bot',
    body: c.body,
    createdAt: '2026-05-20T00:00:00Z',
  }));
  const prsOpened: Array<{ title: string; body: string; head: string; base: string }> = [];
  const pushed: Array<{ branch: string; path: string }> = [];
  let nextId = Math.max(2000, ...issueComments.map((c) => c.id + 1));

  const gh: WorkflowGitHub & {
    issueComments: typeof issueComments;
    prsOpened: typeof prsOpened;
    pushed: typeof pushed;
  } = {
    issueComments,
    prsOpened,
    pushed,
    async addComment(n, body) {
      const id = nextId++;
      issueComments.push({ id, author: 'cezar-bot', body, createdAt: new Date().toISOString() });
      // simulate "add a sibling comment on the PR" path too: any comment we
      // add against an issue number is recorded; tests filter by content.
      void n;
      return id;
    },
    async updateComment(id, body) {
      const c = issueComments.find((x) => x.id === id);
      if (c) c.body = body;
    },
    async listIssueCommentsWithIds() {
      return issueComments.map((c) => ({
        id: c.id,
        author: c.author,
        body: c.body,
        createdAt: c.createdAt,
      }));
    },
    async getIssueWithComments(n) {
      return {
        issue: { number: n, title: `Password reset broken (#${n})`, body: 'It throws on /reset.' },
        comments: issueComments.map((c) => ({
          author: c.author,
          body: c.body,
          createdAt: c.createdAt,
        })),
      };
    },
    async setLabels() {},
    async addLabel() {},
    async closeIssue() {},
    async pushBranch(branch, path) {
      pushed.push({ branch, path });
    },
    async createPullRequest(opts) {
      prsOpened.push(opts);
      return { url: 'https://example.test/pr/42', number: 42 };
    },
  };
  return gh;
}

class SequencedRunner implements AgentRunner {
  readonly specs: AgentRunSpec<unknown>[] = [];
  private idx = 0;
  constructor(
    readonly backend: AgentBackend,
    private readonly outputs: unknown[],
  ) {}
  async run<T>(spec: AgentRunSpec<T>): Promise<AgentRunResult<T>> {
    this.specs.push(spec as AgentRunSpec<unknown>);
    const parsed = (this.outputs[this.idx] ?? null) as T | null;
    this.idx++;
    return {
      text: JSON.stringify(parsed),
      parsed,
      toolCalls: [],
      tokensUsed: 100,
      budgetExceeded: false,
    };
  }
  async interrupt(): Promise<void> {}
}

function makeFakeGit() {
  const commits: string[] = [];
  return {
    commits,
    async commitAll(_wt: string, message: string): Promise<string | null> {
      commits.push(message);
      return `sha${commits.length}0000000`;
    },
    async squashCommitsToBase(
      _wt: string,
      _base: string,
      _message: string,
    ): Promise<string | null> {
      return null;
    },
    async getDiffAgainstBase(): Promise<string> {
      return 'diff --git a/x b/x\n+fix';
    },
  };
}

const VERIFY_OK = {
  isRealUnfixedDefect: true,
  reason: 'reproduced /reset 500 on this branch',
  confidence: 0.9,
};
const ROOT_CAUSE = {
  summary: 'null deref in resetController',
  suspectedFiles: ['src/reset.ts'],
  hypothesis: 'token can be undefined',
  confidence: 0.85,
};
const FIX_REPORT = {
  changedFiles: ['src/reset.ts'],
  approach: 'guard the token before use',
  testCommandsRun: ['yarn test'],
};
const REVIEW_PASS = { verdict: 'pass' as const, summary: 'looks correct', issues: [] };

describe('engine open-pr writes the pr-link marker', () => {
  it('adds a new marker comment on the issue when none exists', async () => {
    const store = await makeStore();
    const github = makeFakeGitHub();
    const runner = new SequencedRunner('anthropic-api', [
      VERIFY_OK,
      ROOT_CAUSE,
      FIX_REPORT,
      REVIEW_PASS,
    ]);
    const git = makeFakeGit();

    const result = await runWorkflow(autofixWorkflow, {
      store,
      config: makeConfig(),
      github,
      issueNumber: 1740,
      apply: true,
      worktreePath: '/tmp/wt',
      runnerFactory: () => runner,
      gitOps: git,
      loopMaxIterations: { 'fix-review': 2 },
    });

    expect(result.status).toBe('succeeded');
    expect((result.blackboard as AutofixBlackboard).verdict?.verdict).toBe('pass');

    // Find the marker comment among everything we wrote to the issue.
    const markers = github.issueComments.filter((c) =>
      c.body.includes(`<!-- ${PR_LINK_MARKER_TAG}`),
    );
    expect(markers).toHaveLength(1);
    const parsed = parseMarkerComment(markers[0].body);
    expect(parsed).toMatchObject({
      prNumber: 42,
      prUrl: 'https://example.test/pr/42',
      prState: 'draft',
    });
    expect(parsed?.branch).toMatch(/^autofix\/cezar-issue-1740$/);
    expect(parsed?.openedAt).toBeDefined();
  });

  it('edits the existing marker in place when one is already on the issue (no duplicate)', async () => {
    // Seed an old marker from a prior (since-closed) PR; the new run on the
    // same issue should re-use that comment id rather than spamming a fresh
    // one. This is the "issue reopened → second autofix attempt" scenario.
    const stale = formatMarkerComment({
      prNumber: 7,
      prUrl: 'https://example.test/pr/7',
      prState: 'closed',
      openedAt: '2026-05-20T00:00:00Z',
    });
    const github = makeFakeGitHub([{ id: 1500, body: stale }]);
    const runner = new SequencedRunner('anthropic-api', [
      VERIFY_OK,
      ROOT_CAUSE,
      FIX_REPORT,
      REVIEW_PASS,
    ]);
    const git = makeFakeGit();

    const result = await runWorkflow(autofixWorkflow, {
      store: await makeStore(),
      config: makeConfig(),
      github,
      issueNumber: 1740,
      apply: true,
      worktreePath: '/tmp/wt',
      runnerFactory: () => runner,
      gitOps: git,
      loopMaxIterations: { 'fix-review': 2 },
    });

    expect(result.status).toBe('succeeded');
    // Still exactly one marker comment.
    const markers = github.issueComments.filter((c) =>
      c.body.includes(`<!-- ${PR_LINK_MARKER_TAG}`),
    );
    expect(markers).toHaveLength(1);
    expect(markers[0].id).toBe(1500); // edited in place
    const parsed = parseMarkerComment(markers[0].body);
    expect(parsed?.prNumber).toBe(42); // updated to the new PR
    expect(parsed?.prState).toBe('draft');
    // openedAt preserved from the stale marker (PR-creation time, not edit time).
    expect(parsed?.openedAt).toBe('2026-05-20T00:00:00Z');
  });

  it('does not write a marker on a dry-run (open-pr is skipped)', async () => {
    const github = makeFakeGitHub();
    const runner = new SequencedRunner('anthropic-api', [
      VERIFY_OK,
      ROOT_CAUSE,
      FIX_REPORT,
      REVIEW_PASS,
    ]);
    const git = makeFakeGit();

    const result = await runWorkflow(autofixWorkflow, {
      store: await makeStore(),
      config: makeConfig(),
      github,
      issueNumber: 1740,
      apply: false,
      worktreePath: '/tmp/wt',
      runnerFactory: () => runner,
      gitOps: git,
      loopMaxIterations: { 'fix-review': 2 },
    });

    expect(result.status).toBe('succeeded');
    expect(github.prsOpened).toHaveLength(0);
    const markers = github.issueComments.filter((c) =>
      c.body.includes(`<!-- ${PR_LINK_MARKER_TAG}`),
    );
    expect(markers).toHaveLength(0);
  });
});
