import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubService } from '@cezar/core';
import type { Config } from '@cezar/core';

// Mock Octokit
vi.mock('@octokit/rest', () => {
  const mockPaginate = vi.fn();
  const mockListForRepo = vi.fn();
  const mockGetLabel = vi.fn();
  const mockCreateLabel = vi.fn();
  const mockAddLabels = vi.fn();
  const mockRemoveLabel = vi.fn();
  const mockSetLabels = vi.fn();
  const mockCreateComment = vi.fn();
  const mockUpdate = vi.fn();
  const mockListLabelsForRepo = vi.fn();
  const mockListComments = vi.fn();

  return {
    Octokit: vi.fn().mockImplementation(function () {
      return {
        paginate: mockPaginate,
        rest: {
          issues: {
            listForRepo: mockListForRepo,
            getLabel: mockGetLabel,
            createLabel: mockCreateLabel,
            addLabels: mockAddLabels,
            removeLabel: mockRemoveLabel,
            setLabels: mockSetLabels,
            createComment: mockCreateComment,
            update: mockUpdate,
            listLabelsForRepo: mockListLabelsForRepo,
            listComments: mockListComments,
          },
        },
      };
    }),
    __mockPaginate: mockPaginate,
    __mockGetLabel: mockGetLabel,
    __mockCreateLabel: mockCreateLabel,
    __mockAddLabels: mockAddLabels,
    __mockRemoveLabel: mockRemoveLabel,
    __mockSetLabels: mockSetLabels,
    __mockCreateComment: mockCreateComment,
    __mockUpdate: mockUpdate,
    __mockListLabelsForRepo: mockListLabelsForRepo,
    __mockListComments: mockListComments,
  };
});

function makeConfig(overrides: Partial<Config['github']> = {}): Config {
  return {
    github: { owner: 'test-owner', repo: 'test-repo', token: 'ghp_test123', ...overrides },
    llm: { model: 'claude-sonnet-4-20250514', maxTokens: 4096, apiKey: '' },
    store: { path: '.issue-store' },
    sync: {
      digestBatchSize: 20,
      duplicateBatchSize: 30,
      minDuplicateConfidence: 0.8,
      includeClosed: false,
      labelBatchSize: 20,
      missingInfoBatchSize: 15,
      recurringBatchSize: 15,
      priorityBatchSize: 20,
      securityBatchSize: 20,
      staleDaysThreshold: 90,
      staleCloseDays: 14,
      doneDetectorBatchSize: 10,
      needsResponseBatchSize: 15,
    },
  };
}

function makeGitHubIssue(number: number, overrides: Record<string, unknown> = {}) {
  return {
    number,
    title: `Issue ${number}`,
    body: `Body ${number}`,
    state: 'open',
    labels: [{ name: 'bug' }],
    user: { login: 'author1' },
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    html_url: `https://github.com/test/repo/issues/${number}`,
    comments: 0,
    reactions: { total_count: 0 },
    ...overrides,
  };
}

describe('GitHubService', () => {
  let mockPaginate: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = (await import('@octokit/rest')) as unknown as {
      __mockPaginate: ReturnType<typeof vi.fn>;
    };
    mockPaginate = mod.__mockPaginate;
  });

  it('throws on missing token', () => {
    expect(() => new GitHubService(makeConfig({ token: '' }))).toThrow('Invalid GitHub token');
  });

  describe('fetchAllIssues', () => {
    it('fetches and maps issues correctly', async () => {
      mockPaginate.mockResolvedValue([
        makeGitHubIssue(1, { comments: 3, reactions: { total_count: 5 } }),
        makeGitHubIssue(2, { state: 'closed' }),
      ]);

      const service = new GitHubService(makeConfig());
      const issues = await service.fetchAllIssues();

      expect(issues).toHaveLength(2);
      expect(issues[0].number).toBe(1);
      expect(issues[0].title).toBe('Issue 1');
      expect(issues[0].state).toBe('open');
      expect(issues[0].labels).toEqual(['bug']);
      expect(issues[0].author).toBe('author1');
      expect(issues[0].contentHash).toBeTruthy();
      expect(issues[0].commentCount).toBe(3);
      expect(issues[0].reactions).toBe(5);
      expect(issues[1].state).toBe('closed');
      expect(issues[1].commentCount).toBe(0);
      expect(issues[1].reactions).toBe(0);
    });

    it('excludes pull requests', async () => {
      mockPaginate.mockResolvedValue([
        makeGitHubIssue(1),
        { ...makeGitHubIssue(2), pull_request: { url: 'https://...' } },
      ]);

      const service = new GitHubService(makeConfig());
      const issues = await service.fetchAllIssues();
      expect(issues).toHaveLength(1);
      expect(issues[0].number).toBe(1);
    });

    it('handles null body', async () => {
      mockPaginate.mockResolvedValue([makeGitHubIssue(1, { body: null })]);

      const service = new GitHubService(makeConfig());
      const issues = await service.fetchAllIssues();
      expect(issues[0].body).toBe('');
    });
  });

  describe('fetchIssuesSince', () => {
    it('passes since parameter and filters PRs', async () => {
      mockPaginate.mockResolvedValue([makeGitHubIssue(3)]);

      const service = new GitHubService(makeConfig());
      const issues = await service.fetchIssuesSince('2024-01-01T00:00:00Z');

      expect(issues).toHaveLength(1);
      expect(mockPaginate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ since: '2024-01-01T00:00:00Z' }),
      );
    });
  });

  describe('error handling', () => {
    it('throws descriptive error on 401', async () => {
      mockPaginate.mockRejectedValue({ status: 401 });

      const service = new GitHubService(makeConfig());
      await expect(service.fetchAllIssues()).rejects.toThrow(/Invalid or expired GitHub token/);
    });

    it('throws descriptive error on 404', async () => {
      mockPaginate.mockRejectedValue({ status: 404 });

      const service = new GitHubService(makeConfig());
      await expect(service.fetchAllIssues()).rejects.toThrow(/not found or is inaccessible/);
    });

    it('treats a bare 403 (no rate-limit signal) as a permission denial', async () => {
      mockPaginate.mockRejectedValue({ status: 403 });

      const service = new GitHubService(makeConfig());
      // No longer the misleading "rate limit exceeded" — a 403 without any
      // rate-limit headers/message is a real permission problem.
      await expect(service.fetchAllIssues()).rejects.toThrow(/denied this action/);
    });

    it('reports a primary rate limit (x-ratelimit-remaining: 0) distinctly', async () => {
      mockPaginate.mockRejectedValue({
        status: 403,
        response: {
          headers: { 'x-ratelimit-remaining': '0' },
          data: { message: 'API rate limit exceeded' },
        },
      });

      const service = new GitHubService(makeConfig());
      await expect(service.fetchAllIssues()).rejects.toThrow(/API rate limit exhausted/);
    });
  });

  describe('label writes', () => {
    async function labelMocks() {
      const mod = (await import('@octokit/rest')) as unknown as {
        __mockGetLabel: ReturnType<typeof vi.fn>;
        __mockCreateLabel: ReturnType<typeof vi.fn>;
        __mockAddLabels: ReturnType<typeof vi.fn>;
      };
      return {
        getLabel: mod.__mockGetLabel,
        createLabel: mod.__mockCreateLabel,
        addLabels: mod.__mockAddLabels,
      };
    }

    it('adds a label in a single request when it already exists (no getLabel probe)', async () => {
      const { getLabel, createLabel, addLabels } = await labelMocks();
      addLabels.mockResolvedValue({});

      await new GitHubService(makeConfig()).addLabel(42, 'priority-high');

      expect(addLabels).toHaveBeenCalledTimes(1);
      expect(getLabel).not.toHaveBeenCalled();
      expect(createLabel).not.toHaveBeenCalled();
    });

    it('creates the repo label then retries when addLabels 404s', async () => {
      const { createLabel, addLabels } = await labelMocks();
      addLabels.mockRejectedValueOnce({ status: 404 }).mockResolvedValueOnce({});
      createLabel.mockResolvedValue({});

      await new GitHubService(makeConfig()).addLabel(42, 'brand-new');

      expect(createLabel).toHaveBeenCalledTimes(1);
      expect(addLabels).toHaveBeenCalledTimes(2);
    });

    it('retries a secondary rate limit and succeeds (self-heals)', async () => {
      const { addLabels } = await labelMocks();
      // retry-after: 0 → instant retry, keeps the test fast.
      addLabels
        .mockRejectedValueOnce({
          status: 403,
          response: {
            headers: { 'retry-after': '0', 'x-ratelimit-remaining': '4999' },
            data: { message: 'You have exceeded a secondary rate limit' },
          },
        })
        .mockResolvedValueOnce({});

      await new GitHubService(makeConfig()).addLabel(7, 'priority-high');

      expect(addLabels).toHaveBeenCalledTimes(2);
    });

    it('does NOT retry a permission 403 and surfaces a permission error', async () => {
      const { addLabels } = await labelMocks();
      addLabels.mockRejectedValue({
        status: 403,
        response: { headers: {}, data: { message: 'Resource not accessible by integration' } },
      });

      await expect(new GitHubService(makeConfig()).addLabel(7, 'priority-high')).rejects.toThrow(
        /GitHub App installation lacks permission/,
      );
      // One real attempt — permission denials are fatal, not retried.
      expect(addLabels).toHaveBeenCalledTimes(1);
    });
  });
});
