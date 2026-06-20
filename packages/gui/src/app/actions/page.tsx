import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { PageContainer } from '@/components/ui/page-container';
import { ActionsView, type ActionRow } from './actions-view';

interface DbActionRow {
  id: string;
  name: string;
  kind: 'built-in' | 'user';
  description: string | null;
  target: 'issue' | 'pr';
  triggers: unknown;
  effects: unknown;
  enabled: boolean;
  replaces_built_in: string | null;
  updated_at: string | null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

export default async function ActionsPage() {
  const workspace = await getActiveWorkspace();

  if (!workspace) {
    return (
      <PageContainer>
        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight text-on-surface">Actions</h1>
          <p className="mt-1 text-sm text-on-surface-variant">
            Configurable AI actions that operate on issues and PRs.
          </p>
        </header>
        <div className="mt-6 rounded-md border border-dashed border-outline-variant bg-surface-container-low p-8 text-center text-sm text-on-surface-variant">
          No workspace selected. Create one first.
        </div>
      </PageContainer>
    );
  }

  const supabase = createSupabaseAdminClient();
  const [{ data: actionRows }, { data: workspaceRow }] = await Promise.all([
    supabase
      .from('actions')
      .select(
        'id, name, kind, description, target, triggers, effects, enabled, replaces_built_in, updated_at',
      )
      .eq('workspace_id', workspace.id)
      .order('name', { ascending: true })
      .returns<DbActionRow[]>(),
    supabase
      .from('workspaces')
      .select('auto_triage_action_id')
      .eq('id', workspace.id)
      .maybeSingle<{ auto_triage_action_id: string | null }>(),
  ]);

  // Preferred-row selection: a `user` row with the same name as a `built-in`
  // shadows the built-in. We surface only the preferred row in the list (so
  // the cockpit shows one row per logical action) and flag whether an
  // override exists.
  const byName = new Map<string, DbActionRow[]>();
  for (const r of actionRows ?? []) {
    const list = byName.get(r.name) ?? [];
    list.push(r);
    byName.set(r.name, list);
  }

  // Also index user rows by `replaces_built_in` so a row keeps its override
  // signal even when the user override was renamed (which can't happen today,
  // but the data model allows it).
  const overrideTargets = new Set<string>();
  for (const r of actionRows ?? []) {
    if (r.kind === 'user' && r.replaces_built_in) overrideTargets.add(r.replaces_built_in);
  }

  const rows: ActionRow[] = [];
  for (const [name, list] of byName) {
    const user = list.find((r) => r.kind === 'user');
    const preferred = user ?? list[0];
    const hasBuiltinShadow = user !== undefined && list.some((r) => r.kind === 'built-in');
    const hasUserOverride =
      preferred.kind === 'built-in' &&
      (list.some((r) => r.kind === 'user') || overrideTargets.has(name));
    rows.push({
      id: preferred.id,
      name,
      kind: preferred.kind,
      description: preferred.description,
      target: preferred.target,
      triggers: asStringArray(preferred.triggers),
      effectsDeclared: preferred.effects === null ? null : asStringArray(preferred.effects).length,
      status: preferred.enabled ? 'enabled' : 'disabled',
      updatedAt: preferred.updated_at,
      replacesBuiltIn: preferred.replaces_built_in,
      hasBuiltinShadow,
      hasUserOverride,
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));

  const isAdmin = workspace.role === 'admin';
  const autoTriageActionId = workspaceRow?.auto_triage_action_id ?? null;

  return <ActionsView rows={rows} readOnly={!isAdmin} autoTriageActionId={autoTriageActionId} />;
}
