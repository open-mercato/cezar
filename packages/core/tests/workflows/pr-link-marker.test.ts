import { describe, expect, it } from 'vitest';
import {
  PR_LINK_MARKER_TAG,
  classifyActivity,
  findMarkerComment,
  formatMarkerComment,
  parseMarkerComment,
  upsertMarkerComment,
  type PrLinkGitHubGateway,
} from '../../src/workflows/pr-link-marker.js';

describe('formatMarkerComment / parseMarkerComment', () => {
  it('round-trips a full payload', () => {
    const data = {
      prNumber: 2050,
      prUrl: 'https://github.com/o/r/pull/2050',
      prState: 'changes-requested',
      branch: 'autofix/cezar-issue-1704',
      openedAt: '2026-05-25T04:01:00Z',
      lastEventAt: '2026-05-25T05:07:22Z',
    };
    const body = formatMarkerComment(data);
    expect(body).toContain(`<!-- ${PR_LINK_MARKER_TAG}`);
    expect(body).toContain('pr_number: 2050');
    expect(body).toContain('🤖 Cezar opened **[PR #2050](https://github.com/o/r/pull/2050)**');
    expect(body).toContain('Status: `changes-requested`');

    const parsed = parseMarkerComment(body);
    expect(parsed).toEqual(data);
  });

  it('parses a minimal payload (no branch / timestamps)', () => {
    const body = formatMarkerComment({
      prNumber: 99,
      prUrl: 'https://example.test/pr/99',
      prState: 'draft',
    });
    const parsed = parseMarkerComment(body);
    expect(parsed).toEqual({
      prNumber: 99,
      prUrl: 'https://example.test/pr/99',
      prState: 'draft',
      branch: undefined,
      openedAt: undefined,
      lastEventAt: undefined,
    });
  });

  it('returns null for non-marker comments', () => {
    expect(parseMarkerComment('Just a plain comment.')).toBeNull();
    expect(parseMarkerComment('')).toBeNull();
    expect(parseMarkerComment('<!-- cezar:other --> different tag')).toBeNull();
  });

  it('returns null when required fields are missing', () => {
    const body = `<!-- ${PR_LINK_MARKER_TAG}\npr_number: notanumber\npr_url: x\n-->`;
    expect(parseMarkerComment(body)).toBeNull();
    const body2 = `<!-- ${PR_LINK_MARKER_TAG}\npr_state: draft\n-->`;
    expect(parseMarkerComment(body2)).toBeNull();
  });

  it('tolerates surrounding markdown and case-insensitive tag', () => {
    const body = [
      'Some preamble paragraph.',
      '',
      `<!-- ${PR_LINK_MARKER_TAG.toUpperCase()}`,
      'pr_number: 7',
      'pr_url: https://example.test/pr/7',
      'pr_state: open',
      '-->',
      '',
      '🤖 Cezar opened **[PR #7](https://example.test/pr/7)**',
    ].join('\n');
    const parsed = parseMarkerComment(body);
    expect(parsed?.prNumber).toBe(7);
    expect(parsed?.prState).toBe('open');
  });
});

describe('classifyActivity', () => {
  it.each([
    ['draft', 'active'],
    ['open', 'active'],
    ['review', 'active'],
    ['changes-requested', 'active'],
    ['wip', 'active'],
    ['merged', 'merged'],
    ['closed', 'closed'],
    ['cancelled', 'closed'],
    ['something-weird', 'other'],
    ['', 'other'],
  ] as const)('%s → %s', (state, bucket) => {
    expect(classifyActivity(state)).toBe(bucket);
  });
});

// ── fake GitHub gateway ────────────────────────────────────────────────────

class FakeGateway implements PrLinkGitHubGateway {
  comments: Array<{ id: number; author: string; body: string; createdAt: string }> = [];
  nextId = 1000;

  async addComment(_issue: number, body: string): Promise<number> {
    const id = this.nextId++;
    this.comments.push({ id, author: 'cezar-bot', body, createdAt: new Date().toISOString() });
    return id;
  }

  async updateComment(commentId: number, body: string): Promise<void> {
    const existing = this.comments.find((c) => c.id === commentId);
    if (!existing) throw new Error(`comment ${commentId} not found`);
    existing.body = body;
  }

  async listIssueCommentsWithIds(_issue: number) {
    return [...this.comments];
  }
}

describe('upsertMarkerComment', () => {
  it('creates a new comment when none exists', async () => {
    const gh = new FakeGateway();
    const result = await upsertMarkerComment(gh, 1704, {
      prNumber: 2050,
      prUrl: 'https://example.test/pr/2050',
      prState: 'draft',
      branch: 'autofix/cezar-issue-1704',
    });
    expect(result.created).toBe(true);
    expect(result.id).toBe(1000);
    expect(gh.comments).toHaveLength(1);
    const parsed = parseMarkerComment(gh.comments[0].body);
    expect(parsed?.prNumber).toBe(2050);
    expect(parsed?.openedAt).toBeDefined();
    expect(parsed?.lastEventAt).toBeDefined();
  });

  it('updates the existing marker in place', async () => {
    const gh = new FakeGateway();
    await upsertMarkerComment(gh, 1704, {
      prNumber: 2050,
      prUrl: 'https://example.test/pr/2050',
      prState: 'draft',
    });
    const firstId = gh.comments[0].id;
    const firstOpenedAt = parseMarkerComment(gh.comments[0].body)?.openedAt;

    const result = await upsertMarkerComment(gh, 1704, {
      prNumber: 2050,
      prUrl: 'https://example.test/pr/2050',
      prState: 'changes-requested',
    });
    expect(result.created).toBe(false);
    expect(result.id).toBe(firstId);
    expect(gh.comments).toHaveLength(1);
    const updated = parseMarkerComment(gh.comments[0].body);
    expect(updated?.prState).toBe('changes-requested');
    // openedAt is preserved across updates so the marker reflects PR creation
    // time, not the most recent edit time.
    expect(updated?.openedAt).toBe(firstOpenedAt);
  });

  it('ignores non-marker comments when searching', async () => {
    const gh = new FakeGateway();
    gh.comments.push({
      id: 500,
      author: 'human',
      body: 'This is just regular feedback.',
      createdAt: '2026-05-25T01:00:00Z',
    });
    gh.comments.push({
      id: 501,
      author: 'bot',
      body: '<!-- some-other-marker --> not us',
      createdAt: '2026-05-25T02:00:00Z',
    });

    const result = await upsertMarkerComment(gh, 1704, {
      prNumber: 7,
      prUrl: 'https://example.test/pr/7',
      prState: 'draft',
    });
    expect(result.created).toBe(true);
    expect(gh.comments).toHaveLength(3);
  });

  it('honours an explicit lastEventAt from the caller', async () => {
    const gh = new FakeGateway();
    await upsertMarkerComment(gh, 1704, {
      prNumber: 7,
      prUrl: 'https://example.test/pr/7',
      prState: 'draft',
      lastEventAt: '2026-05-25T10:00:00Z',
    });
    const parsed = parseMarkerComment(gh.comments[0].body);
    expect(parsed?.lastEventAt).toBe('2026-05-25T10:00:00Z');
  });
});

describe('findMarkerComment', () => {
  it('returns null when listIssueCommentsWithIds is not provided (graceful fallback)', async () => {
    const gw: PrLinkGitHubGateway = {
      async addComment() {
        return 0;
      },
      async updateComment() {},
    };
    expect(await findMarkerComment(gw, 1704)).toBeNull();
  });

  it('returns the latest marker when multiple exist (recovery from a stale duplicate)', async () => {
    const gh = new FakeGateway();
    // Older marker (e.g. left by a prior bug where two were created).
    gh.comments.push({
      id: 100,
      author: 'cezar',
      body: formatMarkerComment({ prNumber: 1, prUrl: 'https://x/pr/1', prState: 'closed' }),
      createdAt: '2026-05-20T00:00:00Z',
    });
    // Current marker.
    gh.comments.push({
      id: 200,
      author: 'cezar',
      body: formatMarkerComment({ prNumber: 2050, prUrl: 'https://x/pr/2050', prState: 'review' }),
      createdAt: '2026-05-25T00:00:00Z',
    });
    const found = await findMarkerComment(gh, 1704);
    expect(found?.id).toBe(200);
    expect(found?.data.prNumber).toBe(2050);
  });
});
