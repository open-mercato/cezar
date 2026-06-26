import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildOpenIssuesContextProviders,
  digestSummary,
} from '../src/lib/open-issues-context';
import type { Database, Json } from '../src/lib/supabase/types';

interface IssueRow {
  number: number;
  title: string;
  body: string;
  digest: Json | null;
}

interface RecordedQuery {
  table?: string;
  selectColumns?: string;
  eqFilters: Array<{ column: string; value: unknown }>;
  ltFilter?: { column: string; value: unknown };
  order?: { column: string; ascending: boolean };
  limit?: number;
}

/**
 * Chainable stand-in for the supabase-js builder used by the `open-issues`
 * context provider, recording the query it constructs and resolving the
 * terminal `await` with the configured rows. Cast through `unknown` — no `any`.
 */
function makeFakeSupabase(rows: IssueRow[]): {
  client: SupabaseClient<Database>;
  query: RecordedQuery;
} {
  const query: RecordedQuery = { eqFilters: [] };

  const builder = {
    select(columns: string) {
      query.selectColumns = columns;
      return builder;
    },
    eq(column: string, value: unknown) {
      query.eqFilters.push({ column, value });
      return builder;
    },
    lt(column: string, value: unknown) {
      query.ltFilter = { column, value };
      return builder;
    },
    order(column: string, options: { ascending: boolean }) {
      query.order = { column, ascending: options.ascending };
      return builder;
    },
    limit(n: number) {
      query.limit = n;
      return Promise.resolve({ data: rows, error: null });
    },
  };

  const client = {
    from(table: string) {
      query.table = table;
      return builder;
    },
  } as unknown as SupabaseClient<Database>;

  return { client, query };
}

const WS = 'ws-1';
const TARGET = 50;

describe('buildOpenIssuesContextProviders', () => {
  it('exposes a single open-issues provider function', () => {
    const { client } = makeFakeSupabase([]);
    const providers = buildOpenIssuesContextProviders(client, WS, TARGET);

    expect(Object.keys(providers)).toEqual(['open-issues']);
    expect(typeof providers['open-issues']).toBe('function');
  });

  it('queries open, lower-numbered issues newest-first capped at 100', async () => {
    const { client, query } = makeFakeSupabase([
      { number: 12, title: 'Older bug', body: 'body 12', digest: { summary: 'digest 12' } },
      { number: 3, title: 'Even older', body: 'body 3', digest: null },
    ]);
    const providers = buildOpenIssuesContextProviders(client, WS, TARGET);

    const out = await providers['open-issues']();

    expect(typeof out).toBe('string');
    expect(query.table).toBe('issues');
    expect(query.selectColumns).toBe('number, title, body, digest');
    expect(query.eqFilters).toContainEqual({ column: 'workspace_id', value: WS });
    expect(query.eqFilters).toContainEqual({ column: 'state', value: 'open' });
    expect(query.ltFilter).toEqual({ column: 'number', value: TARGET });
    expect(query.order).toEqual({ column: 'number', ascending: false });
    expect(query.limit).toBe(100);
  });

  it('throws a descriptive error when the query fails', async () => {
    const failingClient = {
      from() {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          lt() {
            return this;
          },
          order() {
            return this;
          },
          limit() {
            return Promise.resolve({ data: null, error: { message: 'kb boom' } });
          },
        };
      },
    } as unknown as SupabaseClient<Database>;

    const providers = buildOpenIssuesContextProviders(failingClient, WS, TARGET);
    await expect(providers['open-issues']()).rejects.toThrow(/open-issues context query failed: kb boom/);
  });
});

describe('digestSummary', () => {
  it('returns a non-empty summary string from a digest object', () => {
    expect(digestSummary({ summary: 'hello' })).toBe('hello');
  });

  it('returns null for a blank or whitespace summary', () => {
    expect(digestSummary({ summary: '' })).toBeNull();
    expect(digestSummary({ summary: '   ' })).toBeNull();
  });

  it('returns null when summary is missing or not a string', () => {
    expect(digestSummary({ other: 'x' })).toBeNull();
    expect(digestSummary({ summary: 42 })).toBeNull();
  });

  it('returns null for null, arrays, and primitives', () => {
    expect(digestSummary(null)).toBeNull();
    expect(digestSummary(['summary'])).toBeNull();
    expect(digestSummary('summary')).toBeNull();
    expect(digestSummary(7)).toBeNull();
  });
});
