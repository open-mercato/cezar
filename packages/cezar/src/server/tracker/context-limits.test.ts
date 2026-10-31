import { expect, it } from 'vitest';
import { boundedContext } from './context-limits.ts';

const base = {
  issueId: 'i', statusId: 's', fetchedAt: '2026-10-23T00:00:00.000Z', limitations: [], transitions: [],
  item: { id: 'i', key: 'K-1', title: 't', body: '', bodyTruncated: false, url: 'https://x', status: 's', labels: [] },
} as unknown as Parameters<typeof boundedContext>[0];

it('drops the oldest comments to fit and names every loss', () => {
  const comments = Array.from({ length: 6 }, (_, index) => ({ id: String(index), author: 'a', body: 'x'.repeat(100_000), createdAt: '' }));
  const result = boundedContext({ ...base, comments }, { description: true, comments: 1, pagesExhausted: true });
  expect(result.comments.map(c => c.id)).toEqual(['2', '3', '4', '5']);
  expect(result.limitations.join(' ')).toMatch(/2 oldest comment.*omitted/);
  expect(result.limitations.join(' ')).toContain('description contains content rendered approximately');
  expect(result.limitations.join(' ')).toContain('Not every comment page could be read');
});

it('leaves a small, complete context unchanged', () => {
  const comments = [{ id: '1', author: 'a', body: 'ok', createdAt: '' }];
  expect(boundedContext({ ...base, comments }, { description: false, comments: 0 })).toEqual({ ...base, comments });
});
