import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_ACTIONS } from '@cezar/core';
import { seedDefaultActions } from '../src/lib/seed-default-actions';
import type { Database } from '../src/lib/supabase/types';

interface PgError {
  message: string;
}

interface FakeResults {
  upsert?: { error: PgError | null };
  lookup?: { data: { id: string } | null; error: PgError | null };
  update?: { error: PgError | null };
}

interface RecordedCalls {
  upsertTable?: string;
  upsertOnConflict?: string;
  upsertRows?: Array<Record<string, unknown>>;
  updateTable?: string;
  updateValues?: Record<string, unknown>;
  updateIsFilter?: { column: string; value: unknown };
}

/**
 * Minimal chainable stand-in for the supabase-js query builder, recording the
 * calls `seedDefaultActions` makes and resolving the terminal awaits with the
 * configured results. Cast through `unknown` to the real client type at the
 * boundary — no `any`.
 */
function makeFakeSupabase(results: FakeResults): {
  client: SupabaseClient<Database>;
  calls: RecordedCalls;
} {
  const calls: RecordedCalls = {};

  const makeBuilder = (table: string) => {
    let pending: { error: PgError | null } = { error: null };
    const builder = {
      select(_columns: string) {
        return builder;
      },
      upsert(rows: Array<Record<string, unknown>>, options?: { onConflict?: string }) {
        calls.upsertTable = table;
        calls.upsertRows = rows;
        calls.upsertOnConflict = options?.onConflict;
        pending = results.upsert ?? { error: null };
        return builder;
      },
      update(values: Record<string, unknown>) {
        calls.updateTable = table;
        calls.updateValues = values;
        pending = results.update ?? { error: null };
        return builder;
      },
      eq(_column: string, _value: unknown) {
        return builder;
      },
      is(column: string, value: unknown) {
        calls.updateIsFilter = { column, value };
        return builder;
      },
      maybeSingle() {
        return Promise.resolve(results.lookup ?? { data: null, error: null });
      },
      then<TResult1 = { error: PgError | null }>(
        onFulfilled?: (value: { error: PgError | null }) => TResult1 | PromiseLike<TResult1>,
      ): Promise<TResult1> {
        return Promise.resolve(pending).then(onFulfilled);
      },
    };
    return builder;
  };

  const client = {
    from(table: string) {
      return makeBuilder(table);
    },
  } as unknown as SupabaseClient<Database>;

  return { client, calls };
}

const WS = 'ws-123';

describe('seedDefaultActions', () => {
  it('upserts the full catalog keyed on workspace_id,name,kind', async () => {
    const { client, calls } = makeFakeSupabase({
      lookup: { data: { id: 'triage-row-1' }, error: null },
    });

    const result = await seedDefaultActions(client, WS);

    expect(result).toEqual({ ok: true });
    expect(calls.upsertTable).toBe('actions');
    expect(calls.upsertOnConflict).toBe('workspace_id,name,kind');
    expect(calls.upsertRows).toHaveLength(DEFAULT_ACTIONS.length);
    expect(calls.upsertRows?.every((r) => r.kind === 'built-in')).toBe(true);
    expect(calls.upsertRows?.every((r) => r.workspace_id === WS)).toBe(true);
  });

  it('points auto_triage_action_id at the built-in row only when currently null', async () => {
    const { client, calls } = makeFakeSupabase({
      lookup: { data: { id: 'triage-row-1' }, error: null },
    });

    const result = await seedDefaultActions(client, WS);

    expect(result).toEqual({ ok: true });
    expect(calls.updateTable).toBe('workspaces');
    expect(calls.updateValues).toEqual({ auto_triage_action_id: 'triage-row-1' });
    // The "only when null" guard is the `.is(..., null)` filter on the update.
    expect(calls.updateIsFilter).toEqual({ column: 'auto_triage_action_id', value: null });
  });

  it('skips the pointer update when no auto-triage row is found', async () => {
    const { client, calls } = makeFakeSupabase({
      lookup: { data: null, error: null },
    });

    const result = await seedDefaultActions(client, WS);

    expect(result).toEqual({ ok: true });
    expect(calls.updateTable).toBeUndefined();
    expect(calls.updateValues).toBeUndefined();
  });

  it('returns { ok: false, error } on an upsert error without throwing', async () => {
    const { client, calls } = makeFakeSupabase({
      upsert: { error: { message: 'upsert boom' } },
    });

    const result = await seedDefaultActions(client, WS);

    expect(result).toEqual({ ok: false, error: 'upsert boom' });
    // Short-circuits before the pointer update.
    expect(calls.updateTable).toBeUndefined();
  });

  it('returns { ok: false, error } on a lookup error without throwing', async () => {
    const { client } = makeFakeSupabase({
      lookup: { data: null, error: { message: 'lookup boom' } },
    });

    const result = await seedDefaultActions(client, WS);

    expect(result).toEqual({ ok: false, error: 'lookup boom' });
  });

  it('returns { ok: false, error } on a pointer-update error without throwing', async () => {
    const { client } = makeFakeSupabase({
      lookup: { data: { id: 'triage-row-1' }, error: null },
      update: { error: { message: 'update boom' } },
    });

    const result = await seedDefaultActions(client, WS);

    expect(result).toEqual({ ok: false, error: 'update boom' });
  });
});
