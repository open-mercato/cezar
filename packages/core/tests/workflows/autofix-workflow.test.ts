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
import { IssueStore } from '../../src/store/store.js';
import { ConfigSchema } from '../../src/config/config.model.js';
import type { Store } from '../../src/store/store.model.js';

// ─── fakes ──────────────────────────────────────────────────────────────────

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

function makeFakeGitHub() {
  const added: Array<{ n: number; body: string }> = [];
  const updated: Array<{ id: number; body: string }> = [];
  const pushed: Array<{ branch: string; path: string }> = [];
  const prsOpened: Array<{ title: string; body: string; head: string; base: string }> = [];
  let nextId = 2000;
  const gh: WorkflowGitHub & {
    added: typeof added;
    updated: typeof updated;
    pushed: typeof pushed;
    prsOpened: typeof prsOpened;
  } = {
    added,
    updated,
    pushed,
    prsOpened,
    async addComment(n, body) {
      added.push({ n, body });
      return nextId++;
    },
    async updateComment(id, body) {
      updated.push({ id, body });
    },
    async getIssueWithComments(n) {
      return {
        issue: { number: n, title: `Password reset broken (#${n})`, body: 'It throws on /reset.' },
        comments: [],
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

// fake git ops — no real worktree.
function makeFakeGit(opts: { changesPerCommit?: boolean[]; squashableCommit?: boolean[] } = {}) {
  let commitN = 0;
  let squashN = 0;
  const commits: string[] = [];
  const squashed: string[] = [];
  return {
    commits,
    squashed,
    async commitAll(_wt: string, message: string): Promise<string | null> {
      const hasChanges = opts.changesPerCommit ? (opts.changesPerCommit[commitN] ?? true) : true;
      commitN++;
      if (!hasChanges) return null;
      commits.push(message);
      return `sha${commitN}0000000`;
    },
    // Simulates `git reset --soft <base> && git commit -m <msg>` collapsing
    // autosave commits into one clean commit. `squashableCommit[i] === false`
    // models "no diff against base" (squash also returns null).
    async squashCommitsToBase(_wt: string, _base: string, message: string): Promise<string | null> {
      const hasDiff = opts.squashableCommit ? (opts.squashableCommit[squashN] ?? true) : true;
      squashN++;
      if (!hasDiff) return null;
      squashed.push(message);
      return `squash${squashN}000000`;
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
const REVIEW_PASS = {
  verdict: 'pass' as const,
  summary: 'looks correct, addresses the root cause',
  issues: [],
};
const REVIEW_FAIL = {
  verdict: 'fail' as const,
  summary: 'still misses the empty-string case',
  issues: [{ severity: 'blocker' as const, comment: 'handle empty token too' }],
};

// ─── tests ──────────────────────────────────────────────────────────────────

describe('autofixWorkflow (engine)', () => {
  it('happy path: verify → root-cause → fix → commit → review pass → open-pr', async () => {
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
    const bb = result.blackboard as AutofixBlackboard;
    expect(bb.verify?.isRealUnfixedDefect).toBe(true);
    expect(bb.rootCause?.summary).toBe('null deref in resetController');
    expect(bb.fixReport?.approach).toBe('guard the token before use');
    expect(bb.verdict?.verdict).toBe('pass');
    expect(bb.commitSha).toBeTruthy();
    expect(result.prNumber).toBe(42);
    expect(result.prUrl).toBe('https://example.test/pr/42');
    expect(result.branch).toMatch(/^autofix\/cezar-issue-1740$/);

    // 4 agent calls (verify, root-cause, fix, review)
    expect(runner.specs).toHaveLength(4);
    // one commit
    expect(git.commits).toHaveLength(1);
    // pushed + PR opened with the fix title
    expect(github.pushed).toHaveLength(1);
    expect(github.prsOpened).toHaveLength(1);
    expect(github.prsOpened[0].title).toMatch(/^fix: Password reset broken/);
    // Issue gets: (1) the living-comment shell (id 2000), (2) the sticky
    // `cezar:pr-link` marker after open-pr (id 2002). PR gets one shell
    // comment (id 2001) which is later edited with the summary.
    const issueComments = github.added.filter((c) => c.n === 1740);
    const issueShell = issueComments.filter((c) => !c.body.includes('cezar:pr-link'));
    const issueMarker = issueComments.filter((c) => c.body.includes('cezar:pr-link'));
    const prShell = github.added.filter((c) => c.n === 42);
    expect(issueShell).toHaveLength(1);
    expect(issueMarker).toHaveLength(1);
    expect(prShell).toHaveLength(1);
    const prCommentId = 2001; // first addComment → 2000 (issue), second → 2001 (PR)
    const prEdits = github.updated.filter((u) => u.id === prCommentId);
    expect(prEdits.length).toBeGreaterThanOrEqual(1);
    const finalPrComment = prEdits[prEdits.length - 1].body;
    // the PR comment got the root-cause summary
    expect(finalPrComment).toContain('null deref in resetController');
    expect(finalPrComment).toContain('guard the token before use');
    // the issue comment (id 2000) was edited and finalized with a link to the PR
    const issueEdits = github.updated.filter((u) => u.id === 2000);
    const lastIssueEdit = issueEdits[issueEdits.length - 1];
    expect(lastIssueEdit.body).toContain('see PR #42');
    // run records: 4 agent steps succeeded
    // (we don't pass onRunRecord here — the result.runRecords carries them)
    const agentRecords = result.runRecords.filter((r) =>
      ['verify-in-repo', 'root-cause', 'fix', 'review'].includes(r.stepId),
    );
    expect(agentRecords.every((r) => r.status === 'succeeded')).toBe(true);
    expect(result.runRecords.find((r) => r.stepId === 'open-pr')?.status).toBe('succeeded');
  });

  it('review fails once, then passes — the fix↔review loop iterates', async () => {
    const store = await makeStore();
    const github = makeFakeGitHub();
    const runner = new SequencedRunner('anthropic-api', [
      VERIFY_OK,
      ROOT_CAUSE,
      FIX_REPORT,
      REVIEW_FAIL, // iteration 0: fix, commit, review-fail (retriable)
      FIX_REPORT,
      REVIEW_PASS, // iteration 1: fix, commit, review-pass
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
    const bb = result.blackboard as AutofixBlackboard;
    expect(bb.verdict?.verdict).toBe('pass');
    // retry notes were carried into the 2nd fix attempt
    // (the fixer prompt on the 2nd iteration mentions the reviewer's blocker)
    expect(runner.specs).toHaveLength(6);
    const secondFixPrompt = runner.specs[4].userPrompt; // verify,root,fix,review,fix(retry),review
    expect(secondFixPrompt).toMatch(/PRIOR ATTEMPT/);
    expect(secondFixPrompt).toContain('handle empty token too');
    // two commits (one per fix iteration)
    expect(git.commits).toHaveLength(2);
    // step-b ran twice → 2 review records (iterations 0 and 1)
    const reviewRecords = result.runRecords.filter((r) => r.stepId === 'review');
    expect(reviewRecords).toHaveLength(2);
    expect(reviewRecords[0].status).toBe('failed');
    expect(reviewRecords[1].status).toBe('succeeded');
    expect(github.prsOpened).toHaveLength(1);
  });

  it('verify-in-repo says "not a real defect" ⇒ run ends succeeded-but-skipped, no fix', async () => {
    const store = await makeStore();
    const github = makeFakeGitHub();
    const runner = new SequencedRunner('anthropic-api', [
      { isRealUnfixedDefect: false, reason: 'already fixed in commit abc1234', confidence: 0.9 },
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
    });
    expect(result.status).toBe('succeeded');
    expect(result.reason).toMatch(/already fixed/);
    expect(runner.specs).toHaveLength(1);
    expect(git.commits).toHaveLength(0);
    expect(github.prsOpened).toHaveLength(0);
  });

  it('commit step recovers when the autosaver already committed the fix (squash path)', async () => {
    // Regression for the autosaver vs. commit-step race: the fix step's
    // `startWorktreeAutosaver` commits the agent's edits every 90s under
    // `cezar: autosave (fix)`. The explicit commit step then sees a clean
    // working tree (`commitAll` returns null) — pre-fix that hard-failed
    // with "fixer made no file changes" even though the work was on the
    // branch. The fix is `squashCommitsToBase`, exercised here.
    const store = await makeStore();
    const github = makeFakeGitHub();
    const runner = new SequencedRunner('anthropic-api', [
      VERIFY_OK,
      ROOT_CAUSE,
      FIX_REPORT,
      REVIEW_PASS,
    ]);
    const git = makeFakeGit({ changesPerCommit: [false] }); // commitAll → null (autosave already did it)
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
    // commitAll never produced a sha (autosave path), but squash did.
    expect(git.commits).toHaveLength(0);
    expect(git.squashed).toHaveLength(1);
    // The squashed commit got the real commit message, not the autosave one.
    expect(git.squashed[0]).toMatch(/Password reset broken/);
    expect((result.blackboard as AutofixBlackboard).commitSha).toMatch(/^squash/);
    expect(github.prsOpened).toHaveLength(1);
  });

  it('commit step still fails "no file changes" when neither commitAll nor squash finds work', async () => {
    const store = await makeStore();
    const github = makeFakeGitHub();
    const runner = new SequencedRunner('anthropic-api', [
      VERIFY_OK,
      ROOT_CAUSE,
      FIX_REPORT,
      REVIEW_PASS,
    ]);
    const git = makeFakeGit({ changesPerCommit: [false, false], squashableCommit: [false, false] });
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

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/no file changes/);
    expect(git.commits).toHaveLength(0);
    expect(git.squashed).toHaveLength(0);
    expect(github.prsOpened).toHaveLength(0);
  });

  it('dry-run (apply:false): runs through review pass but skips open-pr', async () => {
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
      apply: false,
      worktreePath: '/tmp/wt',
      runnerFactory: () => runner,
      gitOps: git,
      loopMaxIterations: { 'fix-review': 2 },
    });
    expect(result.status).toBe('succeeded');
    expect(result.prNumber).toBeUndefined();
    expect(github.prsOpened).toHaveLength(0);
    expect(github.pushed).toHaveLength(0);
    // the loop still iterated through review-pass
    expect(result.runRecords.find((r) => r.stepId === 'review')?.status).toBe('succeeded');
  });
});
