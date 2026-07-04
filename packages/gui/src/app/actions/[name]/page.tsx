import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { ActionDetailView, type ActionDetail } from './action-detail-view';
import {
  coerceConfidenceConfig,
  DEFAULT_ACCEPTANCE_MODE,
  DEFAULT_MODEL,
  isAcceptanceMode,
  isActionModel,
} from './acceptance-types';

interface DbActionRow {
  id: string;
  workspace_id: string;
  name: string;
  kind: 'built-in' | 'user';
  description: string | null;
  system_prompt: string;
  skill_refs: unknown;
  target: 'issue' | 'pr';
  triggers: unknown;
  effects: unknown;
  output_schema: unknown;
  enabled: boolean;
  replaces_built_in: string | null;
  updated_at: string | null;
  model: string | null;
  acceptance_mode: string | null;
  confidence_config: unknown;
  suggested_flow_id: string | null;
}

interface IssueRow {
  number: number;
  title: string;
}

interface FlowOptionRow {
  id: string;
  name: string;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

export default async function ActionDetailPage({ params }: { params: Promise<{ name: string }> }) {
  const { name: rawName } = await params;
  const name = decodeURIComponent(rawName);

  const workspace = await getActiveWorkspace();
  if (!workspace) {
    return (
      <div className="px-6 py-6">
        <div className="rounded-md border border-dashed border-outline-variant bg-surface-container-low p-8 text-center text-sm text-on-surface-variant">
          No workspace selected.{' '}
          <Link href="/workspaces/new" className="text-primary hover:underline">
            Create one first
          </Link>
          .
        </div>
      </div>
    );
  }

  const supabase = createSupabaseAdminClient();
  const [{ data: rows }, { data: workspaceRow }, { data: issueRows }, { data: flowRows }] =
    await Promise.all([
      supabase
        .from('actions')
        .select(
          'id, workspace_id, name, kind, description, system_prompt, skill_refs, target, triggers, effects, output_schema, enabled, replaces_built_in, updated_at, model, acceptance_mode, confidence_config, suggested_flow_id',
        )
        .eq('workspace_id', workspace.id)
        .eq('name', name)
        .returns<DbActionRow[]>(),
      supabase
        .from('workspaces')
        .select('auto_triage_action_id')
        .eq('id', workspace.id)
        .maybeSingle<{ auto_triage_action_id: string | null }>(),
      supabase
        .from('issues')
        .select('number, title')
        .eq('workspace_id', workspace.id)
        .order('updated_at', { ascending: false })
        .limit(20)
        .returns<IssueRow[]>(),
      supabase
        .from('flows')
        .select('id, name')
        .eq('workspace_id', workspace.id)
        .order('name', { ascending: true })
        .returns<FlowOptionRow[]>(),
    ]);

  const allRows = rows ?? [];
  if (allRows.length === 0) notFound();

  const userRow = allRows.find((r) => r.kind === 'user');
  const builtinRow = allRows.find((r) => r.kind === 'built-in');
  const preferred = userRow ?? builtinRow ?? allRows[0];

  const model = isActionModel(preferred.model) ? preferred.model : DEFAULT_MODEL;
  const acceptanceMode = isAcceptanceMode(preferred.acceptance_mode)
    ? preferred.acceptance_mode
    : DEFAULT_ACCEPTANCE_MODE;
  const confidenceConfig = coerceConfidenceConfig(preferred.confidence_config, acceptanceMode);

  const detail: ActionDetail = {
    id: preferred.id,
    name: preferred.name,
    kind: preferred.kind,
    description: preferred.description,
    systemPrompt: preferred.system_prompt,
    skillRefs: asStringArray(preferred.skill_refs),
    target: preferred.target,
    triggers: asStringArray(preferred.triggers),
    effects: preferred.effects === null ? null : asStringArray(preferred.effects),
    outputSchema: preferred.output_schema ? JSON.stringify(preferred.output_schema, null, 2) : '',
    enabled: preferred.enabled,
    replacesBuiltIn: preferred.replaces_built_in,
    updatedAt: preferred.updated_at,
    hasBuiltinShadow: userRow !== undefined && builtinRow !== undefined,
    isAutoTriage: workspaceRow?.auto_triage_action_id === preferred.id,
    testIssues: (issueRows ?? []).map((i) => ({ number: i.number, title: i.title })),
    model,
    acceptanceMode,
    confidenceConfig,
    suggestedFlowId: preferred.suggested_flow_id,
    availableFlows: (flowRows ?? []).map((f) => ({ id: f.id, name: f.name })),
  };

  const isAdmin = workspace.role === 'admin';

  return <ActionDetailView action={detail} readOnly={!isAdmin} />;
}
