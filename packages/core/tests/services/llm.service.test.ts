import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LLMService } from '@cezar/core';
import type { Config } from '@cezar/core';
import type { StoredIssue } from '@cezar/core';

const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn().mockImplementation(function () {
      return {
        messages: {
          create: mockCreate,
        },
      };
    }),
  };
});

function makeConfig(): Config {
  return {
    github: { owner: 'test', repo: 'repo', token: 'ghp_test' },
    llm: { model: 'claude-sonnet-4-20250514', maxTokens: 4096, apiKey: 'sk-ant-test123' },
    store: { path: '.issue-store' },
    sync: {
      digestBatchSize: 20, duplicateBatchSize: 30, minDuplicateConfidence: 0.80, includeClosed: false,
      labelBatchSize: 20, missingInfoBatchSize: 15, recurringBatchSize: 15,
      priorityBatchSize: 20, securityBatchSize: 20, staleDaysThreshold: 90, staleCloseDays: 14, doneDetectorBatchSize: 10, needsResponseBatchSize: 15,
    },
  };
}

function makeStoredIssue(number: number, digest = true): StoredIssue {
  return {
    number,
    title: `Issue ${number}`,
    body: `Body ${number}`,
    state: 'open',
    labels: [],
    author: 'user1',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    htmlUrl: `https://github.com/test/repo/issues/${number}`,
    contentHash: 'abc123',
    commentCount: 0,
    reactions: 0,
    digest: digest ? {
      summary: `Summary for issue ${number}`,
      category: 'bug',
      affectedArea: 'core',
      keywords: ['test'],
      digestedAt: '2024-01-01T00:00:00Z',
    } : null,
    analysis: {
      duplicateOf: null,
      duplicateConfidence: null,
      duplicateReason: null,
      duplicatesAnalyzedAt: null,
      priority: null,
      priorityReason: null,
      prioritySignals: null,
      priorityAnalyzedAt: null,
      suggestedLabels: null,
      labelsReason: null,
      labelsAnalyzedAt: null,
      labelsAppliedAt: null,
      missingInfoFields: null,
      missingInfoComment: null,
      missingInfoAnalyzedAt: null,
      missingInfoPostedAt: null,
      isRecurringQuestion: null,
      similarClosedIssues: null,
      suggestedResponse: null,
      recurringAnalyzedAt: null,
      isGoodFirstIssue: null,
      goodFirstIssueReason: null,
      goodFirstIssueHint: null,
      goodFirstIssueAnalyzedAt: null,
      securityFlag: null,
      securityConfidence: null,
      securityCategory: null,
      securitySeverity: null,
      securityAnalyzedAt: null,
      staleAction: null,
      staleReason: null,
      staleDraftComment: null,
      staleAnalyzedAt: null,
      qualityFlag: null,
      qualityReason: null,
      qualityAnalyzedAt: null,
      welcomeCommentPostedAt: null,
    },
  };
}

describe('LLMService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws on missing API key', () => {
    const config = makeConfig();
    config.llm.apiKey = '';
    expect(() => new LLMService(config)).toThrow('Missing Anthropic API key');
  });

  describe('generateDigests', () => {
    it('parses valid digest response', async () => {
      mockCreate.mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            digests: [{
              number: 1,
              summary: 'Login page crashes',
              category: 'bug',
              affectedArea: 'auth',
              keywords: ['login', 'crash'],
            }],
          }),
        }],
      });

      const service = new LLMService(makeConfig());
      const result = await service.generateDigests(
        [{ number: 1, title: 'Issue 1', body: 'Body 1' }],
        20,
      );

      expect(result.size).toBe(1);
      const digest = result.get(1)!;
      expect(digest.summary).toBe('Login page crashes');
      expect(digest.category).toBe('bug');
      expect(digest.digestedAt).toBeTruthy();
    });

    it('handles markdown-wrapped JSON', async () => {
      mockCreate.mockResolvedValue({
        content: [{
          type: 'text',
          text: '```json\n{"digests":[{"number":1,"summary":"test","category":"bug","affectedArea":"core","keywords":["a"]}]}\n```',
        }],
      });

      const service = new LLMService(makeConfig());
      const result = await service.generateDigests(
        [{ number: 1, title: 'Issue 1', body: 'Body 1' }],
        20,
      );
      expect(result.size).toBe(1);
    });

    it('returns empty map on invalid JSON', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'not valid json at all' }],
      });

      const service = new LLMService(makeConfig());
      const result = await service.generateDigests(
        [{ number: 1, title: 'Issue 1', body: 'Body 1' }],
        20,
      );
      expect(result.size).toBe(0);
    });

    it('batches issues correctly', async () => {
      mockCreate.mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            digests: [{
              number: 1,
              summary: 'test',
              category: 'bug',
              affectedArea: 'core',
              keywords: ['a'],
            }],
          }),
        }],
      });

      const service = new LLMService(makeConfig());
      const issues = Array.from({ length: 5 }, (_, i) => ({
        number: i + 1,
        title: `Issue ${i + 1}`,
        body: `Body ${i + 1}`,
      }));

      await service.generateDigests(issues, 2);
      // 5 issues / batch size 2 = 3 batches
      expect(mockCreate).toHaveBeenCalledTimes(3);
    });
  });

  describe('retries on transient errors', () => {
    it('retries on 429 and eventually succeeds', async () => {
      vi.useFakeTimers();
      try {
        const rateLimited: any = new Error('rate limited');
        rateLimited.status = 429;
        mockCreate
          .mockRejectedValueOnce(rateLimited)
          .mockResolvedValueOnce({
            content: [{
              type: 'text',
              text: JSON.stringify({
                digests: [{ number: 1, summary: 'ok', category: 'bug', affectedArea: 'core', keywords: ['a'] }],
              }),
            }],
          });

        const service = new LLMService(makeConfig());
        const promise = service.generateDigests([{ number: 1, title: 'Issue 1', body: 'Body 1' }], 20);
        await vi.runAllTimersAsync();
        const result = await promise;

        expect(mockCreate).toHaveBeenCalledTimes(2);
        expect(result.size).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not retry non-retryable errors (e.g. 400)', async () => {
      const badRequest: any = new Error('bad request');
      badRequest.status = 400;
      mockCreate.mockRejectedValue(badRequest);

      const service = new LLMService(makeConfig());
      await expect(
        service.generateDigests([{ number: 1, title: 'Issue 1', body: 'Body 1' }], 20),
      ).rejects.toThrow('bad request');
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('gives up after exhausting retries on persistent 529', async () => {
      vi.useFakeTimers();
      try {
        const overloaded: any = new Error('overloaded');
        overloaded.status = 529;
        mockCreate.mockRejectedValue(overloaded);

        const service = new LLMService(makeConfig());
        const promise = service.generateDigests([{ number: 1, title: 'Issue 1', body: 'Body 1' }], 20);
        const assertion = expect(promise).rejects.toThrow('overloaded');
        await vi.runAllTimersAsync();
        await assertion;

        // initial attempt + 4 retries
        expect(mockCreate).toHaveBeenCalledTimes(5);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('detectDuplicates', () => {
    it('parses valid duplicate response', async () => {
      mockCreate.mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            duplicates: [{
              number: 5,
              duplicateOf: 2,
              confidence: 0.95,
              reason: 'Both describe the same login bug',
            }],
          }),
        }],
      });

      const service = new LLMService(makeConfig());
      const candidates = [makeStoredIssue(5)];
      const kb = [makeStoredIssue(1), makeStoredIssue(2), makeStoredIssue(3)];

      const result = await service.detectDuplicates(candidates, kb);
      expect(result).toHaveLength(1);
      expect(result[0].number).toBe(5);
      expect(result[0].duplicateOf).toBe(2);
      expect(result[0].confidence).toBe(0.95);
    });

    it('returns empty array when no duplicates found', async () => {
      mockCreate.mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({ duplicates: [] }),
        }],
      });

      const service = new LLMService(makeConfig());
      const result = await service.detectDuplicates(
        [makeStoredIssue(5)],
        [makeStoredIssue(1)],
      );
      expect(result).toEqual([]);
    });

    it('returns empty on parse failure', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'I cannot determine duplicates' }],
      });

      const service = new LLMService(makeConfig());
      const result = await service.detectDuplicates(
        [makeStoredIssue(5)],
        [makeStoredIssue(1)],
      );
      expect(result).toEqual([]);
    });
  });
});
