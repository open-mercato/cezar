import { describe, expect, it, vi } from 'vitest';
import { AutofixOrchestrator } from '../../../src/actions/autofix/orchestrator.js';
import { IssueStore } from '../../../src/store/store.js';
import { ConfigSchema } from '../../../src/config/config.model.js';
import type { Store } from '../../../src/store/store.model.js';

describe('AutofixOrchestrator preflight', () => {
  it('skips immediately when done-detector already marked the issue resolved', async () => {
    const store = await makeStore({
      issues: [
        makeIssue({
          number: 1740,
          analysis: {
            issueType: 'bug',
            bugConfidence: 0.95,
            doneDetected: true,
            doneReason: 'PR #99 already resolved this issue',
          },
        }),
      ],
    });

    const github = {
      getIssueWithComments: vi.fn(),
      getIssueTimeline: vi.fn(),
    };
    const llm = { analyze: vi.fn() };

    const orchestrator = new AutofixOrchestrator(store, makeConfig(), github as any, llm as any);
    const outcome = await orchestrator.processIssue(1740, { apply: false });

    expect(outcome).toEqual({ status: 'skipped', reason: 'PR #99 already resolved this issue' });
    expect(github.getIssueWithComments).not.toHaveBeenCalled();
    expect(github.getIssueTimeline).not.toHaveBeenCalled();
    expect(llm.analyze).not.toHaveBeenCalled();
  });

  it('skips when merged PR preflight concludes the issue is already fixed', async () => {
    const store = await makeStore({
      issues: [
        makeIssue({
          number: 1740,
          analysis: {
            issueType: 'bug',
            bugConfidence: 0.95,
          },
        }),
      ],
    });

    const github = {
      getIssueWithComments: vi.fn().mockResolvedValue({
        issue: { title: 'Reset link 404', body: 'Steps to reproduce...' },
        comments: [],
      }),
      getIssueTimeline: vi.fn().mockResolvedValue([
        {
          prNumber: 281,
          prTitle: 'Fix reset password portal route',
          prUrl: 'https://example.test/pr/281',
          merged: true,
        },
      ]),
    };
    const llm = {
      analyze: vi.fn().mockResolvedValue({
        results: [
          {
            number: 1740,
            isDone: true,
            confidence: 0.93,
            reason: 'PR #281 explicitly fixes the missing reset-password route.',
            draftComment: 'Resolved by PR #281.',
          },
        ],
      }),
    };

    const orchestrator = new AutofixOrchestrator(store, makeConfig(), github as any, llm as any);
    const outcome = await orchestrator.processIssue(1740, { apply: false, onEvent: vi.fn() });

    expect(outcome).toEqual({
      status: 'skipped',
      reason: 'PR #281 explicitly fixes the missing reset-password route.',
    });
    expect(github.getIssueWithComments).toHaveBeenCalledWith(1740);
    expect(github.getIssueTimeline).toHaveBeenCalledWith(1740);
    expect(llm.analyze).toHaveBeenCalledTimes(1);

    const issue = store.getIssue(1740);
    expect(issue?.analysis.doneDetected).toBe(true);
    expect(issue?.analysis.doneConfidence).toBe(0.93);
    expect(issue?.analysis.doneReason).toBe(
      'PR #281 explicitly fixes the missing reset-password route.',
    );
    expect(issue?.analysis.doneMergedPRs).toEqual([
      { prNumber: 281, prTitle: 'Fix reset password portal route' },
    ]);
  });
});

async function makeStore(data: Store): Promise<IssueStore> {
  return IssueStore.fromPort({
    load: async () => data,
    save: async () => {},
  });
}

function makeConfig() {
  return ConfigSchema.parse({
    github: { owner: 'acme', repo: 'cezar', token: 'token' },
    llm: { apiKey: 'test-key' },
    store: { path: '.issue-store-test' },
    autofix: { enabled: true, repoRoot: '/tmp/repo' },
  });
}

function makeIssue(overrides: { number: number; analysis?: Record<string, unknown> }) {
  return {
    number: overrides.number,
    title: `Issue #${overrides.number}`,
    body: 'Body',
    state: 'open' as const,
    labels: [],
    assignees: [],
    author: 'alice',
    createdAt: '2026-04-30T00:00:00.000Z',
    updatedAt: '2026-04-30T00:00:00.000Z',
    htmlUrl: `https://example.test/issues/${overrides.number}`,
    contentHash: `hash-${overrides.number}`,
    commentCount: 0,
    reactions: 0,
    comments: [],
    commentsFetchedAt: null,
    digest: {
      summary: 'Reset password page missing',
      category: 'bug' as const,
      affectedArea: 'portal',
      keywords: ['reset', 'password', 'portal'],
      digestedAt: '2026-04-30T00:00:00.000Z',
    },
    analysis: {
      issueType: 'bug',
      bugConfidence: 0.95,
      ...overrides.analysis,
    },
  };
}
