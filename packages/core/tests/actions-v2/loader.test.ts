import { describe, it, expect } from 'vitest';
import { listEnabledActions, loadActionByName } from '../../src/actions-v2/loader.js';

/**
 * `listEnabledActions` / `loadActionByName` against a minimal fake of the
 * Supabase query builder (the loader types the client as `unknown` and only
 * uses from().select().eq().order() + awaiting the builder as a thenable, so
 * a canned-rows fake covers the real surface).
 */

// Matches the loader's internal ActionRow shape (the raw DB row).
interface FakeRow {
  id: string;
  workspace_id: string;
  name: string;
  kind: 'built-in' | 'user';
  description: string | null;
  system_prompt: string;
  skill_refs: unknown;
  context_refs: unknown;
  target: 'issue' | 'pr';
  triggers: unknown;
  effects: unknown;
  output_schema: unknown;
  enabled: boolean;
  model: string | null;
  acceptance_mode: string | null;
  confidence_config: unknown;
  effect_routing: unknown;
  suggested_flow_id: string | null;
}

function makeRow(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id: 'row-1',
    workspace_id: 'ws-1',
    name: 'auto-triage',
    kind: 'built-in',
    description: null,
    system_prompt: 'triage it',
    skill_refs: [],
    context_refs: [],
    target: 'issue',
    triggers: ['on-issue-opened', 'manual'],
    effects: null,
    output_schema: null,
    enabled: true,
    model: null,
    acceptance_mode: null,
    confidence_config: null,
    effect_routing: null,
    suggested_flow_id: null,
    ...overrides,
  };
}

/**
 * Chainable thenable builder: eq()/order() return the builder; awaiting it
 * resolves `{ data: rows, error: null }`. `maybeSingle()` resolves the first
 * row (or null) — enough for the loader's query shapes.
 */
function fakeSupabase(rows: FakeRow[]): unknown {
  const result = { data: rows, error: null };
  const builder = {
    eq: () => builder,
    order: () => builder,
    maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
    then: (
      onfulfilled?: ((value: typeof result) => unknown) | null,
      onrejected?: ((reason: unknown) => unknown) | null,
    ) => Promise.resolve(result).then(onfulfilled, onrejected),
  };
  return {
    from: () => ({ select: () => builder }),
  };
}

describe('listEnabledActions', () => {
  it('a user override wins over the built-in with the same name', async () => {
    const sb = fakeSupabase([
      makeRow({ id: 'builtin-1', kind: 'built-in', system_prompt: 'builtin prompt' }),
      makeRow({ id: 'user-1', kind: 'user', system_prompt: 'user prompt' }),
    ]);
    const actions = await listEnabledActions(sb, 'ws-1');
    expect(actions).toHaveLength(1);
    expect(actions[0].id).toBe('user-1');
    expect(actions[0].systemPrompt).toBe('user prompt');
  });

  it('a disabled user override suppresses the enabled built-in entirely', async () => {
    const sb = fakeSupabase([
      makeRow({ id: 'builtin-1', kind: 'built-in', enabled: true }),
      makeRow({ id: 'user-1', kind: 'user', enabled: false }),
    ]);
    const actions = await listEnabledActions(sb, 'ws-1');
    expect(actions).toHaveLength(0);
  });

  it('filters by matching trigger', async () => {
    const sb = fakeSupabase([
      makeRow({ id: 'a', name: 'auto-triage', triggers: ['on-issue-opened', 'manual'] }),
      makeRow({ id: 'b', name: 'security', triggers: ['on-issue-edited', 'manual'] }),
    ]);
    const opened = await listEnabledActions(sb, 'ws-1', { trigger: 'on-issue-opened' });
    expect(opened.map((a) => a.id)).toEqual(['a']);
    const edited = await listEnabledActions(sb, 'ws-1', { trigger: 'on-issue-edited' });
    expect(edited.map((a) => a.id)).toEqual(['b']);
  });

  it('rows carrying retired trigger strings never match a live trigger', async () => {
    const sb = fakeSupabase([
      makeRow({ id: 'stale', name: 'stale', triggers: ['on-cron'] }),
      makeRow({ id: 'pr-watch', name: 'pr-watch', triggers: ['on-pr-opened', 'on-check-failed'] }),
    ]);
    for (const trigger of [
      'manual',
      'on-issue-opened',
      'on-issue-edited',
      'on-issue-reopened',
    ] as const) {
      const actions = await listEnabledActions(sb, 'ws-1', { trigger });
      expect(actions).toHaveLength(0);
    }
    // ... but the rows still load without a trigger filter (manual "run now"
    // by id keeps working for user rows with retired triggers).
    const all = await listEnabledActions(sb, 'ws-1');
    expect(all).toHaveLength(2);
  });

  it('filters by target', async () => {
    const sb = fakeSupabase([
      makeRow({ id: 'a', name: 'auto-triage', target: 'issue' }),
      makeRow({ id: 'b', name: 'pr-review', target: 'pr' }),
    ]);
    const issues = await listEnabledActions(sb, 'ws-1', { target: 'issue' });
    expect(issues.map((a) => a.id)).toEqual(['a']);
  });

  it('maps context_refs / effect_routing / suggested_flow_id onto ActionDef', async () => {
    const sb = fakeSupabase([
      makeRow({
        context_refs: ['open-issues'],
        effect_routing: { 'suggest-workflow': 'auto', 'label.add': 'always-defer' },
        suggested_flow_id: 'flow-123',
      }),
    ]);
    const [action] = await listEnabledActions(sb, 'ws-1');
    expect(action.contextRefs).toEqual(['open-issues']);
    expect(action.effectRouting).toEqual({
      'suggest-workflow': 'auto',
      'label.add': 'always-defer',
    });
    expect(action.suggestedFlowId).toBe('flow-123');
  });

  it('parses jsonb columns defensively (malformed values degrade, never throw)', async () => {
    const sb = fakeSupabase([
      makeRow({
        skill_refs: 'not-an-array',
        context_refs: { nope: true },
        triggers: ['on-issue-opened', 42, null],
        effect_routing: { 'label.add': 'bogus-mode', comment: 'auto' },
        confidence_config: 'garbage',
        suggested_flow_id: null,
      }),
    ]);
    const [action] = await listEnabledActions(sb, 'ws-1');
    expect(action.skillRefs).toEqual([]);
    expect(action.contextRefs).toEqual([]);
    expect(action.triggers).toEqual(['on-issue-opened']);
    // Only the well-formed routing entry survives.
    expect(action.effectRouting).toEqual({ comment: 'auto' });
    expect(action.suggestedFlowId).toBeNull();
    // Malformed confidence_config falls back to the default threshold shape.
    expect(action.confidenceConfig).toEqual({ autoAcceptAbove: 80 });
  });

  it('an effect_routing object with no valid entries maps to undefined (runner defaults apply)', async () => {
    const sb = fakeSupabase([makeRow({ effect_routing: { 'label.add': 'whenever' } })]);
    const [action] = await listEnabledActions(sb, 'ws-1');
    expect(action.effectRouting).toBeUndefined();
  });
});

describe('loadActionByName', () => {
  it('prefers the user row over the built-in', async () => {
    const sb = fakeSupabase([
      makeRow({ id: 'builtin-1', kind: 'built-in' }),
      makeRow({ id: 'user-1', kind: 'user' }),
    ]);
    const action = await loadActionByName(sb, 'ws-1', 'auto-triage');
    expect(action?.id).toBe('user-1');
  });

  it('returns null when no row matches', async () => {
    const sb = fakeSupabase([]);
    const action = await loadActionByName(sb, 'ws-1', 'missing');
    expect(action).toBeNull();
  });
});
