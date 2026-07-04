import { DEFAULT_AUTO_ACCEPT_ABOVE } from './action.js';
import type {
  AcceptanceMode,
  ActionDef,
  ActionTrigger,
  ConfidenceConfig,
  EffectRoutingMode,
} from './action.js';
import type { EffectName } from './effects.js';

/**
 * The DB row shape for the `actions` table. Typed locally against the subset
 * of columns we read so `@cezar/core` stays free of the GUI's generated
 * Supabase types — callers pass the typed client as `unknown`.
 */
interface ActionRow {
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

// `context_refs`, `effect_routing`, `suggested_flow_id` are added by
// migration 0044 (Phase 3/5 of the actions cleanup) — they ship in the same
// release as this loader change.
const ACTION_COLUMNS =
  'id, workspace_id, name, kind, description, system_prompt, skill_refs, context_refs, target, triggers, effects, output_schema, enabled, model, acceptance_mode, confidence_config, effect_routing, suggested_flow_id';

interface QueryResult<T> {
  data: T | null;
  error: { message: string } | null;
}

/**
 * Loose chainable builder. The real Supabase types are generic and don't
 * cleanly survive going through `unknown` at the package boundary; modelling
 * just the shape we use (and `then`-ing the builder as a thenable to await
 * the underlying result) is simpler than threading the full generic.
 */
interface Querylike<TRow> {
  eq(col: string, value: unknown): Querylike<TRow>;
  order(col: string, opts?: { ascending?: boolean }): Querylike<TRow>;
  maybeSingle(): Promise<QueryResult<TRow>>;
  then<TResult1 = QueryResult<TRow[]>, TResult2 = never>(
    onfulfilled?: ((value: QueryResult<TRow[]>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2>;
}

interface FromBuilderLike {
  select(cols: string): Querylike<ActionRow>;
}

interface LooseSupabase {
  from(table: string): FromBuilderLike;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function rowToAction(row: ActionRow): ActionDef {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    kind: row.kind,
    description: row.description,
    systemPrompt: row.system_prompt,
    skillRefs: asStringArray(row.skill_refs),
    contextRefs: asStringArray(row.context_refs),
    target: row.target,
    // Deliberately lenient cast: DB rows may still carry retired trigger
    // strings (e.g. 'on-cron') — they simply never match a fired trigger.
    triggers: asStringArray(row.triggers) as ActionTrigger[],
    effects: row.effects == null ? null : (asStringArray(row.effects) as EffectName[]),
    outputSchema:
      row.output_schema &&
      typeof row.output_schema === 'object' &&
      !Array.isArray(row.output_schema)
        ? (row.output_schema as Record<string, unknown>)
        : null,
    enabled: row.enabled,
    model: row.model,
    acceptanceMode: parseAcceptanceMode(row.acceptance_mode),
    confidenceConfig: parseConfidenceConfig(row.confidence_config),
    effectRouting: parseEffectRouting(row.effect_routing),
    suggestedFlowId: typeof row.suggested_flow_id === 'string' ? row.suggested_flow_id : null,
  };
}

/**
 * Defensive map of the `effect_routing` jsonb column. Keeps only entries
 * whose value is a valid routing mode; returns undefined for empty/absent
 * objects so the runner falls back to its built-in default map.
 */
function parseEffectRouting(
  value: unknown,
): Partial<Record<EffectName, EffectRoutingMode>> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Partial<Record<EffectName, EffectRoutingMode>> = {};
  let any = false;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === 'auto' || v === 'always-defer') {
      out[k as EffectName] = v;
      any = true;
    }
  }
  return any ? out : undefined;
}

function parseAcceptanceMode(value: string | null): AcceptanceMode {
  return value === 'human-in-the-loop' ? 'human-in-the-loop' : 'auto';
}

function parseConfidenceConfig(value: unknown): ConfidenceConfig {
  const obj =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const clamp = (v: unknown, fallback: number): number => {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(100, Math.round(n)));
  };
  const high = clamp(obj.autoAcceptAbove, DEFAULT_AUTO_ACCEPT_ABOVE);
  if ('autoDenyBelow' in obj) {
    return {
      autoAcceptAbove: high,
      autoDenyBelow: Math.max(0, Math.min(clamp(obj.autoDenyBelow, 0), high - 1)),
    };
  }
  return { autoAcceptAbove: high };
}

/**
 * Look up a single Action by `(workspace_id, name)`. When both a `built-in`
 * and a `user` row exist for the same name (the override pattern), the user
 * row wins. Returns null when no row matches.
 */
export async function loadActionByName(
  supabase: unknown,
  workspaceId: string,
  name: string,
): Promise<ActionDef | null> {
  const sb = supabase as LooseSupabase;
  const { data, error } = await sb
    .from('actions')
    .select(ACTION_COLUMNS)
    .eq('workspace_id', workspaceId)
    .eq('name', name);
  if (error) throw new Error(`loadActionByName(${name}) failed: ${error.message}`);
  return pickPreferred(data ?? []);
}

/**
 * Look up the workspace's auto-triage Action via `workspaces.auto_triage_action_id`.
 * Returns null when the workspace has no auto-triage action pointer set.
 */
export async function loadAutoTriageAction(
  supabase: unknown,
  workspaceId: string,
): Promise<ActionDef | null> {
  const sb = supabase as unknown as {
    from(table: 'workspaces'): {
      select(cols: 'auto_triage_action_id'): {
        eq(
          col: 'id',
          value: string,
        ): {
          maybeSingle(): Promise<QueryResult<{ auto_triage_action_id: string | null }>>;
        };
      };
    };
  };
  const { data, error } = await sb
    .from('workspaces')
    .select('auto_triage_action_id')
    .eq('id', workspaceId)
    .maybeSingle();
  if (error) throw new Error(`loadAutoTriageAction lookup failed: ${error.message}`);
  if (!data?.auto_triage_action_id) return null;

  const actionsSb = supabase as LooseSupabase;
  const { data: row, error: rowErr } = await actionsSb
    .from('actions')
    .select(ACTION_COLUMNS)
    .eq('id', data.auto_triage_action_id)
    .maybeSingle();
  if (rowErr) throw new Error(`loadAutoTriageAction fetch failed: ${rowErr.message}`);
  return row ? rowToAction(row) : null;
}

/**
 * List enabled actions for a workspace, optionally filtered by `target`
 * and/or matching `trigger`. Triggers live in the row's jsonb `triggers`
 * array; we fetch the row set then filter in JS — the per-workspace action
 * set is small (≤30) so the trade-off favours code simplicity over a
 * trickier PostgREST array-contains query.
 */
export async function listEnabledActions(
  supabase: unknown,
  workspaceId: string,
  filter?: { target?: 'issue' | 'pr'; trigger?: ActionTrigger },
): Promise<ActionDef[]> {
  const sb = supabase as LooseSupabase;
  // We deliberately do NOT filter `enabled = true` in SQL: a user row may
  // override a built-in with `enabled = false` to disable it. Such a row must
  // survive into `pickPreferred` so it wins over (and suppresses) the built-in;
  // we then drop the resolved row if the winner is disabled.
  const { data, error } = await sb
    .from('actions')
    .select(ACTION_COLUMNS)
    .eq('workspace_id', workspaceId)
    .order('name', { ascending: true });
  if (error) throw new Error(`listEnabledActions failed: ${error.message}`);
  const grouped = new Map<string, ActionRow[]>();
  for (const row of data ?? []) {
    const list = grouped.get(row.name) ?? [];
    list.push(row);
    grouped.set(row.name, list);
  }
  let rows: ActionDef[] = [];
  for (const list of grouped.values()) {
    const picked = pickPreferred(list);
    if (picked && picked.enabled) rows.push(picked);
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  if (filter?.target) rows = rows.filter((a) => a.target === filter.target);
  if (filter?.trigger) rows = rows.filter((a) => a.triggers.includes(filter.trigger!));
  return rows;
}

/**
 * Given a (possibly empty) set of rows sharing a name, return the user row
 * when present, otherwise the built-in. Encapsulates the override-precedence
 * rule so the same logic governs both single-name and full-list lookups.
 */
function pickPreferred(rows: ActionRow[]): ActionDef | null {
  if (rows.length === 0) return null;
  const user = rows.find((r) => r.kind === 'user');
  return rowToAction(user ?? rows[0]);
}
