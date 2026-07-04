import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IssueStore } from '@cezar/core';
import { contentHash } from '@cezar/core';

function makeIssue(number: number, overrides: Record<string, unknown> = {}) {
  const title = `Issue ${number}`;
  const body = `Body for issue ${number}`;
  return {
    number,
    title,
    body,
    state: 'open' as const,
    labels: [],
    assignees: [],
    author: 'user1',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    htmlUrl: `https://github.com/test/repo/issues/${number}`,
    contentHash: contentHash(title, body),
    commentCount: 0,
    reactions: 0,
    ...overrides,
  };
}

describe('IssueStore', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'store-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('init and load', () => {
    it('creates a new store and loads it back', async () => {
      const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
      const meta = store.getMeta();
      expect(meta.owner).toBe('test');
      expect(meta.repo).toBe('repo');
      expect(meta.lastSyncedAt).toBeNull();
      expect(meta.version).toBe(1);

      const loaded = await IssueStore.load(tmpDir);
      expect(loaded.getMeta()).toEqual(meta);
    });

    it('loadOrNull returns null for missing store', async () => {
      const result = await IssueStore.loadOrNull(join(tmpDir, 'nonexistent'));
      expect(result).toBeNull();
    });
  });

  describe('upsertIssue', () => {
    it('creates a new issue', async () => {
      const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
      const result = store.upsertIssue(makeIssue(1));
      expect(result.action).toBe('created');
      expect(store.getIssues()).toHaveLength(1);
      expect(store.getIssue(1)?.title).toBe('Issue 1');
    });

    it('returns unchanged for same content hash', async () => {
      const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
      store.upsertIssue(makeIssue(1));
      const result = store.upsertIssue(makeIssue(1));
      expect(result.action).toBe('unchanged');
      expect(store.getIssues()).toHaveLength(1);
    });

    it('returns updated when content hash differs', async () => {
      const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
      store.upsertIssue(makeIssue(1));

      // Set a digest first
      store.setDigest(1, {
        summary: 'test',
        category: 'bug',
        affectedArea: 'core',
        keywords: ['test'],
        digestedAt: '2024-01-01T00:00:00Z',
      });
      expect(store.getIssue(1)?.digest).not.toBeNull();

      // Now update with different content
      const updated = makeIssue(1, {
        body: 'Updated body',
        contentHash: contentHash('Issue 1', 'Updated body'),
      });
      const result = store.upsertIssue(updated);
      expect(result.action).toBe('updated');
      // Digest should be cleared on content change
      expect(store.getIssue(1)?.digest).toBeNull();
    });
  });

  describe('setDigest', () => {
    it('sets digest on existing issue', async () => {
      const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
      store.upsertIssue(makeIssue(1));

      const digest = {
        summary: 'A bug in login',
        category: 'bug' as const,
        affectedArea: 'auth',
        keywords: ['login', 'crash'],
        digestedAt: '2024-01-01T00:00:00Z',
      };
      store.setDigest(1, digest);
      expect(store.getIssue(1)?.digest).toEqual(digest);
    });

    it('throws for nonexistent issue', async () => {
      const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
      expect(() =>
        store.setDigest(999, {
          summary: 'test',
          category: 'bug',
          affectedArea: 'core',
          keywords: [],
          digestedAt: '2024-01-01T00:00:00Z',
        }),
      ).toThrow('Issue #999 not found');
    });
  });

  describe('setAnalysis', () => {
    it('merges analysis fields', async () => {
      const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
      store.upsertIssue(makeIssue(1));

      store.setAnalysis(1, {
        duplicateOf: 5,
        duplicateConfidence: 0.95,
        duplicateReason: 'Same login bug',
        duplicatesAnalyzedAt: '2024-01-01T00:00:00Z',
      });

      const issue = store.getIssue(1)!;
      expect(issue.analysis.duplicateOf).toBe(5);
      expect(issue.analysis.duplicateConfidence).toBe(0.95);
      // Other fields remain null
      expect(issue.analysis.priority).toBeNull();
    });

    it('throws for nonexistent issue', async () => {
      const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
      expect(() => store.setAnalysis(999, { duplicateOf: 1 })).toThrow('Issue #999 not found');
    });
  });

  describe('getIssues', () => {
    it('filters by state', async () => {
      const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
      store.upsertIssue(makeIssue(1, { state: 'open' }));
      store.upsertIssue(makeIssue(2, { state: 'closed' }));
      store.upsertIssue(makeIssue(3, { state: 'open' }));

      expect(store.getIssues({ state: 'open' })).toHaveLength(2);
      expect(store.getIssues({ state: 'closed' })).toHaveLength(1);
      expect(store.getIssues({ state: 'all' })).toHaveLength(3);
      expect(store.getIssues()).toHaveLength(3);
    });

    it('filters by hasDigest', async () => {
      const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
      store.upsertIssue(makeIssue(1));
      store.upsertIssue(makeIssue(2));

      store.setDigest(1, {
        summary: 'test',
        category: 'bug',
        affectedArea: 'core',
        keywords: [],
        digestedAt: '2024-01-01T00:00:00Z',
      });

      expect(store.getIssues({ hasDigest: true })).toHaveLength(1);
      expect(store.getIssues({ hasDigest: false })).toHaveLength(1);
    });
  });

  describe('roundtrip save/load', () => {
    it('persists all data through save and load', async () => {
      const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
      store.upsertIssue(makeIssue(1));
      store.upsertIssue(makeIssue(2));
      store.setDigest(1, {
        summary: 'A bug',
        category: 'bug',
        affectedArea: 'core',
        keywords: ['crash'],
        digestedAt: '2024-01-01T00:00:00Z',
      });
      store.setAnalysis(1, {
        duplicateOf: 2,
        duplicateConfidence: 0.9,
        duplicateReason: 'Same issue',
        duplicatesAnalyzedAt: '2024-01-01T00:00:00Z',
      });
      store.updateMeta({ lastSyncedAt: '2024-01-01T12:00:00Z', totalFetched: 2 });
      await store.save();

      const loaded = await IssueStore.load(tmpDir);
      expect(loaded.getIssues()).toHaveLength(2);
      expect(loaded.getIssue(1)?.digest?.summary).toBe('A bug');
      expect(loaded.getIssue(1)?.analysis.duplicateOf).toBe(2);
      expect(loaded.getMeta().lastSyncedAt).toBe('2024-01-01T12:00:00Z');
      expect(loaded.getMeta().totalFetched).toBe(2);
    });
  });

  describe('Zod validation', () => {
    it('rejects invalid store data on load', async () => {
      const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
      // Corrupt the file
      const { writeFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      await writeFile(join(tmpDir, 'store.json'), JSON.stringify({ bad: 'data' }));

      await expect(IssueStore.load(tmpDir)).rejects.toThrow();
    });
  });
});
