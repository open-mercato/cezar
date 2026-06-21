import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatAuditComment, withAuditFooter, postAuditComment } from '@cezar/core';
import type { GitHubService } from '@cezar/core';

describe('audit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T10:30:00Z'));
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  describe('formatAuditComment', () => {
    it('formats a standalone audit comment with full timestamp and actions', () => {
      const result = formatAuditComment([
        'Marked as duplicate of #45 (95% confidence)',
        'Added `duplicate` label',
      ]);

      expect(result).toContain('**CEZAR update**');
      expect(result).toContain('2026-03-15T10:30:00.000Z');
      expect(result).toContain('- Marked as duplicate of #45 (95% confidence)');
      expect(result).toContain('- Added `duplicate` label');
    });

    it('handles single action', () => {
      const result = formatAuditComment(['Added `security` label']);

      expect(result).toContain('- Added `security` label');
      expect(result.match(/^- /gm)).toHaveLength(1);
    });
  });

  describe('withAuditFooter', () => {
    it('appends audit footer to existing comment body', () => {
      const body = 'Thanks for reporting! Could you share:\n\n1. Steps to reproduce\n2. Your OS';
      const result = withAuditFooter(body, [
        'Requested missing information: reproduction steps, OS',
        'Added `needs-info` label',
      ]);

      // Original body is preserved
      expect(result).toContain('Thanks for reporting!');
      expect(result).toContain('1. Steps to reproduce');

      // Footer is appended after separator
      expect(result).toContain('---');
      expect(result).toContain('**CEZAR update**');
      expect(result).toContain('2026-03-15T10:30:00.000Z');
      expect(result).toContain('- Requested missing information: reproduction steps, OS');
      expect(result).toContain('- Added `needs-info` label');
    });

    it('body comes before the separator', () => {
      const result = withAuditFooter('Original text', ['Action done']);
      const separatorIndex = result.indexOf('---');
      const bodyIndex = result.indexOf('Original text');

      expect(bodyIndex).toBeLessThan(separatorIndex);
    });
  });

  describe('postAuditComment', () => {
    it('calls github.addComment with formatted audit comment', async () => {
      const mockGithub = {
        addComment: vi.fn().mockResolvedValue(undefined),
      } as unknown as GitHubService;

      await postAuditComment(mockGithub, 42, ['Closed as resolved', 'Added `stale` label']);

      expect(mockGithub.addComment).toHaveBeenCalledOnce();
      expect(mockGithub.addComment).toHaveBeenCalledWith(
        42,
        expect.stringContaining('**CEZAR update**'),
      );
      expect(mockGithub.addComment).toHaveBeenCalledWith(
        42,
        expect.stringContaining('- Closed as resolved'),
      );
      expect(mockGithub.addComment).toHaveBeenCalledWith(
        42,
        expect.stringContaining('- Added `stale` label'),
      );
    });
  });
});
