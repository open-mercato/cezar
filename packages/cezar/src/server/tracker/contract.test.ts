import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  trackerAssociationInputSchema,
  trackerCandidatesQuerySchema,
  trackerCandidatesResponseSchema,
  trackerCandidatesResultSchema,
  trackerItemParamsSchema,
  trackerItemResponseSchema,
  trackerItemResultSchema,
  trackerItemSchema,
  trackerItemsResponseSchema,
  trackerItemsResultSchema,
  trackerListQuerySchema,
  trackerSearchQuerySchema,
  trackerSourceSchema,
  type TrackerCandidatesQuery,
  type TrackerCandidatesQueryInput,
  type TrackerInvalidCursor,
  type TrackerListQuery,
  type TrackerListQueryInput,
  type TrackerNotFound,
  type TrackerSearchQuery,
  type TrackerSearchQueryInput,
} from '@open-mercato/cezar-contract';

const item = {
  kind: 'issue' as const,
  id: 'CEZ-42',
  title: 'Keep tracker failures distinct from empty results',
  author: 'Ada Lovelace',
  createdAt: '2026-09-18T09:30:00.000Z',
  updatedAt: '2026-09-19T11:45:00.000Z',
  labels: ['api', 'tracker'],
  body: 'A complete issue description.',
  bodyTruncated: false,
  unsupportedContent: false,
  url: 'https://example.atlassian.net/browse/CEZ-42',
  status: 'In Progress',
};

describe('tracker entity schemas', () => {
  it('accepts HTTPS source URLs and rejects insecure source URLs', () => {
    expect(
      trackerSourceSchema.safeParse({ id: 'cloud-1', webUrl: 'https://example.atlassian.net' })
        .success,
    ).toBe(true);
    expect(
      trackerSourceSchema.safeParse({ id: 'cloud-1', webUrl: 'http://example.atlassian.net' })
        .success,
    ).toBe(false);
  });

  it('keeps association input server-owned fields out of the request', () => {
    expect(
      trackerAssociationInputSchema.safeParse({
        kind: 'jira',
        externalId: '10001',
        sourceId: 'cloud-1',
        externalName: 'Cezar',
      }).success,
    ).toBe(false);
  });

  it('requires ISO timestamps and complete issue-loss metadata', () => {
    expect(trackerItemSchema.safeParse(item).success).toBe(true);
    expect(trackerItemSchema.safeParse({ ...item, updatedAt: 'last Thursday' }).success).toBe(
      false,
    );
    const { unsupportedContent: _unsupportedContent, ...missingLossFlag } = item;
    expect(trackerItemSchema.safeParse(missingLossFlag).success).toBe(false);
  });
});

describe('tracker result and HTTP response branches', () => {
  it('keeps a controlled failure distinct from an empty successful item page', () => {
    const failure = {
      available: false as const,
      code: 'rate_limited' as const,
      reason: 'Try again later',
      retryAfterSeconds: 30,
    };
    const empty = { available: true as const, items: [], truncated: false as const };

    expect(trackerItemsResultSchema.parse(failure)).toEqual(failure);
    expect(trackerItemsResultSchema.parse(empty)).toEqual(empty);
    expect(
      trackerItemsResultSchema.safeParse({ ...failure, items: [] }).success,
    ).toBe(false);
    expect(
      trackerItemsResultSchema.safeParse({ ...failure, retryAfterSeconds: -1 }).success,
    ).toBe(false);
  });

  it('requires a bounded next cursor exactly when a page is truncated', () => {
    expect(
      trackerCandidatesResultSchema.safeParse({
        available: true,
        source: { id: 'cloud-1', webUrl: 'https://example.atlassian.net' },
        candidates: [],
        truncated: true,
      }).success,
    ).toBe(false);
    expect(
      trackerCandidatesResultSchema.safeParse({
        available: true,
        source: { id: 'cloud-1', webUrl: 'https://example.atlassian.net' },
        candidates: [],
        truncated: false,
        nextCursor: 'unexpected',
      }).success,
    ).toBe(false);
    expect(
      trackerCandidatesResultSchema.safeParse({
        available: true,
        source: { id: 'cloud-1', webUrl: 'https://example.atlassian.net' },
        candidates: [{ id: '10001', name: 'Cezar' }],
        truncated: true,
        nextCursor: 'page-2',
      }).success,
    ).toBe(true);
    expect(
      trackerItemsResultSchema.safeParse({
        available: true,
        items: [item],
        truncated: true,
        nextCursor: 'x'.repeat(4097),
      }).success,
    ).toBe(false);
  });

  it('excludes invalid cursors from HTTP 200 collection responses', () => {
    const invalidCursor: TrackerInvalidCursor = {
      available: false,
      code: 'invalid_cursor',
      reason: 'The search changed; start again',
    };

    expect(trackerCandidatesResultSchema.safeParse(invalidCursor).success).toBe(true);
    expect(trackerCandidatesResponseSchema.safeParse(invalidCursor).success).toBe(false);
    expect(trackerItemsResultSchema.safeParse(invalidCursor).success).toBe(true);
    expect(trackerItemsResponseSchema.safeParse(invalidCursor).success).toBe(false);
  });

  it('excludes not-found only from the detail HTTP 200 response', () => {
    const notFound: TrackerNotFound = {
      available: false,
      code: 'not_found',
      reason: 'Issue not found in the selected project',
    };
    const unavailable = {
      available: false as const,
      code: 'unavailable' as const,
      reason: 'Jira did not respond',
    };

    expect(trackerItemResultSchema.safeParse(notFound).success).toBe(true);
    expect(trackerItemResponseSchema.safeParse(notFound).success).toBe(false);
    expect(trackerItemResponseSchema.safeParse(unavailable).success).toBe(true);
  });
});

describe('tracker query and parameter schemas', () => {
  it('parses candidate defaults and rejects invalid numeric limits', () => {
    expect(trackerCandidatesQuerySchema.parse({ kind: 'jira' })).toEqual({
      kind: 'jira',
      limit: 50,
    });
    expect(trackerCandidatesQuerySchema.parse({ kind: 'linear', q: '  roadmap  ', limit: '100' }))
      .toEqual({ kind: 'linear', q: 'roadmap', limit: 100 });

    for (const limit of ['0', '101', '1.5', 'many']) {
      expect(trackerCandidatesQuerySchema.safeParse({ kind: 'jira', limit }).success).toBe(false);
    }
  });

  it('decodes a labels JSON parameter and rejects malformed or invalid arrays', () => {
    expect(
      trackerListQuerySchema.parse({ labels: '["backend","needs triage"]' }),
    ).toEqual({ limit: 50, state: 'active', labels: ['backend', 'needs triage'] });

    const twentyOneLabels = JSON.stringify(
      Array.from({ length: 21 }, (_, index) => `label-${index + 1}`),
    );
    for (const labels of ['not-json', '{"label":"backend"}', '["backend",""]', twentyOneLabels]) {
      expect(trackerListQuerySchema.safeParse({ labels }).success).toBe(false);
    }
  });

  it('uses different list and search state defaults and validates wire flags', () => {
    expect(trackerListQuerySchema.parse({})).toEqual({ limit: 50, state: 'active' });
    expect(trackerSearchQuerySchema.parse({ q: '  completed work  ' })).toEqual({
      q: 'completed work',
      limit: 50,
      state: 'all',
    });
    expect(trackerListQuerySchema.safeParse({ refresh: 'true' }).success).toBe(false);
    expect(trackerSearchQuerySchema.safeParse({ q: '   ' }).success).toBe(false);
  });

  it('rejects reserved static route names and oversized detail IDs', () => {
    for (const id of ['association', 'candidates', 'search', '', 'x'.repeat(257)]) {
      expect(trackerItemParamsSchema.safeParse({ id }).success).toBe(false);
    }
    expect(trackerItemParamsSchema.parse({ id: 'CEZ-42' })).toEqual({ id: 'CEZ-42' });
  });

  it('publishes string wire inputs separately from parsed driver query types', () => {
    expectTypeOf<TrackerCandidatesQueryInput['limit']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<TrackerCandidatesQuery['limit']>().toEqualTypeOf<number>();
    expectTypeOf<TrackerListQueryInput['labels']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<TrackerListQuery['labels']>().toEqualTypeOf<string[] | undefined>();
    expectTypeOf<TrackerSearchQueryInput['limit']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<TrackerSearchQuery['limit']>().toEqualTypeOf<number>();
    expectTypeOf<TrackerSearchQueryInput['state']>().toEqualTypeOf<'active' | 'all' | undefined>();
    expectTypeOf<TrackerSearchQuery['state']>().toEqualTypeOf<'active' | 'all'>();
  });
});
